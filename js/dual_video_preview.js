/**
 * DualVideoPreview – ComfyUI frontend
 * Based on the known-working version, with audio controls added minimally.
 */

import { app } from "/scripts/app.js";

function viewUrl(filename, subfolder = "", type = "output") {
  return `/view?${new URLSearchParams({ filename, subfolder, type })}&t=${Date.now()}`;
}

function buildSliderWidget(videoDataArray, loop, onSizeReady) {
  const [v1, v2] = [videoDataArray[0] ?? null, videoDataArray[1] ?? null];

  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "relative", width: "100%", userSelect: "none",
    background: "#0d0d0d", borderRadius: "6px", overflow: "hidden",
    fontFamily: "monospace", boxSizing: "border-box",
  });

  // ── Stage ─────────────────────────────────────────────────────────────────
  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position: "relative", width: "100%",
    background: "#111", overflow: "hidden", cursor: "col-resize",
  });
  root.appendChild(stage);

  function makeVideo(vd, clipped) {
    if (!vd) return null;
    const el = document.createElement("video");
    el.src = viewUrl(vd.filename, vd.subfolder, vd.type);
    el.loop = loop;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    Object.assign(el.style, {
      position: "absolute", top: "0", left: "0",
      width: "100%", height: "100%",
      objectFit: "contain", display: "block", pointerEvents: "none",
    });
    if (clipped) el.style.clipPath = "inset(0 50% 0 0)";
    return el;
  }

  // v2 (After)  → bottom layer, always fully visible
  // v1 (Before) → top layer, clipped to left portion
  const layerBottom = makeVideo(v2, false);
  const layerTop    = makeVideo(v1, true);

  if (layerBottom) stage.appendChild(layerBottom);
  if (layerTop)    stage.appendChild(layerTop);

  // Sync both videos: when one is seeked / played / paused, mirror to the other
  function syncVideos(master, slave) {
    if (!slave) return;
    master.addEventListener("play",   () => { slave.currentTime = master.currentTime; slave.play().catch(() => {}); });
    master.addEventListener("pause",  () => { slave.pause(); slave.currentTime = master.currentTime; });
    master.addEventListener("seeked", () => { slave.currentTime = master.currentTime; });
  }
  if (layerBottom && layerTop) syncVideos(layerBottom, layerTop);

  // Aspect ratio from first video that loads metadata
  const anyVideo = layerBottom || layerTop;
  if (anyVideo) {
    stage.style.aspectRatio = "16 / 9"; // provisional so stage has height immediately
    anyVideo.addEventListener("loadedmetadata", () => {
      const w = anyVideo.videoWidth, h = anyVideo.videoHeight;
      if (w && h) stage.style.aspectRatio = `${w} / ${h}`;
      onSizeReady && onSizeReady();
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

  // ── Drag ──────────────────────────────────────────────────────────────────
  let dragging = false;
  let sliderPct = 0.5;

  function applySlider(clientX) {
    const rect = stage.getBoundingClientRect();
    sliderPct = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    const p = (sliderPct * 100).toFixed(2) + "%";
    line.style.left = p;
    handle.style.left = p;
    if (layerTop) layerTop.style.clipPath = `inset(0 ${((1 - sliderPct) * 100).toFixed(2)}% 0 0)`;
  }

  stage.addEventListener("mousedown", e => {
    dragging = true;
    handle.style.transform = "translate(-50%, -50%) scale(1.18)";
    applySlider(e.clientX); e.preventDefault();
  });
  window.addEventListener("mousemove", e => { if (dragging) applySlider(e.clientX); });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.style.transform = "translate(-50%, -50%) scale(1)";
  });
  stage.addEventListener("touchstart", e => {
    dragging = true; applySlider(e.touches[0].clientX); e.preventDefault();
  }, { passive: false });
  window.addEventListener("touchmove", e => { if (dragging) applySlider(e.touches[0].clientX); });
  window.addEventListener("touchend", () => { dragging = false; });

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

  // ── Controls bar ──────────────────────────────────────────────────────────
  const allVideos = [layerBottom, layerTop].filter(Boolean);
  let playing = true;
  let globalMuted = true;

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex", alignItems: "center", gap: "6px",
    padding: "6px 10px", background: "#111", borderTop: "1px solid #222",
    boxSizing: "border-box", width: "100%",
  });

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

  // Play / Pause — drives layerBottom as master; syncVideos handles layerTop
  const ppBtn = btn("⏸", "Play / Pause");
  ppBtn.onclick = () => {
    playing = !playing;
    ppBtn.textContent = playing ? "⏸" : "▶";
    allVideos.forEach(v => playing ? v.play().catch(() => {}) : v.pause());
  };

  // Restart
  const rstBtn = btn("⟳", "Restart");
  rstBtn.onclick = () => {
    playing = true;
    ppBtn.textContent = "⏸";
    allVideos.forEach(v => { v.currentTime = 0; v.play().catch(() => {}); });
  };

  // Mute / Unmute
  // IMPORTANT: clicking this button IS the user gesture that browsers require
  // before they allow audio to play. Setting muted=false anywhere else won't work.
  const mutBtn = btn("🔇", "Toggle audio");
  mutBtn.onclick = () => {
    globalMuted = !globalMuted;
    mutBtn.textContent = globalMuted ? "🔇" : "🔊";
    mutBtn.style.color  = globalMuted ? "#ccc" : "#4af";
    // Apply muted directly here — inside a click handler = trusted user gesture
    if (globalMuted) {
      allVideos.forEach(v => { v.muted = true; });
    } else {
      // Only unmute the dominant side; the other stays muted
      if (layerBottom) layerBottom.muted = sliderPct >= 0.5; // After  side
      if (layerTop)    layerTop.muted    = sliderPct <  0.5; // Before side
    }
  };

  // Volume slider
  const volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = "0"; volSlider.max = "1"; volSlider.step = "0.02"; volSlider.value = "1";
  Object.assign(volSlider.style, {
    width: "64px", accentColor: "#4af", cursor: "pointer", flexShrink: "0",
  });
  volSlider.oninput = () => {
    const vol = parseFloat(volSlider.value);
    allVideos.forEach(v => { v.volume = vol; });
  };

  // Timecode from the bottom (master) video
  const time = document.createElement("span");
  Object.assign(time.style, {
    marginLeft: "auto", fontSize: "9px", color: "#555",
    fontVariantNumeric: "tabular-nums", flexShrink: "0",
  });
  const fmt = s => isFinite(s)
    ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`
    : "0:00.0";
  if (layerBottom) {
    layerBottom.ontimeupdate = () => {
      time.textContent = `${fmt(layerBottom.currentTime)} / ${fmt(layerBottom.duration)}`;
    };
  }

  bar.append(ppBtn, rstBtn, mutBtn, volSlider, time);
  root.appendChild(bar);

  // ── Hint ──────────────────────────────────────────────────────────────────
  const hint = document.createElement("div");
  Object.assign(hint.style, {
    textAlign: "center", fontSize: "9px", color: "#444",
    padding: "3px", background: "#0d0d0d", letterSpacing: "0.08em",
  });
  hint.textContent = "drag ⇔ to compare  •  click 🔇 to enable audio";
  root.appendChild(hint);

  return root;
}

// ── Extension ─────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "DualVideoPreview",

  async nodeCreated(node) {
    if (node.comfyClass !== "DualVideoPreview") return;

    node.onExecuted = function(output) {
      const videos = output?.dual_videos;
      const loop   = output?.loop?.[0] ?? true;
      if (!videos?.length) return;

      const self = this;

      let domWidget = self.widgets?.find(w => w.name === "dvp_ui");
      if (!domWidget) {
        const container = document.createElement("div");
        Object.assign(container.style, { width: "100%", overflow: "hidden" });
        domWidget = self.addDOMWidget("dvp_ui", "preview", container, {
          getValue() { return null; },
          setValue() {},
          computeSize(width) {
            const el = this.element?.firstChild;
            return [width, el ? el.offsetHeight : 300];
          },
        });
      }

      function fitNode() {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const inner = domWidget.element?.firstChild;
          if (!inner) return;
          let overhead = self.titleHeight ?? 30;
          if (self.widgets) {
            for (const w of self.widgets) {
              if (w === domWidget) break;
              overhead += (w.computeSize ? w.computeSize(self.size[0])[1] : 20) + 4;
            }
          }
          self.setSize([Math.max(self.size[0], 460), overhead + inner.offsetHeight + 12]);
          app.graph?.setDirtyCanvas(true, false);
        }));
      }

      const widget = buildSliderWidget(videos, loop, fitNode);
      domWidget.element.innerHTML = "";
      domWidget.element.appendChild(widget);
      fitNode();
    };
  },
});
