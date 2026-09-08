// ─── ONE PRODUCT'S DISPLAY HISTORY ───────────────────────────────────────────
//
// (Owner spec clause 6, 2026-09-08: the timeline is "visible from both tabs AND
// FROM THE PRODUCT".)
//
// Read-only. Every display row this product has ever had, at every shop, open
// ones first, each with its own timeline: requested, sent with the size and by
// whom, closed with the reason.
//
// ── WHY IT LIVES ON THE LOCATOR AND NOT ON THE DISPLAY REGISTRY ──────────────
// The Display Registry (HubCleanup's Hub 1 / Hub 2 tabs) is where NEW STOCK
// gets registered and it is explicitly out of scope for this work — "stays as
// it is". The Locator is already the screen a person opens to ask "where is
// this shoe", answers it per location, and is read-only, which is exactly the
// shape of this question. So the display answer joins the stock answer instead
// of being bolted onto a write surface nobody was asked to touch.
//
// ── COST ─────────────────────────────────────────────────────────────────────
// One subscription to /settings/displayRows, and only while a product is
// selected — the same node and the same scale class as /settings/displaySlots,
// which several screens already stream. It is NOT a per-product read: RTDB
// cannot index across stores, and three shallow store nodes are the whole node.

import React, { useMemo } from "react";
import { allRows, rowIsOpen, rowTimeline, OPEN_VIA_TEXT, CLOSE_REASON_TEXT } from "./displayRowCore";
import { useDisplayRowsState } from "./useStock";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { BORDER, BLUE_L, GREEN, GRAY, FONT } from "./ui";

export default function ProductDisplayHistory({ productId, registry }) {
  const { value: rows, settled } = useDisplayRowsState(!!productId);

  const mine = useMemo(() => {
    if (!productId) return [];
    return allRows(rows)
      .filter((r) => r.productId === productId)
      // Open first, then newest-closed first — what is on a wall now matters
      // more than what was on one in July.
      .sort((a, b) => (rowIsOpen(b) ? 1 : 0) - (rowIsOpen(a) ? 1 : 0)
        || String(b.openedAt || "").localeCompare(String(a.openedAt || "")));
  }, [rows, productId]);

  if (!productId) return null;

  return (
    <div style={{ fontFamily: FONT, marginTop: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: GRAY, letterSpacing: ".6px", textTransform: "uppercase", marginBottom: 8 }}>
        Display history
      </div>
      {!settled ? (
        <div style={{ fontSize: 12.5, color: GRAY }}>Loading…</div>
      ) : mine.length === 0 ? (
        <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.5 }}>
          This product has never been registered on a shop's display wall — or its display predates the
          record. Nothing here moves stock either way.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {mine.map((r) => {
            const open = rowIsOpen(r);
            return (
              <div key={`${r.store}/${r.rowId}`}
                   style={{ border: BORDER, borderRadius: 12, padding: 11, background: "rgba(255,255,255,.02)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: open ? GREEN : GRAY }}>
                  {open ? "On display now" : "Closed"} · {labelFor(r.store, registry)} · size {formatSize(r.size ?? r.sizeKey)}
                  {!open && r.closedReason ? ` · ${CLOSE_REASON_TEXT[r.closedReason] || r.closedReason}` : ""}
                </div>
                <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.5)", marginTop: 2 }}>
                  {OPEN_VIA_TEXT[r.openedVia] || "source not recorded"}
                  {r.bookedHub ? ` · booked at ${labelFor(r.bookedHub, registry)}` : ""}
                </div>
                <ol style={{ margin: "7px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                  {rowTimeline(r).map((l, i) => (
                    <li key={i} style={{ fontSize: 11.5, color: l.what === "closed" ? GRAY : BLUE_L, display: "flex", gap: 8 }}>
                      <span style={{ color: "rgba(255,255,255,.3)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                        {String(l.at).slice(0, 16).replace("T", " ")}
                      </span>
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
