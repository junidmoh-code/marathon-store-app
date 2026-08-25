// ─── applyMovement — THE SINGLE WRITER TO /stock ──────────────────────────────
// Every quantity change in the system goes through this one function. It writes the
// affected stock cell(s) AND the append-only ledger movement in ONE atomic multi-
// path update() — never separately. No other code may write /stock directly.
// See design/INVENTORY-DESIGN.md §1.4 / §1.5.
//
// CELL EFFECTS by movement type (a "relocation" touches TWO cells in one atomic op
// so stock is never invisible — in-transit is a real holding, not a gap):
//   received     → +to
//   opening      → +to   (one-time opening balance; additive into the cell)
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
import { stockCellPath } from "../../utils/sizeKey";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { reactivateUpdates, REACTIVATED_EVENT } from "../../utils/deactivation";

const VALID_TYPES = new Set(["received", "opening", "sold", "transfer_in", "transfer_out", "adjustment", "return"]);

// ── AUTO-REACTIVATION ON ARRIVAL (owner spec 2026-08-25) ─────────────────────
// A DEACTIVATED product (products/{id}/deactivated — a reversibly retired
// finished line, src/utils/deactivation.js) that receives stock would be
// invisible: the engine ignores it, nobody refills it, the units sit
// unnoticed. So any movement that lands stock AT A REAL LOCATION reactivates
// the product in the SAME atomic update as the stock write. Arrivals are:
// received, opening, return, transfer_in (from in_transit to a real shelf) and
// a positive adjustment. NOT `sold` (a deduction) and NOT transfer_out (its
// +leg lands in in_transit; reactivation waits for the transfer_in that puts
// units on an actual shelf). The UI is told via REACTIVATED_EVENT so every
// receive surface announces it without each caller opting in.
function isArrival(m) {
  if (m.type === "received" || m.type === "opening" || m.type === "return" || m.type === "transfer_in") return true;
  return m.type === "adjustment" && !!m.to;
}

function emptyLink(link) {
  return { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, ...(link || {}) };
}

// Returns the list of cell deltas for a movement: [{ loc, delta }]. delta sign is
// the effect on that cell. Returns null on an invalid shape.
function cellDeltas(m) {
  const q = Number(m.qty);
  switch (m.type) {
    case "received":     return m.to   ? [{ loc: m.to,   delta: +q }] : null;
    case "opening":      return m.to   ? [{ loc: m.to,   delta: +q }] : null;
    case "return":       return m.to   ? [{ loc: m.to,   delta: +q }] : null;
    case "sold":         return m.from ? [{ loc: m.from, delta: -q }] : null;
    case "adjustment":   return m.to ? [{ loc: m.to, delta: +q }] : (m.from ? [{ loc: m.from, delta: -q }] : null);
    case "transfer_out":
    case "transfer_in":  return (m.from && m.to) ? [{ loc: m.from, delta: -q }, { loc: m.to, delta: +q }] : null;
    default:             return null;
  }
}

// ── expect: THE ABSOLUTE-VALUE PRECONDITION (opt-in) ──────────────────────────
// `expect: { qty }` makes the write conditional on the cell STILL holding that
// quantity at the moment this function reads it. Absent (the default) nothing
// changes for any existing caller.
//
// Why it exists. The `v` version guard protects the window between THIS
// function's read and its write — microseconds. A caller that read the cell
// itself first (to show a user a number and ask them to act on it) has a second,
// much wider window: the network round trip between the caller's read and ours.
// Nothing used to police that gap, so a concurrent write could land in it and
// this function would compute its delta against the NEW base and commit happily,
// with no version conflict, because it never saw the old version.
//
// For a RELATIVE movement that is correct — a transfer of 3 is a transfer of 3
// whatever else happened. For an ABSOLUTE intent ("the shelf holds 8"), it is
// not: the delta gets applied to a base the human never saw, and stock lands on
// a number nobody counted. `expect` closes that window; together with the `v`
// rule the read-decide-write becomes atomic end to end.
//
// Single-cell movements only — a relocation touches two cells and "the expected
// quantity" would be ambiguous.
//
// movement: {
//   type, productId, size, qty(>0), from?|null, to?|null, reason?, link?,
//   ts?(real event time ISO), actorRole?, cellState?(set /state on touched cells),
//   movementId?(supply to make the call idempotent — e.g. from an offline queue),
//   expect?({ qty } — refuse unless the cell still holds exactly this)
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

  const expectQty = movement.expect && typeof movement.expect.qty === "number" ? movement.expect.qty : null;
  if (expectQty !== null && deltas.length !== 1) return { ok: false, reason: "expect_requires_single_cell" };

  const mvId = movement.movementId || push(child(ref(database), "stock_movements")).key;

  // One small read decides auto-reactivation for the whole call. Read ONCE
  // (not per attempt): the worst a stale read costs is re-clearing an
  // already-cleared flag, which lands on the same final state.
  let reactivation = null;
  if (isArrival(movement)) {
    try {
      const dSnap = await get(child(ref(database), `products/${movement.productId}/deactivated`));
      if (dSnap.exists()) {
        const byName = (user.email || "").split("@")[0] || null;
        reactivation = reactivateUpdates(movement.productId, {
          uid: user.uid, byName, nowMs: serverNowMs(), reason: "stock_received",
        });
      }
    } catch {
      // A failed flag read must never block a stock write — the next arrival
      // (or a manual tap) reactivates instead.
      reactivation = null;
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Idempotency: if this movement already landed, treat as success (re-sync safe).
    const existing = await get(child(ref(database), `stock_movements/${mvId}`));
    if (existing.exists()) return { ok: true, movementId: mvId, idempotent: true };

    // Read every involved cell.
    const cells = [];
    for (const d of deltas) {
      // Encode the size into the cell key — "." (half-sizes) is illegal in RTDB
      // keys and would reject the write. Same path for the read here and the write
      // below (c.path). Matches the POS encoding so both apps key /stock alike.
      const path = stockCellPath(d.loc, movement.productId, movement.size);
      const snap = await get(child(ref(database), path));
      const cell = snap.val();
      const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      // The absolute-value precondition, checked against the read we are about to
      // write from — NOT against whatever the caller saw earlier. Re-checked on
      // every attempt, so a retry can never launder a stale expectation.
      if (expectQty !== null && curQty !== expectQty) {
        return { ok: false, reason: "stale_expectation", location: d.loc, expected: expectQty, live: curQty };
      }
      const newQty = curQty + d.delta;
      // P0 (stock-integrity): only a NEGATIVE delta can be floored — a positive
      // delta (a return / the +to leg of a transfer) always applies, even onto a
      // cell already negative (raising −3 to −2 is an improvement; the old
      // `newQty < 0` form refused exactly those restocks). A negative delta below
      // zero is refused unless the movement is `sold` OR the caller opts in with
      // `allowNegative` (A1: a dispatch is a physical fact — the parcel leaves the
      // hub whether or not the hub cell was counted; the resulting hub negative
      // is the same honest shortage signal a `sold` oversell leaves at a shop).
      if (d.delta < 0 && newQty < 0 && movement.type !== "sold" && !movement.allowNegative) {
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

    const now = serverNowIso();
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
    if (reactivation) Object.assign(updates, reactivation);   // same atomic write as the stock
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
      if (reactivation && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        // Every receive surface announces the reactivation without opting in.
        window.dispatchEvent(new CustomEvent(REACTIVATED_EVENT, {
          detail: { productId: movement.productId, movementType: movement.type },
        }));
      }
      return reactivation
        ? { ok: true, movementId: mvId, reactivated: true }
        : { ok: true, movementId: mvId };
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
  const cellPath = stockCellPath(loc, productId, size);   // encoded size key (half-size safe)
  const now = serverNowIso();
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
