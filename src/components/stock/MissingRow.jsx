// ─── MISSING PRODUCTS — THE CARD (Junid, 22 Nov 2026) ─────────────────────────
// One fixed-size card. A photo big enough to know the product, its name, one
// stock line, and the destinations as buttons ON the card: tapping one IS the
// solve. No second step, no panel, no sentence.
//
// NOTHING HERE CHANGES SIZE. The card is CARD_H tall whatever its name, however
// many destinations it has and whatever state a button is in; a card still
// being worked out is a skeleton of the same box. The only movement on the
// screen is a card LEAVING: its slot closes in one transition (Slot), and the
// cards below move up once.
import React, { memo, useEffect, useState } from "react";
import { FONT, GREEN, BLUE_L, AMBER } from "./ui";
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
const destBtn = (live, pressed) => ({
  flex: 1, minWidth: 0, height: 48, borderRadius: 13, fontFamily: FONT, fontSize: 16, fontWeight: 800,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 8px",
  cursor: live ? "pointer" : "default", WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: pressed ? "rgba(74,222,128,.34)" : live ? "rgba(74,222,128,.14)" : "rgba(255,255,255,.02)",
  border: `1px solid ${live ? "rgba(74,222,128,.5)" : "rgba(255,255,255,.07)"}`,
  color: live ? GREEN : "rgba(255,255,255,.22)",
});
const hideBtn = (live) => ({
  width: 62, flexShrink: 0, height: 48, borderRadius: 13, fontFamily: FONT, fontSize: 13.5, fontWeight: 700,
  cursor: live ? "pointer" : "default", WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
  background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: live ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.2)",
});

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
 * row       missingListCore's row
 * busy      the destination id a tap is being written for (or null)
 * canAct    the viewer may solve / hide
 * onTap     (row, destId)   onHide (row)   onPhoto (product)
 */
function MissingRow({ row, product, twinProduct, busy = null, canAct = true, onTap, onHide, onPhoto }) {
  const live = product || { id: row.pid, photoUrl: row.photo };
  return (
    <div data-card={row.pid} data-card-name={row.name} data-card-kind={row.kind} style={shell}>
      <div style={{ display: "flex", gap: 12, height: PHOTO }}>
        <button type="button" aria-label="Look at the photo" onClick={() => onPhoto?.(live)}
          style={{ position: "relative", width: PHOTO, height: PHOTO, borderRadius: 13, flexShrink: 0, overflow: "hidden", border: "none", padding: 0, background: "rgba(60,110,255,.1)", cursor: "zoom-in" }}>
          <PrimaryPhoto product={live} productId={row.pid} snapshot={row.photo || null} alt="" width={PHOTO} height={PHOTO} style={{ width: PHOTO, height: PHOTO, objectFit: "cover", display: "block" }} />
        </button>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div data-name style={{ fontWeight: 800, fontSize: 16, lineHeight: "20px", height: 40, color: "#fff", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{String(row.name).replace(/\u00a0/g, " ")}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 36 }}>
            <div data-stock style={{ fontSize: 15, fontWeight: 700, color: BLUE_L, whiteSpace: "nowrap" }}>
              {row.sourceName} {row.stock}{row.needsPolicy && <span data-needs-policy style={{ color: AMBER, marginLeft: 8 }}>No policy yet</span>}
            </div>
            {/* SAME NAME ELSEWHERE: the other record's photo, no sentence. */}
            {row.twin && (
              <button type="button" data-same-name={row.twin} aria-label="Another record has this name — look at its photo" onClick={() => onPhoto?.(twinProduct || { id: row.twin })}
                style={{ width: 36, height: 36, borderRadius: 9, overflow: "hidden", padding: 0, flexShrink: 0, background: "rgba(251,191,36,.12)", border: `2px solid ${AMBER}`, cursor: "zoom-in" }}>
                <PrimaryPhoto product={twinProduct || { id: row.twin }} productId={row.twin} alt="" width={32} height={32} style={{ width: 32, height: 32, objectFit: "cover", display: "block" }} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, height: 48 }}>
        {row.dests.map((d) => {
          const on = d.ok && canAct && !busy;
          return (
            <button key={d.id} type="button" data-dest={d.id} disabled={!on} aria-busy={busy === d.id || undefined} aria-label={`Send to ${d.name}`}
              onClick={() => onTap?.(row, d.id)} style={destBtn(d.ok && canAct, busy === d.id)}>{d.name}</button>
          );
        })}
        <button type="button" data-action="hide" disabled={!canAct || !!busy} onClick={() => onHide?.(row)} style={hideBtn(canAct && !busy)}>Hide</button>
      </div>
    </div>
  );
}

export default memo(MissingRow);
