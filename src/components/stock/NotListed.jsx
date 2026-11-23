// ─── MISSING PRODUCTS — "NOT LISTED" (Junid, 23 Nov 2026) ─────────────────────
// "Nothing disappears silently." A product with stock at Central that no shop
// or hub of the division holds is either a card on the list, or here, with
// the reason in a few words (notListedCore.js decides the rows; this file
// only draws them).
//
//   NotListedLine   one small line at the very bottom of the list:
//                   "Not listed: N". Below the cards — nothing above them moves.
//   NotListed       the plain list it opens: photo, name, Central quantity,
//                   reason, and — where Junid can act from here — the action.
//
// The actions write only what the screen already wrote elsewhere: Unhide
// (the hidden tab's own update) and Unmark (the division button's own marks).
// Anything that needs a policy or a seat opens the Engine Policy card; this
// screen never sets one.
import React, { memo } from "react";
import { FONT, GRAY, BLUE_L, AMBER } from "./ui";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";

export const NOT_LISTED_LINE_H = 40;
const ROW_H = 56;
const PHOTO = 44;

export function NotListedLine({ n, onOpen }) {
  return (
    <button type="button" data-not-listed-line={n} onClick={onOpen}
      style={{ display: "block", width: "100%", height: NOT_LISTED_LINE_H, marginTop: 6, padding: 0, border: "none", background: "none",
        color: "rgba(255,255,255,.42)", fontFamily: FONT, fontSize: 12.5, fontWeight: 700, textAlign: "center", cursor: "pointer",
        WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
      Not listed: <span style={{ fontVariantNumeric: "tabular-nums" }}>{n}</span>
    </button>
  );
}

// What can be done about a reason from this screen, if anything.
//   unhide       Hidden → Unhide (the hidden tab's own write)
//   unmark       Marked for the other division → Unmark (the division button's write)
//   policy       needs Junid's numbers or seats → open the Engine Policy card
export function actionFor(reason) {
  if (reason === "hidden") return "unhide";
  if (reason === "markedConcrete" || reason === "markedMarathon") return "unmark";
  if (reason === "noPolicy" || reason === "noSize" || reason === "emptyRows" || reason === "bothShops") return "policy";
  return null;
}
const ACTION_LABEL = { unhide: "Unhide", unmark: "Unmark", policy: "Engine Policy" };

const Row = memo(function Row({ row, product, can, busy, onAct }) {
  const act = actionFor(row.reason);
  const allowed = act && can[act];
  return (
    <div data-not-listed-row={row.pid} data-reason={row.reason}
      style={{ height: ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 10, padding: "6px 6px 6px 6px",
        borderBottom: "1px solid rgba(255,255,255,.06)", fontFamily: FONT }}>
      <div style={{ width: PHOTO, height: PHOTO, borderRadius: 9, overflow: "hidden", background: "rgba(255,255,255,.05)", flexShrink: 0 }}>
        <PrimaryPhoto product={product} productId={row.pid} snapshot={row.photo || null} alt="" width={PHOTO} height={PHOTO} style={{ width: PHOTO, height: PHOTO, objectFit: "cover", display: "block" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</div>
        <div style={{ fontSize: 12, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color: "rgba(255,255,255,.7)", fontVariantNumeric: "tabular-nums" }}>Central {row.centralUnits}</span>
          {" · "}<span data-reason-text style={{ color: row.group === "chosen" ? GRAY : AMBER }}>{row.text}</span>
        </div>
      </div>
      {allowed && (
        <button type="button" data-action={`not-listed-${act}`} disabled={!!busy} onClick={() => onAct(act, row)}
          style={{ height: 40, padding: "0 12px", borderRadius: 10, flexShrink: 0, fontFamily: FONT, fontSize: 12.5, fontWeight: 800, cursor: busy ? "default" : "pointer",
            background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.3)", color: BLUE_L, opacity: busy ? 0.6 : 1,
            WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>{busy ? "…" : ACTION_LABEL[act]}</button>
      )}
    </div>
  );
});

/**
 * rows    notListedRows(…) for this division (already narrowed by the search)
 * byId    Map pid → product
 * can     { unhide, unmark, policy } — what this viewer may do
 * busy    { pid: true } while that row's action is written
 * onAct   (action, row) → void
 */
export default function NotListed({ rows = [], byId, can = {}, busy = {}, onAct, limit = 200, onMore }) {
  if (!rows.length) return <div data-not-listed-empty style={{ padding: 18, color: GRAY, fontSize: 14, fontFamily: FONT }}>Every product Central holds for this division is on the list.</div>;
  return (
    <div data-not-listed>
      {rows.slice(0, limit).map((r) => <Row key={r.pid} row={r} product={byId.get(r.pid)} can={can} busy={!!busy[r.pid]} onAct={onAct} />)}
      {rows.length > limit && (
        <button type="button" data-action="not-listed-more" onClick={onMore}
          style={{ display: "block", width: "100%", height: 44, marginTop: 6, borderRadius: 11, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.03)", color: "rgba(255,255,255,.6)", fontFamily: FONT, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>More</button>
      )}
    </div>
  );
}
