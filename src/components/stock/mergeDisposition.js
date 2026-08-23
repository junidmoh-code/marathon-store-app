// ─── WHAT HAPPENS TO A LOSER'S CELL — the client's half of the merge plan ─────
// MIRROR: functions/lib/merge-disposition.cjs — KEEP THE TWO IN SYNC.
// That file carries the full reasoning: why a counted shelf means the
// duplicate's units are already inside the survivor's number, why the rule is
// per-CELL (product + size + location, the finest record that exists), and why
// every uncertain branch transfers rather than removes.
//
// This copy exists so the confirm screen can STATE the outcome per location in
// plain words before anyone taps MERGE. The server decides it again from its
// own reads — the client's preview is never the authority — and
// functions/test/merge-disposition-differential.test.cjs fuzzes both copies
// over the same worlds so they cannot drift apart silently.
//
// The counted state reaches this module as a Set of cell keys per location.
// Fetching it is mergeDispositionStore.js's job, and it is deliberately a
// RANGED read per product (orderByKey over the "{pid}::" prefix), never the
// whole counted node — hub 1's is a third of a megabyte.

export const COUNT_SESSIONS_PATH = "settings/hubSneakerCount/sessions";
export const COUNTED_PATH = "settings/hubSneakerCount/counted";

/** The count record's key for one cell — byte-identical to hubCountCore.cellKey. */
export function countCellKey(productId, sizeKey) {
  return `${productId}::${sizeKey}`;
}

/** Is this count record a usable, current count? (recordIsCurrent + settled)
 *  A "flag" record COUNTS — the shelf was physically counted, only the stock
 *  correction is pending an admin; see the server copy for the full reasoning. */
export function countRecordCounts(rec) {
  return !!rec && !rec.staleAt && rec.settled !== false;
}

/** Every cell key counted (and still current) in one location's session node. */
export function countedCellKeys(countedNode) {
  const out = new Set();
  for (const [key, rec] of Object.entries(countedNode || {})) {
    if (countRecordCounts(rec)) out.add(key);
  }
  return out;
}

/** THE DECISION for one cell → "transfer" | "remove". */
export function dispositionForCell({ loserId, survivorId, sizeKey, countedKeys }) {
  const keys = countedKeys instanceof Set ? countedKeys : new Set();
  if (keys.has(countCellKey(loserId, sizeKey))) return "transfer";
  if (keys.has(countCellKey(survivorId, sizeKey))) return "remove";
  return "transfer";
}

/** The whole plan, per location. See the .cjs mirror for the returned shape. */
export function planMerge({ loserId, survivorId, loserCells, countedByLoc }) {
  const out = [];
  for (const loc of Object.keys(loserCells || {}).sort()) {
    const cells = loserCells[loc] || {};
    const countedKeys = (countedByLoc && countedByLoc[loc]) || new Set();
    const transfer = [];
    const remove = [];
    for (const sizeKey of Object.keys(cells).sort()) {
      const cell = cells[sizeKey];
      const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      if (qty === 0) continue;
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

// ─── THE SENTENCE THE SCREEN SHOWS ───────────────────────────────────────────
// Owner spec, verbatim: "6 pairs at Hub 1 will be removed — already counted
// under this product", "16 at Central will move across". Plain words, per
// location, with the before/after totals beside them. No choice, no toggle.
export function outcomeLines(row, locLabel) {
  const lines = [];
  // Gated on the CELL LISTS, not the quantity sums: two removed cells at one
  // location can cancel (+3 in a 9, −3 in a 10, both counted under the
  // survivor), the sum is 0, and the screen would then say nothing about a
  // location the merge still writes off. A list is non-empty exactly when the
  // disposition applies.
  if (row.remove.length) {
    lines.push({
      kind: "remove",
      text: `${row.removeQty} at ${locLabel} will be removed — already counted under this product`,
    });
  }
  if (row.transfer.length) {
    lines.push({
      kind: "transfer",
      text: `${row.transferQty} at ${locLabel} will move across`,
    });
  }
  return lines;
}
