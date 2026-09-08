// ─── DISPLAY ROW UI — the pieces both display tabs share ─────────────────────
//
// Two tabs ask opposite questions ("which wall has too many records" and "which
// wall has none") and reach for the same four things: a product photo, a size
// picker that never pre-selects, a readable row timeline, and the one sentence
// that says closing a record moves no stock. They live here so the two screens
// cannot drift into two different promises about what a tap does.

import React, { useState } from "react";
import { rowTimeline, OPEN_VIA_TEXT, closeEffectLine } from "./displayRowCore";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { CARD, BORDER, BLUE, BLUE_L, GREEN, GRAY, AMBER, FONT, bGray } from "./ui";

export const card = { background: CARD, border: BORDER, borderRadius: 15, padding: 14 };

/** How an actor reads. `system:pos_sale` is the till trigger naming itself; a
 *  bare uid is an account, shown short because the whole string is noise on a
 *  timeline and this app never claims to know which PERSON was at a device. */
const actorText = (by) => (String(by).startsWith("system:")
  ? String(by).slice(7).replace(/_/g, " ")
  : `account ${String(by).slice(0, 6)}`);

/** Product thumbnail, with the same shoe fallback DuplicatesTab uses. */
export function Photo({ url, size = 54 }) {
  if (url) {
    return <img src={url} alt="" loading="lazy"
      style={{ width: size, height: size, borderRadius: 10, objectFit: "cover", background: "rgba(255,255,255,.05)", flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.42, flexShrink: 0 }}>👟</div>
  );
}

/**
 * THE SIZE PICKER, AND THE ABSOLUTE RULE IT ENFORCES.
 *
 * (Owner directive, 2026-09-08.) Nothing here picks, guesses, suggests or
 * pre-selects a size. There is no `defaultSize` prop, no "last used", no "most
 * available", no highlight on the size the system happens to expect — because a
 * highlighted answer is the answer that gets confirmed, and the record then
 * says what the system assumed rather than what is on the wall.
 *
 * It opens with NOTHING chosen and the confirm button is dead until a human
 * touches a size. That is the whole contract, and it is a component rather than
 * three copies for exactly that reason.
 */
export function SizePicker({ sizes = [], onPick, onCancel, title, note, confirmLabel = "Confirm", busy = false }) {
  const [picked, setPicked] = useState(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{title}</div>
      {note && <div style={{ fontSize: 12, color: "rgba(233,238,255,.65)", lineHeight: 1.5 }}>{note}</div>}
      {sizes.length ? (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {sizes.map((sz) => {
            const on = picked === sz;
            return (
              <button key={sz} type="button" onClick={() => setPicked(sz)}
                style={{ padding: "11px 15px", borderRadius: 11, fontSize: 14, fontWeight: 800, cursor: "pointer", minWidth: 50,
                         fontFamily: FONT,
                         background: on ? BLUE : "rgba(74,127,255,.10)",
                         border: `2px solid ${on ? BLUE : "rgba(74,127,255,.30)"}`,
                         color: on ? "#fff" : BLUE_L }}>
                {formatSize(sz)}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: AMBER }}>
          This product has no sizes on record — fix the product first. Nothing here will invent one.
        </div>
      )}
      <div style={{ display: "flex", gap: 7 }}>
        <button type="button" disabled={!picked || busy} onClick={() => picked && onPick(picked)}
          style={{ ...bGray, borderColor: picked ? GREEN : "rgba(255,255,255,.14)",
                   color: picked ? GREEN : GRAY, opacity: busy ? 0.5 : 1,
                   cursor: picked && !busy ? "pointer" : "not-allowed" }}>
          {busy ? "Saving…" : picked ? `${confirmLabel} — size ${formatSize(picked)}` : "Pick a size"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} style={bGray}>Cancel</button>
      </div>
    </div>
  );
}

/** CLAUSE 6 — the row's own history, readable, from the row and nothing else. */
export function RowHistory({ row }) {
  const lines = rowTimeline(row);
  if (!lines.length) {
    return <div style={{ fontSize: 12, color: GRAY }}>No history recorded for this record.</div>;
  }
  return (
    <ol style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
      {lines.map((l, i) => (
        <li key={i} style={{ fontSize: 12, color: l.what === "closed" ? GRAY : "rgba(233,238,255,.75)", display: "flex", gap: 8 }}>
          <span style={{ color: "rgba(255,255,255,.35)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {String(l.at).slice(0, 16).replace("T", " ")}
          </span>
          <span>
            {l.text}
            {/* "sent … BY WHOM" — clause 6 asks for it, so it is rendered.
                A till or a trigger names itself ("system:pos_sale"); a person is
                an auth uid, because anonymous auth carries no email and this
                app's own convention is that attribution is an ACCOUNT, never a
                name. Showing the account is the honest version of "by whom";
                inventing a display name would not be.
                (Spec-conformance review.) */}
            {l.by ? <span style={{ color: "rgba(255,255,255,.35)" }}>{` · by ${actorText(l.by)}`}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A collapsible "history" affordance — clause 6 asks for it on both tabs. */
export function HistoryToggle({ row }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer",
                 color: BLUE_L, fontSize: 12, fontWeight: 700, fontFamily: FONT }}>
        {open ? "Hide history" : "History"}
      </button>
      {open && <RowHistory row={row} />}
    </div>
  );
}

/** One open row, described the way an operator standing at the wall reads it:
 *  the size, when it was registered, and where it came from. */
export function RowLine({ row }) {
  return (
    <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.72)" }}>
      Size <b style={{ color: "#fff" }}>{formatSize(row.size ?? row.sizeKey)}</b>
      {` · registered ${String(row.openedAt || "").slice(0, 10) || "date not recorded"}`}
      {` · ${OPEN_VIA_TEXT[row.openedVia] || "source not recorded"}`}
      {row.bookedHub ? ` · booked at ${labelFor(row.bookedHub)}` : " · no hub on the record"}
    </div>
  );
}

/** The one sentence, from the one place. */
export function NoStockMovedLine({ row }) {
  return (
    <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.7)", lineHeight: 1.45 }}>
      {closeEffectLine(row)}
    </div>
  );
}
