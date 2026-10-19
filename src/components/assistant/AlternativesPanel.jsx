// ─── "AVAILABLE NOW INSTEAD" — the wall's alternatives panel ─────────────────
//
// Junid's rebuild (2026-10-19, item 7): when a size has no stock, the
// alternatives speak the wall's language. Photo-only tiles in a wrapping grid
// (6 across at 1440, 5 at 1280, never a sideways scroll), each with one green
// pill naming the size the customer asked for. A tap opens the SAME overlay
// the wall uses (TileDetails) in place of the grid, with a back arrow; an
// available size there adds exactly as on the wall and closes the panel.
//
// THE ROWS ARE NOT RE-DECIDED HERE. They come from AssistantView's
// alternativesFor — the one ranking, unchanged, every row already sellable in
// the requested size (alternativesCore). This file draws the first eighteen
// in that order and nothing else. `rows` null means "not answered yet" and
// draws nothing, as AlternativesStrip does; an empty array is a real answer.
//
// The original shoe's own controls (sizes, Display Partner, quantity, Add)
// stay the host's (AssistantDesktop's quick-view), drawn as a fixed band
// BELOW this panel: the panel takes the flexible height and scrolls inside,
// so the grid changing height never moves them.

import { useEffect, useRef, useState } from "react";
import { formatSize } from "../../utils/sizeLabel";
import { TileDetails, TilePhoto } from "./SneakerWall.jsx";

export const ALT_PANEL_MAX = 18;

const PANEL_CSS = `
  .alt-panel{display:flex;flex-direction:column;height:100%;min-height:0}
  .alt-body{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 22px}
  .alt-line{flex:0 0 auto;font-size:13px;font-weight:600;color:#8b8b95;padding:2px 0 12px}
  .alt-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-bottom:14px}
  /* Wrapping, never sideways: 6 columns at 1440, 5 at 1280, 4 on a tablet. */
  .alt-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
  @media(max-width:1399px){.alt-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
  @media(max-width:1100px){.alt-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  .alt-tile{position:relative;aspect-ratio:5/4;border-radius:14px;overflow:hidden;background:#0a0a0a;border:0;padding:0;cursor:pointer;display:block;width:100%}
  .alt-tile img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;opacity:0;transition:opacity .2s}
  .alt-tile img.ok{opacity:1}
  .alt-tile:focus-visible,.sw-back:focus-visible{outline:2px solid #b9beff;outline-offset:2px}
  /* The size the customer asked for — the same green the strip used, so every
     tile visibly carries it. */
  .alt-sz{position:absolute;top:7px;left:7px;z-index:2;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,.92);color:#04150E;font-size:11px;font-weight:900;font-variant-numeric:tabular-nums}
  .alt-none{border:1px dashed rgba(255,255,255,.16);border-radius:12px;padding:14px 16px;color:#8b8b95;font-size:13px;font-weight:700}
  .alt-detail{display:flex;flex-direction:column;gap:10px;min-height:0;flex:1}
  .sw-back{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px 0 8px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e6e6ea;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
  .alt-big{position:relative;width:min(560px,100%);aspect-ratio:5/4;max-height:100%;border-radius:16px;overflow:hidden;background:#0a0a0a}
  .alt-big::after{content:"";position:absolute;inset:0;border-radius:16px;pointer-events:none;z-index:3;box-shadow:inset 0 0 0 3px #5b63ff}
  .alt-big .sw-photo{position:absolute;inset:0}
`;

// The quiet line above the grid — one grey sentence, the short form of
// sneakerBlockNoteText's reasons (`w` is sneakerOutWhy's answer). The long
// amber note it replaces said the same things; the panel needs only the gist.
export function quietBlockLine(size, w, stillOut = true) {
  const sz = formatSize(size);
  const hub = w?.hubLabel || "Hub 1";
  if (!stillOut) return `Size ${sz} can be ordered again — pick it below, or one of these:`;
  if (!w || w.booked <= 0)
    return w?.checkedBoth ? `Size ${sz} not at Hub 1 or Hub 2 — these have it:` : `Size ${sz} not at ${hub} — these have it:`;
  if (w.available <= 0)
    return w.pullOnly ? `Size ${sz} at ${hub} is held for a display-pair request — these have it:`
      : `Size ${sz} at ${hub} is held for another customer's order — these have it:`;
  return `Your order already has every size ${sz} ${hub} can give — these have it:`;
}

export default function AlternativesPanel({ rows, requestedSize, line, sizeGate, onQuickAdd, onViewPhoto,
                                            onShown, onPicked, onAdded }) {
  const [picked, setPicked] = useState(null);
  const answered = Array.isArray(rows);
  // A new size (or a new answer) returns to the grid.
  useEffect(() => { setPicked(null); }, [requestedSize]);

  // Telemetry, log only — once per size shown, after availability answered.
  const shownFor = useRef("");
  useEffect(() => {
    if (!answered || !onShown || !requestedSize) return;
    const k = String(requestedSize);
    if (shownFor.current === k) return;
    shownFor.current = k;
    onShown();
    // onShown is a fresh closure every render; the ref makes this once per size.
  }, [answered, requestedSize]);

  // Escape in a picked shoe returns to the grid instead of closing the whole
  // quick-view (capture phase, ahead of AssistantDesktop's window handler).
  useEffect(() => {
    if (!picked || typeof window === "undefined") return undefined;
    const h = (e) => { if (e.key === "Escape") { e.stopImmediatePropagation(); setPicked(null); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [picked]);

  const shown = answered ? rows.slice(0, ALT_PANEL_MAX) : [];
  const pickedRow = picked ? shown.find(r => r.product.id === picked) : null;

  return (
    <div className="alt-panel">
      <style>{PANEL_CSS}</style>
      <div className="alt-body">
        {/* Only once the rows have answered: "these have it:" over an empty
            space would be a claim the screen cannot make yet. */}
        {line && answered ? <div className="alt-line" role="status">{line}</div> : null}
        {pickedRow ? (
          <div className="alt-detail">
            <button type="button" className="sw-back" onClick={() => setPicked(null)} aria-label="Back to the alternatives">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              Back
            </button>
            <div className="alt-big" data-testid="alt-detail">
              <div className="sw-photo"><TilePhoto key={pickedRow.product.photoUrl || ""} p={pickedRow.product} /></div>
              <TileDetails p={pickedRow.product} sizeGate={sizeGate} onQuickAdd={onQuickAdd} onViewPhoto={onViewPhoto}
                           onAdded={(p, sz) => onAdded?.(pickedRow, sz)} />
            </div>
          </div>
        ) : !answered ? null : !shown.length ? (
          <div className="alt-none" role="status">Nothing in size {formatSize(requestedSize)} is available anywhere right now</div>
        ) : (
          <div className="alt-scroll">
            <div className="alt-grid" data-testid="alt-grid">
              {shown.map(r => {
                const sz = r.matchedSize ?? requestedSize;
                return (
                  <button key={r.product.id} type="button" className="alt-tile" aria-label={`${r.product.name}, size ${formatSize(sz)} available`}
                          onClick={() => { onPicked?.(r); setPicked(r.product.id); }}>
                    <span className="alt-sz">{sz === "Free Size" ? "OS" : formatSize(sz)}</span>
                    <TilePhoto key={r.product.photoUrl || ""} p={r.product} />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
