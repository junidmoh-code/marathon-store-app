// ─── ALREADY IN STOCK — the client half of the satisfied-request rule ─────────
// A refill request asks for units at a destination. Once those units are THERE,
// the ask is answered — and it does not matter one bit how they arrived. A
// manual Transfer, a supplier receive, a customer return and a picked refill are
// all the same fact to the person looking at the shelf.
//
// The DURABLE half of this rule is server-side: `satisfiedClosures` in
// functions/lib/refill-engine.cjs withdraws the request for real (status
// cancelled, cancelReason "already_in_stock") on the next scan. Read the long
// note there for the full reasoning, including why it cannot churn.
//
// THIS file exists only so the queue does not show 15 minutes of work that is
// already done. It hides nothing and decides nothing on its own: a covered
// request is moved out of the actionable cards into a labelled "already covered"
// line that says exactly what will happen to it. If this file and the engine
// ever disagreed, the engine wins — the request simply stays open and reappears
// as work, which is the safe direction to be wrong in.
//
// ONE UNIT SATISFIES ONE REQUEST. The allocation is oldest-request-first, the
// same order and the same tie-break the engine uses, so two sibling requests on
// one cell can never both be retired by the same physical pair. Getting this
// wrong is not cosmetic: it would tell Central that a size needing 2 more pairs
// was fully handled.

import { stockSizeKey } from "../../utils/sizeKey";

// Units on hand in one destination cell, floored at zero. Negative cells are an
// oversell signal, never available stock (same `avail()` rule as the engine).
//
// `cells` is the DECODED map useStockCells() returns — keyed by the raw size
// ("5.5"), not the stored key ("5_5"). Sizes are matched by re-encoding both
// sides through stockSizeKey so a decoded "5.5" and a request's "5.5" meet even
// if one side ever arrives as a number.
export function onHandFor(cells, size) {
  const want = stockSizeKey(size);
  for (const [k, cell] of Object.entries(cells || {})) {
    if (k === "_meta") continue;
    if (stockSizeKey(k) === want) return Math.max(Number(cell?.qty) || 0, 0);
  }
  return 0;
}

/**
 * Split open requests for ONE destination into work that is still real and work
 * the shelf has already answered.
 *
 * @param requests open /refill_requests rows for this destination (any order).
 * @param destCells useStockCells(dest) — { productId: { size: cell } }, decoded.
 * @returns { actionable, covered } — `covered` rows carry `onHand`, what the
 *          cell held when they were judged, so the UI can state the evidence
 *          rather than just asserting the request is done.
 */
export function partitionSatisfied(requests = [], destCells = {}) {
  const ordered = [...(requests || [])]
    .filter((r) => r && r.productId && r.size != null)
    // Oldest first, id as the tie-break — the engine stamps a whole run with one
    // createdAt, so without the second key the split would be order-dependent.
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));

  const claimed = new Map();
  const actionable = [];
  const covered = [];
  for (const r of ordered) {
    const onHand = onHandFor(destCells?.[r.productId], r.size);
    const key = `${r.productId}|${stockSizeKey(r.size)}`;
    const want = Math.max(Number(r.qty) || 1, 1);
    const free = onHand - (claimed.get(key) || 0);
    if (free >= want) {
      claimed.set(key, (claimed.get(key) || 0) + want);
      covered.push({ ...r, onHand });
    } else {
      actionable.push(r);
    }
  }
  return { actionable, covered };
}
