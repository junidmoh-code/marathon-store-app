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
// ── CLAUSE 1 IS ENFORCED HERE TOO ────────────────────────────────────────────
// At most one open display request per product per store. The caller passes the
// orders it already holds and this refuses a second — the same guard the
// checkout runs, from the same pure function, so the two entry points cannot
// disagree about what "already asked for" means.

import { ref, set, get, remove } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { getNextOrderNumber } from "../../utils/orderCounter";
import { hasOpenDisplayRequest } from "./displayRowCore";
import { labelFor } from "./locations";

// ─── UNDOING ONE ─────────────────────────────────────────────────────────────
// (Owner, 2026-09-09: "give an undo button".) A wall walk is a walk — the
// operator is looking at shelves, tapping quickly, and the tap that raises a
// request is one pixel from the tap that registers one. Until now the raise was
// irreversible from this screen: it drew a real order number and entered the
// warehouse queue, and the only way back was to find the order elsewhere.
//
// ── WHAT MAY BE UNDONE, AND WHAT MAY NOT ─────────────────────────────────────
// Only an order this walk raised, at this store, that the warehouse has NOT yet
// started on. The moment it is Ready the warehouse has picked a shoe off a
// shelf for it, and deleting the order would leave that pair in someone's hand
// with nothing to say why. Then it is not an undo, it is a cancellation, and it
// belongs where cancellations already live.
//
// ── THE ID IS RE-READ, AND THE STAMP IS CHECKED ──────────────────────────────
// /orders ids are RECYCLED daily (the counter resets), so an id alone does not
// identify an order — tomorrow's order 42 is not today's. The undo therefore
// carries the createdAt it minted and refuses if the record at that id no
// longer carries the same one. Without that, an undo left on screen across
// midnight could delete a stranger's order.

export const CANCEL_GONE = "gone";
export const CANCEL_NOT_OURS = "not-ours";
export const CANCEL_STARTED = "started";

/**
 * Pure: may THIS undo delete THIS record? Split out so every refusal is a test
 * rather than a hope, and so the writer below cannot quietly disagree with it.
 *
 * @param order   what /orders/{id} actually holds right now, or null
 * @param expect  { createdAt, store } — what the undo believes it raised
 */
export function canCancelDisplayRequest(order, expect = {}) {
  if (!order || typeof order !== "object") {
    return { ok: false, reason: CANCEL_GONE, message: "That request is no longer there — nothing to undo." };
  }
  // Same id, different order: the daily counter recycled it.
  if (!expect.createdAt || order.createdAt !== expect.createdAt) {
    return { ok: false, reason: CANCEL_NOT_OURS,
      message: "That order number now belongs to a different order. Nothing was undone." };
  }
  if (order.wallWalk !== true || order.requestDisplayPartner !== true) {
    return { ok: false, reason: CANCEL_NOT_OURS,
      message: "That is not a wall-walk request. Nothing was undone." };
  }
  if (expect.store && order.destShop !== expect.store) {
    return { ok: false, reason: CANCEL_NOT_OURS,
      message: "That request belongs to another wall. Nothing was undone." };
  }
  // Anything past "incoming" means the warehouse has acted on it.
  if (order.readyAt || order.collectedAt || order.outOfStockAt || order.comingTomorrowAt
      || (order.status && order.status !== "incoming")) {
    return { ok: false, reason: CANCEL_STARTED,
      message: "The warehouse has already started on this one — it can no longer be undone here." };
  }
  return { ok: true };
}

/**
 * Undo a request this walk just raised.
 * → { ok } | { ok: false, reason, message }
 */
export async function cancelDisplayRequest({ orderId, createdAt, store }) {
  try {
    if (!orderId) return { ok: false, reason: CANCEL_GONE, message: "Nothing to undo." };
    // RE-READ. The decision is made against what the database holds now, never
    // against what the screen remembers.
    const snap = await get(ref(database, `orders/${orderId}`));
    const verdict = canCancelDisplayRequest(snap.val(), { createdAt, store });
    if (!verdict.ok) return verdict;
    await remove(ref(database, `orders/${orderId}`));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: CANCEL_GONE, message: String(err?.message || err) };
  }
}

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
    // createdAt travels back so an undo can prove the record it deletes is still
    // the one this raise created — /orders ids are recycled daily.
    return { ok: true, orderId, createdAt: now };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}
