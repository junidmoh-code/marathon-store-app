// ── Which Shopify units this parcel carries ──────────────────────────────────
// A pack that shipped every line fulfils the whole order (fulfilOnShopify, as
// before). A pack that left lines resolving — or a follow-up order carrying
// one line that came good later — fulfils only its own Shopify line items
// (fulfilLinesOnShopify), on top of a baseline recorded once before the first
// attempt (see shopifyOrders.mjs).
import { ONLINE_ORDERS_PATH } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { fulfilOnShopify, fulfilmentBaseline, fulfilLinesOnShopify } from "./shopifyOrders.mjs";

const tail = (gid) => String(gid).split("/").pop();

/**
 * { lineItemGid: units } for the lines this pack shipped, or null when the
 * pack shipped the whole order. `packedLines` ({ [i]: true }) is written by the
 * POS pack; an order packed before partial packs existed has none and shipped
 * everything.
 */
export function packedLineItems(order) {
  const lines = linesOf(order);
  const packedIdx = order?.packedLines
    ? Object.keys(order.packedLines).filter((k) => order.packedLines[k]).map(Number)
    : null;
  const partial = !!order?.followUpOf || (packedIdx && lines.some((_, i) => !packedIdx.includes(i)));
  if (!partial) return null;
  const idx = packedIdx ?? lines.map((_, i) => i);
  const out = {};
  for (const i of idx) {
    const l = lines[i];
    if (!l?.shopifyLineItemId) continue;
    out[l.shopifyLineItemId] = (out[l.shopifyLineItemId] || 0) + (Number(l.qty) || 0);
  }
  return out;
}

export async function fulfilParcel(ctx, id, order, { trackingNumber = null, trackingCompany = null } = {}) {
  const packed = packedLineItems(order);
  if (!packed) return fulfilOnShopify(ctx.graphql, { orderGid: order.shopifyGid, trackingNumber, ...(trackingCompany ? { trackingCompany } : {}) });
  if (!Object.keys(packed).length) return { ok: true, fulfillmentIds: [], alreadyDone: true };
  let stored = order.fulfil?.baseline;
  if (!stored) {
    const base = await fulfilmentBaseline(ctx.graphql, order.shopifyGid);
    if (!base) return { ok: false, error: "Shopify no longer has this order" };
    stored = {};
    for (const [gid, n] of Object.entries(base)) stored[tail(gid)] = n;
    // RECORDED BEFORE THE FIRST MUTATION — the whole point of a baseline.
    await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/fulfil/baseline`).set(stored);
  }
  const baseline = {};
  for (const gid of Object.keys(packed)) baseline[gid] = Number(stored[tail(gid)]) || 0;
  // A parcel carrying a swapped item is fulfilled against the ORIGINAL
  // Shopify line: Shopify's shipping email would name the wrong product, so it
  // is not sent (the customer agent already confirmed the swap by email).
  const swapped = linesOf(order).some((l, i) => l?.swappedFrom && (order.followUpOf || order.packedLines?.[i]));
  return fulfilLinesOnShopify(ctx.graphql, { orderGid: order.shopifyGid, packed, baseline, trackingNumber, trackingCompany, notifyCustomer: !swapped });
}
