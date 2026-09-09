// ─── RAISING A DISPLAY REQUEST FROM THE WALL WALK ────────────────────────────
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
// ── THERE IS NO UNDO HERE, AND THAT IS A DECISION ────────────────────────────
// (Owner asked for one, 2026-09-09. It is deliberately NOT here.) Undoing means
// removing a live warehouse job, and three things stand in the way of doing that
// safely from a client:
//
//   1. THE READ IS DENIED TO THE PEOPLE WHO NEED IT. /orders has no per-child
//      .read — a destShop-pinned device may only read it through the
//      orderByChild("destShop") query useOrders already runs. A store operator
//      is the only person who walks a wall, and they cannot read orders/{id}
//      directly, so an undo that checks before deleting fails for exactly them.
//   2. READ-THEN-DELETE IS NOT ATOMIC. The one guard that matters is "the
//      warehouse has not started". Between the check and the delete the
//      warehouse can mark it Ready — and then a pair is off a shelf and in
//      somebody's hand with no order left to explain it. A transaction would
//      close that window, and a transaction needs the same denied read.
//   3. NOTHING IN THIS APP HAS EVER DELETED AN ORDER. A wall-walk request is
//      written nowhere else, so a delete would destroy the only copy — raisedBy
//      included — and leave no trace it ever existed.
//
// The confirm step in DisplayRegistrationView is what actually stops the
// accidental request, and it needs none of this. A real undo belongs behind a
// callable that can read the order with admin rights, refuse it atomically, and
// write a tombstone before it removes anything.
//
// ── CLAUSE 1 IS ENFORCED HERE TOO ────────────────────────────────────────────
// At most one open display request per product per store. The caller passes the
// orders it already holds and this refuses a second — the same guard the
// checkout runs, from the same pure function, so the two entry points cannot
// disagree about what "already asked for" means.

import { ref, set } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { getNextOrderNumber } from "../../utils/orderCounter";
import { hasOpenDisplayRequest } from "./displayRowCore";
import { labelFor } from "./locations";

/**
 * Raise one display partner request for a product at a store.
 *
 * @param orders     the orders the caller already streams — the clause 1 guard
 * @param store      whose wall it is for (marathon-pe / trophy)
 * @param hub        the hub that will serve it (hub1 / hub2)
 * @param product    { id, name, photo, photoUrl, category, productType }
 * → { ok, orderId } | { ok: false, message, already? }
 */
export async function raiseDisplayRequest({ orders, store, hub, product }) {
  try {
    if (!store || !product?.id) return { ok: false, message: "Store and product are required." };
    if (hasOpenDisplayRequest(orders, { store, productId: product.id })) {
      return { ok: false, already: true,
        message: `A display partner is already on its way for ${product.name} at ${labelFor(store)}. The wall gets one pair, not two.` };
    }
    const now = serverNowIso();
    const orderId = await getNextOrderNumber();
    const order = {
      id: orderId,
      productId: product.id,
      productName: product.name || "",
      productPhoto: product.photo ?? null,
      productPhotoUrl: product.photoUrl ?? null,
      productCategory: product.category || "",
      productType: product.productType || "sneaker",
      // NO SIZE. The operator picks it at Send. See the header.
      size: null,
      sentSize: null,
      customerName: `Display wall — ${labelFor(store)}`,
      customerPhone: null,
      customerId: null,
      customerCode: null,
      customerPending: false,
      hub,
      placedAtHub: hub,
      placedStore: "central",
      destShop: store,
      requestDisplay: false,
      requestDisplayPartner: true,
      // Not a display-pair PULL: nothing is being taken off a wall, a pair is
      // being asked FOR one. The pull contract (#456) is untouched by this.
      displayPairRequest: false,
      displayPairStore: null,
      wallWalk: true,
      raisedBy: auth.currentUser?.uid || null,
      status: "incoming",
      createdAt: now,
      updatedAt: now,
      readyAt: null,
      outOfStockAt: null,
      comingTomorrowAt: null,
      collectedAt: null,
      displayRefillScheduledAt: null,
      displayRefillHub: null,
      displayRefillStatus: null,
      displayRefilledAt: null,
      displayRefillStockDepletedAt: null,
      displayRefilledBy: null,
    };
    await set(ref(database, `orders/${orderId}`), order);
    return { ok: true, orderId };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}
