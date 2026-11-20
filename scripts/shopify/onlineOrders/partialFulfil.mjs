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

// ── ONE ORDER, ONE PARCEL: NO PART-SHIPPING (Junid, 20 Nov 2026) ─────────────
// "One order ships as one parcel, all items together, unless the 24h no-reply rule fired. Part-shipping is blocked."
// A pack may leave a line out ONLY when a recorded decision has taken that line off the order's parcel:
//   store_credit       Jamie's ship-without rule (the 24 h no-reply rule, or the customer said no to the alternatives)
//   refund             the money went back for that line
//   refund_requested   the customer asked for that line's money back
//   resolution/money   the store's customer agent settled it in credit or a refund
//   cancelled          the line was cancelled
// Anything else left behind (left out by "Ship available items", still resolving, unavailable, no stock, not found,
// moved to a follow-up) stops the ship step BEFORE a courier is booked: #2204's T-shirt and #2292's trainer were
// left behind that way on 20 Nov and each customer got half an order. A second parcel (<id>r<n>), a follow-up record
// and an exchange are their own parcels and are not judged here.
export const OFF_PARCEL_OUTCOMES = Object.freeze(["store_credit", "refund", "refund_requested"]);
const isOwnParcel = (id, order) => !!order?.followUpOf || !!order?.reship || /^exchange-/.test(String(id)) || /^\d+[rf]\d+$/.test(String(id));
/** Has a recorded decision taken this line off the parcel? PURE. */
export function settledOffParcel(line) {
  if (!line) return true;
  if (String(line.source?.status || line.status || "") === "cancelled") return true;
  if (OFF_PARCEL_OUTCOMES.includes(String(line.resolution?.outcome?.kind || ""))) return true;
  const money = line.resolution?.money;
  return !!money && ["credit", "refund"].includes(String(money.kind)) && Number(money.amountCents) > 0;
}
/**
 * The lines a pack left behind with nothing settled: [{ i, title, size, status }] (empty = the parcel is the whole
 * order, or everything missing from it was settled). PURE.
 */
export function partShipBlockers(id, order) {
  if (!order?.packedLines || isOwnParcel(id, order)) return [];
  const out = [];
  linesOf(order).forEach((l, i) => {
    if (!l || order.packedLines[i]) return;
    if (!settledOffParcel(l)) out.push({ i, title: l.title || l.pid || `line ${i + 1}`, size: l.size ?? null, status: String(l.source?.status || l.status || "open") });
  });
  return out;
}
/** The one sentence the packer and Junid read. PURE. */
export const partShipReason = (blockers) => `part-shipping is blocked: ${blockers.map((b) => `${b.title}${b.size != null && b.size !== "_" ? ` ${b.size}` : ""} (${b.status.replace(/_/g, " ")})`).join(", ")} ${blockers.length === 1 ? "is" : "are"} not in the parcel and nothing has settled ${blockers.length === 1 ? "it" : "them"}. One order ships as one parcel: add the item, or wait until it is settled (Jamie's 24 hour rule), then press Retry`;

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
