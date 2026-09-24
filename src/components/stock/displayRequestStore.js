// ─── RAISING A DISPLAY REQUEST FROM THE WALL WALK ────────────────────────────
//
// ── 2026-09-24: IT NOW LANDS ON THE DISPLAY REFILL CARD ─────────────────────
// Everything below about "an order carrying requestDisplayPartner" still holds.
// What changed is WHERE the order starts: the 2026-09-08 version minted it as
// an `incoming` customer order, which only reached the Display Refill card
// after someone marked it Ready in the ORDER queue — so in practice it never
// did (order #093, Trophy, sat incoming). It is now born as a scheduled refill
// task at the hub that holds the shoe. The why, the shape and the live evidence
// are in displayRequestCore.js; this file is only the writes.
//
// Three things were added around the write:
//   1. the wall's record is CLEARED first — the operator has just said this
//      shoe is not on the wall, so no open row and no live slot may say it is;
//   2. the source hub is chosen by stock (pickDisplaySourceHub), and a shoe no
//      hub can give out raises nothing;
//   3. a double tap — or two devices — makes ONE request: a transaction on
//      REQUEST_LOCK_ROOT/{store}/{productId} fences the window before the new
//      order reaches everybody's /orders stream.
//
// The text below is the 2026-09-08 header, kept because its reasoning (one
// pipeline, a real order number, no size) is still the design.
//
// (Owner spec clause 5, 2026-09-08: "NOT ON THE WALL → Request Display,
// entering the existing request pipeline unchanged.")
//
// THE PIPELINE IS AN ORDER. A display partner request has always been an order
// carrying `requestDisplayPartner: true`: the assistant raises it, the
// warehouse marks it Ready, the refill task appears fifteen minutes later, the
// operator taps Send, PICKS THE SIZE and confirms. Nothing in that is changed
// or copied here — this module only mints the same kind of order from a
// different starting point, so a wall walk feeds the queue the warehouse
// already works.
//
// WHY NOT A SEPARATE "WALL WALK REQUEST" NODE: because the warehouse would then
// have two lists to work and one of them would rot. The whole value of "entering
// the pipeline unchanged" is that the operator's day does not change.
//
// ── WHAT THIS ORDER IS NOT ───────────────────────────────────────────────────
// It is not a customer order and it never pretends to be:
//   • no phone number, so no WhatsApp is sent and nothing is promised to
//     anybody — the send path is not even called from here;
//   • `wallWalk: true` and a customer name that reads as what it is
//     ("Display wall — Trophy"), so nobody at the warehouse mistakes it for
//     someone waiting at a counter;
//   • NO SIZE. A display request is size-optional by design ("send a pair"),
//     and the size is decided by the operator at Send. Stamping one here would
//     be the ABSOLUTE RULE's exact violation — the record would then say the
//     size the wall walk assumed rather than the size that went on the wall.
//
// ── IT DRAWS A REAL ORDER NUMBER, AND THAT IS DELIBERATE ─────────────────────
// From the shared daily counter (utils/orderCounter.js — extracted, not
// copied). A display-partner request has always consumed one; giving wall-walk
// requests their own sequence would put two numbering schemes in the same queue
// for the same kind of work.
//
// ── CLAUSE 1 IS ENFORCED HERE TOO ────────────────────────────────────────────
// At most one open display request per product per store. The caller passes the
// orders it already holds and this refuses a second — the same guard the
// checkout runs, from the same pure function, so the two entry points cannot
// disagree about what "already asked for" means.

import { ref, get, set, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { getNextOrderNumber } from "../../utils/orderCounter";
import { otherOpenDisplayRequests, isOpenDisplayRequest, requestStoreFor, openRowsFor } from "./displayRowCore";
import { closeDisplayRow, readRowsNow } from "./displayRowStore";
import { clearDisplaySlot } from "./displaySlots";
import { pickDisplaySourceHub, wallWalkOrder, requestLockPath, lockHeld } from "./displayRequestCore";
import { labelFor } from "./locations";

/**
 * CLEAR THIS WALL'S RECORD FOR ONE SHOE. Every open ledger row is closed
 * (`corrected` — "this size was not on the wall"), read fresh, never from the
 * caller's snapshot; then the slot is cleared, which also catches a slot left
 * standing with no row behind it (the size-grid marker reads the slot). No
 * stock moves. → { ok, closed, warning? } | { ok: false, message }
 */
export async function clearWallRecord({ store, productId }) {
  const fresh = await readRowsNow(store, productId);
  if (!fresh.ok) return { ok: false, message: fresh.message };
  const open = openRowsFor(fresh.rows, store, productId);
  const warnings = [];
  for (const row of open) {
    // eslint-disable-next-line no-await-in-loop
    const res = await closeDisplayRow({ rows: fresh.rows, row, reason: "corrected", via: "not_on_wall",
                                        detail: { reason: "corrected", store } });
    if (!res.ok) return { ok: false, message: res.message };
    if (res.warning) warnings.push(res.warning);
  }
  const slot = await clearDisplaySlot({ store, productId, source: "manual" });
  if (slot && slot.ok === false) warnings.push(`The display slot could not be cleared (${slot.message}).`);
  return { ok: true, closed: open.length, warning: warnings.join(" ") || null };
}

/**
 * "NOT ON THE WALL": clear the record, then raise ONE display refill task.
 *
 * @param orders   the /orders the screen streams — the ordinary open-request guard
 * @param store    marathon-pe | trophy
 * @param product  the catalogue record ({ id, name, hubs, photoUrl, ... })
 * @param hubData  { hub1: { cells, promised, ready }, hub2: {...} }
 * → { ok: true, orderId, hub, order }
 *   | { ok: false, already: true, orderId?, message }
 *   | { ok: false, noStock: true, message }
 *   | { ok: false, message }
 */
export async function raiseDisplayRequest({ orders, store, product, hubData }) {
  try {
    if (!store || !product?.id) return { ok: false, message: "Store and product are required." };
    const productId = product.id;

    const cleared = await clearWallRecord({ store, productId });
    if (!cleared.ok) return { ok: false, message: `The display record could not be cleared (${cleared.message}). Nothing was requested.` };
    // A partial clear (a slot that would not clear) is reported on EVERY
    // answer below, not only on success — the operator must see it whatever
    // happened to the request. (Architect review.)
    const note = (r) => (cleared.warning ? { ...r, message: `${r.message || ""} ${cleared.warning}`.trim(), warning: cleared.warning } : r);

    // ── THE ORDINARY GUARD: an open request from EITHER path blocks. ──────
    const blocker = otherOpenDisplayRequests(orders, { store, productId })[0];
    if (blocker) {
      return note({ ok: false, already: true, orderId: blocker.id,
        message: `Order #${blocker.id} already asks for a display of ${product.name} at ${labelFor(store)}.` });
    }

    const pick = pickDisplaySourceHub({ product, hubData });
    if (!pick.hub) {
      return note(pick.unread
        ? { ok: false, message: "The warehouse stock has not loaded yet — try again in a moment. Nothing was requested." }
        : { ok: false, noStock: true, message: "None in any warehouse — nothing was requested." });
    }

    // ── THE DOUBLE-TAP FENCE ──────────────────────────────────────────────
    const lockPath = requestLockPath(store, productId);
    if (!lockPath) return { ok: false, message: "That product id cannot be stored as a path. Nothing was requested." };
    const lockRef = ref(database, lockPath);
    // Read first: primes the SDK cache so the transaction's first attempt sees
    // the server value, not null (the null-first trap), AND lets a claim whose
    // order is still open be named by its keyed read — one order, never /orders.
    const prior = (await get(lockRef)).val();
    if (prior?.orderId) {
      const o = (await get(ref(database, `orders/${prior.orderId}`))).val();
      if (o && o.createdAt === prior.orderCreatedAt && o.productId === productId
          && requestStoreFor(o) === store && isOpenDisplayRequest(o)) {
        return note({ ok: false, already: true, orderId: prior.orderId,
          message: `Order #${prior.orderId} already asks for a display of ${product.name} at ${labelFor(store)}.` });
      }
    }
    const by = auth.currentUser?.uid || null;
    const claimAt = serverNowMs();
    const claim = await runTransaction(lockRef, (cur) =>
      (lockHeld(cur, claimAt) ? undefined : { claimAt, by, orderId: null, orderCreatedAt: null }));
    if (!claim.committed) {
      return note({ ok: false, already: true,
        message: `A display of ${product.name} for ${labelFor(store)} was requested a moment ago.` });
    }

    const nowIso = serverNowIso();
    let orderId = null;
    let order = null;
    try {
      orderId = await getNextOrderNumber();
      order = wallWalkOrder({ orderId, store, hub: pick.hub, product, nowIso, by });
      order.raisedByEmail = auth.currentUser?.email || null;
      await set(ref(database, `orders/${orderId}`), order);
    } catch (err) {
      // A write that REPORTS failure may still have landed (a client timeout
      // after the server applied it). Ask the one key before deciding: if our
      // order is there, it is a success and the fence must name it; only if it
      // is not do we release the wall. (Architect review.)
      const landed = orderId
        ? await get(ref(database, `orders/${orderId}`)).then((sn) => sn.val()).catch(() => null)
        : null;
      if (!(landed && landed.createdAt === nowIso && landed.productId === productId)) {
        await set(lockRef, null).catch(() => {});
        throw err;
      }
    }
    await update(lockRef, { orderId, orderCreatedAt: nowIso }).catch(() => {});
    return { ok: true, orderId, hub: pick.hub, order, cleared: cleared.closed, warning: cleared.warning };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}
