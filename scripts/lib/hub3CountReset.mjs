// ─── HUB 3 COUNT RESET — the pure core + the apply (db injected) ─────────────
// Junid, 6 Nov 2026: Hub 3 is physically recounted from zero. Every Hub 3 stock
// cell goes to 0 (positives AND old negatives) through the existing server-side
// writer (functions/lib/admin-movement.cjs applyMovementAdmin — one transaction
// per cell, guarded by the exact qty this reset read), with a recoverable trail:
//   • a local file   scripts/out/hub3-before-<resetId>.json  (the whole before)
//   • RTDB           /settings/hubSneakerCount/resets/hub3/<resetId>
//   • the ledger     one `adjustment` per non-zero cell, reason
//                    "hub3_count_reset", link.countResetBefore = the qty it held
// then clears the count markers (counted/sessions/register for hub3) and
// confirms both count-mode flags are ON.
//
// SCOPE — ONE LOCATION. Every stock path this module writes is asserted to sit
// under stock/hub3/ before anything is written; a plan that would touch any
// other location is refused whole. Held shipments (stock/in_transit,
// settings/stockHold) are never read or written.
//
// db is a firebase-admin Database (or the test fake). Nothing here initialises
// an SDK.

export const HUB = "hub3";
export const REASON = "hub3_count_reset";
export const ACTOR = "system:hub3-count-reset";
export const COUNT_ROOT = "settings/hubSneakerCount";

const UNSAFE = /[.#$/\[\]\s]/;
const qtyOf = (cell) => (cell && typeof cell === "object" && typeof cell.qty === "number" ? cell.qty : null);
import { decodeSizeKey } from "../../src/utils/sizeKey.js";
export { decodeSizeKey };
export const movementIdFor = (resetId, pid, sizeKey) => `h3reset_${resetId}_${pid}_${sizeKey}`;

/** The before-state + the per-cell plan, from ONE read of /stock/hub3. */
export function planReset(hubStock, { resetId }) {
  const cells = [], skipped = [];
  let cellCount = 0, units = 0, positiveUnits = 0, negativeUnits = 0, positives = 0, negatives = 0;
  const nonZero = {};
  for (const [pid, sizes] of Object.entries(hubStock || {})) {
    if (!sizes || typeof sizes !== "object") { skipped.push({ pid, why: "row_not_object" }); continue; }
    for (const [sizeKey, cell] of Object.entries(sizes)) {
      if (cell == null) continue;   // RTDB array hole — no cell
      cellCount++;
      const q = qtyOf(cell);
      if (q === null) { skipped.push({ pid, sizeKey, why: "no_numeric_qty" }); continue; }
      units += q;
      if (q === 0) continue;
      if (UNSAFE.test(pid) || UNSAFE.test(sizeKey)) { skipped.push({ pid, sizeKey, qty: q, why: "unsafe_key" }); continue; }
      if (q > 0) { positives++; positiveUnits += q; } else { negatives++; negativeUnits += -q; }
      (nonZero[pid] ||= {})[sizeKey] = q;
      cells.push({
        pid, sizeKey, before: q,
        path: `stock/${HUB}/${pid}/${sizeKey}`,
        movementId: movementIdFor(resetId, pid, sizeKey),
      });
    }
  }
  return {
    resetId, hub: HUB, cells, skipped, nonZero,
    summary: { cells: cellCount, units, nonZeroCells: cells.length, positives, negatives, positiveUnits, negativeUnits },
  };
}

/** Refuse a plan that would write anywhere but stock/hub3/. */
export function assertOnlyHub3(plan) {
  const bad = plan.cells.filter((c) => !c.path.startsWith(`stock/${HUB}/`) || c.path.split("/").length !== 4);
  if (bad.length) throw new Error(`REFUSED: ${bad.length} planned write(s) outside stock/${HUB}/ — e.g. ${bad[0].path}`);
}

export function movementFor(c, { resetId, nowIso, before = c.before }) {
  return {
    type: "adjustment",
    productId: c.pid,
    size: decodeSizeKey(c.sizeKey),
    sizeKey: c.sizeKey,
    qty: Math.abs(before),
    from: before > 0 ? HUB : null,
    to: before < 0 ? HUB : null,
    reason: REASON,
    movementId: c.movementId,
    actor: ACTOR,
    actorRole: "admin",
    expectQty: before,
    ts: nowIso,
    link: { deviceId: null, countResetId: resetId, countLocation: HUB, countResetBefore: before, countSize: decodeSizeKey(c.sizeKey) },
  };
}

/**
 * Apply the plan. Each cell: applyMovementAdmin guarded by expectQty. A cell
 * that moved since the read (a sale in the gap) is re-read ALONE and retried
 * against its new qty (twice at most) — never a whole-node re-read.
 */
export async function applyReset({ db, plan, applyMovementAdmin, nowMs, concurrency = 8, log = () => {} }) {
  assertOnlyHub3(plan);
  const nowIso = new Date(nowMs).toISOString();
  const done = [], refused = [];
  let removed = 0, added = 0;
  const queue = [...plan.cells];
  async function one(c) {
    let before = c.before;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (before === 0) { done.push({ ...c, applied: 0, note: "already_zero" }); return; }
      const r = await applyMovementAdmin(db, movementFor(c, { resetId: plan.resetId, nowIso, before }), { nowIso });
      if (r.ok) {
        if (before > 0) removed += before; else added += -before;
        done.push({ ...c, applied: before, idempotent: !!r.idempotent });
        return;
      }
      if (r.reason !== "cell_changed") { refused.push({ ...c, reason: r.reason, r }); return; }
      const cur = (await db.ref(c.path).once("value")).val();
      const q = qtyOf(cur);
      if (q === null) { refused.push({ ...c, reason: "cell_gone" }); return; }
      log(`  moved since read: ${c.path} ${before} → ${q}, retrying`);
      before = q;
    }
    refused.push({ ...c, reason: "kept_moving" });
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  return { done, refused, removed, added };
}

/** Clear the count markers for Hub 3 and set both count-mode flags, one update. */
export function markerClearUpdate({ nowIso, by = ACTOR }) {
  return {
    [`${COUNT_ROOT}/counted/${HUB}`]: null,
    [`${COUNT_ROOT}/sessions/${HUB}`]: null,
    [`${COUNT_ROOT}/register/${HUB}`]: null,
    [`${COUNT_ROOT}/countMode/${HUB}`]: true,
    [`${COUNT_ROOT}/countModeMeta/${HUB}`]: { on: true, at: nowIso, by },
    [`config/refillEngine/pausedLocations/${HUB}`]: true,
  };
}

/**
 * Verify after apply. Reads /stock/hub3 once and the ledger row of each planned
 * cell by id. PASS when every planned cell either reads 0 or has moved on
 * since the reset (its mv is no longer the reset movement — a count or a sale
 * landed afterwards), AND the reset rows sum to the snapshot's non-zero total.
 */
export async function verifyReset({ db, plan }) {
  const stock = (await db.ref(`stock/${HUB}`).once("value")).val() || {};
  const problems = [];
  let ledgerNet = 0, rows = 0, laterMoved = 0, otherNonZero = 0;
  for (const c of plan.cells) {
    const cell = stock[c.pid] && stock[c.pid][c.sizeKey];
    const q = qtyOf(cell);
    const row = (await db.ref(`stock_movements/${c.movementId}`).once("value")).val();
    // A cell that was already 0 by the time the reset reached it (a sale in
    // the gap took it there) needs no movement — applied 0, no row.
    if (!row && c.applied === 0 && q === 0) continue;
    if (!row) { problems.push(`${c.path}: no reset movement ${c.movementId}`); continue; }
    rows++;
    const signed = row.to === HUB ? Number(row.qty) : -Number(row.qty);
    ledgerNet += signed;
    if (q === 0) continue;
    if (cell && cell.mv && cell.mv !== c.movementId) { laterMoved++; continue; }
    problems.push(`${c.path}: reads ${q} after reset`);
  }
  // Cells that were 0 at the snapshot and are non-zero now — a count since the
  // reset, never a reset failure. Reported, not failed.
  const planned = new Set(plan.cells.map((c) => `${c.pid}/${c.sizeKey}`));
  for (const [pid, sizes] of Object.entries(stock)) {
    for (const [k, cell] of Object.entries(sizes || {})) {
      if (cell == null || planned.has(`${pid}/${k}`)) continue;
      if (qtyOf(cell)) otherNonZero++;
    }
  }
  // Skipped at planning (unsafe key / no numeric qty) → never zeroed: a FAIL.
  for (const sk of plan.skipped || []) problems.push(`skipped at planning: ${sk.pid}/${sk.sizeKey ?? ""} (${sk.why})`);
  // Each row's qty is the before it actually zeroed (a moved cell was retried
  // against its new qty), so the reset rows sum to −(what they zeroed).
  const expectedNet = -plan.cells.reduce((t, c) => t + (c.applied ?? c.before), 0);
  if (ledgerNet !== expectedNet) problems.push(`ledger net ${ledgerNet} ≠ expected ${expectedNet}`);
  return { pass: problems.length === 0, problems, rows, ledgerNet, expectedNet, laterMoved, otherNonZero };
}
