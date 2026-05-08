/**
 * DualVideoPreview – ComfyUI frontend
 * - Drag-to-compare slider
 * - Seekable frames timeline with tick marks + playhead
 * - Controls bar + timeline always locked to the bottom; never disappear on resize
 * - Audio controls with per-side mute logic
 */

import { app } from "/scripts/app.js";

function viewUrl(filename, subfolder = "", type = "output") {
  return `/view?${new URLSearchParams({ filename, subfolder, type })}&t=${Date.now()}`;
}

function buildSliderWidget(videoDataArray, loop, onSizeReady) {
  const [v1, v2] = [videoDataArray[0] ?? null, videoDataArray[1] ?? null];

  // ── Root ──────────────────────────────────────────────────────────────────
  // height:100% fills the container that ComfyUI owns — flex column means
  // stage grows freely and chrome stays fixed at the bottom.
  const root = document.createElement("div");
  Object.assign(root.style, {
    width:         "100%",
    height:        "100%",
    display:       "flex",
    flexDirection: "column",
    userSelect:    "none",
    background:    "#0d0d0d",
    borderRadius:  "6px",
    overflow:      "hidden",
    fontFamily:    "monospace",
    boxSizing:     "border-box",
  });

  // ── Stage ─────────────────────────────────────────────────────────────────
  // flex: 1 1 0 + minHeight: 0  →  shrinks freely without enforcing any
  // content-based minimum. The video inside uses objectFit:contain so it
  // letterboxes gracefully at any stage size.
  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position:  "relative",
    width:     "100%",
    flex:      "1 1 0",
    minHeight: "0",
    background:"#111",
    overflow:  "hidden",
    cursor:    "col-resize",
  });
  root.appendChild(stage);

  // ── Videos ────────────────────────────────────────────────────────────────
  function makeVideo(vd, clipped) {
    if (!vd) return null;
    const el = document.createElement("video");
    el.src         = viewUrl(vd.filename, vd.subfolder, vd.type);
    el.loop        = loop;
    el.muted       = true;
    el.autoplay    = true;
    el.playsInline = true;
    Object.assign(el.style, {
      position: "absolute", top: "0", left: "0",
      width: "100%", height: "100%",
      objectFit: "contain", display: "block", pointerEvents: "none",
    });
    if (clipped) el.style.clipPath = "inset(0 50% 0 0)";
    return el;
  }

  const layerBottom = makeVideo(v2, false);  // After  – bottom, full
  const layerTop    = makeVideo(v1, true);   // Before – top, clipped

  if (layerBottom) stage.appendChild(layerBottom);
  if (layerTop)    stage.appendChild(layerTop);

  // Sync playback
  function syncVideos(master, slave) {
    if (!slave) return;
    master.addEventListener("play",   () => { slave.currentTime = master.currentTime; slave.play().catch(() => {}); });
    master.addEventListener("pause",  () => { slave.pause(); slave.currentTime = master.currentTime; });
    master.addEventListener("seeked", () => { slave.currentTime = master.currentTime; });
  }
  if (layerBottom && layerTop) syncVideos(layerBottom, layerTop);

  // Notify extension of video natural size so it can set the initial node height
  const anyVideo = layerBottom || layerTop;
  if (anyVideo) {
    anyVideo.addEventListener("loadedmetadata", () => {
      onSizeReady && onSizeReady(anyVideo.videoWidth, anyVideo.videoHeight);
    }, { once: true });
  }

  // ── Divider line ──────────────────────────────────────────────────────────
  const line = document.createElement("div");
  Object.assign(line.style, {
    position: "absolute", top: "0", bottom: "0", left: "50%",
    width: "2px", background: "rgba(255,255,255,0.9)",
    transform: "translateX(-50%)", pointerEvents: "none",
    zIndex: "10", boxShadow: "0 0 8px rgba(0,0,0,0.7)",
  });
  stage.appendChild(line);

  // ── Handle ────────────────────────────────────────────────────────────────
  const handle = document.createElement("div");
  Object.assign(handle.style, {
    position: "absolute", top: "50%", left: "50%",
    transform: "translate(-50%, -50%)",
    width: "36px", height: "36px", borderRadius: "50%",
    background: "rgba(255,255,255,0.97)", border: "2px solid rgba(0,0,0,0.2)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: "11", boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
    fontSize: "14px", color: "#333", pointerEvents: "none",
  });
  handle.textContent = "⇔";
  stage.appendChild(handle);

  // ── Compare-slider drag ───────────────────────────────────────────────────
  let dragging  = false;
  let sliderPct = 0.5;

  function applySlider(clientX) {
    const rect = stage.getBoundingClientRect();
    sliderPct = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    const p = (sliderPct * 100).toFixed(2) + "%";
    line.style.left   = p;
    handle.style.left = p;
    if (layerTop) layerTop.style.clipPath = `inset(0 ${((1 - sliderPct) * 100).toFixed(2)}% 0 0)`;
  }

  stage.addEventListener("mousedown", e => {
    dragging = true;
    handle.style.transform = "translate(-50%, -50%) scale(1.18)";
    applySlider(e.clientX); e.preventDefault();
  });
  window.addEventListener("mousemove", e => { if (dragging) applySlider(e.clientX); });
  window.addEventListener("mouseup",   () => {
    if (!dragging) return;
    dragging = false;
    handle.style.transform = "translate(-50%, -50%) scale(1)";
  });
  stage.addEventListener("touchstart", e => {
    dragging = true; applySlider(e.touches[0].clientX); e.preventDefault();
  }, { passive: false });
  window.addEventListener("touchmove", e => { if (dragging) applySlider(e.touches[0].clientX); });
  window.addEventListener("touchend",  () => { dragging = false; });

  // ── Labels ────────────────────────────────────────────────────────────────
  function makeLabel(text, side, color) {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute", top: "8px", [side]: "10px",
      background: "rgba(0,0,0,0.65)", color, fontSize: "10px",
      letterSpacing: "0.1em", textTransform: "uppercase",
      padding: "3px 8px", borderRadius: "3px", zIndex: "12",
      pointerEvents: "none", border: `1px solid ${color}55`,
    });
    el.textContent = text;
    return el;
  }
  if (v1) stage.appendChild(makeLabel(v1.label, "left",  "#4af"));
  if (v2) stage.appendChild(makeLabel(v2.label, "right", "#fa4"));

  // ── Bottom chrome ─────────────────────────────────────────────────────────
  // flex: 0 0 auto — fixed, never shrinks, always at the bottom of the flex column
  const chrome = document.createElement("div");
  Object.assign(chrome.style, {
    flex:          "0 0 auto",
    display:       "flex",
    flexDirection: "column",
    background:    "#0d0d0d",
    borderTop:     "1px solid #1a1a1a",
  });
  root.appendChild(chrome);

  // ── Timeline ──────────────────────────────────────────────────────────────
  const tlWrap = document.createElement("div");
  Object.assign(tlWrap.style, {
    position:     "relative",
    width:        "100%",
    height:       "36px",
    flexShrink:   "0",
    background:   "#111",
    cursor:       "pointer",
    boxSizing:    "border-box",
    borderBottom: "1px solid #1a1a1a",
    overflow:     "hidden",
  });
  chrome.appendChild(tlWrap);

  // Progress fill
  const tlFill = document.createElement("div");
  Object.assign(tlFill.style, {
    position: "absolute", left: "0", top: "0", bottom: "0",
    width: "0%",
    background: "linear-gradient(90deg, #1a3a5c 0%, #2a6096 100%)",
    pointerEvents: "none", zIndex: "1",
  });
  tlWrap.appendChild(tlFill);

  // Tick canvas
  const tickCanvas = document.createElement("canvas");
  tickCanvas.height = 36;
  Object.assign(tickCanvas.style, {
    position: "absolute", left: "0", top: "0",
    width: "100%", height: "100%",
    pointerEvents: "none", zIndex: "2",
  });
  tlWrap.appendChild(tickCanvas);

  // Needle
  const needle = document.createElement("div");
  Object.assign(needle.style, {
    position: "absolute", top: "0", bottom: "0", left: "0%",
    width: "2px", background: "#4af",
    transform: "translateX(-50%)", pointerEvents: "none",
    zIndex: "4", boxShadow: "0 0 4px #4af8",
  });
  tlWrap.appendChild(needle);

  // Diamond knob
  const knob = document.createElement("div");
  Object.assign(knob.style, {
    position: "absolute", top: "50%", left: "0%",
    transform: "translate(-50%, -50%) rotate(45deg)",
    width: "8px", height: "8px",
    background: "#4af", pointerEvents: "none",
    zIndex: "5", boxShadow: "0 0 6px #4af",
  });
  tlWrap.appendChild(knob);

  // Frame counter badge
  const frameLabel = document.createElement("div");
  Object.assign(frameLabel.style, {
    position: "absolute", right: "6px", top: "50%",
    transform: "translateY(-50%)",
    fontSize: "9px", color: "#778",
    fontVariantNumeric: "tabular-nums",
    pointerEvents: "none", zIndex: "6",
    background: "#111d", padding: "1px 4px", borderRadius: "3px",
  });
  frameLabel.textContent = "f 0 / —";
  tlWrap.appendChild(frameLabel);

  let _fps = 24, _duration = 0, _totalFrames = 0;

  function drawTicks(width) {
    tickCanvas.width = Math.max(1, Math.round(width));
    const ctx = tickCanvas.getContext("2d");
    ctx.clearRect(0, 0, tickCanvas.width, 36);
    if (!_duration || width < 10) return;

    const pxPerSec   = width / _duration;
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const interval   = candidates.find(c => c * pxPerSec >= 50) ?? 300;
    const minor      = interval / 5;

    ctx.font      = "8px monospace";
    ctx.textAlign = "center";

    for (let t = 0; t <= _duration + minor * 0.5; t += minor) {
      const x       = (t / _duration) * width;
      const isMajor = (Math.round(t / minor) % 5) === 0;
      ctx.globalAlpha = isMajor ? 0.45 : 0.18;
      ctx.strokeStyle = "#8af";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 4 : 20);
      ctx.lineTo(x, 36);
      ctx.stroke();
      if (isMajor && t > minor * 0.5) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle   = "#6af";
        const mins = Math.floor(t / 60), secs = Math.floor(t % 60);
        ctx.fillText(`${mins}:${String(secs).padStart(2, "0")}`, x, 13);
      }
    }
  }

  const tlResizeObs = new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    if (w > 0) drawTicks(w);
  });
  tlResizeObs.observe(tlWrap);

  function updateTimeline(t) {
    if (!_duration) return;
    const pct    = Math.min(t / _duration, 1);
    const pctStr = (pct * 100).toFixed(3) + "%";
    tlFill.style.width = pctStr;
    needle.style.left  = pctStr;
    knob.style.left    = pctStr;
    frameLabel.textContent = `f ${Math.round(t * _fps)} / ${_totalFrames}`;
  }

  // Timeline seek drag
  let tlDragging = false;
  function seekFromEvent(clientX) {
    const rect = tlWrap.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    allVideos.forEach(v => { v.currentTime = pct * _duration; });
    updateTimeline(pct * _duration);
  }

  tlWrap.addEventListener("mousedown", e => {
    tlDragging = true; seekFromEvent(e.clientX); e.stopPropagation(); e.preventDefault();
  });
  window.addEventListener("mousemove", e => { if (tlDragging) seekFromEvent(e.clientX); });
  window.addEventListener("mouseup",   () => { tlDragging = false; });
  tlWrap.addEventListener("touchstart", e => {
    tlDragging = true; seekFromEvent(e.touches[0].clientX); e.stopPropagation(); e.preventDefault();
  }, { passive: false });
  window.addEventListener("touchmove",  e => { if (tlDragging) seekFromEvent(e.touches[0].clientX); });
  window.addEventListener("touchend",   () => { tlDragging = false; });

  // ── Controls bar ──────────────────────────────────────────────────────────
  const allVideos = [layerBottom, layerTop].filter(Boolean);
  let playing     = true;
  let globalMuted = true;

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex", alignItems: "center", gap: "6px",
    padding: "5px 10px", flexShrink: "0",
    background: "#111", borderBottom: "1px solid #1a1a1a",
    boxSizing: "border-box", width: "100%",
  });
  chrome.appendChild(bar);

  function btn(icon, title) {
    const b = document.createElement("button");
    b.textContent = icon; b.title = title;
    Object.assign(b.style, {
      background: "#1e1e1e", color: "#ccc", border: "1px solid #2e2e2e",
      borderRadius: "5px", cursor: "pointer", fontSize: "14px",
      padding: "4px 10px", lineHeight: "1.5", transition: "background 0.1s",
      flexShrink: "0",
    });
    b.onmouseenter = () => { b.style.background = "#2a2a2a"; };
    b.onmouseleave = () => { b.style.background = "#1e1e1e"; };
    return b;
  }

  const ppBtn = btn("⏸", "Play / Pause");
  ppBtn.onclick = () => {
    playing = !playing;
    ppBtn.textContent = playing ? "⏸" : "▶";
    allVideos.forEach(v => playing ? v.play().catch(() => {}) : v.pause());
  };

  const rstBtn = btn("⟳", "Restart");
  rstBtn.onclick = () => {
    playing = true; ppBtn.textContent = "⏸";
    allVideos.forEach(v => { v.currentTime = 0; v.play().catch(() => {}); });
  };

  const mutBtn = btn("🔇", "Toggle audio");
  mutBtn.onclick = () => {
    globalMuted = !globalMuted;
    mutBtn.textContent = globalMuted ? "🔇" : "🔊";
    mutBtn.style.color = globalMuted ? "#ccc" : "#4af";
    if (globalMuted) {
      allVideos.forEach(v => { v.muted = true; });
    } else {
      if (layerBottom) layerBottom.muted = sliderPct >= 0.5;
      if (layerTop)    layerTop.muted    = sliderPct <  0.5;
    }
  };

  const volSlider = document.createElement("input");
  volSlider.type = "range"; volSlider.min = "0"; volSlider.max = "1";
  volSlider.step = "0.02"; volSlider.value = "1";
  Object.assign(volSlider.style, { width: "64px", accentColor: "#4af", cursor: "pointer", flexShrink: "0" });
  volSlider.oninput = () => { const v = parseFloat(volSlider.value); allVideos.forEach(el => { el.volume = v; }); };

  const time = document.createElement("span");
  Object.assign(time.style, {
    marginLeft: "auto", fontSize: "9px", color: "#555",
    fontVariantNumeric: "tabular-nums", flexShrink: "0",
  });
  const fmt = s => isFinite(s)
    ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`
    : "0:00.0";

  bar.append(ppBtn, rstBtn, mutBtn, volSlider, time);

  // ── Hint ──────────────────────────────────────────────────────────────────
  const hint = document.createElement("div");
  Object.assign(hint.style, {
    textAlign: "center", fontSize: "9px", color: "#333",
    padding: "2px 0", background: "#0d0d0d",
    letterSpacing: "0.08em", flexShrink: "0",
  });
  hint.textContent = "drag ⇔ to compare  •  click timeline to seek  •  🔇 to enable audio";
  chrome.appendChild(hint);

  // ── Master video wiring ───────────────────────────────────────────────────
  const master = layerBottom || layerTop;
  if (master) {
    master.addEventListener("loadedmetadata", () => {
      _duration    = master.duration;
      _fps         = (typeof root._dvpFps === "number" && root._dvpFps > 0) ? root._dvpFps : 24;
      _totalFrames = Math.round(_duration * _fps);
      drawTicks(tlWrap.offsetWidth || 400);
      updateTimeline(0);
    });
    master.ontimeupdate = () => {
      time.textContent = `${fmt(master.currentTime)} / ${fmt(master.duration)}`;
      if (!tlDragging) updateTimeline(master.currentTime);
    };
    master.addEventListener("seeked", () => { updateTimeline(master.currentTime); });
    master.addEventListener("ended",  () => { if (!loop) updateTimeline(master.duration); });
  }

  return root;
}

// ── Extension ─────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "DualVideoPreview",

  async nodeCreated(node) {
    if (node.comfyClass !== "DualVideoPreview") return;

    // Create the container once and add it as a DOM widget.
    // No computeSize override — ComfyUI owns the height entirely.
    // The container uses height:100% so the inner flex column fills it exactly.
    const container = document.createElement("div");
    Object.assign(container.style, {
      width:    "100%",
      height:   "100%",
      overflow: "hidden",
      boxSizing: "border-box",
    });
    node.addDOMWidget("dvp_ui", "preview", container);

    node.onExecuted = function(output) {
      const videos = output?.dual_videos;
      const loop   = output?.loop?.[0] ?? true;
      if (!videos?.length) return;

      const fpsWidget = this.widgets?.find(w => w.name === "fps");
      const widget    = buildSliderWidget(videos, loop, null);
      if (fpsWidget) widget._dvpFps = parseFloat(fpsWidget.value) || 24;

      container.innerHTML = "";
      container.appendChild(widget);
    };
  },
});
