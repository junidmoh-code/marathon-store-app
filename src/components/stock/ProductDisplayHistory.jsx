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
// ── COST, STATED HONESTLY ────────────────────────────────────────────────────
// One subscription to the WHOLE of /settings/displayRows, mounted only while a
// product is selected and torn down when the operator taps Change.
//
// It is NOT the same scale class as /settings/displaySlots, and an earlier
// version of this comment said it was. displaySlots holds one flat record per
// (store, product) and is overwritten in place; displayRows KEEPS EVERY CLOSED
// ROW FOREVER, each carrying its own events map, so it grows monotonically with
// every send. Today that is ~460 open rows and no closed ones; at roughly a
// dozen sends a day it is a few thousand small records a year, which is still a
// small node — but it is a growing one, and the honest statement is "small and
// growing", not "the same as the slot node". (Independent second-brain review.)
//
// If it ever stops being small the fix is a per-store read here (the Locator
// knows no store, so it would have to read all three) or an archive of closed
// rows older than a year. Neither is needed yet, and neither should be built
// before the node is actually big.
//
// It cannot be a per-product read: RTDB cannot index across stores, and the
// node is store-major.

import React, { useMemo } from "react";
import { allRows, rowIsOpen, OPEN_VIA_TEXT, CLOSE_REASON_TEXT } from "./displayRowCore";
import { RowHistory } from "./displayRowUi";
import { useDisplayRowsState } from "./useStock";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { BORDER, GREEN, GRAY, FONT } from "./ui";

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
                {/* THE SHARED timeline, not a third copy of it. This surface
                    rendered its own list and left `by` out, so the product view
                    silently dropped the "and by whom" half of clause 6 that the
                    two tabs render. One component, one answer.
                    (Independent second-brain review.) */}
                <RowHistory row={r} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
