// ── Cross-store stock fan-out: the pure half ─────────────────────────────────
// stock-fanout.mjs runs one long-lived process PER STORE on the Mac mini
// (SHOPIFY_STORE=marathon / =concrete). A product listed on BOTH stores sells
// from one stock pool, so the last unit could sell twice inside the 2-minute
// reconcile tick. The fan-out closes that window two ways:
//
//   1. STOCK MOVED — the shopifyInventoryDirty Function marks each store's
//      dirty node for a product live there; this store's process LISTENS to
//      its own node and pushes the product within seconds.
//
//   2. A SALE ON THE OTHER STORE THE APP HAS NOT PULLED IN YET — every 20 s
//      each process reads its OWN store's newest orders. A line for a product
//      that is also live on another store, from an order not yet in
//      /online_orders, is written to /shopify_pending_sales/{store}/{orderId}
//      and the other store's dirty node is bumped. That store's push takes
//      the pending units off (pendingForeignFor). Once the order is ingested
//      its holds take over (inventorySync withoutForeignHolds) and the pending
//      entry is dropped — never both at once.
//
// Marathon-only products are untouched: Marathon's process acts ONLY on
// products also live on Concrete, and never clears Marathon's marker (the
// reconcile tick still owns it exactly as before).
import { assertSafeSegment, encodeSizeKey } from "../../src/utils/sizeKey.js";

export const PENDING_PATH = "shopify_pending_sales";
export const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const ORDER_LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const ORDER_POLL_MS = 20 * 1000;

export const isLiveOn = (node) => node?.state === "live" && node?.liveState === "on";
export const numericId = (gid) => String(gid || "").split("/").pop();

/**
 * Pending lines of one Shopify order, for products in `dualPids` only:
 * { [pid]: { [sizeKey]: qty } }. `resolve(productGid, variantGid)` →
 * { pid, sizeKey } | null (this store's id map). Cancelled orders hold nothing.
 */
export async function pendingLinesFor(order, { dualPids, resolve }) {
  if (!order || order.cancelledAt) return {};
  const out = {};
  for (const li of order.lineItems?.nodes || []) {
    const qty = Number(li.currentQuantity ?? li.quantity) || 0;
    if (qty <= 0 || !li.variant?.id) continue;
    const hit = await resolve(li.variant.product?.id, li.variant.id);
    if (!hit || !dualPids.has(hit.pid)) continue;
    assertSafeSegment(hit.pid, "productId");
    assertSafeSegment(hit.sizeKey, "sizeKey");
    (out[hit.pid] ||= {})[hit.sizeKey] = (out[hit.pid][hit.sizeKey] || 0) + qty;
  }
  return out;
}

/**
 * Units of `pid` sold on OTHER stores and not yet ingested:
 * pendingNode = /shopify_pending_sales (whole, small); `ingested(orderId)` →
 * true when /online_orders/{orderId} exists.
 */
export async function pendingForeignFor(pendingNode, pid, ownStore, ingested, nowMs) {
  const out = {};
  for (const [store, orders] of Object.entries(pendingNode || {})) {
    if (store === ownStore) continue;
    for (const [orderId, entry] of Object.entries(orders || {})) {
      const lines = entry?.lines?.[pid];
      if (!lines) continue;
      if (nowMs - (Number(entry.at) || 0) > PENDING_MAX_AGE_MS) continue;
      if (await ingested(orderId)) continue;
      for (const [sizeKey, q] of Object.entries(lines)) out[sizeKey] = (out[sizeKey] || 0) + (Number(q) || 0);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Variant → { pid, sizeKey } through a store's id map (claims, then variants). */
export function makeResolver(get, syncPath) {
  const cache = new Map();
  return async (productGid, variantGid) => {
    if (!productGid || !variantGid) return null;
    const key = `${productGid}|${variantGid}`;
    if (cache.has(key)) return cache.get(key);
    let hit = null;
    const pid = await get(`${syncPath}/_claims/${numericId(productGid)}`);
    if (typeof pid === "string" && pid) {
      const variants = (await get(`${syncPath}/${pid}/variants`)) || {};
      for (const [sizeKey, v] of Object.entries(variants)) {
        if (v?.shopifyVariantId === variantGid) { hit = { pid, sizeKey }; break; }
      }
    }
    cache.set(key, hit);
    return hit;
  };
}

/** Lag sample (ms) → a short human line. */
export function lagLine(kind, pid, ms) {
  return `lag ${kind} ${pid}: ${(ms / 1000).toFixed(1)} s`;
}

export { encodeSizeKey };
