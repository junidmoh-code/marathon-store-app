// ─── applyMovementAdmin — the server-side stock writer ───────────────────────
// The canonical writer is a CLIENT module (src/components/stock/applyMovement.js):
// it imports the client firebase handle and stamps auth.currentUser, so a
// Cloud Function cannot call it. This reproduces its CONTRACT:
//
//   • the movement id is the idempotency key — if the ledger row exists, no-op;
//   • cell writes bump `v` by exactly 1 and change `mv`; a new cell starts at 0;
//   • a negative-going leg may not overdraw the cell unless `allowNegative`;
//   • NEGATIVE BASE: an arrival at a real shelf (received / return / the +leg
//     of a relocation, never an adjustment, never in_transit) credits from
//     max(cell, 0) and records the cleared debt as `negativeCleared` — the same
//     rule the client writer applies since 2026-09-11 (FULFIL-CREDIT-GAP.md);
//   • the size → cell key fold is the CLIENT's (stockSizeKey): null / "" /
//     "Free Size" → "_" (review, PR #602: the engine's encodeSizeKey folds
//     "Free Size" to "Free_Size" and would read the wrong cell forever).
//
// ── WHY EACH CELL IS A TRANSACTION, NOT A MULTI-PATH UPDATE ──────────────────
// The Admin SDK bypasses the rules' v+1 guard, so a read → compute → update()
// has a window in which a device write (a POS `sold` on the same hub cell,
// during trading hours) lands and is silently overwritten (Sonnet + second-brain
// reviews, PR #602). Each cell is therefore mutated with a real RTDB
// transaction — a server-side CAS: the callback sees the committed value and a
// concurrent write re-runs it. The cost is that the two cells of a relocation
// are no longer ONE atomic write. That is made safe by ORDER and by a MARKER:
//   • legs run negative first (the source), positive last (the destination),
//     so an interruption leaves stock conservatively LOW, never fabricated;
//   • every touched cell is stamped `relMv: <movementId>`; a resumed call (or
//     a device retrying the same id — the client writer honours the stamp too)
//     skips a cell already carrying it, so no leg is ever applied twice;
//   • the ledger row is written LAST, create-once, with the before/after the
//     transactions actually saw — the movement id is still the "done" marker
//     every reader relies on.
// A crash between legs is completed by the caller's next attempt with the SAME
// movement id (the stranded-transit sweep re-plans hourly).
//
// Only the movement types the sweep and the repair need are admitted
// (transfer_in, adjustment) — widen deliberately, with a test, not by default.
//
// `db` is injected (firebase-admin Database or the test fake): this module never
// initialises the SDK itself.

"use strict";

const ADMITTED_TYPES = new Set(["transfer_in", "adjustment"]);

const emptyLink = (link) => ({ orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, ...(link || {}) });
const read = async (db, path) => (await db.ref(path).once("value")).val();

// Mirror of src/utils/sizeKey.js stockSizeKey — the ONE fold every cell key
// goes through on the client. Kept byte-equivalent; the differential fuzz in
// applyMovementMirror.fuzz.test.js runs both writers over "5.5", "Free Size"
// and "" and compares the cells they land on.
function stockCellKey(size) {
  const s = size == null ? "" : String(size).trim();
  if (!s || s === "Free Size") return "_";
  return s.replace(/[.#$/\[\]\s]/g, "_");
}
const cellPath = (loc, pid, size, sizeKey) => `stock/${loc}/${pid}/${sizeKey || stockCellKey(size)}`;

// Same predicate as the client's clampsNegativeBase — kept byte-for-byte in
// meaning so the two writers cannot disagree about which legs clamp.
function clampsNegativeBase(movement, delta, loc) {
  return delta > 0 && movement.type !== "adjustment" && loc !== "in_transit";
}

function cellDeltas(m) {
  const qty = Number(m.qty);
  switch (m.type) {
    // negative leg FIRST — see the header
    case "transfer_in": return m.from && m.to ? [{ loc: m.from, delta: -qty }, { loc: m.to, delta: +qty }] : null;
    case "adjustment": return m.to ? [{ loc: m.to, delta: +qty }] : (m.from ? [{ loc: m.from, delta: -qty }] : null);
    default: return null;
  }
}

/**
 * movement: { type, productId, size, sizeKey?, qty(>0), from?, to?, reason?, link?,
 *             movementId (REQUIRED — deterministic, the idempotency key),
 *             actor (REQUIRED — "system:…"), actorRole?, allowNegative? }
 * → { ok:true, movementId, idempotent?, newQty? } | { ok:false, reason, … }
 */
async function applyMovementAdmin(db, movement, { nowIso }) {
  if (!movement || !ADMITTED_TYPES.has(movement.type)) return { ok: false, reason: "invalid_type" };
  if (!movement.productId || movement.size == null || movement.size === "") return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0)) return { ok: false, reason: "qty_must_be_positive" };
  if (!movement.movementId) return { ok: false, reason: "movement_id_required" };
  if (!movement.actor) return { ok: false, reason: "actor_required" };
  if (movement.type === "adjustment" && !(movement.reason && String(movement.reason).trim())) return { ok: false, reason: "adjustment_requires_reason" };
  if (/[.#$/\[\]\s]/.test(String(movement.movementId))) return { ok: false, reason: "movement_id_unsafe" };
  const deltas = cellDeltas(movement);
  if (!deltas) return { ok: false, reason: "missing_location" };
  const mvId = movement.movementId;
  const qty = Number(movement.qty);

  if (await read(db, `stock_movements/${mvId}`)) return { ok: true, movementId: mvId, idempotent: true };

  const before = {}, after = {}, negativeCleared = {};
  let refusal = null;
  for (const d of deltas) {
    const path = cellPath(d.loc, movement.productId, movement.size, movement.sizeKey);
    // COLD-NULL TRAP (delta review, PR #602; test/helpers/guarded-txn.cjs): a
    // Cloud Function has no local cache, so the transaction's FIRST callback
    // runs on null, and returning undefined there ABORTS without ever seeing
    // the server value — every debit leg would refuse as "insufficient" on a
    // cold start. So the cell is read first, and a null callback value is
    // judged against that read: the proposal goes to the server with the
    // null hash, mismatches, and the callback is re-run with the real value.
    // (A cell that was truly absent commits from null, correctly.)
    const preRead = await read(db, path);
    let seen = null;
    const res = await db.ref(path).transaction((raw) => {
      const cur = raw === null ? preRead : raw;
      seen = cur;
      // Already stamped by THIS movement (a resumed call): leave the cell alone.
      if (cur && cur.relMv === mvId) return undefined;
      const curQty = cur && typeof cur.qty === "number" ? cur.qty : 0;
      const clearedDebt = curQty < 0 && clampsNegativeBase(movement, d.delta, d.loc) ? curQty : 0;
      const newQty = (curQty - clearedDebt) + d.delta;
      if (d.delta < 0 && newQty < 0 && !movement.allowNegative) return undefined;   // floor — reported below
      return {
        ...(cur || {}),
        qty: newQty,
        v: cur && typeof cur.v === "number" ? cur.v + 1 : 0,
        mv: mvId,
        relMv: mvId,
        relBefore: curQty,   // so a resumed call can still write an honest before/after
        lastType: movement.type,
        updatedAt: nowIso,
        updatedBy: movement.actor,
      };
    });
    const cur = seen;
    const curQty = cur && typeof cur.qty === "number" ? cur.qty : 0;
    if (!res.committed) {
      if (cur && cur.relMv === mvId) {
        // resumed: this leg landed on an earlier attempt — recover its snapshot
        before[d.loc] = typeof cur.relBefore === "number" ? cur.relBefore : curQty - d.delta;
        after[d.loc] = curQty;
        continue;
      }
      refusal = { ok: false, reason: "insufficient_stock", location: d.loc, available: curQty, requested: qty };
      break;
    }
    const written = res.snapshot.val();
    before[d.loc] = curQty;
    after[d.loc] = written.qty;
    if (curQty < 0 && clampsNegativeBase(movement, d.delta, d.loc)) negativeCleared[d.loc] = curQty;
  }
  if (refusal) return refusal;

  const mv = {
    type: movement.type, productId: movement.productId, size: String(movement.size), qty,
    from: movement.from ?? null, to: movement.to ?? null, before, after,
    actor: movement.actor, actorRole: movement.actorRole ?? "admin",
    ts: movement.ts || nowIso, appliedAt: nowIso, reason: movement.reason ?? null,
    link: emptyLink(movement.link),
    ...(Object.keys(negativeCleared).length ? { negativeCleared } : {}),
  };
  // create-once: a device that wrote the same id first wins the row
  await db.ref(`stock_movements/${mvId}`).transaction((cur) => (cur == null ? mv : undefined));
  // The ledger row is now the idempotency marker; the in-flight stamps come
  // off so a stamped cell means exactly "a leg landed, the row did not yet".
  // Best effort — a stale stamp costs the sweep one extra lookup, never a unit.
  const unstamp = {};
  for (const d of deltas) {
    const path = cellPath(d.loc, movement.productId, movement.size, movement.sizeKey);
    unstamp[`${path}/relMv`] = null; unstamp[`${path}/relBefore`] = null;
  }
  try { await db.ref().update(unstamp); } catch { /* see above */ }
  return { ok: true, movementId: mvId, newQty: after[movement.to || movement.from] };
}

module.exports = { applyMovementAdmin, clampsNegativeBase, cellPath, stockCellKey };
