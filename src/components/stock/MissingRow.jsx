// ─── MISSING PRODUCTS — THE CARD (Junid, 22 Nov 2026) ─────────────────────────
// One fixed-size card. A photo big enough to know the product, its name, one
// stock line, the locations it may go to, and Solve. Choose a location, then
// Solve (Junid, 22 Nov 2026 — a location tap never sends anything).
//
// NOTHING HERE CHANGES SIZE. The card is CARD_H tall whatever its name, however
// many destinations it has and whatever state a button is in; a card still
// being worked out is a skeleton of the same box. The only movement on the
// screen is a card LEAVING: its slot closes in one transition (Slot), and the
// cards below move up once.
import React, { memo, useEffect, useState } from "react";
import { FONT, GREEN, BLUE, BLUE_L, AMBER } from "./ui";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";

export const CARD_H = 168;
export const CARD_GAP = 10;
export const LEAVE_MS = 240;
const PHOTO = 88;

const shell = {
  height: CARD_H, boxSizing: "border-box", padding: 12, borderRadius: 16, fontFamily: FONT,
  background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.09)",
  display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden",
};
const NO_PICK = Object.freeze([]);
// A location: a neutral outline until chosen, then filled blue with a tick.
// Never green: green means one thing on this screen — Solve, ready to go.
const chip = (on) => ({
  position: "relative", flex: 1, minWidth: 0, height: 48, borderRadius: 13, fontFamily: FONT, fontSize: 15.5, fontWeight: 800,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 16px", cursor: "pointer",
  WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: on ? BLUE : "transparent",
  border: `1px solid ${on ? BLUE : "rgba(255,255,255,.2)"}`,
  color: on ? "#fff" : "rgba(255,255,255,.88)",
});
// Solve: the main action. Green and solid only once a location is chosen.
const solveBtn = (ready, busy) => ({
  width: 96, flexShrink: 0, height: 48, borderRadius: 13, fontFamily: FONT, fontSize: 16, fontWeight: 800,
  cursor: ready ? "pointer" : "default", WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: ready || busy ? GREEN : "transparent",
  border: `1px solid ${ready || busy ? GREEN : "rgba(255,255,255,.1)"}`,
  color: ready || busy ? "#052e14" : "rgba(255,255,255,.28)",
  opacity: busy ? 0.75 : 1,
});
// Hide: small and secondary — a quiet word beside the stock line.
const hideLink = {
  flexShrink: 0, height: 36, padding: "0 4px 0 10px", background: "none", border: "none", fontFamily: FONT,
  fontSize: 13.5, fontWeight: 600, color: "rgba(255,255,255,.42)", cursor: "pointer", WebkitTapHighlightColor: "transparent",
};

// The slot a card sits in. `leaving` closes it once; `entering` (a card put
// back by Undo) opens it the same way.
export function Slot({ leaving = false, entering = false, children, ...rest }) {
  const [open, setOpen] = useState(!entering);
  useEffect(() => {
    if (open) return undefined;
    // One frame at height 0, then open (a timer where there is no frame clock).
    const raf = typeof requestAnimationFrame === "function";
    const t = raf ? requestAnimationFrame(() => setOpen(true)) : setTimeout(() => setOpen(true), 16);
    return () => (raf ? cancelAnimationFrame(t) : clearTimeout(t));
  }, [open]);
  const shut = leaving || !open;
  return (
    <div {...rest} style={{
      height: shut ? 0 : CARD_H + CARD_GAP, opacity: shut ? 0 : 1, overflow: "hidden",
      transition: `height ${LEAVE_MS}ms cubic-bezier(.4,0,.2,1), opacity ${Math.round(LEAVE_MS * 0.7)}ms ease`,
      pointerEvents: leaving ? "none" : "auto",
    }}>{children}</div>
  );
}

export function SkeletonRow() {
  const bar = (w, h) => ({ width: w, height: h, borderRadius: 6, background: "rgba(255,255,255,.06)" });
  return (
    <div data-skeleton aria-hidden="true" style={{ height: CARD_H + CARD_GAP }}>
      <div style={shell}>
        <div style={{ display: "flex", gap: 12, height: PHOTO }}>
          <div style={{ width: PHOTO, height: PHOTO, borderRadius: 13, background: "rgba(255,255,255,.06)", flexShrink: 0 }} />
          <div style={{ flex: 1, paddingTop: 4 }}><div style={bar("78%", 16)} /><div style={{ ...bar("40%", 14), marginTop: 12 }} /></div>
        </div>
        <div style={{ height: 48, borderRadius: 13, background: "rgba(255,255,255,.04)" }} />
      </div>
    </div>
  );
}

/**
 * CHOOSE, THEN SOLVE (Junid, 22 Nov 2026). A location button only selects.
 * Solve sends to what is selected. Nothing is preselected, not even a lone
 * Hub 3. Nothing on this card ever renders disabled: a location is offered or
 * absent, and Solve with nothing chosen simply does nothing.
 *
 * row       missingListCore's row (its `dests` are only the offered locations)
 * selected  the location ids chosen on THIS card, in tap order
 * busy      true while this card's Solve is being written
 * canAct    the viewer may choose, solve and hide
 * onPick (row, destId)   onSolve (row)   onHide (row)   onPhoto (product)
 */
function MissingRow({ row, product, twinProduct, selected = NO_PICK, busy = false, canAct = true, onPick, onSolve, onHide, onPhoto }) {
  const live = product || { id: row.pid, photoUrl: row.photo };
  const ready = canAct && !busy && selected.length > 0;
  return (
    <div data-card={row.pid} data-card-name={row.name} data-card-kind={row.kind} style={shell}>
      <div style={{ display: "flex", gap: 12, height: PHOTO }}>
        <button type="button" aria-label="Look at the photo" onClick={() => onPhoto?.(live)}
          style={{ position: "relative", width: PHOTO, height: PHOTO, borderRadius: 13, flexShrink: 0, overflow: "hidden", border: "none", padding: 0, background: "rgba(60,110,255,.1)", cursor: "zoom-in" }}>
          <PrimaryPhoto product={live} productId={row.pid} snapshot={row.photo || null} alt="" width={PHOTO} height={PHOTO} style={{ width: PHOTO, height: PHOTO, objectFit: "cover", display: "block" }} />
        </button>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div data-name style={{ fontWeight: 800, fontSize: 16, lineHeight: "20px", height: 40, color: "#fff", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{String(row.name).replace(/\u00a0/g, " ")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 36 }}>
            <div data-stock style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, color: BLUE_L, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {row.sourceName} {row.stock}{row.needsPolicy && <span data-needs-policy style={{ color: AMBER, marginLeft: 8 }}>No policy yet</span>}
            </div>
            {/* SAME NAME ELSEWHERE: the other record's photo, no sentence. */}
            {row.twin && (
              <button type="button" data-same-name={row.twin} aria-label="Another record has this name — look at its photo" onClick={() => onPhoto?.(twinProduct || { id: row.twin })}
                style={{ width: 36, height: 36, borderRadius: 9, overflow: "hidden", padding: 0, flexShrink: 0, background: "rgba(251,191,36,.12)", border: `2px solid ${AMBER}`, cursor: "zoom-in" }}>
                <PrimaryPhoto product={twinProduct || { id: row.twin }} productId={row.twin} alt="" width={32} height={32} style={{ width: 32, height: 32, objectFit: "cover", display: "block" }} />
              </button>
            )}
            {canAct && (
              <button type="button" data-action="hide" onClick={() => { if (!busy) onHide?.(row); }} style={hideLink}>Hide</button>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, height: 48 }}>
        {canAct && row.dests.map((d) => {
          const on = selected.includes(d.id);
          return (
            <button key={d.id} type="button" data-dest={d.id} aria-pressed={on} aria-label={on ? `${d.name}, selected` : `Choose ${d.name}`}
              onClick={() => { if (!busy) onPick?.(row, d.id); }} style={chip(on)}>
              {/* The tick sits at the chip's edge, so the name never moves when chosen. */}
              <span aria-hidden="true" style={{ position: "absolute", left: 9, top: 0, bottom: 0, display: "flex", alignItems: "center", opacity: on ? 1 : 0 }}>✓</span>{d.name}
            </button>
          );
        })}
        {canAct && (
          <button type="button" data-action="solve" aria-disabled={!ready} aria-busy={busy || undefined}
            onClick={() => { if (ready) onSolve?.(row); }} style={solveBtn(ready, busy)}>
            {/* One word, always: a label that changed would move (busy = dimmed). */}
            Solve
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(MissingRow);
