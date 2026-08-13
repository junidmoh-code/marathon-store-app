// ─── TONGUE LABEL READER + LABEL CAMERA — the ONE label capture, shared ──────
// Extracted from HubCleanup.jsx (owner fix 4, 2026-08-06) so the ASSISTANT
// view can reuse the identical pipeline: three-frame burst capture, QR/
// DataMatrix first, the readStyleCodeLabel OCR funnel (image-hash cached
// server-side — a retake re-bills nothing), format codes preferred, token
// readings for the alias store. ONE implementation, three consumers
// (register, count, assistant).

import React, { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { Html5Qrcode } from "html5-qrcode";
import { prepareLabelPhoto } from "../../utils/labelPhoto";
import { formatStyleCodeForDisplay } from "../../utils/styleCode";
import { interpretLabelScan } from "../../utils/labelScan";
import { mergeFrameTokens } from "../../utils/labelFrames";
import { chooseFromLabelRead } from "./hubCleanupCore";
import { learnLabelLayout } from "./hubCleanupStore";
import { FONT, bBlue, bGray, bGhost, input } from "./ui";

// The tongue-label OCR — the SAME reader the style-code gate uses at intake.
const readStyleCodeLabelFn = httpsCallable(functions, "readStyleCodeLabel");
// Hidden mount ids are per-instance — two readers can be mounted at once.
let qrReaderSeq = 0;

function BigButton({ children, onClick, tone = "blue", disabled, style }) {
  const tones = {
    blue: { background: "rgba(74,127,255,.18)", border: "2px solid rgba(74,127,255,.55)", color: "#D7E3FF" },
    green: { background: "rgba(74,222,128,.18)", border: "2px solid rgba(74,222,128,.6)", color: "#B7F0CC" },
    ghost: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.75)" },
  };
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{ width: "100%", minHeight: 58, borderRadius: 15, fontSize: 17, fontWeight: 800, fontFamily: FONT,
               cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
               ...tones[tone], ...style }}>
      {children}
    </button>
  );
}

// ─── LABEL CAMERA — three frames, not one ────────────────────────────────────
// Most OCR variance is single-frame noise, so the capture grabs THREE frames
// ~350ms apart in one press and the reader keeps only tokens seen in at least
// two (utils/labelFrames.js). Each frame is downscaled to ≤1024px before
// upload (same budget as prepareLabelPhoto) and the server caches per frame's
// image hash — so the three frames cost at most three vision calls ONCE, and
// a retake of any identical frame re-bills nothing.
// The COPY is a prop with the tongue-label wording as its default, because the
// same pipeline now serves a second subject: the printed barcode on a perfume
// box. Telling an operator to "fold the tongue forward" while they hold a
// perfume carton is how a shared component teaches people to distrust it. The
// mechanism — three frames, downscale, stream teardown, single-photo fallback —
// is untouched and stays in ONE place.
export function LabelCamera({
  onFrames, onFallback, onClose,
  title = "The label inside the tongue",
  hint = "Fold the tongue forward and fill the frame with the printed label. One press takes three quick frames.",
  shootLabel = "◉ Capture the label",
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);
  const [shooting, setShooting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const grabFrame = () => new Promise((resolve) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { resolve(null); return; }
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ base64: String(reader.result).split(",")[1] || "", blob });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.85);
  });

  const shoot = async () => {
    setShooting(true);
    const frames = [];
    for (let i = 0; i < 3; i++) {
      const f = await grabFrame();
      if (f) frames.push(f);
      if (i < 2) await new Promise((r) => setTimeout(r, 350));
    }
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    setShooting(false);
    if (frames.length) onFrames(frames);
    else onFallback();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.96)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{title}</div>
        <button onClick={onClose} style={{ ...bGhost, padding: "10px 16px", fontSize: 13 }}>Close</button>
      </div>
      {error ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ textAlign: "center", maxWidth: 320 }}>
            <div style={{ color: "#FF9B9B", fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>
              Camera stream unavailable — take a single photo instead.
            </div>
            <button onClick={onFallback} style={{ ...bBlue, minHeight: 50, padding: "0 20px", fontSize: 14 }}>📷 Take one photo</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <video ref={videoRef} playsInline muted style={{ maxWidth: "100%", maxHeight: "100%" }} />
          </div>
          <div style={{ padding: "14px 18px 30px" }}>
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 12.5, textAlign: "center", marginBottom: 10 }}>
              {hint}
            </div>
            <button onClick={shoot} disabled={shooting}
              style={{ width: "100%", minHeight: 62, borderRadius: 15, fontSize: 17, fontWeight: 800, fontFamily: FONT, cursor: "pointer",
                       background: "rgba(74,127,255,.2)", border: "2px solid rgba(74,127,255,.6)", color: "#D7E3FF",
                       opacity: shooting ? 0.6 : 1 }}>
              {shooting ? "Capturing 3 frames…" : shootLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── TONGUE LABEL READER — the ONE style-number capture, shared by both passes ─
// Registration and the count bring a shoe's style number in identically: a
// photo of the label INSIDE the tongue goes through the same readStyleCodeLabel
// callable the intake gate uses (client-side downscale via prepareLabelPhoto;
// the server caches on the image-byte hash, so a retake of the same photo
// re-bills no vision call), with typed entry as the always-available fallback.
// Copy is explicit on purpose — the operator must never wonder whether this is
// the shop-barcode scan. It is not.
export function TongueLabelReader({ busy, big = false, onCode, onTokens = null }) {
  const [qrId] = useState(() => `label-qr-still-reader-${++qrReaderSeq}`);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState(null);          // { text, options? }
  const [typed, setTyped] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef(null);

  // ── The shared frame pipeline (single photo OR three-frame burst) ─────────
  // Frames are OCR'd one by one; the FIRST format-valid code short-circuits
  // (that path is exact and confusable-guarded — unchanged). Only when NO
  // frame yields a code do the frames' token sets merge (≥2-of-3 agreement)
  // into a label READING for the alias store. Never a dead end.
  const processFrames = async (frames) => {
    setReading(true);
    setReadNote(null);
    try {
      // QR/DataMatrix on the first frame — deterministic beats OCR.
      try {
        const f = new File([frames[0].blob], "label.jpg", { type: "image/jpeg" });
        const scanner = new Html5Qrcode(qrId, false);
        const decoded = await scanner.scanFile(f, false);
        try { scanner.clear(); } catch { /* nothing mounted */ }
        const qr = interpretLabelScan(decoded);
        if (qr.kind === "code") {
          onCode(qr.code, { source: "label", labelPhoto: frames[0] });
          return;
        }
      } catch { /* no machine-readable code — OCR takes over */ }

      const frameTokens = [];
      let sawOptions = null;
      let frameError = null;
      for (const frame of frames) {
        // ONE frame failing (a transient request error) must not discard the
        // other frames' readings — a burst with two usable frames still
        // resolves; the error only surfaces when NOTHING usable remains.
        let data;
        try {
          ({ data } = await readStyleCodeLabelFn({ imageBase64: frame.base64, mimeType: "image/jpeg" }));
        } catch (err) {
          frameError = err;
          continue;
        }
        const out = chooseFromLabelRead(data);
        const formattedChosen = out.kind === "chosen" ? formatStyleCodeForDisplay(out.code) : "";
        if (out.kind === "chosen" && formattedChosen) {
          // `allCodes` carries EVERY code-shaped token this label printed —
          // the caller files them all as identities for the resolved product
          // (owner spec 2026-08-08: one shoe in hand, one identity, however
          // many tokens the label shows). `auto` marks a learned-layout pick.
          // `modelName` is the label's printed model line when the OCR funnel
          // carried one (tier-2 residual, or the cached `mn`) — the link
          // panel's second-strongest suggestion source. Null on clean tier-1
          // reads by the funnel's documented cost design.
          onCode(formattedChosen, {
            source: "label", labelPhoto: frame,
            allCodes: out.allCandidates || null, auto: !!out.auto,
            modelName: typeof data.modelName === "string" ? data.modelName : null,
          });
          // A learned-layout pick must never be INVISIBLE (Sonnet review,
          // PR #334): the flow proceeds, but the pick is announced with the
          // other token(s) as override chips. Tapping one both corrects this
          // read AND records the disagreement that replaces — and on a second
          // disagreement permanently disables — the rule (lib/label-layout).
          // Without this, the counting surface could never generate the
          // correcting answer a wrong rule needs.
          if (out.auto && Array.isArray(out.allCandidates) && out.allCandidates.length > 1) {
            setReadNote({
              text: `Read ${formattedChosen} as the style number — learned from earlier labels like this one. Wrong? Tap the right one:`,
              options: out.allCandidates.filter((c) => formatStyleCodeForDisplay(c) !== formattedChosen).map(formatStyleCodeForDisplay),
              candidates: out.allCandidates,
              labelPhoto: frame,
              modelName: typeof data.modelName === "string" ? data.modelName : null,
            });
          }
          return;
        }
        if (out.kind === "options" && !sawOptions) sawOptions = { out, frame, modelName: typeof data.modelName === "string" ? data.modelName : null };
        if (out.kind === "tokens") frameTokens.push(out.tokens);
      }
      if (sawOptions) {
        // A layout no rule decides yet — the manual tap is the fallback, and
        // the tap TEACHES: it learns the layout rule and files every token
        // (candidates rides along so the tap handler has the full set).
        setReadNote({
          text: "The label shows more than one code-looking number — tap the style number:",
          options: sawOptions.out.options,
          candidates: sawOptions.out.candidates || null,
          labelPhoto: sawOptions.frame,
          modelName: sawOptions.modelName,
        });
        return;
      }
      const merged = mergeFrameTokens(frameTokens);
      if (merged.length >= 2 && onTokens) {
        onTokens(merged, { labelPhoto: frames[0] });
        return;
      }
      setReadNote({ text: frameError && frameTokens.length === 0
        ? `Could not read that label (${frameError?.message || frameError}) — try again, or type the style number.`
        : chooseFromLabelRead({ candidates: [] }).message });
    } catch (err) {
      setReadNote({ text: `Could not read that label (${err?.message || err}) — type the style number instead.` });
    } finally { setReading(false); }
  };

  const handleLabelPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setReading(true);
    try {
      const photo = await prepareLabelPhoto(file);
      await processFrames([photo]);
    } catch (err) {
      setReadNote({ text: `Could not read that photo (${err?.message || err}) — type the style number instead.` });
      setReading(false);
    }
  };

  const applyTyped = () => {
    // Never while a burst is still reading — a late OCR result must not
    // replace a manual entry (or vice versa) across register/count/assistant.
    if (reading || busy) return;
    const v = typed.trim();
    if (!v) return;
    const formatted = formatStyleCodeForDisplay(v);
    if (!formatted) {
      // Normalises to nothing (punctuation only, etc.) — say so instead of
      // silently arming a blank code that disables the save with no explanation.
      setReadNote({ text: `“${v}” doesn't look like a style number — check the label inside the tongue.` });
      return;
    }
    setTyped("");
    setReadNote(null);
    onCode(formatted, { source: "manual", labelPhoto: null });
  };

  return (
    <div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={handleLabelPhoto} style={{ display: "none" }} />
      <BigButton tone="blue" disabled={busy || reading} onClick={() => setCameraOpen(true)}
                 style={big ? { minHeight: 84, fontSize: 20 } : { minHeight: 64, fontSize: 17 }}>
        {reading ? "Reading the tongue label…" : "📷 Photograph the tongue label"}
      </BigButton>
      {cameraOpen && (
        <LabelCamera
          onFrames={(frames) => { setCameraOpen(false); processFrames(frames); }}
          onFallback={() => { setCameraOpen(false); fileRef.current && fileRef.current.click(); }}
          onClose={() => setCameraOpen(false)} />
      )}
      <div id={qrId} style={{ display: "none" }} />
      {readNote && (
        <div style={{ marginTop: 10, background: "rgba(251,191,36,.07)", border: "1px solid rgba(251,191,36,.25)",
                      borderRadius: 11, padding: "9px 12px", fontSize: 12.5, color: "#FDE9B0" }}>
          {readNote.text}

          {readNote.options && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
              {readNote.options.map((c) => (
                <button key={c} type="button"
                  onClick={() => {
                    const f = formatStyleCodeForDisplay(c);
                    if (!f) { setReadNote({ text: "That one isn't a style number — type it from the label instead." }); return; }
                    // The tap is the human's answer for this LAYOUT — record it
                    // so the same question is not asked twice (best-effort:
                    // read-only roles may not be allowed to teach, and a failed
                    // lesson must never block the read itself).
                    if (readNote.candidates && readNote.candidates.length > 1) {
                      learnLabelLayout({ codes: readNote.candidates, chosenCode: c }).catch(() => {});
                    }
                    setReadNote(null);
                    onCode(f, {
                      source: "label", labelPhoto: readNote.labelPhoto || null,
                      allCodes: readNote.candidates || null,
                      modelName: readNote.modelName || null,
                    });
                  }}
                  style={{ ...bBlue, fontSize: 13.5, minHeight: 42, fontVariantNumeric: "tabular-nums" }}>{c}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); applyTyped(); }}
            style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)}
               placeholder="…or type the style number, e.g. CT8527-016"
               style={{ ...input, flex: 1, minHeight: 48, fontSize: 15 }} />
        <button type="submit" disabled={!typed.trim() || reading || busy} style={{ ...bGray, minHeight: 48, padding: "0 16px" }}>Set</button>
      </form>
    </div>
  );
}


