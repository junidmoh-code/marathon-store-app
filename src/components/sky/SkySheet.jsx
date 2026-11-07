// ─── THE PHONE BOTTOM SHEET (Junid, 6 Nov — "sky-wall v3") ───────────────────
//
// Replaces the transparent overlay the size picker used to float in (grid text
// bled through it, its sizes overlapped the tiles behind). Now:
//   • the page behind dims and blurs (the scrim);
//   • a solid glass sheet slides up from the bottom, with a drag handle and a
//     close button;
//   • it dismisses on a drag down (from the handle or the header), on the close
//     button, on Escape, or on a tap on the dimmed area.
// Presentation only: `onClose` is the caller's own reset (AssistantView's
// resetSheet), and every control inside is the caller's, unchanged.

import { useEffect, useRef, useState } from "react";
import { ProductStage } from "./Sky.jsx";

const CLOSE_PX = 110;      // a drag this far down closes the sheet
const FLICK = 0.6;         // …or a quick flick (px per ms) past 30px

export function SkySheet({ onClose, label = "Product", testId = "sky-sheet", children }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const moved = useRef(false);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under the sheet.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const down = (e) => {
    if (!e.target.closest?.("[data-sheet-grab]")) return;
    if (e.target.closest?.("button,a,input") && !e.target.closest?.(".sky-sheet__handle")) return;
    drag.current = { y: e.clientY, t: Date.now(), id: e.pointerId };
    moved.current = false;
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dist = Math.max(0, e.clientY - d.y);
    if (dist > 4 && !moved.current) { moved.current = true; setDragging(true); e.currentTarget.setPointerCapture?.(e.pointerId); }
    if (moved.current) setDy(dist);
  };
  const up = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setDragging(false);
    const dist = Math.max(0, e.clientY - d.y);
    const v = dist / Math.max(1, Date.now() - d.t);
    if (moved.current && (dist > CLOSE_PX || (v > FLICK && dist > 30))) { onClose(); return; }
    setDy(0);
  };
  // A drag must not end as a click on whatever it started over (the photo).
  const swallowClick = (e) => { if (moved.current) { moved.current = false; e.stopPropagation(); e.preventDefault(); } };

  return (
    <div className="sky-sheetscrim" data-testid={`${testId}-scrim`}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="sky-sheet sky-sheet--v3" role="dialog" aria-modal="true" aria-label={label} data-testid={testId}
           data-dragging={dragging ? "true" : undefined}
           style={dy ? { transform: `translateY(${dy}px)` } : undefined}
           onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onClickCapture={swallowClick}>
        <div className="sky-sheet__handle" data-sheet-grab="" aria-hidden="true"><span /></div>
        {children}
      </div>
    </div>
  );
}

/** The sheet's header: the shoe floating with its shadow on the left; name,
 *  W-code and hub chips; the price on the right; close (and the admin actions,
 *  when the caller passes them) in the corner. Drag-to-close starts here too. */
export function SkySheetHead({ p, chips = [], price = null, onClose, onPhoto = null, photoTitle, photoCount = 0, actions = null, badge = null }) {
  return (
    <div className="sky-sheet__head" data-sheet-grab="">
      <div className="sky-sheet__img" data-contrast-exempt="" onClick={onPhoto || undefined} title={photoTitle}
           style={{ cursor: onPhoto ? "zoom-in" : "default" }}>
        <ProductStage p={p} height="100%" emoji={p.photo || "👟"} priority cutoutHeight="70%" />
        {photoCount > 1 && <span className="sky-sheet__n">{photoCount}</span>}
      </div>
      <div className="sky-sheet__info">
        <div className="sky-sheet__name" data-contrast-exempt="">{p.name}{badge}</div>
        <div className="sky-sheet__meta" data-contrast-exempt="">
          {chips.filter(Boolean).map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="sky-sheet__price" data-contrast-exempt="">{price}</div>
      </div>
      {actions ? <div className="sky-sheet__acts">{actions}</div> : null}
      <button type="button" onClick={onClose} aria-label="Close" className="sky-sheet__x" data-testid="sheet-close">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

/** The quantity row: label left, a glass − n + stepper right. */
export function SkyStepperRow({ label = "Quantity", value, onDec, onInc, decDisabled, incDisabled }) {
  return (
    <div className="sky-sheet__row" data-contrast-exempt="">
      <div className="sky-sheet__rowlab">{label}</div>
      <div className="sky-step">
        <button type="button" onClick={onDec} disabled={decDisabled} aria-label="One fewer">−</button>
        <span aria-live="polite">{value}</span>
        <button type="button" onClick={onInc} disabled={incDisabled} aria-label="One more">+</button>
      </div>
    </div>
  );
}
