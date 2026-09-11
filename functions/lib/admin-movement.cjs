// ─── applyMovementAdmin — the server-side stock writer ───────────────────────
// The canonical writer is a CLIENT module (src/components/stock/applyMovement.js):
// it imports the client firebase handle and stamps auth.currentUser, so a
// Cloud Function cannot call it. This reproduces its CONTRACT, field for field,
// the way scripts/lib/headwearCollapseCore.mjs does for migrations:
//
//   • the movement and every touched cell land in ONE atomic multi-path update;
//   • the movement id is the idempotency key — if it exists, no-op (and the
//     check runs INSIDE the retry loop, immediately before the guarded write);
//   • cell writes bump `v` by exactly 1 and change `mv`; a new cell starts at 0;
//   • the Admin SDK bypasses the rules' v+1 guard, so optimistic concurrency is
//     re-implemented as read → compute → re-read → compare → write, retried on
//     a mismatch;
//   • a negative-going leg may not overdraw the cell unless `allowNegative`;
//   • NEGATIVE BASE: an arrival at a real shelf (received / return / the +leg
//     of a relocation, never an adjustment, never in_transit) credits from
//     max(cell, 0) and records the cleared debt as `negativeCleared` — the same
//     rule the client writer applies since 2026-09-11 (FULFIL-CREDIT-GAP.md);
//   • before/after per-location audit snapshot from the SAME reads that
//     computed the write.
//
// Only the movement types the sweep needs are admitted (transfer_in, adjustment)
// — widen deliberately, with a test, not by default.
//
// `db` is injected (firebase-admin Database or the test fake): this module never
// initialises the SDK itself.

"use strict";

const { encodeSizeKey } = require("./refill-engine.cjs");

const CONFLICT_RETRIES = 5;
const ADMITTED_TYPES = new Set(["transfer_in", "adjustment"]);

const emptyLink = (link) => ({ orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, ...(link || {}) });
const cellPath = (loc, pid, size) => `stock/${loc}/${pid}/${encodeSizeKey(size)}`;
const read = async (db, path) => (await db.ref(path).once("value")).val();

function cellDeltas(m) {
  const qty = Number(m.qty);
  switch (m.type) {
    case "transfer_in": return m.from && m.to ? [{ loc: m.from, delta: -qty }, { loc: m.to, delta: +qty }] : null;
    case "adjustment": return m.to ? [{ loc: m.to, delta: +qty }] : (m.from ? [{ loc: m.from, delta: -qty }] : null);
    default: return null;
  }
}

// Same predicate as the client's clampsNegativeBase — kept byte-for-byte in
// meaning so the two writers cannot disagree about which legs clamp.
function clampsNegativeBase(movement, delta, loc) {
  return delta > 0 && movement.type !== "adjustment" && loc !== "in_transit";
}

const sameCell = (a, b) => {
  const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);
  const v = (c) => (c && typeof c.v === "number" ? c.v : null);
  return q(a) === q(b) && v(a) === v(b);
};

/**
 * movement: { type, productId, size, qty(>0), from?, to?, reason?, link?,
 *             movementId (REQUIRED — deterministic, the idempotency key),
 *             actor (REQUIRED — "system:…"), actorRole?, allowNegative? }
 * → { ok:true, movementId, idempotent? , newQty? } | { ok:false, reason, … }
 */
async function applyMovementAdmin(db, movement, { nowIso }) {
  if (!movement || !ADMITTED_TYPES.has(movement.type)) return { ok: false, reason: "invalid_type" };
  if (!movement.productId || movement.size == null || movement.size === "") return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0)) return { ok: false, reason: "qty_must_be_positive" };
  if (!movement.movementId) return { ok: false, reason: "movement_id_required" };
  if (!movement.actor) return { ok: false, reason: "actor_required" };
  if (movement.type === "adjustment" && !(movement.reason && String(movement.reason).trim())) return { ok: false, reason: "adjustment_requires_reason" };
  if (/[.#$/\[\]]/.test(String(movement.movementId))) return { ok: false, reason: "movement_id_unsafe" };
  const deltas = cellDeltas(movement);
  if (!deltas) return { ok: false, reason: "missing_location" };
  const mvId = movement.movementId;

  for (let attempt = 1; attempt <= CONFLICT_RETRIES; attempt++) {
    if (await read(db, `stock_movements/${mvId}`)) return { ok: true, movementId: mvId, idempotent: true };

    const cells = [];
    for (const d of deltas) {
      const path = cellPath(d.loc, movement.productId, movement.size);
      const cell = await read(db, path);
      const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      const clearedDebt = curQty < 0 && clampsNegativeBase(movement, d.delta, d.loc) ? curQty : 0;
      const newQty = (curQty - clearedDebt) + d.delta;
      if (d.delta < 0 && newQty < 0 && !movement.allowNegative) {
        return { ok: false, reason: "insufficient_stock", location: d.loc, available: curQty, requested: Number(movement.qty) };
      }
      cells.push({ loc: d.loc, path, cell, curQty, newQty, clearedDebt });
    }

    const before = {}, after = {}, negativeCleared = {};
    for (const c of cells) { before[c.loc] = c.curQty; after[c.loc] = c.newQty; if (c.clearedDebt) negativeCleared[c.loc] = c.clearedDebt; }
    const mv = {
      type: movement.type, productId: movement.productId, size: String(movement.size), qty: Number(movement.qty),
      from: movement.from ?? null, to: movement.to ?? null, before, after,
      actor: movement.actor, actorRole: movement.actorRole ?? "admin",
      ts: movement.ts || nowIso, appliedAt: nowIso, reason: movement.reason ?? null,
      link: emptyLink(movement.link),
      ...(Object.keys(negativeCleared).length ? { negativeCleared } : {}),
    };
    const updates = { [`stock_movements/${mvId}`]: mv };
    for (const c of cells) {
      updates[`${c.path}/qty`] = c.newQty;
      updates[`${c.path}/v`] = c.cell && typeof c.cell.v === "number" ? c.cell.v + 1 : 0;
      updates[`${c.path}/mv`] = mvId;
      updates[`${c.path}/lastType`] = movement.type;
      updates[`${c.path}/updatedAt`] = nowIso;
      updates[`${c.path}/updatedBy`] = movement.actor;
    }

    // The re-check: anything that moved a cell since the read makes the
    // computed qty stale — recompute rather than overwrite another writer.
    let moved = false;
    for (const c of cells) if (!sameCell(c.cell, await read(db, c.path))) { moved = true; break; }
    if (moved) continue;

    await db.ref().update(updates);
    return { ok: true, movementId: mvId, newQty: after[movement.to || movement.from] };
  }
  return { ok: false, reason: "conflict_retries_exhausted" };
}

module.exports = { applyMovementAdmin, clampsNegativeBase, cellPath };
