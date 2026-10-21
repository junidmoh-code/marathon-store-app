// ── A website order, as the app holds it — PURE ─────────────────────────────
// Everything here is a function of its arguments: no database, no Shopify, no
// clock. orders-poll.mjs does the reading and writing; this decides what is
// written. The contract is docs/ONLINE-ORDERS.md.
import {
  orderLabel, ONLINE_PICK_KIND, PACKER_INSTRUCTION, PACKING_STORE, ORDER_STATUS, LINE_STATUS,
  ATTENTION_KIND, HOLDING_STATUSES, deriveOrderStatus,
} from "../../../src/utils/onlineOrders.js";

// Only these are pulled in. A pending-payment order becomes PAID later and is
// picked up then (its updated_at moves); a partly fulfilled one was handled by
// hand and stays that way.
export function isIngestible(node) {
  return !!node
    && !node.cancelledAt
    && node.displayFinancialStatus === "PAID"
    && node.displayFulfillmentStatus === "UNFULFILLED";
}

/** "123.45" → 12345. Shopify money is a decimal string in shop currency. */
export function cents(money) {
  const n = Number(money?.shopMoney?.amount ?? money?.amount ?? money);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const gidTail = (gid) => (typeof gid === "string" ? gid.split("/").pop() : null);
export const numericId = gidTail;

// RTDB stores no null, no undefined and no empty string worth keeping: drop
// them here so what is written is what reads back.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

export function customerOf(node) {
  const c = node.customer || {};
  const a = node.shippingAddress || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim()
    || a.name || [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || null;
  return compact({
    name,
    phone: node.phone || c.defaultPhoneNumber?.phoneNumber || a.phone || null,
    email: node.email || c.defaultEmailAddress?.emailAddress || null,
  });
}

export function shippingOf(node) {
  const a = node.shippingAddress;
  // `provider` is null today (courier booking is out of scope). RTDB cannot
  // store null, so it is simply absent; readers use `shipping?.provider ?? null`.
  const address = a ? compact({
    name: a.name, address1: a.address1, address2: a.address2, city: a.city,
    province: a.province, zip: a.zip, country: a.country, phone: a.phone,
  }) : null;
  return address && Object.keys(address).length ? { address } : {};
}

export function totalsOf(node) {
  return compact({
    subtotalCents: cents(node.currentSubtotalPriceSet),
    shippingCents: cents(node.totalShippingPriceSet),
    taxCents: cents(node.currentTotalTaxSet),
    totalCents: cents(node.currentTotalPriceSet),
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || null,
  });
}

/**
 * One app line from a routed piece.
 *   item      the Shopify line item node
 *   resolved  { pid, size, sizeKey, product, isFootwear } or { reason } when
 *             the variant is not in /shopify_sync
 *   piece     { qty, locationId, status } from routeLine (absent when unresolved)
 */
export function buildLine({ index, item, resolved, piece }) {
  const base = {
    lineId: `l${index}`,
    shopifyLineItemId: item.id,
    variantId: item.variant?.id || null,
    // Kept so a Resolve can look the line up again without Shopify.
    productGid: item.variant?.product?.id || null,
    title: [item.title, item.variantTitle].filter(Boolean).join(" — ") || "Item",
    unitPriceCents: cents(item.discountedUnitPriceAfterAllDiscountsSet ?? item.originalUnitPriceSet),
  };
  if (!resolved?.pid) {
    return compact({
      ...base,
      qty: Number(item.currentQuantity ?? item.quantity) || 1,
      source: { status: LINE_STATUS.UNRESOLVED },
      reason: resolved?.reason || "This Shopify item is not linked to a product in the app",
    });
  }
  const p = resolved.product || {};
  return compact({
    ...base,
    pid: resolved.pid,
    size: resolved.size,
    sizeKey: resolved.sizeKey,
    qty: piece.qty,
    title: p.name || base.title,
    photoUrl: p.photoUrl || null,
    barcode: resolved.barcode || null,
    category: p.category || null,
    isFootwear: !!resolved.isFootwear,
    source: compact({ locationId: piece.locationId, status: piece.status }),
  });
}

export function buildOrder({ node, lines, nowMs }) {
  const order = {
    // The order's NAME is its Shopify number (orderLabel → "#1768"); the
    // three-letter codes belong to its hub order units, not to the order.
    orderNumber: node.number,
    shopifyGid: node.id,
    shopifyName: node.name,
    createdAt: Date.parse(node.createdAt) || nowMs,
    ingestedAt: nowMs,
    updatedAt: nowMs,
    customer: customerOf(node),
    shipping: shippingOf(node),
    totals: totalsOf(node),
    lines,
    status: ORDER_STATUS.NEW,
  };
  if (!Object.keys(order.shipping).length) delete order.shipping;
  if (!Object.keys(order.customer).length) delete order.customer;
  return order;
}

const linesOf = (order) => (Array.isArray(order?.lines) ? order.lines : Object.values(order?.lines || {}));

/**
 * The hold rows an order should have: { "pid/sizeKey": { qty, ref, locs } }.
 * Empty for an order that holds nothing (packed, cancelled, or unresolved
 * lines only). `locs` names where the units are routed; a no_stock unit counts
 * in qty (Shopify must not sell it again either) and in no location.
 */
export function holdRowsFor(order) {
  const rows = {};
  // A PACKED order still holds the lines it shipped without — the ones still
  // climbing the escalation chain (they ship in a follow-up when they come good).
  const packed = order?.status === ORDER_STATUS.PACKED;
  if (!HOLDING_STATUSES.includes(order?.status) && !packed) return rows;
  for (const line of linesOf(order)) {
    if (!line?.pid || !line.sizeKey) continue;
    const st = line.source?.status;
    if (packed && st !== LINE_STATUS.RESOLVING) continue;
    // Settled lines hold nothing: no unit exists (unavailable), the customer
    // took credit / a refund / another item (resolved), or a follow-up order
    // holds it now (moved).
    if (st === LINE_STATUS.CANCELLED || st === LINE_STATUS.UNAVAILABLE || st === LINE_STATUS.RESOLVED || st === LINE_STATUS.MOVED) continue;
    const key = `${line.pid}/${line.sizeKey}`;
    const row = rows[key] || (rows[key] = { qty: 0, ref: orderLabel(order), locs: {} });
    const q = Number(line.qty) || 0;
    row.qty += q;
    // Fulfilled in the Shopify admin before the pack (switch on): Shopify has
    // already taken the unit off on_hand and no longer commits it, so the push
    // must subtract THIS hold outright (inventorySync.mjs onlineHoldAdjustment).
    if (order.shopifyFulfilledAt) row.released = (row.released || 0) + q;
    const loc = line.source?.locationId;
    if (loc) row.locs[loc] = (row.locs[loc] || 0) + q;
  }
  for (const row of Object.values(rows)) if (!Object.keys(row.locs).length) delete row.locs;
  return rows;
}

/** Same hold? (`at` is bookkeeping, not part of the hold.) */
export function sameHold(a, b) {
  if (!a || !b) return !a && !b;
  const locs = (r) => JSON.stringify(Object.entries(r.locs || {}).sort());
  return Number(a.qty) === Number(b.qty) && a.ref === b.ref && locs(a) === locs(b)
    && (Number(a.released) || 0) === (Number(b.released) || 0);
}

// ── Feed entries ─────────────────────────────────────────────────────────────
// `gen` counts re-routes of the line (Settings → Resolve). A re-routed line
// gets a FRESH entry key, so the entry it had before (cancelled, or answered
// "Not found") is never mistaken for the new one and never re-opened.
const genSuffix = (gen) => (Number(gen) > 0 ? `_r${Number(gen)}` : "");
export const displayKey = (orderId, index, gen = 0) => `online__${orderId}__${index}${genSuffix(gen)}`;

// ── Hub orders: the EXISTING store-order route ───────────────────────────────
// A website line routed to a hub (every sneaker; clothing that only Hub 2 has)
// becomes the same /orders record the Assistant writes when a shop orders from
// a hub (App.jsx placeOrders) — one record per unit, field for field — so Hub 1
// and Hub 2 see it in their Warehouse queue and the TV shows it. Differences,
// all deliberate:
//   id / key       the order's three-letter code ("KQZ"); "KQZ-2", "KQZ-2-1"…
//                  when the order sends more than one unit through a hub. A
//                  letters-first key can never be rung at a till (the POS
//                  order lookup keeps digits only) — so the till never sells
//                  it and never deducts it: the deduction is the POS Pack's.
//   customerName   "Shopify"; customerPhone null — every customer message
//                  (order_placed / ready / out_of_stock / tomorrow) is gated
//                  on a phone, so none is ever sent.
//   channel        "online" — dispatch skips its stock movement on this
//                  (App.jsx recordDispatchTransfer); the POS dispatch index
//                  skips it too. onlineOrderId / onlineLineIndex link back.
export function hubOrderKeys(ref, orderLines, index) {
  const lines = Array.isArray(orderLines) ? orderLines : [];
  const hubUnits = lines.reduce((n, l) => n + (l?.source?.status === LINE_STATUS.PICK ? Math.max(1, Number(l.qty) || 1) : 0), 0);
  const line = lines[index];
  const qty = Math.max(1, Number(line?.qty) || 1);
  const gen = Number(line?.routeGen) > 0 ? `r${Number(line.routeGen)}` : "";
  if (hubUnits === 1 && !gen) return [ref];
  const base = `${ref}-${index + 1}${gen}`;
  return qty === 1 ? [base] : Array.from({ length: qty }, (_, u) => `${base}-${u + 1}`);
}

export function hubOrderRecord({ key, line, onlineOrderId, lineIndex, section, nowIso, orderNumber = null, unit = 0 }) {
  const hub = line.source.locationId;
  return {
    id: key,
    productId: line.pid,
    productName: line.title ?? null,
    productPhoto: null,
    productPhotoUrl: line.photoUrl ?? null,
    size: line.size ?? null,
    sentSize: null,
    productType: line.isFootwear ? "sneaker" : "clothing",
    customerName: "Shopify",
    customerPhone: null,
    customerId: null,
    customerCode: null,
    customerPending: false,
    hub,
    placedAtHub: hub,
    placedStore: "central",
    destShop: PACKING_STORE,
    section: section ?? null,
    requestDisplay: false,
    requestDisplayPartner: false,
    displayPairRequest: false,
    displayPairStore: null,
    status: "incoming",
    createdAt: nowIso,
    updatedAt: nowIso,
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
    channel: "online",
    onlineOrderId: String(onlineOrderId),
    onlineLineIndex: lineIndex,
    // The website order's Shopify number (the POS collect-by-code shows it)
    // and which unit of the line this code is (one code per pair).
    ...(orderNumber != null ? { onlineOrderNumber: orderNumber } : {}),
    onlineUnit: unit,
    // Escalation round 2: this hub already marked it Out of Stock once.
    ...(line.source?.checkProperly === true ? { checkProperly: true } : {}),
  };
}

/**
 * What the hub has done with a line's /orders records, for the order line.
 *   records  the line's hub orders, as read (null = gone)
 * → { status, locationId?, reason? } or null when nothing changed hands yet.
 *   every unit sent ("ready"/"collected") → handed, from the hub that sent it
 *   any unit out of stock                  → no_stock
 *   a unit sent in a different size        → needs_attention (Shopify sold a size)
 */
export function hubOutcome(line, records) {
  // Only this program's own records — a key a shop's order happened to take is never read as ours.
  const recs = (records || []).filter((r) => r && r.channel === "online");
  if (!recs.length) return null;
  const oos = recs.find((r) => r.status === "out_of_stock");
  if (oos) return { status: LINE_STATUS.NO_STOCK, reason: `${oos.hub ?? "The hub"} marked it out of stock` };
  const wrong = recs.find((r) => r.sentSize != null && String(r.sentSize) !== String(line.size ?? ""));
  if (wrong) return { status: LINE_STATUS.NEEDS_ATTENTION, reason: `${wrong.hub ?? "The hub"} sent size ${wrong.sentSize}, the website sold size ${line.size}` };
  if (recs.every((r) => r.status === "ready" || r.status === "collected")) {
    const hubs = [...new Set(recs.map((r) => r.hub).filter(Boolean))];
    return { status: LINE_STATUS.HANDED, ...(hubs.length === 1 ? { locationId: hubs[0] } : {}) };
  }
  return null;
}

/**
 * A display-check record the shop's feed already knows how to show: the same
 * open-check fields buildNewCheck writes (functions/displayChecks/lib.cjs),
 * plus the online-order fields. `assignedTo` is the rostered person, resolved
 * by the caller with the feed's own resolveAssignment.
 */
export function displayEntry({ orderId, order, index, line, checkId, nowMs, saDate, assignedTo }) {
  return compact({
    kind: ONLINE_PICK_KIND,
    checkId,
    productId: line.pid,
    productName: line.title,
    size: line.size == null || line.size === "" ? "_" : String(line.size),
    sizeKey: line.sizeKey,
    dedupeKey: displayKey(orderId, index, line.routeGen),
    photoUrl: line.photoUrl,
    saleCount: Number(line.qty) || 1,
    qty: Number(line.qty) || 1,
    status: "open",
    createdAt: nowMs,
    activatedAt: nowMs,
    activatedSaDate: saDate,
    assignedTo: assignedTo || null,
    orderId, ref: orderLabel(order), orderNumber: order.orderNumber ?? null, lineIndex: index,
    instruction: PACKER_INSTRUCTION,
    // Escalation round 2: the shop said "Not found" once already.
    checkProperly: line.source?.checkProperly === true ? true : null,
  });
}

// ── Attention ────────────────────────────────────────────────────────────────
const LINE_ATTENTION = Object.freeze({
  [LINE_STATUS.UNRESOLVED]: ATTENTION_KIND.UNRESOLVED,
  [LINE_STATUS.NO_STOCK]: ATTENTION_KIND.NO_STOCK,
  [LINE_STATUS.NOT_FOUND]: ATTENTION_KIND.NOT_FOUND,
  [LINE_STATUS.NEEDS_ATTENTION]: ATTENTION_KIND.WALKIN_OVERRIDE,
});

const PLACE = { hub1: "Hub 1", hub2: "Hub 2", "marathon-pe": "Marathon PE", trophy: "Trophy" };
export const placeName = (loc) => PLACE[loc] || loc || "nowhere";

/** The attention an order's lines call for, or null. */
export function attentionFromLines(order, nowMs) {
  const bad = linesOf(order).filter((l) => LINE_ATTENTION[l?.source?.status]);
  if (!bad.length) return null;
  const kind = LINE_ATTENTION[bad[0].source.status];
  const what = (l) => `${l.title}${l.size && l.size !== "_" ? ` size ${l.size}` : ""} ×${l.qty}`;
  const why = (l) => {
    switch (l.source.status) {
      case LINE_STATUS.UNRESOLVED: return `${what(l)}: ${l.reason || "not linked to a product in the app"}`;
      case LINE_STATUS.NO_STOCK: return `${what(l)}: ${l.source.reason || "no stock at Hub 1, Hub 2, Marathon PE or Trophy"}`;
      case LINE_STATUS.NOT_FOUND: return `${what(l)}: not found at ${placeName(l.source.locationId)}`;
      default: return `${what(l)}: ${l.source.reason || `a walk-in sale took the unit held at ${placeName(l.source.locationId)}`}`;
    }
  };
  return { kind, reason: bad.map(why).join("; "), at: nowMs };
}

export { deriveOrderStatus, linesOf };
