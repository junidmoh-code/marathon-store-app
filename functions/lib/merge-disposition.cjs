// ─── WHAT HAPPENS TO A LOSER'S CELL — the merge decides, it does not ask ──────
// (Owner spec 2026-08-23.) A merge joins a DUPLICATE RECORD into the record the
// shop actually counts against. The duplicate's units are not extra shoes: at a
// location that has been counted, the physical pairs on that shelf were counted
// ONCE, under whichever record the counter resolved to. If we transferred the
// duplicate's booked quantity on top of that count, the location's total would
// double-count every one of those pairs.
//
// So each of the loser's cells gets one of two dispositions, worked out from
// the count state alone — no question, no toggle, no hub named in code:
//
//   TRANSFER  the quantity moves onto the survivor's cell at the SAME location
//             and size, exactly as a merge has always done. Totals at that
//             location are conserved to the unit, sign included.
//   REMOVE    the quantity is written off the loser through an adjustment
//             movement and does NOT arrive on the survivor. The units are
//             already inside the survivor's counted number.
//
// ── WHAT "COUNTED" IS, AND AT WHICH GRANULARITY ──────────────────────────────
// The only record in this system that establishes a physical count is the hub
// count's per-CELL record:
//
//   /settings/hubSneakerCount/sessions/{loc}          → { sessionId, … }
//   /settings/hubSneakerCount/counted/{loc}/{sid}/{productId}::{sizeKey}
//                                                     → { action, actual, at,
//                                                         settled, staleAt? }
//
// That is PRODUCT + SIZE + LOCATION — finer than the location, finer than the
// product, and it is what this module uses. There is no "this location is
// finished" flag anywhere in the data (the session carries doneCells/totalCells
// progress, nothing more), so a location-level rule would have needed a
// threshold invented here. A per-cell rule needs no threshold at all: a hub
// that has counted nothing has no counted cells and everything transfers; a hub
// that finishes counting starts removing, cell by cell, on its own.
//
// A cell counts as COUNTED on exactly the test the count screen itself uses for
// its "N of M" progress (src/components/stock/hubCountCore.js recordIsCurrent):
// a record exists and has not been staled by a release. `settled === false` is
// additionally excluded here — an unsettled record means a human still has to
// walk back to that shelf, and an unverified count must never authorise a
// write-off.
//
// ── THE TWO-SIDED RULE, AND WHY THE LOSER SIDE COMES FIRST ───────────────────
//   1. the LOSER's own cell is counted  → TRANSFER.
//      A human physically counted units UNDER THIS RECORD. Those pairs are real
//      and were not counted under the survivor. Removing them would destroy a
//      verified count, which this module will never do.
//   2. else the SURVIVOR's cell at the same location+size is counted → REMOVE.
//      The shelf was counted and the pairs landed on the survivor's number.
//   3. else → TRANSFER.
//      Nobody counted this location+size on either record. Nothing is known, so
//      nothing is destroyed: the merge behaves exactly as it always has.
//
// Every branch that is uncertain transfers. Removal happens only on positive
// evidence that the same shelf, in the same size, was counted under the record
// that survives.
//
// MIRROR: src/components/stock/mergeDisposition.js — KEEP THE TWO IN SYNC. The
// client renders the outcome per location BEFORE the operator confirms, and the
// server decides it again from its own reads; a disagreement would show one
// thing and do another. test/merge-disposition-differential.test.cjs runs both
// copies over the same randomised worlds for exactly that reason.

"use strict";

const COUNT_SESSIONS_PATH = "settings/hubSneakerCount/sessions";
const COUNTED_PATH = "settings/hubSneakerCount/counted";

/** The count record's key for one cell — byte-identical to hubCountCore.cellKey. */
function countCellKey(productId, sizeKey) {
  return `${productId}::${sizeKey}`;
}

/**
 * Is this count record a usable, current count?
 * Mirrors hubCountCore.recordIsCurrent, plus the unsettled exclusion.
 */
function countRecordCounts(rec) {
  return !!rec && !rec.staleAt && rec.settled !== false;
}

/**
 * Every cell key counted (and still current) in one location's session node.
 * @param {object|null} countedNode  /settings/hubSneakerCount/counted/{loc}/{sid}
 * @returns {Set<string>}
 */
function countedCellKeys(countedNode) {
  const out = new Set();
  for (const [key, rec] of Object.entries(countedNode || {})) {
    if (countRecordCounts(rec)) out.add(key);
  }
  return out;
}

/**
 * THE DECISION for one cell.
 * @param {object} args
 *   loserId, survivorId, sizeKey
 *   countedKeys   Set<string> of counted cell keys AT THIS LOCATION (may be empty)
 * @returns {"transfer"|"remove"}
 */
function dispositionForCell({ loserId, survivorId, sizeKey, countedKeys }) {
  const keys = countedKeys instanceof Set ? countedKeys : new Set();
  if (keys.has(countCellKey(loserId, sizeKey))) return "transfer";
  if (keys.has(countCellKey(survivorId, sizeKey))) return "remove";
  return "transfer";
}

/**
 * The whole plan, per location — what the confirm screen states and what the
 * commit does, from the same function.
 *
 * @param {object} args
 *   loserId, survivorId
 *   loserCells   { loc: { sizeKey: {qty,…} } }  — size cells only, no _meta
 *   countedByLoc { loc: Set<string> }           — counted cell keys per location
 * @returns {Array<{loc, transfer: Array<{sizeKey, qty}>, remove: Array<{sizeKey, qty}>,
 *                  transferQty, removeQty}>}  locations in stable (sorted) order
 */
function planMerge({ loserId, survivorId, loserCells, countedByLoc }) {
  const out = [];
  for (const loc of Object.keys(loserCells || {}).sort()) {
    const cells = loserCells[loc] || {};
    const countedKeys = (countedByLoc && countedByLoc[loc]) || new Set();
    const transfer = [];
    const remove = [];
    for (const sizeKey of Object.keys(cells).sort()) {
      const cell = cells[sizeKey];
      const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      if (qty === 0) continue;               // the node delete takes empty cells
      const d = dispositionForCell({ loserId, survivorId, sizeKey, countedKeys });
      (d === "remove" ? remove : transfer).push({ sizeKey, qty });
    }
    if (!transfer.length && !remove.length) continue;
    out.push({
      loc, transfer, remove,
      transferQty: transfer.reduce((n, c) => n + c.qty, 0),
      removeQty: remove.reduce((n, c) => n + c.qty, 0),
    });
  }
  return out;
}

module.exports = {
  COUNT_SESSIONS_PATH, COUNTED_PATH,
  countCellKey, countRecordCounts, countedCellKeys, dispositionForCell, planMerge,
};
