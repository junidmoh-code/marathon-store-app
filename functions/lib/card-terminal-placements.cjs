// ─── WHERE A TERMINAL STOOD, AND WHEN — the placement history ────────────────
// Junid, 17 Sep 2026: which till a speedpoint is on is CONFIGURATION with an
// effective-from time, never code. Rows under the registry entry:
//
//   /config/cardTerminals/{TID}/placements/{key}
//     → { storeId, tillId, effectiveFrom (ms), label, setAt, setBy?, note? }
//
// The row with the LATEST effectiveFrom not after a moment is where the
// machine stood at that moment. Entered from Card machines → settings →
// "Moved" (the cardTerminalAdmin callable, action "move").
//
// THE ROW'S OWN storeId STAYS THE FILING KEY. Batches are filed under
// /card_batches/{storeId}/{tid}; that never moves with the machine (a filing
// key that moved would strand every batch already filed). A placement in
// ANOTHER store is how a machine crosses shops without being retired —
// 5 Oct 2026, 12:46 SAST: 67325636 (Marathon PE Till 1) and 67377843 (Trophy
// Till 1) swapped tills.
//
// THE READER IS marathon-pos-app src/reports/cardrecon/placements.js, which
// reconciles each transaction on the till its terminal stood on at that
// transaction's time. Before a terminal's first placement it falls back to
// the till the batch record stamped at capture — history reads as it did.
//
// PURE: no firebase-admin, no clock. Tested in
// functions/test/card-terminal-placements.test.cjs.

"use strict";

/** The key a placement is stored under. Never integer-like (RTDB would make the map an array). */
function placementKey(effectiveFrom) {
  return `at-${effectiveFrom}`;
}

/** Every valid placement on a registry row, oldest first. */
function terminalPlacements(row) {
  const raw = row && row.placements;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .filter(([, p]) => p && typeof p === "object"
      && typeof p.storeId === "string" && p.storeId
      && typeof p.tillId === "string" && p.tillId
      && Number.isFinite(Number(p.effectiveFrom)))
    .map(([key, p]) => ({ ...p, key, effectiveFrom: Number(p.effectiveFrom) }))
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The placement in force at `atMs`, or null (none yet: the row's own till applies). */
function placementAt(row, atMs) {
  if (!Number.isFinite(atMs)) return null;
  let hit = null;
  for (const p of terminalPlacements(row)) {
    if (p.effectiveFrom <= atMs) hit = p; else break;
  }
  return hit;
}

/** Where the machine stood at `atMs`: its placement, else the row's own store and till. */
function tillAt(row, atMs) {
  const p = placementAt(row, atMs);
  return p ? { storeId: p.storeId, tillId: p.tillId, label: p.label || null }
    : { storeId: row && row.storeId, tillId: row && row.tillId, label: (row && row.label) || null };
}

/**
 * The placement that writes down where a row stands TODAY, for a row that has
 * none yet — so the first move records what it moved FROM. It starts at the
 * row's last known till move (`tillChangedAt`), else when the machine arrived
 * (`activeFrom`), else 0: before that, readers use each batch's own stamp.
 */
function seedPlacement(row) {
  const from = [row && row.tillChangedAt, row && row.activeFrom].map(Number).find(Number.isFinite) ?? 0;
  return {
    storeId: row.storeId, tillId: row.tillId, effectiveFrom: from,
    ...(row.label ? { label: row.label } : {}),
    note: "seeded from the registry row",
  };
}

module.exports = { placementKey, terminalPlacements, placementAt, tillAt, seedPlacement };
