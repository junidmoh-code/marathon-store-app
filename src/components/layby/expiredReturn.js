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
import { encodeSizeKey } from "../../utils/sizeKey";
import { serverNowIso } from "../../utils/serverTime";

export const RETURN_REASON = "layby_expired_return";

// ── WHERE THE UNITS GO: THE LAYBY'S OWN HUB, NEVER A CONSTANT ────────────────
// This was hardcoded to "hub1" and that was wrong the moment Pine came online.
// The POS already routes by store — locationIds.js STORE_TO_HUB is
// { pe: hub1, pine: hub3, trophy: hub1 } — so a Pine layby is stored at hub3 and
// its units belong back on hub3's shelf.
//
// Pine + hub3 are an ISOLATED network (owner: "completely separate from us
// here"; same split the sneaker sweep encodes). Returning a Pine parcel into
// hub1 would not be an off-by-one, it would move real goods between buildings
// that do not trade with each other — and the ledger would look correct.
//
// So: no default. A layby whose storageHub is missing or unrecognised is
// REFUSED, not guessed. All 185 live laybys carry an explicit storageHub, so
// nothing legitimate depends on a fallback.
// Canonical hubs from /locations (verified 2026-08-05: base, central, hub1,
// hub2, hub3, in_transit, marathon-pe, marathon-pine, studio, trophy).
// hubC is NOT among them — it appears in some POS-side constants but has never
// existed as a location, and the movement rule validates `to` against
// /locations. Accepting it here would turn a clean up-front refusal into a
// confusing rules rejection halfway through a parcel. (CodeRabbit, Minor.)
export const KNOWN_HUBS = ["hub1", "hub2", "hub3"];

export function returnDestFor(layby) {
  const hub = layby?.storageHub;
  return typeof hub === "string" && KNOWN_HUBS.includes(hub) ? hub : null;
}

const claimPath = (laybyId) => `laybys/${laybyId}/expiredReturn`;

// ── THE IDEMPOTENCY KEY (CodeRabbit, CRITICAL) ───────────────────────────────
// Without this, a retry after a PARTIAL failure re-adds every line that already
// succeeded. applyMovement mints a fresh push key when no movementId is given,
// so its "has this movement already landed?" check can never match on a second
// attempt — and the failure path deliberately RELEASES the claim so the clerk
// can retry. The claim guards two clerks; it does nothing about one clerk
// retrying, and only a warning string stood between that and doubled stock.
//
// Deterministic per (layby, product, size) — the same shape the rest of the repo
// uses (`negfix_…`, `rrf_…`, receiveMovementId). Re-running is now a no-op:
// applyMovement sees the id already exists and returns { ok, idempotent }.
const returnMovementId = (laybyId, productId, sizeKey) =>
  `laybyret_${laybyId}_${productId}_${encodeSizeKey(sizeKey)}`;

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

  const dest = returnDestFor(layby);
  if (!dest) {
    return {
      ok: false,
      message: `This layby has no recognised storage hub (${layby?.storageHub ?? "none"}), so there is no safe shelf to put it back on. Tell an admin — do not guess.`,
    };
  }

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
  //
  // EVERYTHING FROM HERE IS WRAPPED (CodeRabbit, Major): the claim was released
  // only on a returned {ok:false}. If applyMovement THREW, or the final update
  // rejected, the claim stayed held forever — no UI can clear it, so the layby
  // became permanently unreturnable. Worse on the second path: the stock was
  // already back on the shelf while the layby stayed un-terminal, so the POS
  // kept offering it AND the retry was blocked.
  //
  // Releasing on a throw is only safe because the movement ids above are
  // deterministic — the retry re-applies nothing.
  const movementIds = [];
  try {
  for (const line of loaded.lines) {
    const mv = await applyMovement({
      type: "received",
      productId: line.productId,
      size: line.size,
      qty: line.qty,
      to: dest,
      from: null,
      reason: RETURN_REASON,
      actorRole,
      movementId: returnMovementId(laybyId, line.productId, line.size),
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
  return { ok: true, movementIds, lines: loaded.lines.length, units, dest };
  } catch (err) {
    // Release so a retry is possible; deterministic ids make it safe.
    await update(ref(database), { [claimPath(laybyId)]: null }).catch(() => {});
    return {
      ok: false,
      threw: true,
      partial: movementIds.length > 0,
      movementIds,
      message: movementIds.length
        ? `Failed after ${movementIds.length} of ${loaded.lines.length} lines (${String(err?.message || err)}). Safe to try again — the lines already moved will not be added twice.`
        : `Could not return this layby: ${String(err?.message || err)}. Nothing was moved.`,
    };
  }
}
