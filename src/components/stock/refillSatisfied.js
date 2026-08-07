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

// ─── THE ENGINE'S ENCODER, MIRRORED ──────────────────────────────────────────
// encodeSizeKey() in functions/lib/refill-engine.cjs. It is NOT stockSizeKey:
// it has no "Free Size" fold, so the engine reads the cell "Free_Size" where the
// client reads "_". Both agree on "" and on the "_" sentinel; "Free Size" is the
// single divergence, and it is the Free_Size phantom-cell bug all over again.
//
// This exists so the client can ASK whether the engine would see the same cell,
// and decline to promise a withdrawal it cannot deliver — see coverableSize().
const engineSizeKey = (size) => {
  const s = String(size == null ? "" : size).trim();
  if (!s) return "_";
  return s.replace(/[.#$/[\]\s]/g, "_");
};

// Can this size be marked "already covered"? Only when the client and the engine
// resolve it to the SAME cell. Where they disagree the client would hide the
// card while the engine could never withdraw the request — an immortal open row,
// which is the exact bug class this whole change exists to remove. Silence is
// the safe direction: the request simply stays visible as work.
export const coverableSize = (size) => engineSizeKey(size) === stockSizeKey(size);

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
 * @param lockedIds refillIds that hold a lock in /refill_engine/open.
 * @returns { actionable, covered } — `covered` rows carry `onHand`, what the
 *          cell held when they were judged, so the UI can state the evidence
 *          rather than just asserting the request is done.
 *
 * ─── LOCKED REQUESTS ARE NEVER "COVERED" ───────────────────────────────────
 * This is the asymmetry that made the first version of this file wrong, and it
 * is worth stating at length because it is subtle and it self-conceals.
 *
 * The engine refuses to withdraw a LOCKED request on raw quantity, because
 * `needGone` nets the cell against the approved TARGET and other inbound. A
 * request of qty 2 against a target of 3, on a cell holding 2, is STILL REAL
 * WORK — one unit short of target. The engine keeps it, correctly.
 *
 * Without this exclusion the client did exactly what the engine refuses to do:
 * `free >= want` (2 >= 2) moved that card out of the queue into "already
 * covered". The engine would never withdraw it (target unmet), the deficit loop
 * would never re-raise it (the live lock is counted as inbound), and the picker
 * could no longer see it. The note even promised the engine would withdraw it —
 * a promise that would never come true. The hub sits one unit under target
 * forever with no visible work anywhere.
 *
 * So: this partition covers ONLY what the engine's satisfiedClosures pass would
 * genuinely withdraw. Same population, same allocation, same answer.
 *
 * Locked requests still hold their units. A lock means "these units are spoken
 * for", so they are claimed BEFORE anything else is judged — otherwise an
 * unlocked sibling could be retired against stock the locked request is already
 * counting on. Being over-conservative here costs a visible card; being
 * under-conservative loses an ask that nothing will ever raise again.
 */
export function partitionSatisfied(requests = [], destCells = {}, lockedIds = new Set()) {
  const isLocked = (r) => lockedIds.has(r.id);
  const claimed = new Map();
  const cellKey = (r) => `${r.productId}|${stockSizeKey(r.size)}`;
  for (const r of requests || []) {
    if (!r || !r.productId || r.size == null || !isLocked(r)) continue;
    const k = cellKey(r);
    claimed.set(k, (claimed.get(k) || 0) + Math.max(Number(r.qty) || 1, 1));
  }

  // EVERY ROW LANDS SOMEWHERE. This function partitions a queue, so a row it
  // cannot classify must fall to `actionable` — still visible as work — not out
  // of both lists. The engine has the same `size != null` guard, but there a
  // skip means "no withdrawal", which is safe; here a skip would delete the card
  // from the only screen that shows it, and nothing else would ever surface it.
  // (CodeRabbit, PR #332 — it also caught that the old test PINNED the wrong
  // behaviour by asserting both lists were empty.)
  const classifiable = (r) => r && r.productId && r.size != null;
  const ordered = [...(requests || [])]
    .filter((r) => classifiable(r) && !isLocked(r))
    // Oldest first, id as the tie-break — the engine stamps a whole run with one
    // createdAt, so without the second key the split would be order-dependent.
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));

  const actionable = [];
  const covered = [];
  for (const r of ordered) {
    const onHand = onHandFor(destCells?.[r.productId], r.size);
    const key = cellKey(r);
    const want = Math.max(Number(r.qty) || 1, 1);
    const free = onHand - (claimed.get(key) || 0);
    if (coverableSize(r.size) && free >= want) {
      claimed.set(key, (claimed.get(key) || 0) + want);
      covered.push({ ...r, onHand });
    } else {
      actionable.push(r);
    }
  }
  // Locked requests were removed before the split; they are always real work.
  // So is anything unclassifiable — see the note above. Together with `ordered`
  // this covers every input row exactly once, which is the invariant the tests
  // assert: nothing a queue was given may silently disappear from it.
  for (const r of requests || []) {
    if (!r) continue;
    if (isLocked(r) || !classifiable(r)) actionable.push(r);
  }
  return { actionable, covered };
}

/** refillIds holding a lock in /refill_engine/open — the shape useEngineOpen() returns. */
export function lockedRefillIds(openIndex) {
  const out = new Set();
  for (const byPid of Object.values(openIndex || {})) {
    for (const bySize of Object.values(byPid || {})) {
      for (const entry of Object.values(bySize || {})) if (entry?.refillId) out.add(entry.refillId);
    }
  }
  return out;
}
