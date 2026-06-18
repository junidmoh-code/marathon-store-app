// ─── applyMovement — THE SINGLE WRITER TO /stock ──────────────────────────────
// Every quantity change in the system goes through this one function. It writes the
// affected stock cell(s) AND the append-only ledger movement in ONE atomic multi-
// path update() — never separately. No other code may write /stock directly.
// See design/INVENTORY-DESIGN.md §1.4 / §1.5.
//
// CELL EFFECTS by movement type (a "relocation" touches TWO cells in one atomic op
// so stock is never invisible — in-transit is a real holding, not a gap):
//   received     → +to
//   sold         → −from
//   return       → +to
//   adjustment   → +to (positive) OR −from (negative)
//   transfer_out → −from, +to   (to is in_transit)
//   transfer_in  → −from, +to   (from is in_transit)
//
// PRECISION MECHANICS (why counts can't drift):
//   • Optimistic concurrency: each cell carries a version `v`; we read it then write
//     v+1. The rule rejects any write whose v isn't exactly data.v+1, so a concurrent
//     writer can't clobber us. On rejection we re-read every involved cell and retry.
//   • Idempotency: the movement id is the idempotency key. If it already exists we
//     no-op (offline re-sync, double-tap, retried network all collapse to one).
//   • Paired write: all touched cells + the movement are one atomic update — all-or-
//     nothing. A rejected attempt writes NOTHING (safe to retry).
//   • Negative floor: only the `sold` decrement may drive a cell negative (already-
//     happened event → surfaces as an accuracy signal, not a hidden clamp). Transfers,
//     receives and adjustments are blocked from going negative.
//
// NOTE on retries: a rule rejection (version conflict) and a genuine permission
// denial both surface as PERMISSION_DENIED — RTDB can't distinguish them client-side.
// We retry any failure a bounded number of times; a real permission error simply
// exhausts the retries and is reported.

import { ref, child, get, update, push } from "firebase/database";
import { database, auth } from "../../firebase";

const VALID_TYPES = new Set(["received", "sold", "transfer_in", "transfer_out", "adjustment", "return"]);

function emptyLink(link) {
  return { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, ...(link || {}) };
}

// Returns the list of cell deltas for a movement: [{ loc, delta }]. delta sign is
// the effect on that cell. Returns null on an invalid shape.
function cellDeltas(m) {
  const q = Number(m.qty);
  switch (m.type) {
    case "received":     return m.to   ? [{ loc: m.to,   delta: +q }] : null;
    case "return":       return m.to   ? [{ loc: m.to,   delta: +q }] : null;
    case "sold":         return m.from ? [{ loc: m.from, delta: -q }] : null;
    case "adjustment":   return m.to ? [{ loc: m.to, delta: +q }] : (m.from ? [{ loc: m.from, delta: -q }] : null);
    case "transfer_out":
    case "transfer_in":  return (m.from && m.to) ? [{ loc: m.from, delta: -q }, { loc: m.to, delta: +q }] : null;
    default:             return null;
  }
}

// movement: {
//   type, productId, size, qty(>0), from?|null, to?|null, reason?, link?,
//   ts?(real event time ISO), actorRole?, cellState?(set /state on touched cells),
//   movementId?(supply to make the call idempotent — e.g. from an offline queue)
// }
// returns { ok:true, movementId, idempotent? } | { ok:false, reason, ... }
export async function applyMovement(movement, opts = {}) {
  const { maxRetries = 6 } = opts;

  const user = auth.currentUser;
  if (!user) return { ok: false, reason: "not_authenticated" };

  if (!movement || !VALID_TYPES.has(movement.type)) return { ok: false, reason: "invalid_type" };
  if (!movement.productId || !movement.size)         return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0))                   return { ok: false, reason: "qty_must_be_positive" };
  if (movement.type === "adjustment" && !(movement.reason && String(movement.reason).trim()))
    return { ok: false, reason: "adjustment_requires_reason" };

  const deltas = cellDeltas(movement);
  if (!deltas) return { ok: false, reason: "missing_location" };

  const mvId = movement.movementId || push(child(ref(database), "stock_movements")).key;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Idempotency: if this movement already landed, treat as success (re-sync safe).
    const existing = await get(child(ref(database), `stock_movements/${mvId}`));
    if (existing.exists()) return { ok: true, movementId: mvId, idempotent: true };

    // Read every involved cell.
    const cells = [];
    for (const d of deltas) {
      const path = `stock/${d.loc}/${movement.productId}/${movement.size}`;
      const snap = await get(child(ref(database), path));
      const cell = snap.val();
      const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      const newQty = curQty + d.delta;
      // Only a `sold` decrement may go negative; everything else is floored.
      if (newQty < 0 && movement.type !== "sold") {
        return { ok: false, reason: "insufficient_stock", location: d.loc, available: curQty, requested: Number(movement.qty) };
      }
      cells.push({ path, cell, newQty });
    }

    // Per-cell old→new snapshot for the audit trail, keyed by location so a two-cell
    // relocation (transfer) is unambiguous. Derived from the SAME reads that compute
    // the write, so the ledger's before/after can never disagree with the qty it wrote.
    const before = {}, after = {};
    cells.forEach((c, i) => {
      const loc = deltas[i].loc;
      before[loc] = c.cell && typeof c.cell.qty === "number" ? c.cell.qty : 0;
      after[loc]  = c.newQty;
    });

    const now = new Date().toISOString();
    const mv = {
      type: movement.type,
      productId: movement.productId,
      size: movement.size,
      qty: Number(movement.qty),
      from: movement.from ?? null,
      to: movement.to ?? null,
      before,                            // { loc: qty before } — old→new audit trail
      after,                             // { loc: qty after  }
      actor: user.uid,
      actorRole: movement.actorRole ?? null,
      ts: movement.ts || now,            // REAL event time (offline sale time, not sync time)
      appliedAt: now,                    // when it actually hit RTDB
      reason: movement.reason ?? null,
      link: emptyLink(movement.link),
    };

    const updates = {};
    updates[`stock_movements/${mvId}`] = mv;
    for (const c of cells) {
      const newV = c.cell && typeof c.cell.v === "number" ? c.cell.v + 1 : 0;
      updates[`${c.path}/qty`] = c.newQty;
      updates[`${c.path}/v`] = newV;
      updates[`${c.path}/mv`] = mvId;
      updates[`${c.path}/lastType`] = movement.type;
      updates[`${c.path}/updatedAt`] = now;
      updates[`${c.path}/updatedBy`] = user.uid;
      if (movement.cellState) updates[`${c.path}/state`] = movement.cellState;
    }

    try {
      await update(ref(database), updates);
      return { ok: true, movementId: mvId };
    } catch (err) {
      if (attempt === maxRetries) {
        return { ok: false, reason: "write_failed", error: String(err?.message || err) };
      }
      await new Promise(r => setTimeout(r, 40 * attempt));
    }
  }
  return { ok: false, reason: "retries_exhausted" };
}

// ── setCellState ──────────────────────────────────────────────────────────────
// Rollout gate flip (untracked → counting → live) WITHOUT a quantity change. This
// is the one legitimate cell write that isn't a movement, so it lives here too —
// /stock still has exactly one writer module. It writes ONLY `state` (qty/v/mv
// untouched) on an existing cell, or seeds a fresh qty:0 cell for a counted-zero
// size. The security rule's metadata-only branch permits exactly this shape.
export async function setCellState(loc, productId, size, state) {
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: "not_authenticated" };
  if (!["untracked", "counting", "live"].includes(state)) return { ok: false, reason: "invalid_state" };
  const cellPath = `stock/${loc}/${productId}/${size}`;
  const now = new Date().toISOString();
  const snap = await get(child(ref(database), cellPath));
  const updates = {};
  if (snap.exists()) {
    updates[`${cellPath}/state`] = state;
    updates[`${cellPath}/updatedAt`] = now;
    updates[`${cellPath}/updatedBy`] = user.uid;
  } else {
    updates[`${cellPath}`] = { qty: 0, v: 0, mv: "seed", lastType: "count", state, updatedAt: now, updatedBy: user.uid };
  }
  try {
    await update(ref(database), updates);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "write_failed", error: String(err?.message || err) };
  }
}
