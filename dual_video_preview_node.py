"""
DualVideoPreview – ComfyUI custom node
Fast MP4 encoding matching VHS performance:
- Frames written to temp PNGs in parallel threads
- Single ffmpeg call with image sequence input (much faster than pipe)
- H.265 with fallback to H.264
- Optional AUDIO inputs muxed as AAC into the MP4
"""

import os
import hashlib
import subprocess
import threading
import wave
import numpy as np
from PIL import Image
import folder_paths

output_dir = folder_paths.get_output_directory()

# Check codec availability once at import time
def _available_codecs():
    try:
        r = subprocess.run(["ffmpeg", "-encoders", "-v", "quiet"],
                           capture_output=True, text=True)
        return r.stdout
    except FileNotFoundError:
        return ""

_CODEC_LIST = _available_codecs()
HAS_H265 = "libx265" in _CODEC_LIST
HAS_H264 = "libx264" in _CODEC_LIST


def _write_frame(args):
    """Write a single frame PNG to disk. Called from thread pool."""
    frame_np, path = args
    Image.fromarray(frame_np).save(path, format="PNG", compress_level=1)


def _write_audio_wav(audio_dict: dict, path: str):
    """
    Write a ComfyUI AUDIO dict {"waveform": Tensor(1,C,N), "sample_rate": int}
    to a 16-bit WAV file that ffmpeg can mux.
    """
    waveform    = audio_dict["waveform"]
    sample_rate = int(audio_dict["sample_rate"])

    wav = waveform.cpu().numpy()
    if wav.ndim == 3:
        wav = wav[0]           # (1,C,N) → (C,N)
    if wav.ndim == 1:
        wav = wav[np.newaxis]  # mono → (1,N)

    channels, samples = wav.shape
    wav_i16 = (np.clip(wav, -1.0, 1.0) * 32767).astype(np.int16)
    interleaved = wav_i16.T.flatten().tobytes()

    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(interleaved)


def _frames_to_mp4(frames_tensor, fps: float, audio_dict=None, uid_extra: str = "") -> str:
    """
    Convert (B, H, W, C) float32 tensor → H.265/H.264 MP4.
    Optionally muxes audio from a ComfyUI AUDIO dict.
    Uses parallel PNG writes + ffmpeg image-sequence input for maximum speed.
    Returns filename relative to output_dir.
    """
    import tempfile
    from concurrent.futures import ThreadPoolExecutor

    frames = frames_tensor.cpu().numpy()
    B, H, W, C = frames.shape

    # Cache key: hash actual pixel content (first + mid + last frame) so that
    # new frames with the same shape/fps always produce a different filename.
    audio_sig = str(audio_dict["waveform"].shape) if audio_dict else "noaudio"
    hasher = hashlib.md5()
    for fi in [0, B // 2, B - 1]:
        hasher.update((np.clip(frames[fi], 0.0, 1.0) * 255).astype(np.uint8).tobytes())
    hasher.update((str(fps) + uid_extra + audio_sig).encode())
    uid = hasher.hexdigest()[:12]
    filename = f"dvp_{uid}.mp4"
    filepath = os.path.join(output_dir, filename)

    if os.path.exists(filepath):
        return filename  # cached – skip encoding

    # Even dimensions required by codecs
    W_enc = W - (W % 2)
    H_enc = H - (H % 2)

    # Convert all frames to uint8 up front (vectorised, fast)
    frames_u8 = (np.clip(frames, 0.0, 1.0) * 255).astype(np.uint8)
    if W_enc != W or H_enc != H:
        frames_u8 = frames_u8[:, :H_enc, :W_enc, :]

    with tempfile.TemporaryDirectory(prefix="dvp_") as tmpdir:
        # --- Write PNGs in parallel -------------------------------------------
        paths = [os.path.join(tmpdir, f"f{i:06d}.png") for i in range(B)]
        with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4)) as pool:
            list(pool.map(_write_frame, zip(frames_u8, paths)))

        # --- Write audio WAV if provided --------------------------------------
        audio_path = None
        if audio_dict is not None:
            try:
                audio_path = os.path.join(tmpdir, "audio.wav")
                _write_audio_wav(audio_dict, audio_path)
            except Exception as e:
                print(f"[DualVideoPreview] Audio write failed, encoding without audio: {e}")
                audio_path = None

        # --- Pick encoder -----------------------------------------------------
        if HAS_H265:
            vcodec = "libx265"
            codec_args = [
                "-tag:v", "hvc1",
                "-crf", "20",
                "-preset", "ultrafast",
                "-x265-params", "log-level=error",
            ]
        elif HAS_H264:
            print("[DualVideoPreview] H.265 unavailable, using H.264")
            vcodec = "libx264"
            codec_args = ["-crf", "18", "-preset", "ultrafast"]
        else:
            raise RuntimeError("[DualVideoPreview] No supported video encoder found (need libx265 or libx264)")

        # --- Build ffmpeg command ---------------------------------------------
        cmd = [
            "ffmpeg", "-y",
            "-r", str(fps),
            "-i", os.path.join(tmpdir, "f%06d.png"),
        ]

        if audio_path:
            cmd += ["-i", audio_path]

        cmd += [
            "-vcodec", vcodec,
            *codec_args,
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]

        if audio_path:
            video_duration = B / fps
            cmd += [
                "-acodec", "aac",
                "-b:a", "192k",
                "-t", str(video_duration),
                "-map", "0:v:0",
                "-map", "1:a:0",
            ]
        else:
            cmd += ["-an"]

        cmd.append(filepath)

        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"[DualVideoPreview] ffmpeg failed:\n{result.stderr.decode()}"
            )

    return filename


class DualVideoPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "video_1":  ("STRING", {"default": "", "tooltip": "Path to first video file"}),
                "video_2":  ("STRING", {"default": "", "tooltip": "Path to second video file"}),
                "frames_1": ("IMAGE",  {"tooltip": "Frame sequence for video 1 (B,H,W,C)"}),
                "frames_2": ("IMAGE",  {"tooltip": "Frame sequence for video 2 (B,H,W,C)"}),
                "audio_1":  ("AUDIO",  {"tooltip": "Audio track for video 1"}),
                "audio_2":  ("AUDIO",  {"tooltip": "Audio track for video 2"}),
                "label_1":  ("STRING", {"default": "Before"}),
                "label_2":  ("STRING", {"default": "After"}),
                "fps":      ("FLOAT",  {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.5}),
                "loop":     ("BOOLEAN",{"default": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview_videos"
    OUTPUT_NODE = True
    CATEGORY = "image/video"
    DESCRIPTION = "Preview two videos with a drag-to-compare slider. Encodes frames as H.265 MP4 with optional audio."

    def _resolve(self, path, frames, audio, label, slot, fps):
        if frames is not None:
            try:
                filename = _frames_to_mp4(frames, fps, audio_dict=audio, uid_extra=label + str(slot))
            except RuntimeError as e:
                print(e)
                return None
            return {"filename": filename, "subfolder": "", "type": "output",
                    "slot": slot, "label": label}

        if path and os.path.isfile(path):
            abs_out  = os.path.abspath(output_dir)
            abs_path = os.path.abspath(path)
            if abs_path.startswith(abs_out):
                rel = os.path.relpath(abs_path, abs_out)
                return {"filename": os.path.basename(rel),
                        "subfolder": os.path.dirname(rel),
                        "type": "output", "slot": slot, "label": label}
            return {"filename": os.path.basename(path), "subfolder": "",
                    "type": "output", "slot": slot, "label": label}

        return None

    def preview_videos(self, video_1="", video_2="", frames_1=None, frames_2=None,
                       audio_1=None, audio_2=None,
                       label_1="Before", label_2="After", fps=24.0, loop=True):
        results = []
        v1_result, v2_result = [None], [None]

        def enc1():
            v1_result[0] = self._resolve(video_1, frames_1, audio_1, label_1, 1, fps)
        def enc2():
            v2_result[0] = self._resolve(video_2, frames_2, audio_2, label_2, 2, fps)

        t1 = threading.Thread(target=enc1)
        t2 = threading.Thread(target=enc2)
        t1.start(); t2.start()
        t1.join();  t2.join()

        if v1_result[0]: results.append(v1_result[0])
        if v2_result[0]: results.append(v2_result[0])
        return {"ui": {"dual_videos": results, "loop": [loop]}}


NODE_CLASS_MAPPINGS        = {"DualVideoPreview": DualVideoPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"DualVideoPreview": "Dual Video Preview 🎬"}
