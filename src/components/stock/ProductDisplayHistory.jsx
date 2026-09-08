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
// ── COST — TWO KEYED READS, NOT THE NODE ─────────────────────────────────────
// One `get()` per display store at `/settings/displayRows/{store}/{productId}`,
// fired when a product is selected. Two small reads, each returning only this
// product's rows.
//
// It used to subscribe to the WHOLE of /settings/displayRows, and the comment
// justifying that ended "it cannot be a per-product read: RTDB cannot index
// across stores, and the node is store-major" — which contradicted the sentence
// four lines above it that described doing exactly this, and was simply wrong.
// The node being store-major is what MAKES the keyed read possible: store and
// product are both path segments, so the row set for one product at one store
// is a path, not a query. displayRowStore's own `rowsNow` has read it that way
// from the start, and closeDisplayRowForPartnerSale does it on the ordering
// screen for the same reason.
//
// The distinction mattered more here than anywhere else, because displayRows
// KEEPS EVERY CLOSED ROW FOREVER — each with its own events map — so unlike
// displaySlots it grows monotonically with every send. Reading the whole of a
// monotonically growing node to show one product was the one read on this
// feature that would get worse every day it ran. (Spec-conformance review.)
//
// A `get` rather than a subscription: this is a read-only history on a screen
// whose subject changes only when the operator picks a different product, and
// nothing on it writes a row.

import React, { useEffect, useMemo, useState } from "react";
import { get, ref } from "firebase/database";
import { database } from "../../firebase";
import { allRows, rowIsOpen, rowSegment, storeRowsPath, OPEN_VIA_TEXT, CLOSE_REASON_TEXT, rowSizeText } from "./displayRowCore";
import { RowHistory } from "./displayRowUi";
import { DISPLAY_STORES } from "./hubCleanupCore";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { BORDER, GREEN, GRAY, FONT } from "./ui";

export default function ProductDisplayHistory({ productId, registry }) {
  // Shaped as { [store]: { [productId]: { [rowId]: row } } } — the node's own
  // three levels — so `allRows`, the shared reader the tabs use, takes it
  // unchanged and there is no second traversal to keep in step with the first.
  const [rows, setRows] = useState({});
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!productId) { setRows({}); setSettled(false); return undefined; }
    let on = true;
    setSettled(false);
    (async () => {
      const out = {};
      // The SANITISED product segment, because that is the path the writers
      // wrote to — the same rule (and the same failure it prevents) as
      // displayRowStore's rowsNow. A product id that cannot be a key has no
      // rows rather than rows read from some other product's path.
      const pid = rowSegment(productId);
      if (pid) {
        await Promise.all(DISPLAY_STORES.map(async (store) => {
          const base = storeRowsPath(store);
          if (!base) return;
          try {
            const byRow = (await get(ref(database, `${base}/${pid}`))).val();
            if (byRow) out[store] = { [productId]: byRow };
          } catch { /* an unreadable store contributes nothing; the rest still show */ }
        }));
      }
      // `settled` goes true either way, so a product with no display history
      // shows its "never been on a wall" line instead of Loading… forever.
      if (on) { setRows(out); setSettled(true); }
    })();
    return () => { on = false; };
  }, [productId]);

  const mine = useMemo(() => {
    if (!productId) return [];
    return allRows(rows)
      .filter((r) => r.productId === productId)
      // Open first, then newest-CLOSED first. The comparator used openedAt for
      // everything, which sorts closed rows by when the pair went ON the wall
      // rather than when it came off — so a long-standing display that closed
      // yesterday sorted below a brief one that closed in June. A closed row's
      // own time is closedAt. (CodeRabbit.)
      .sort((a, b) => (rowIsOpen(b) ? 1 : 0) - (rowIsOpen(a) ? 1 : 0)
        // The `|| ""` wraps the WHOLE ternary. Left on the false branch only, an
        // open row with no openedAt stringified to "undefined", which sorts
        // above every ISO date and jumped it to the top instead of the bottom.
        // (Adversarial review of the fix round.)
        || String((rowIsOpen(b) ? b.openedAt : b.closedAt || b.openedAt) || "")
             .localeCompare(String((rowIsOpen(a) ? a.openedAt : a.closedAt || a.openedAt) || "")));
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
                  {open ? "On display now" : "Closed"} · {labelFor(r.store, registry)} · size {formatSize(rowSizeText(r))}
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
