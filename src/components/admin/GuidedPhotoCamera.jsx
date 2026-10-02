// ─── GUIDED PHOTO CAMERA — a live camera with the pose drawn on it ───────────
// Owner spec 2026-10-02 (guided product photos). Modelled on LabelCamera in
// stock/TongueLabelReader.jsx — the same getUserMedia rear camera, the same
// stream teardown on unmount AND after the shot, the same "never a dead end"
// fallback to the file input — with two differences that are the whole point:
//
//   • an OUTLINE is drawn over the live picture (photoGuides.js owns the shapes
//     and the copy). It is an absolutely positioned SVG, non-interactive
//     (pointer-events: none — a tap on the picture must never be eaten by the
//     overlay), white at ~35% so it reads on a dark floor and a white wall, and
//     LETTERBOXED to the video's displayed rect: the video is object-fit:
//     contain, so on a phone the picture rarely fills its box, and an outline
//     placed on the box instead of the picture would put the "low-centre" shoe
//     on a black bar.
//   • ONE frame, not three. LabelCamera bursts because OCR noise averages out;
//     a product photo is one picture, taken at the camera's native resolution
//     (capped at 2400px — the AI source copy's ceiling) so nothing is thrown
//     away before the encode pipeline decides what to keep.
//
// The capture is handed over as a JPEG Blob, the SAME type a picked file is, so
// the consumer runs ONE pipeline for both (utils/productPhotoEncode.js).
//
// GuidedPhotoStep (below) is the form's card for one step: the instruction, a
// thumbnail once captured, "Take photo" (camera when there is a stream, the
// file input straight away when there is not) and the always-present "Choose
// from photos". Staff never type anything here.

import React, { useEffect, useRef, useState } from "react";
import { GUIDE_STROKE, containRect, placeOutline } from "./photoGuides.js";
import { drawScaled, SOURCE_PHOTO_MAX_DIM } from "../../utils/productPhotoEncode.js";

// MIRROR of cameraStreamAvailable in stock/TongueLabelReader.jsx. Copied rather
// than imported: that module pulls in firebase/functions and html5-qrcode at
// import time, and this one must stay mountable in a test without either.
export function cameraStreamAvailable() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === "function";
}

// The outline itself, in a frame of frameW×frameH user units.
export function GuideOutline({ step, frameW, frameH, strokeWidth = 2.5 }) {
  const { x, y, scale } = placeOutline(step, frameW, frameH);
  // Stroke width is divided by the scale so the line is the same weight on a
  // 320px phone and a 1200px tablet.
  const sw = strokeWidth / (scale || 1);
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill="none" stroke={GUIDE_STROKE}
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" data-guide={step.id}>
      <path d={step.shape.outline} />
      {step.shape.marks.map((d, i) => <path key={i} d={d} strokeDasharray={`${6 * sw} ${4 * sw}`} />)}
    </g>
  );
}

const ghostBtn = {
  background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.2)", borderRadius: 12,
  color: "rgba(255,255,255,.85)", fontSize: 13, fontWeight: 700, padding: "10px 16px", cursor: "pointer",
};

export default function GuidedPhotoCamera({ step, onCapture, onFallback, onClose }) {
  const boxRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(() => !cameraStreamAvailable());
  const [shooting, setShooting] = useState(false);
  // The video's displayed rect inside its box. null until measured — the
  // overlay then covers the whole box, which is still a usable guide.
  const [rect, setRect] = useState(null);

  const stopStream = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    // No camera stream API at all (an old WebView, an http origin): the flow is
    // NOT lost — the fallback button below opens the photo picker.
    if (!cameraStreamAvailable()) return undefined;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // play() returns a promise in every current browser, but not in an
          // older WebView — and a throw here would land in the catch below and
          // wrongly report "camera unavailable" over a working stream.
          const playing = typeof video.play === "function" ? video.play() : null;
          if (playing && typeof playing.catch === "function") playing.catch(() => {});
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; stopStream(); };
  }, []);

  // Re-measure the letterboxed rect whenever the video's size can have changed:
  // metadata arriving (the real aspect becomes known), the window resizing, a
  // phone rotating.
  useEffect(() => {
    if (error) return undefined;
    const measure = () => {
      const box = boxRef.current;
      const video = videoRef.current;
      if (!box || !video || !box.clientWidth) return;
      setRect(containRect(box.clientWidth, box.clientHeight, video.videoWidth, video.videoHeight));
    };
    const video = videoRef.current;
    if (video && video.addEventListener) video.addEventListener("loadedmetadata", measure);
    if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", measure);
    measure();
    return () => {
      if (video && video.removeEventListener) video.removeEventListener("loadedmetadata", measure);
      if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("resize", measure);
    };
  }, [error]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { stopStream(); onFallback(); return; }
    setShooting(true);
    let blob = null;
    try {
      const canvas = drawScaled(video, video.videoWidth, video.videoHeight, SOURCE_PHOTO_MAX_DIM);
      // High quality on purpose: this frame is re-encoded by the product photo
      // pipeline, and every generation of JPEG loss lands on the AI source copy.
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    } catch (err) {
      console.warn("guided photo capture failed:", err);
      blob = null;
    } finally {
      // Whatever happened, the camera is released and the button comes back.
      stopStream();
      setShooting(false);
    }
    if (blob) onCapture(blob);
    else onFallback();
  };

  const frameW = rect ? rect.width : 300;
  const frameH = rect ? rect.height : 400;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.96)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{step.title}</div>
        <button type="button" onClick={() => { stopStream(); onClose(); }} style={ghostBtn}>Close</button>
      </div>
      {error ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ textAlign: "center", maxWidth: 320 }}>
            <div style={{ color: "#FF9B9B", fontSize: 14, lineHeight: 1.5, marginBottom: 10 }}>
              Camera unavailable on this device — choose the photo instead.
            </div>
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
              {step.instruction}
            </div>
            <button type="button" onClick={onFallback}
              style={{ background: "rgba(74,127,255,.2)", border: "2px solid rgba(74,127,255,.6)", borderRadius: 12,
                       color: "#D7E3FF", minHeight: 50, padding: "0 20px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
              Choose from photos
            </button>
          </div>
        </div>
      ) : (
        <>
          <div ref={boxRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <video ref={videoRef} playsInline muted
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
            <svg aria-hidden="true" data-testid="photo-guide-overlay"
              viewBox={`0 0 ${frameW} ${frameH}`} preserveAspectRatio="none"
              style={{ position: "absolute", pointerEvents: "none",
                       left: rect ? rect.left : 0, top: rect ? rect.top : 0,
                       width: rect ? rect.width : "100%", height: rect ? rect.height : "100%" }}>
              <GuideOutline step={step} frameW={frameW} frameH={frameH} />
            </svg>
          </div>
          <div style={{ padding: "14px 18px 30px" }}>
            <div style={{ color: "rgba(255,255,255,.75)", fontSize: 13.5, fontWeight: 600, textAlign: "center", marginBottom: 12 }}>
              {step.instruction}
            </div>
            <button type="button" onClick={shoot} disabled={shooting}
              style={{ width: "100%", minHeight: 62, borderRadius: 15, fontSize: 17, fontWeight: 800, cursor: "pointer",
                       background: "rgba(74,127,255,.2)", border: "2px solid rgba(74,127,255,.6)", color: "#D7E3FF",
                       opacity: shooting ? 0.6 : 1 }}>
              {shooting ? "Taking photo…" : "◉ Take photo"}
            </button>
            <button type="button" onClick={() => { stopStream(); onFallback(); }}
              style={{ ...ghostBtn, width: "100%", marginTop: 10, minHeight: 44 }}>
              Choose from photos
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── ONE STEP'S CARD ON THE NEW PRODUCT FORM ────────────────────────────────
export function GuidedPhotoStep({ step, filled, previewUrl, onFile, invalid, disabled }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef(null);
  const pick = () => { if (fileRef.current) fileRef.current.click(); };
  const take = () => { if (cameraStreamAvailable()) setCameraOpen(true); else pick(); };
  const borderColor = invalid ? "#F87171" : filled ? "rgba(74,222,128,.55)" : "rgba(60,110,255,.28)";

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "stretch", background: "rgba(60,110,255,.05)",
                  border: `2px ${filled ? "solid" : "dashed"} ${borderColor}`, borderRadius: 12, padding: 12 }}>
      <div style={{ width: 72, height: 72, flexShrink: 0, borderRadius: 10, overflow: "hidden",
                    background: "rgba(255,255,255,.04)", border: "1px solid rgba(60,110,255,.2)" }}>
        {previewUrl
          ? <img src={previewUrl} alt={step.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : (
            <svg viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
              <GuideOutline step={step} frameW={72} frameH={72} strokeWidth={1.5} />
            </svg>
          )}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{step.title}</span>
          {filled && <span style={{ fontSize: 11, fontWeight: 800, color: "#4ADE80" }}>✓ TAKEN</span>}
          {!filled && step.required && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", color: "#F87171" }}>REQUIRED</span>}
        </div>
        <div style={{ fontSize: 12, color: "rgba(233,238,255,.55)", lineHeight: 1.4 }}>{step.instruction}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <button type="button" onClick={take} disabled={disabled}
            style={{ background: "rgba(74,127,255,.18)", border: "1px solid rgba(74,127,255,.55)", borderRadius: 10,
                     color: "#D7E3FF", fontSize: 13, fontWeight: 800, padding: "9px 14px", minHeight: 40, cursor: "pointer" }}>
            {filled ? "Retake" : `Take ${step.title.toLowerCase()}`}
          </button>
          <button type="button" onClick={pick} disabled={disabled}
            style={{ background: "transparent", border: "1px solid rgba(255,255,255,.16)", borderRadius: 10,
                     color: "rgba(233,238,255,.65)", fontSize: 12.5, fontWeight: 700, padding: "9px 12px", minHeight: 40, cursor: "pointer" }}>
            Choose from photos
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = ""; // the same file picked twice must still fire
          if (file) onFile(file);
        }} />
      {cameraOpen && (
        <GuidedPhotoCamera
          step={step}
          onCapture={(blob) => { setCameraOpen(false); onFile(blob); }}
          onFallback={() => { setCameraOpen(false); pick(); }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
