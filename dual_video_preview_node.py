"""
DualVideoPreview – ComfyUI custom node
Fast MP4 encoding matching VHS performance:
- Raw frames piped directly to ffmpeg
- H.264 GPU encoding
- Optional AUDIO inputs muxed as AAC into the MP4
"""

import os
import hashlib
import subprocess
import threading
import wave
import numpy as np
import torch
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
HAS_H264_NVENC = "h264_nvenc" in _CODEC_LIST
HAS_H264_AMF = "h264_amf" in _CODEC_LIST
HAS_H264_QSV = "h264_qsv" in _CODEC_LIST


def _send_progress(node_id, slot, value, max_value, text):
    if node_id is None:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("dvp_progress", {
            "node": str(node_id), "slot": slot, "value": value,
            "max": max_value, "text": text,
        })
    except Exception:
        pass


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


def _frames_to_mp4(frames_tensor, fps: float, audio_dict=None, uid_extra: str = "", node_id=None, slot=1, preview_size=1280) -> str:
    """
    Convert (B, H, W, C) float32 tensor → H.264 MP4.
    Optionally muxes audio from a ComfyUI AUDIO dict.
    Pipes raw frames to ffmpeg and uses NVENC when available.
    Returns filename relative to output_dir.
    """
    import tempfile

    B, H, W, C = frames_tensor.shape
    _send_progress(node_id, slot, 0, B, f"Video {slot}: preparing {B} frames")

    # Cache key: hash actual pixel content (first + mid + last frame) so that
    # new frames with the same shape/fps always produce a different filename.
    audio_sig = str(audio_dict["waveform"].shape) if audio_dict else "noaudio"
    hasher = hashlib.md5()
    for fi in [0, B // 2, B - 1]:
        sample = frames_tensor[fi].clamp(0.0, 1.0).mul(255).to(dtype=torch.uint8).cpu().numpy()
        hasher.update(sample.tobytes())
    hasher.update((str(fps) + uid_extra + audio_sig + str(preview_size)).encode())
    uid = hasher.hexdigest()[:12]
    filename = f"dvp_{uid}.mp4"
    filepath = os.path.join(output_dir, filename)

    if os.path.exists(filepath):
        _send_progress(node_id, slot, B, B, f"Video {slot}: cached")
        return filename  # cached – skip encoding

    # Even dimensions required by codecs
    W_enc = W - (W % 2)
    H_enc = H - (H % 2)
    preview_scale = min(1.0, preview_size / max(W_enc, H_enc))
    W_preview = max(2, round(W_enc * preview_scale) // 2 * 2)
    H_preview = max(2, round(H_enc * preview_scale) // 2 * 2)

    pixel_formats = {1: "gray", 3: "rgb24", 4: "rgba"}
    if C not in pixel_formats:
        raise RuntimeError(f"[DualVideoPreview] Unsupported frame channel count: {C}")

    with tempfile.TemporaryDirectory(prefix="dvp_") as tmpdir:
        # --- Write audio WAV if provided --------------------------------------
        audio_path = None
        if audio_dict is not None:
            try:
                audio_path = os.path.join(tmpdir, "audio.wav")
                _write_audio_wav(audio_dict, audio_path)
            except Exception as e:
                print(f"[DualVideoPreview] Audio write failed, encoding without audio: {e}")
                audio_path = None

        encoders = []
        if HAS_H264_NVENC:
            encoders.append(("h264_nvenc", ["-preset", "p1", "-tune", "ll", "-rc:v", "vbr", "-cq:v", "23", "-b:v", "0"]))
        if HAS_H264_AMF:
            encoders.append(("h264_amf", ["-quality", "balanced", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21"]))
        if HAS_H264_QSV:
            encoders.append(("h264_qsv", ["-preset", "medium", "-global_quality", "19", "-look_ahead", "1"]))
        if not encoders:
            raise RuntimeError("[DualVideoPreview] No GPU video encoder found (NVENC, AMF or QSV required)")

        last_error = ""
        for vcodec, codec_args in encoders:
            encoder_label = f"GPU {vcodec}"
            _send_progress(node_id, slot, 0, B, f"Video {slot}: encoding with {encoder_label}")
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", pixel_formats[C],
                "-s:v", f"{W_enc}x{H_enc}", "-r", str(fps), "-i", "-",
            ]
            if audio_path:
                cmd += ["-i", audio_path]
            if vcodec == "h264_nvenc":
                cmd += ["-vf", f"format=nv12,hwupload_cuda,scale_cuda={W_preview}:{H_preview}"]
            elif (W_preview, H_preview) != (W_enc, H_enc):
                cmd += ["-vf", f"scale={W_preview}:{H_preview}:flags=fast_bilinear"]
            cmd += ["-vcodec", vcodec, *codec_args]
            if vcodec != "h264_nvenc":
                cmd += ["-pix_fmt", "yuv420p"]
            cmd += ["-movflags", "+faststart"]
            if audio_path:
                cmd += ["-acodec", "aac", "-b:a", "192k", "-t", str(B / fps), "-map", "0:v:0", "-map", "1:a:0"]
            else:
                cmd += ["-an"]
            cmd.append(filepath)

            popen_args = {"stdin": subprocess.PIPE, "stderr": subprocess.PIPE, "bufsize": 0}
            if os.name == "nt":
                popen_args["creationflags"] = 0x08000000
            process = subprocess.Popen(cmd, **popen_args)
            try:
                progress_step = max(1, B // 100)
                for index in range(1, B + 1):
                    frame = frames_tensor[index - 1, :H_enc, :W_enc, :]
                    frame = frame.clamp(0.0, 1.0).mul(255).to(dtype=torch.uint8)
                    process.stdin.write(frame.contiguous().cpu().numpy().tobytes())
                    if index == B or index % progress_step == 0:
                        _send_progress(node_id, slot, index, B, f"Video {slot}: {index}/{B} [{encoder_label}]")
                process.stdin.close()
            except BrokenPipeError:
                pass
            last_error = process.stderr.read().decode(errors="replace")
            returncode = process.wait()
            if returncode == 0:
                _send_progress(node_id, slot, B, B, f"Video {slot}: ready [{encoder_label}]")
                break
            print(f"[DualVideoPreview] {vcodec} unavailable, trying next GPU encoder")
        else:
            raise RuntimeError(f"[DualVideoPreview] ffmpeg failed:\n{last_error}")

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
                "preview_size": ("INT", {"default": 1280, "min": 256, "max": 3840, "step": 64, "tooltip": "Maximum preview dimension. Lower values improve playback performance."}),
                "loop":     ("BOOLEAN",{"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview_videos"
    OUTPUT_NODE = True
    CATEGORY = "image/video"
    DESCRIPTION = "Preview two videos with a drag-to-compare slider. Encodes frames as GPU-accelerated H.264 MP4 with optional audio."

    def _resolve(self, path, frames, audio, label, slot, fps, preview_size, unique_id):
        if frames is not None:
            filename = _frames_to_mp4(frames, fps, audio_dict=audio, uid_extra=label + str(slot), node_id=unique_id, slot=slot, preview_size=preview_size)
            return {"filename": filename, "subfolder": "", "type": "output",
                    "slot": slot, "label": label}

        if path and os.path.isfile(path):
            _send_progress(unique_id, slot, 1, 1, f"Video {slot}: ready")
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
                       label_1="Before", label_2="After", fps=24.0, preview_size=1280, loop=True, unique_id=None):
        results = []
        v1_result, v2_result = [None], [None]
        errors = []

        def enc1():
            try:
                v1_result[0] = self._resolve(video_1, frames_1, audio_1, label_1, 1, fps, preview_size, unique_id)
            except Exception as e:
                errors.append(e)
        def enc2():
            try:
                v2_result[0] = self._resolve(video_2, frames_2, audio_2, label_2, 2, fps, preview_size, unique_id)
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=enc1)
        t2 = threading.Thread(target=enc2)
        t1.start(); t2.start()
        t1.join();  t2.join()

        if errors:
            raise errors[0]

        if v1_result[0]: results.append(v1_result[0])
        if v2_result[0]: results.append(v2_result[0])
        return {"ui": {"dual_videos": results, "loop": [loop]}}


NODE_CLASS_MAPPINGS        = {"DualVideoPreview": DualVideoPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"DualVideoPreview": "Dual Video Compare 🎬"}
