// ─── EXPIRED LAYBY → BACK ON THE HUB 1 SHELF ─────────────────────────────────
// The warehouse half of the expired-layby flow (owner direction 2026-08-04):
// hub 1 keeps the parcels, so hub 1 decides when an expired one goes back to
// stock. The POS keeps the money side — issuing store credit is a cashier job
// and nothing here touches it.
//
// ── WHY THIS IS THE FIRST LAYBY CODE THAT WRITES /stock ──────────────────────
// Until now the whole layby module moved status flags only; `returnPullToStock`
// flips a pull to RETURNED_TO_STOCK and writes no inventory at all. Putting an
// expired layby's units back on the shelf is a real stock movement, so it goes
// through applyMovement — the single writer — like everything else.
//
// ── WHY `received` AND NOT `return` ──────────────────────────────────────────
// Forced by the live rules, not preference:
//     'return'   → stockRole pos|store|admin
//     'received' → stockRole warehouse|admin
// The people doing this are hub 1 warehouse staff, so a `return` movement would
// be refused by RTDB on every single line. `received` is also the honest verb
// here: goods are arriving back into hub 1's countable stock.
//
// ── WHERE THE ITEMS COME FROM ────────────────────────────────────────────────
// A /laybys record carries `itemCount` and NOTHING ELSE about what is in the
// parcel — no product, no size, no quantity. The lines live on the POS sale it
// was created from (/pos/sales/{saleId}/lineItems). So the return reads across
// into POS data, and REFUSES rather than guesses when a line will not resolve:
// measured 2026-08-04, 29 of 30 open laybys resolve cleanly and one does not.
// A partial return would silently under-count the shelf.
//
// ── DOUBLE-RETURN IS THE REAL HAZARD ─────────────────────────────────────────
// Two clerks on two tablets, or one impatient double-tap, would otherwise add
// the units twice and inflate hub 1 for good. A create-if-absent transaction on
// the layby's own claim node makes exactly one caller the winner; the loser is
// told, and writes nothing.

import { ref, get, child, runTransaction, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "../stock/applyMovement";
import { LAYBY_STATUS } from "./contract";
import { serverNowIso } from "../../utils/serverTime";

export const RETURN_DEST = "hub1";           // the storage hub every layby uses
export const RETURN_REASON = "layby_expired_return";

const claimPath = (laybyId) => `laybys/${laybyId}/expiredReturn`;

/**
 * Read the parcel's real contents from the POS sale.
 * Returns { ok, lines } or { ok:false, reason } — never a partial list.
 */
export async function loadLaybyLines(layby) {
  const saleId = layby?.saleId;
  if (!saleId) return { ok: false, reason: "no_sale_link", message: "This layby has no linked sale, so its contents cannot be read." };

  const snap = await get(child(ref(database), `pos/sales/${saleId}/lineItems`));
  const raw = snap.val();
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  const lines = arr.filter((l) => l && typeof l === "object");
  if (!lines.length) return { ok: false, reason: "no_lines", message: "The linked sale has no item lines — nothing to put back." };

  // Every line must be complete. One unusable line means the parcel cannot be
  // returned correctly, and a partial return is worse than none.
  const bad = lines.filter((l) => !l.productId || l.size == null || !(Number(l.qty) > 0));
  if (bad.length) {
    return {
      ok: false,
      reason: "incomplete_lines",
      message: `${bad.length} of ${lines.length} item line${bad.length === 1 ? "" : "s"} is missing a product, size or quantity. Put this one back by hand and tell an admin.`,
    };
  }

  return {
    ok: true,
    lines: lines.map((l) => ({
      productId: l.productId,
      size: String(l.size),
      // A partially refunded layby returns only what is still held.
      qty: Math.max(0, Number(l.qty) - (Number(l.refundedQty) || 0)),
      name: l.name || l.productId,
    })).filter((l) => l.qty > 0),
  };
}

/**
 * Put an expired layby's units back on the hub 1 shelf.
 *
 * Order of operations is deliberate:
 *   1. CLAIM (transaction) — one winner, so a double-tap cannot double-add.
 *   2. MOVE  — one `received` movement per line, through applyMovement.
 *   3. MARK  — flip the layby to EXPIRED_RETURNED, which is what stops the POS
 *              offering it.
 *
 * If a movement fails mid-way the claim is released, so the clerk can retry;
 * the movements already written are reported by id and are NOT reversed
 * automatically — a half-return is a human decision, not a silent rollback.
 */
export async function returnExpiredLaybyToStock(layby, { actorRole, hubLabel } = {}) {
  const laybyId = layby?.laybyId;
  if (!laybyId) return { ok: false, message: "This layby has no id." };

  const loaded = await loadLaybyLines(layby);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  if (!loaded.lines.length) return { ok: false, message: "Every line on this layby was already refunded — nothing to put back." };

  const user = auth.currentUser;
  const claim = {
    by: hubLabel || (user ? user.uid : null),
    uid: user ? user.uid : null,
    at: serverNowIso(),
  };

  // 1. CLAIM — create-if-absent. `undefined` aborts the transaction, so a claim
  //    that already exists leaves the winner's record untouched.
  const res = await runTransaction(ref(database, claimPath(laybyId)), (cur) => (cur ? undefined : claim));
  const held = res && res.snapshot ? res.snapshot.val() : null;
  if (!res?.committed) {
    return {
      ok: false,
      alreadyClaimed: true,
      message: held?.by
        ? `Already being returned by ${held.by}. Refresh to see the result.`
        : "Someone else is already returning this layby.",
    };
  }

  // 2. MOVE — one movement per line, each carrying the layby in its provenance
  //    so the shelf can be traced back to the parcel it came from.
  const movementIds = [];
  for (const line of loaded.lines) {
    const mv = await applyMovement({
      type: "received",
      productId: line.productId,
      size: line.size,
      qty: line.qty,
      to: RETURN_DEST,
      from: null,
      reason: RETURN_REASON,
      actorRole,
      link: {
        laybyId,
        saleId: layby.saleId || null,
        invoiceNo: layby.invoiceNo || null,
      },
    });
    if (!mv.ok) {
      // Release the claim so a retry is possible, and say exactly how far it got.
      await update(ref(database), { [claimPath(laybyId)]: null }).catch(() => {});
      return {
        ok: false,
        partial: movementIds.length > 0,
        movementIds,
        message: movementIds.length
          ? `Stopped after ${movementIds.length} of ${loaded.lines.length} lines (${line.name}: ${mv.reason}). Those already moved are in History — check before retrying.`
          : `Could not return ${line.name}: ${mv.reason === "write_failed" ? "the write was refused — this account may not have warehouse stock rights." : mv.reason}`,
      };
    }
    movementIds.push(mv.movementId);
  }

  // 3. MARK — terminal state + provenance. This is the flag the POS reads.
  const now = serverNowIso();
  await update(ref(database), {
    [`laybys/${laybyId}/status`]: LAYBY_STATUS.EXPIRED_RETURNED,
    [`laybys/${laybyId}/expiredReturnedAt`]: now,
    [`laybys/${laybyId}/expiredReturnedBy`]: hubLabel || null,
    [`laybys/${laybyId}/expiredReturnMovements`]: movementIds,
    [`${claimPath(laybyId)}/completedAt`]: now,
  });

  const units = loaded.lines.reduce((t, l) => t + l.qty, 0);
  return { ok: true, movementIds, lines: loaded.lines.length, units };
}
