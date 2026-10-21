// ── Shopify reads and the one Shopify write the online orders make ───────────
// Through the shared client (client.mjs) — same token, same throttling, same
// 2026-07 pin. Scopes: read_orders, write_merchant_managed_fulfillment_orders
// (orders-smoke.mjs proves both).

const ORDER_FIELDS = `
  id legacyResourceId name number createdAt updatedAt cancelledAt
  displayFinancialStatus displayFulfillmentStatus email phone
  customer { firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { name firstName lastName address1 address2 city province zip country phone }
  currentSubtotalPriceSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  lineItems(first: 100) {
    nodes {
      id title variantTitle quantity currentQuantity sku
      variant { id barcode product { id } }
      discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
      originalUnitPriceSet { shopMoney { amount } }
    }
  }`;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Every order UPDATED since `sinceMs` and CREATED since `createdSinceMs`
 * (the go-live instant — orders older than it were rung by hand and must
 * never be pulled in, or they would be deducted twice). updated_at, not
 * created_at, because a payment landing later, or a cancellation, moves it.
 * Paged; oldest change first so a partial run still advances in order.
 */
export async function fetchOrdersUpdatedSince(graphql, { sinceMs, createdSinceMs, maxPages = 20 }) {
  const q = `updated_at:>='${iso(sinceMs)}' AND created_at:>='${iso(createdSinceMs)}'`;
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(
      `query ($q: String!, $after: String) {
        orders(first: 25, after: $after, sortKey: UPDATED_AT, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ORDER_FIELDS} }
        }
      }`,
      { q, after },
    );
    out.push(...(data.orders?.nodes ?? []));
    if (!data.orders?.pageInfo?.hasNextPage) return out;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}

/** One order by its numeric id, with the same fields as the list. */
export async function fetchOrderById(graphql, id) {
  const data = await graphql(`query ($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: `gid://shopify/Order/${id}` });
  return data.order ?? null;
}

/** The order's fulfilment orders that still have units to ship. */
export async function openFulfillmentOrders(graphql, orderGid) {
  const data = await graphql(
    `query ($id: ID!) {
      order(id: $id) {
        id cancelledAt
        fulfillmentOrders(first: 20) {
          nodes { id status lineItems(first: 100) { nodes { remainingQuantity } } }
        }
      }
    }`,
    { id: orderGid },
  );
  if (!data.order) return { missing: true, open: [] };
  const open = (data.order.fulfillmentOrders?.nodes ?? []).filter((fo) =>
    (fo.status === "OPEN" || fo.status === "IN_PROGRESS")
    && (fo.lineItems?.nodes ?? []).some((li) => li.remainingQuantity > 0));
  return { missing: false, cancelled: !!data.order.cancelledAt, open };
}

/**
 * Mark the order fulfilled on Shopify: every open fulfilment order, all
 * remaining units, notifying the customer. The tracking number goes only when
 * the packer typed one. Re-reads first, so a retry after an ambiguous failure
 * (a 5xx may have applied) finds nothing open and reports done instead of
 * fulfilling twice — and an order Yasmin already fulfilled in the Shopify
 * admin out of habit is simply done.
 * → { ok: true, fulfillmentIds, alreadyDone? } | { ok: false, error }
 */
export async function fulfilOnShopify(graphql, { orderGid, trackingNumber = null, trackingCompany = null }) {
  const { missing, open } = await openFulfillmentOrders(graphql, orderGid);
  if (missing) return { ok: false, error: "Shopify no longer has this order" };
  if (!open.length) return { ok: true, fulfillmentIds: [], alreadyDone: true };
  const fulfillmentIds = [];
  for (const fo of open) {
    const fulfillment = {
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
      notifyCustomer: true,
      ...(trackingNumber
        ? { trackingInfo: { number: String(trackingNumber), ...(trackingCompany ? { company: String(trackingCompany) } : {}) } }
        : {}),
    };
    const data = await graphql(
      `mutation ($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      { fulfillment },
      { mutation: true },
    );
    const errs = data.fulfillmentCreate?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; "), fulfillmentIds };
    if (data.fulfillmentCreate?.fulfillment?.id) fulfillmentIds.push(data.fulfillmentCreate.fulfillment.id);
  }
  return { ok: true, fulfillmentIds };
}

// ── PARTIAL fulfilment — only the lines that were packed ───────────────────
// A pack may ship some lines and leave others resolving (escalation), and a
// follow-up order ships one line later. Shopify must show exactly what left:
// fulfilmentCreate with fulfillmentOrderLineItems for those Shopify line items.
//
// IDEMPOTENT ACROSS AN AMBIGUOUS FAILURE: one Shopify line item can be split
// over two app lines (one shipped, one resolving), so "what is still open" is
// not "what we owe". The caller records a BASELINE — units of each line item
// already fulfilled before this pack — once, before the first attempt; each
// attempt then fulfils baseline + packed − fulfilled-now, which is 0 after a
// 5xx that had in fact applied.

const PARTIAL_FIELDS = `
  id cancelledAt
  lineItems(first: 100) { nodes { id currentQuantity unfulfilledQuantity } }
  fulfillmentOrders(first: 20) {
    nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } }
  }`;

async function readForPartial(graphql, orderGid) {
  const data = await graphql(`query ($id: ID!) { order(id: $id) { ${PARTIAL_FIELDS} } }`, { id: orderGid });
  return data.order ?? null;
}

const fulfilledNow = (li) => Math.max(0, (Number(li.currentQuantity) || 0) - (Number(li.unfulfilledQuantity) || 0));

/** { [lineItemGid]: units already fulfilled } — the baseline to record before the first attempt. */
export async function fulfilmentBaseline(graphql, orderGid) {
  const order = await readForPartial(graphql, orderGid);
  if (!order) return null;
  const out = {};
  for (const li of order.lineItems?.nodes ?? []) out[li.id] = fulfilledNow(li);
  return out;
}

/** Pure: the fulfilmentOrderLineItems to send. `want` = { lineItemGid: units owed now }. */
export function partialFulfilmentPlan(fulfillmentOrders, want) {
  const left = { ...want };
  const plan = [];
  for (const fo of fulfillmentOrders) {
    if (fo.status !== "OPEN" && fo.status !== "IN_PROGRESS") continue;
    const items = [];
    for (const foli of fo.lineItems?.nodes ?? []) {
      const lid = foli.lineItem?.id;
      const owe = Math.min(Number(left[lid]) || 0, Number(foli.remainingQuantity) || 0);
      if (owe > 0) { items.push({ id: foli.id, quantity: owe }); left[lid] -= owe; }
    }
    if (items.length) plan.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: items });
  }
  return plan;
}

/**
 * Fulfil `packed` ({ lineItemGid: units in this parcel }) on top of `baseline`.
 * → { ok: true, fulfillmentIds, alreadyDone? } | { ok: false, error }
 */
export async function fulfilLinesOnShopify(graphql, { orderGid, packed, baseline, trackingNumber = null, trackingCompany = null, notifyCustomer = true }) {
  const order = await readForPartial(graphql, orderGid);
  if (!order) return { ok: false, error: "Shopify no longer has this order" };
  const want = {};
  for (const li of order.lineItems?.nodes ?? []) {
    if (!(li.id in packed)) continue;
    const owe = (Number(baseline?.[li.id]) || 0) + (Number(packed[li.id]) || 0) - fulfilledNow(li);
    if (owe > 0) want[li.id] = owe;
  }
  if (!Object.keys(want).length) return { ok: true, fulfillmentIds: [], alreadyDone: true };
  const plan = partialFulfilmentPlan(order.fulfillmentOrders?.nodes ?? [], want);
  // Owed but not coverable (on hold, scheduled, closed, or short): never
  // "done" — the fulfil-failed attention tells Junid (Sonnet review, PR #778).
  const covered = {};
  for (const e of plan) for (const fo of order.fulfillmentOrders?.nodes ?? []) if (fo.id === e.fulfillmentOrderId) {
    for (const it of e.fulfillmentOrderLineItems) { const lid = (fo.lineItems?.nodes ?? []).find((x) => x.id === it.id)?.lineItem?.id; if (lid) covered[lid] = (covered[lid] || 0) + it.quantity; }
  }
  const short = Object.entries(want).filter(([lid, n]) => (covered[lid] || 0) < n);
  if (short.length) return { ok: false, error: `Shopify has no open fulfilment for ${short.map(([lid, n]) => `${n - (covered[lid] || 0)} unit(s) of line item ${lid.split("/").pop()}`).join(", ")} (on hold, scheduled or closed?)` };
  // One fulfilment per fulfilment order (each may sit at its own Shopify
  // location). A failure part-way is safe: the retry re-reads and owes less.
  const fulfillmentIds = [];
  for (const entry of plan) {
    const fulfillment = {
      lineItemsByFulfillmentOrder: [entry],
      notifyCustomer,
      ...(trackingNumber ? { trackingInfo: { number: String(trackingNumber), ...(trackingCompany ? { company: trackingCompany } : {}) } } : {}),
    };
    const data = await graphql(
      `mutation ($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      { fulfillment },
      { mutation: true },
    );
    const errs = data.fulfillmentCreate?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; "), fulfillmentIds };
    if (data.fulfillmentCreate?.fulfillment?.id) fulfillmentIds.push(data.fulfillmentCreate.fulfillment.id);
  }
  return { ok: true, fulfillmentIds };
}
