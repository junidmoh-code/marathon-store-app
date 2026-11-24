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
//
// COMPACT (Junid, 23 Nov 2026 — "far too big, a phone shows three and a half
// cards"): the same card at 94 px. The photo runs the card's full height on
// the left; beside it the name (two lines at most), the stock line, and under
// them the locations and Solve. Every tap target is still at least 40 px tall
// — the saving is padding, gaps and font size, never a smaller button.
import React, { memo, useEffect, useRef, useState } from "react";
import { FONT, GREEN, BLUE, BLUE_L, AMBER } from "./ui";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";

export const CARD_H = 94;
export const CARD_GAP = 4;
export const LEAVE_MS = 240;
// THE DIVISION BUTTON TAKES TWO TAPS (Junid, 24 Nov 2026): the first arms it
// ("Tap again to move to Concrete"), a second on the same button within this
// window marks the product. Anything else — the window running out — and the
// first tap did nothing.
export const DIVISION_CONFIRM_MS = 4000;
// Inside the 1 px border and 4 px padding: 94 − 2 − 8 = 84.
const INNER = 84;
const PHOTO = INNER;
// The name + stock block above the buttons, and the button row.
const TOP_H = 44;
const BTN_H = 40;

const shell = {
  height: CARD_H, boxSizing: "border-box", padding: "4px 6px 4px 4px", borderRadius: 14, fontFamily: FONT,
  background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.09)",
  display: "flex", gap: 8, overflow: "hidden",
};
const NO_PICK = Object.freeze([]);
// A location: a neutral outline until chosen, then filled blue with a tick.
// Never green: green means one thing on this screen — Solve, ready to go.
const chip = (on) => ({
  position: "relative", flex: 1, minWidth: 0, height: BTN_H, borderRadius: 11, fontFamily: FONT, fontSize: 12.5, fontWeight: 800, letterSpacing: "-.01em",
  // left room for the tick; "Marathon PE" fits whole at iPhone width
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 3px 0 12px", cursor: "pointer",
  WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: on ? BLUE : "transparent",
  border: `1px solid ${on ? BLUE : "rgba(255,255,255,.2)"}`,
  color: on ? "#fff" : "rgba(255,255,255,.88)",
});
// A shop held back by the one-owner rule: the chip's box, no border, muted
// italic text — plainly not a button.
const heldNote = {
  flex: 1, minWidth: 0, height: BTN_H, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: FONT, fontSize: 12, fontWeight: 600, fontStyle: "italic", color: "rgba(255,255,255,.42)",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 4px",
};
// Solve: the main action. Green and solid only once a location is chosen.
const solveBtn = (ready, busy) => ({
  width: 56, flexShrink: 0, height: BTN_H, borderRadius: 11, fontFamily: FONT, fontSize: 14.5, fontWeight: 800, padding: 0,
  cursor: ready ? "pointer" : "default", WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: ready || busy ? GREEN : "transparent",
  border: `1px solid ${ready || busy ? GREEN : "rgba(255,255,255,.1)"}`,
  color: ready || busy ? "#052e14" : "rgba(255,255,255,.28)",
  opacity: busy ? 0.75 : 1,
});
// THE DIVISION BUTTON (Junid, 23 Nov 2026): where Hide was, beside the stock
// line. Small and secondary, and shaped unlike anything else on the card — a
// short dashed violet tag, not a filled or outlined chip — so it can't be read
// as a destination or as Solve. Its tap target is the full 44 px of the name +
// stock block, to the right of it (never over the buttons below); the tag drawn
// inside is 22 px, so the card never grows.
const divisionHit = {
  flexShrink: 0, height: TOP_H, padding: "0 0 0 8px", background: "none", border: "none", fontFamily: FONT,
  display: "flex", alignItems: "center", cursor: "pointer", WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
};
const divisionTag = (busy) => ({
  height: 22, lineHeight: "20px", boxSizing: "border-box", padding: "0 7px", borderRadius: 6,
  border: "1px dashed rgba(196,160,255,.55)", color: "rgba(214,190,255,.9)", background: "transparent",
  fontSize: 11.5, fontWeight: 700, letterSpacing: ".02em", whiteSpace: "nowrap", opacity: busy ? 0.5 : 1,
});

// The armed state: the same button, its words laid OVER the name + stock block
// (absolute, inside the 44 px row), so nothing on the card moves. The small tag
// keeps its place underneath, hidden, holding the button's width.
const divisionConfirm = {
  position: "absolute", left: 0, right: 0, top: 0, height: TOP_H, boxSizing: "border-box", zIndex: 1,
  display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", borderRadius: 9,
  background: "#1a1430", border: "1px dashed rgba(196,160,255,.85)", color: "#e4d4ff",
  fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
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
        <div style={{ width: PHOTO, height: PHOTO, borderRadius: 11, background: "rgba(255,255,255,.06)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ paddingTop: 3 }}><div style={bar("78%", 12)} /><div style={{ ...bar("40%", 11), marginTop: 8 }} /></div>
          <div style={{ height: BTN_H, borderRadius: 11, background: "rgba(255,255,255,.04)" }} />
        </div>
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
 * canAct    the viewer may choose and solve
 * divisionLabel  "Concrete" (on a Marathon card) / "Marathon" (on a Concrete
 *           card), or null when this viewer may not mark a division
 * onPick (row, destId)   onSolve (row)   onDivision (row)   onPhoto (product)
 */
function MissingRow({ row, product, twinProduct, selected = NO_PICK, busy = false, canAct = true, onPick, onSolve, divisionLabel = null, onDivision, onPhoto }) {
  const live = product || { id: row.pid, photoUrl: row.photo };
  const ready = canAct && !busy && selected.length > 0;
  // Armed = the first tap landed; a second within DIVISION_CONFIRM_MS marks.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const disarm = () => { clearTimeout(armTimer.current); setArmed(false); };
  const tapDivision = () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), DIVISION_CONFIRM_MS);
      return;
    }
    disarm();
    onDivision?.(row);
  };
  return (
    <div data-card={row.pid} data-card-name={row.name} data-card-kind={row.kind} style={shell}>
      <button type="button" aria-label="Look at the photo" onClick={() => onPhoto?.(live)}
        style={{ position: "relative", width: PHOTO, height: PHOTO, borderRadius: 11, flexShrink: 0, overflow: "hidden", border: "none", padding: 0, background: "rgba(60,110,255,.1)", cursor: "zoom-in" }}>
        <PrimaryPhoto product={live} productId={row.pid} snapshot={row.photo || null} alt="" width={PHOTO} height={PHOTO} style={{ width: PHOTO, height: PHOTO, objectFit: "cover", display: "block" }} />
      </button>
      <div style={{ flex: 1, minWidth: 0, height: INNER, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", height: TOP_H }}>
          <div style={{ flex: 1, minWidth: 0, height: TOP_H, display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
            {/* Two lines at most, always the same box: a short name and a long one give the same card. */}
            <div data-name style={{ fontWeight: 800, fontSize: 13, lineHeight: "15px", height: 30, color: "#fff", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{String(row.name).replace(/\u00a0/g, " ")}</div>
            <div data-stock style={{ fontSize: 12.5, lineHeight: "14px", height: 14, fontWeight: 700, color: BLUE_L, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {row.sourceName} {row.stock}
            </div>
          </div>
          {/* SAME NAME ELSEWHERE: the other record's photo, no sentence. */}
          {row.twin && (
            <button type="button" data-same-name={row.twin} aria-label="Another record has this name — look at its photo" onClick={() => onPhoto?.(twinProduct || { id: row.twin })}
              style={{ width: 40, height: 40, borderRadius: 9, overflow: "hidden", padding: 0, marginLeft: 6, flexShrink: 0, background: "rgba(251,191,36,.12)", border: `2px solid ${AMBER}`, cursor: "zoom-in" }}>
              <PrimaryPhoto product={twinProduct || { id: row.twin }} productId={row.twin} alt="" width={36} height={36} style={{ width: 36, height: 36, objectFit: "cover", display: "block" }} />
            </button>
          )}
          {divisionLabel && (
            <button type="button" data-action="division" data-division-mark={divisionLabel.toLowerCase()} data-armed={armed || undefined}
              aria-label={armed ? `Tap again to move to ${divisionLabel}` : `Belongs to ${divisionLabel} only`} title={`This product belongs to ${divisionLabel} only`}
              onClick={tapDivision} style={divisionHit}>
              <span aria-hidden="true" style={{ ...divisionTag(busy === "division"), visibility: armed ? "hidden" : "visible" }}>{divisionLabel}</span>
              {armed && <span data-division-confirm aria-hidden="true" style={divisionConfirm}>Tap again to move to {divisionLabel}</span>}
              <span role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{armed ? `Tap again to move to ${divisionLabel}` : ""}</span>
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, height: BTN_H }}>
          {canAct && (Array.isArray(row.order) && row.order.length ? row.order : row.dests.map((d) => d.id)).map((id) => {
            const d = row.dests.find((x) => x.id === id);
            // ONE OWNER (Junid, 24 Nov 2026): where another shop owns the
            // product, a quiet note in the missing button's place — text, not
            // a button, so nothing on the card is ever disabled.
            if (!d) {
              const h = (row.held || []).find((x) => x.id === id);
              return h ? (
                <span key={id} data-held-for={h.owner} data-held-at={id} title={`One shop per product: this one is ${h.note}`}
                  style={heldNote}>{h.note}</span>
              ) : null;
            }
            const on = selected.includes(d.id);
            return (
              <button key={d.id} type="button" data-dest={d.id} aria-pressed={on} aria-label={d.name}
                onClick={() => { if (armed) disarm(); if (!busy) onPick?.(row, d.id); }} style={chip(on)}>
                {/* The tick sits at the chip's edge, so the name never moves when chosen. */}
                <span aria-hidden="true" style={{ position: "absolute", left: 3, top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 11, opacity: on ? 1 : 0 }}>✓</span>{d.name}
              </button>
            );
          })}
          {canAct && (
            <button type="button" data-action="solve" aria-disabled={!ready} aria-busy={busy || undefined}
              onClick={() => { if (armed) disarm(); if (ready) onSolve?.(row); }} style={solveBtn(ready, busy)}>
              {/* One word, always: a label that changed would move (busy = dimmed). */}
              Solve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(MissingRow);
