// ─── What is IN a layby parcel — for the hub's request card (31 Oct 2026) ────
// Warehouse staff were reading the parcel number off every parcel on the shelf
// to find a layby. The request card now shows the product photo and the size,
// so the parcel can be spotted by eye.
//
// Neither /laybyPulls nor /laybys carries the products: the layby's lines live
// only on its sale, /pos/sales/{saleId}/lineItems ({ L1: { productId, size,
// name, brand, qty, refundedQty } }). So, per card:
//   1. ONE single-key read of that sale's lineItems (never /pos/sales);
//   2. per product, the photo leaves of THAT product only —
//      /products/{pid}/photoUrl, photoUpdatedAt, thumbAt (the three fields the
//      primary-photo reader needs: the photo and the marker of its thumbnail).
//      When the caller already holds the live product (the warehouse's own
//      product list), nothing is read at all.
// Both are cached for the life of the page (keyed by sale / product), so a
// card that re-renders, scrolls away and back, or moves from Incoming to
// Today's history never reads twice. A failed read is NOT cached — the next
// mount tries again.
import { ref, get } from "firebase/database";
import { database } from "../../firebase";

const itemsCache = new Map();   // saleId    → Promise<item[]>
const photoCache = new Map();   // productId → Promise<{ id, photoUrl, photoUpdatedAt, thumbAt } | null>

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[^.#$[\]/]{1,128}$/;

// lineItems → the parcel's lines, in line order, refunded-out lines dropped.
export function itemsFromLineItems(lineItems) {
  if (!lineItems || typeof lineItems !== "object") return [];
  const entries = Array.isArray(lineItems) ? lineItems.map((v, i) => [String(i), v]) : Object.entries(lineItems);
  return entries
    .filter(([, l]) => l && typeof l === "object")
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([lineId, l]) => {
      const qty = Number.isFinite(l.qty) ? l.qty : 1;
      const refunded = Number.isFinite(l.refundedQty) ? l.refundedQty : 0;
      return {
        lineId,
        productId: typeof l.productId === "string" && PID_RE.test(l.productId) ? l.productId : null,
        size: l.size != null && l.size !== "" ? String(l.size) : null,
        name: l.name || [l.brand, l.productName].filter(Boolean).join(" ") || null,
        qty: Math.max(0, qty - refunded),
      };
    })
    .filter((it) => it.qty > 0);
}

export function fetchLaybyItems(saleId) {
  if (!saleId || !KEY_RE.test(saleId)) return Promise.resolve([]);
  if (!itemsCache.has(saleId)) {
    const p = get(ref(database, `pos/sales/${saleId}/lineItems`))
      .then((snap) => itemsFromLineItems(snap.val()))
      .catch((e) => { itemsCache.delete(saleId); throw e; });
    itemsCache.set(saleId, p);
  }
  return itemsCache.get(saleId);
}

export function fetchProductPhoto(productId) {
  if (!productId || !PID_RE.test(productId)) return Promise.resolve(null);
  if (!photoCache.has(productId)) {
    const leaf = (k) => get(ref(database, `products/${productId}/${k}`)).then((s) => s.val());
    const p = Promise.all([leaf("photoUrl"), leaf("photoUpdatedAt"), leaf("thumbAt")])
      .then(([photoUrl, photoUpdatedAt, thumbAt]) => (photoUrl ? { id: productId, photoUrl, photoUpdatedAt, thumbAt } : null))
      .catch((e) => { photoCache.delete(productId); throw e; });
    photoCache.set(productId, p);
  }
  return photoCache.get(productId);
}

/** Test seam: forget every cached read. */
export function _resetLaybyItemCaches() { itemsCache.clear(); photoCache.clear(); }
