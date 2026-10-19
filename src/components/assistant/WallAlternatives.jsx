// ─── "THESE HAVE IT" — the wall popup's alternatives strip ──────────────────
//
// Junid, round 3 item 10 (2026-10-19): a suggestion, not a screen. The
// product popup stays the primary surface at its normal size; when a tapped
// size has no stock, this strip appears INSIDE it, directly under the size
// pills: one small grey line, then a single sideways-scrolling row of small
// photo tiles (110×88, 5:4), each carrying the green pill of the size the
// customer asked for. A tap swaps the popup's content to that shoe in place
// (the host keeps a "← back to …" link); the add is the popup's normal add.
// It replaces the full-screen "Available now instead" panel of #764.
//
// THE ROWS ARE NOT RE-DECIDED HERE. They come from AssistantView's
// alternativesFor — the one ranking, unchanged, every row already sellable in
// the requested size (alternativesCore). This file draws the first eighteen
// in that order and nothing else. `rows` null means "not answered yet" and
// draws nothing, as AlternativesStrip does; an empty array is a real answer.

import { useEffect, useRef } from "react";
import { formatSize } from "../../utils/sizeLabel";
import { TilePhoto } from "./SneakerWall.jsx";

export const ALT_PANEL_MAX = 18;

const STRIP_CSS = `
  .alt-strip{margin-top:12px;min-width:0}
  .alt-strip[hidden]{display:none}
  .alt-line{min-height:15px;font-size:12px;font-weight:600;color:#8b8b95;padding:0 0 8px}
  /* One row, sideways only: snap per tile, no visible scrollbar (touch and
     trackpad still scroll it), never a vertical overflow. */
  .alt-row{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;padding-bottom:2px}
  .alt-row::-webkit-scrollbar{display:none}
  .alt-tile{position:relative;flex:0 0 110px;width:110px;height:88px;scroll-snap-align:start;border-radius:12px;overflow:hidden;background:#0a0a0a;border:0;padding:0;cursor:pointer;display:block}
  .alt-tile::after{content:"";position:absolute;inset:0;border-radius:12px;pointer-events:none;z-index:3;box-shadow:inset 0 0 0 2px transparent;transition:box-shadow .12s}
  .alt-tile:hover::after{box-shadow:inset 0 0 0 2px #5b63ff}
  .alt-tile img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;opacity:0;transition:opacity .2s}
  .alt-tile img.ok{opacity:1}
  .alt-tile .sw-noimg{font-size:10.5px;padding:8px}
  .alt-tile:focus-visible{outline:2px solid #b9beff;outline-offset:2px}
  /* The size the customer asked for — the strip's green, on every tile. */
  .alt-sz{position:absolute;top:5px;left:5px;z-index:2;padding:1px 6px;border-radius:999px;background:rgba(16,185,129,.92);color:#04150E;font-size:10.5px;font-weight:900;font-variant-numeric:tabular-nums}
  .alt-none{border:1px dashed rgba(255,255,255,.16);border-radius:10px;padding:10px 12px;color:#8b8b95;font-size:12px;font-weight:700}
  @media(prefers-reduced-motion:reduce){.alt-tile img{transition:none}}
`;

// The quiet line above the strip — one grey sentence, the short form of
// sneakerBlockNoteText's reasons (`w` is sneakerOutWhy's answer). The long
// amber note it replaces said the same things; the strip needs only the gist.
export function quietBlockLine(size, w, stillOut = true) {
  const sz = formatSize(size);
  const hub = w?.hubLabel || "Hub 1";
  if (!stillOut) return `Size ${sz} can be ordered again — pick it above, or one of these:`;
  if (!w || w.booked <= 0)
    return w?.checkedBoth ? `Size ${sz} not at Hub 1 or Hub 2 — these have it:` : `Size ${sz} not at ${hub} — these have it:`;
  if (w.available <= 0)
    return w.pullOnly ? `Size ${sz} at ${hub} is held for a display-pair request — these have it:`
      : `Size ${sz} at ${hub} is held for another customer's order — these have it:`;
  return `Your order already has every size ${sz} ${hub} can give — these have it:`;
}

export default function WallAlternatives({ rows, requestedSize, line, onShown, onPicked, hidden = false }) {
  const answered = Array.isArray(rows);

  // Telemetry, log only — once per size shown, after availability answered.
  // The host keys this strip by shoe + size, so a new size is a fresh mount.
  const shownFor = useRef("");
  useEffect(() => {
    if (!answered || !onShown || !requestedSize) return;
    const k = String(requestedSize);
    if (shownFor.current === k) return;
    shownFor.current = k;
    onShown();
    // onShown is a fresh closure every render; the ref makes this once per size.
  }, [answered, requestedSize]);

  const shown = answered ? rows.slice(0, ALT_PANEL_MAX) : [];

  return (
    <div className="alt-strip" data-testid="alt-strip" hidden={hidden}>
      <style>{STRIP_CSS}</style>
      {/* Always mounted, so a screen reader announces the text when it
          arrives; empty until the rows have answered, because "these have
          it:" over nothing is a claim the screen cannot make yet. */}
      <div className="alt-line" role="status">{line && answered ? line : ""}</div>
      {!answered ? null : !shown.length ? (
        <div className="alt-none">Nothing in size {formatSize(requestedSize)} is available anywhere right now</div>
      ) : (
        <div className="alt-row" data-testid="alt-row">
          {shown.map(r => {
            const sz = r.matchedSize ?? requestedSize;
            return (
              <button key={r.product.id} type="button" className="alt-tile"
                      aria-label={`${r.product.name}, size ${formatSize(sz)} available`}
                      onClick={() => onPicked?.(r)}>
                <span className="alt-sz">{sz === "Free Size" ? "OS" : formatSize(sz)}</span>
                <TilePhoto key={r.product.photoUrl || ""} p={r.product} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
