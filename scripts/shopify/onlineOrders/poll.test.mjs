import { describe, it, expect } from "vitest";
import { runOrdersPoll, attentionMail } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import doorRates from "../../shipping/fixtures/rates-door-capetown.json";
import lockerRates from "../../shipping/fixtures/rates-locker-capetown.json";

// Courier Guy, faked: rates from the recorded fixtures; a shipment call is
// recorded so a test can prove none happened. Every poll test gets one, so no
// test ever constructs the real client.
function fakeCourier() {
  const calls = [];
  return {
    calls,
    getRates: async (body) => { calls.push(["getRates", body]); return body.collection_pickup_point_id ? lockerRates : doorRates; },
    createShipment: async (body) => { calls.push(["createShipment", body]); throw new Error("createShipment must not be reached"); },
    cancelShipment: async (ref) => { calls.push(["cancelShipment", ref]); throw new Error("cancelShipment must not be reached"); },
  };
}

const NOW = Date.parse("2026-10-21T10:00:00Z");
const GO_LIVE = Date.parse("2026-10-21T09:00:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;

function world(over = {}) {
  return {
    online_orders_meta: { goLiveAtMs: GO_LIVE },
    config: { onlineOrders: { enabled: false } },
    products: {
      SNK: { name: "Air Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["8", "9"], photoUrl: "https://x/snk.jpg" },
      TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", productType: "clothing", sizes: ["M", "L"], barcodes: { M: "6001", L: "6002" }, photoUrl: "https://x/tee.jpg" },
    },
    shopify_sync: {
      _claims: { 111: "SNK", 222: "TEE" },
      SNK: { shopifyProductId: P(111), variants: { 8: { shopifyVariantId: V(1108) }, 9: { shopifyVariantId: V(1109) } } },
      TEE: { shopifyProductId: P(222), variants: { M: { shopifyVariantId: V(222001) }, L: { shopifyVariantId: V(222002) } } },
    },
    stock: {
      hub1: { SNK: { 8: { qty: 1 } } },
      hub2: { SNK: { 8: { qty: 2 } }, TEE: { M: { qty: 3 } } },
      "marathon-pe": { TEE: { M: { qty: 1 } } },
      trophy: { TEE: { M: { qty: 0 } } },
    },
    ...over,
  };
}

function shopifyOrder(over = {}) {
  return {
    id: "gid://shopify/Order/9001", legacyResourceId: "9001", name: "#1801", number: 1801,
    createdAt: "2026-10-21T09:30:00Z", updatedAt: "2026-10-21T09:31:00Z", cancelledAt: null,
    displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED",
    email: "buyer@example.com", phone: null,
    customer: { firstName: "Thandi", lastName: "M", defaultPhoneNumber: { phoneNumber: "+27820000000" } },
    shippingAddress: { name: "Thandi M", address1: "1 Main Rd", city: "Gqeberha", zip: "6001", country: "South Africa" },
    currentSubtotalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "ZAR" } },
    currentTotalPriceSet: { shopMoney: { amount: "1600.00", currencyCode: "ZAR" } },
    totalShippingPriceSet: { shopMoney: { amount: "100.00" } },
    currentTotalTaxSet: { shopMoney: { amount: "195.65" } },
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/1", title: "Air Runner", variantTitle: "8", quantity: 2, currentQuantity: 2, variant: { id: V(1108), product: { id: P(111) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "500.00" } } },
      { id: "gid://shopify/LineItem/2", title: "Club Tee", variantTitle: "M", quantity: 2, currentQuantity: 2, variant: { id: V(222001), product: { id: P(222) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "250.00" } } },
    ] },
    ...over,
  };
}

// A Shopify double: orders come from `orders`, fulfilment from `fos`.
function shopify({ orders = [], fos = [], fulfilErrors = [], byId = {} } = {}) {
  const calls = [];
  const graphql = async (query, vars) => {
    calls.push({ query, vars });
    if (/order\(id: \$id\) \{\s+id legacyResourceId/.test(query)) return { order: byId[vars.id.split("/").pop()] ?? null };
    if (query.includes("orders(")) return { orders: { nodes: orders, pageInfo: { hasNextPage: false } } };
    if (query.includes("fulfillmentOrders(")) return { order: { id: vars.id, cancelledAt: null, fulfillmentOrders: { nodes: fos } } };
    if (query.includes("fulfillmentCreate")) {
      return { fulfillmentCreate: fulfilErrors.length ? { fulfillment: null, userErrors: fulfilErrors.map((message) => ({ message })) } : { fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS" }, userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  return { graphql, calls };
}

function deps(f, sh, over = {}) {
  const mails = [];
  return {
    mails,
    deps: {
      db: f.db, graphql: sh.graphql, nowMs: async () => NOW,
      send: async (m) => { mails.push(m); },
      increment, saDate: () => "2026-10-21",
      resolveAssignment: ({ roster }) => roster?.days?.wed?.uid ?? null,
      log: () => {},
      courier: fakeCourier(),
      ...over,
    },
  };
}

const order = (f, id = "9001") => f.read(`online_orders/${id}`);
const lineAt = (f, i, id = "9001") => order(f, id).lines[i];

describe("ingest", () => {
  it("writes the order, routes and splits every line, and holds it — with the switch off", async () => {
    const f = fakeDb(world());
    const sh = shopify({ orders: [shopifyOrder()] });
    const out = await runOrdersPoll(deps(f, sh).deps);
    expect(out.ingested).toBe(1);
    const o = order(f);
    expect(o).toMatchObject({ ref: "WEB-1801", orderNumber: 1801, status: "new", customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" } });
    expect(o.totals).toEqual({ subtotalCents: 150000, shippingCents: 10000, taxCents: 19565, totalCents: 160000, currency: "ZAR" });
    expect(o.lines.map((l) => [l.pid, l.size, l.qty, l.source.locationId, l.source.status])).toEqual([
      ["SNK", "8", 1, "hub1", "pick"],
      ["SNK", "8", 1, "hub2", "pick"],
      ["TEE", "M", 1, "marathon-pe", "display"],
      ["TEE", "M", 1, "hub2", "pick"],
    ]);
    expect(lineAt(f, 2)).toMatchObject({ barcode: "6001", isFootwear: false, unitPriceCents: 25000, photoUrl: "https://x/tee.jpg" });
    expect(lineAt(f, 0)).toMatchObject({ isFootwear: true });
    expect(f.read("online_reservations/SNK/8/9001")).toMatchObject({ qty: 2, ref: "WEB-1801", locs: { hub1: 1, hub2: 1 } });
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 2, locs: { "marathon-pe": 1, hub2: 1 } });
    // The reconciler is told: both products' markers moved.
    expect(f.read("shopify_inventory_dirty")).toEqual({ SNK: 1, TEE: 1 });
    // Switch off → no feed anywhere.
    expect(f.read("online_picks")).toBeNull();
    expect(f.read("displayChecks_active")).toBeNull();
    // The Shopify query is bounded below by go-live.
    expect(sh.calls[0].vars.q).toContain(`created_at:>='2026-10-21T09:00:00Z'`);
  });

  it("is idempotent on the Shopify order id", async () => {
    const f = fakeDb(world());
    const sh = shopify({ orders: [shopifyOrder()] });
    await runOrdersPoll(deps(f, sh).deps);
    const n = f.writes.length;
    const out = await runOrdersPoll(deps(f, sh).deps);
    expect(out.ingested).toBe(0);
    expect(f.writes.slice(n).filter(([, p]) => p.startsWith("online_orders/9001") || p.startsWith("online_reservations"))).toEqual([]);
    expect(f.read("shopify_inventory_dirty")).toEqual({ SNK: 1, TEE: 1 });
  });

  it("skips unpaid, part-fulfilled and cancelled-on-arrival orders", async () => {
    const f = fakeDb(world());
    const sh = shopify({ orders: [
      shopifyOrder({ legacyResourceId: "1", displayFinancialStatus: "PENDING" }),
      shopifyOrder({ legacyResourceId: "2", displayFulfillmentStatus: "PARTIALLY_FULFILLED" }),
      shopifyOrder({ legacyResourceId: "3", cancelledAt: "2026-10-21T09:40:00Z" }),
    ] });
    await runOrdersPoll(deps(f, sh).deps);
    expect(f.read("online_orders")).toBeNull();
  });

  it("a shop with Display Checks switched off is never routed to", async () => {
    const f = fakeDb(world());
    const sh = shopify({ orders: [shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[1]] } })] });
    await runOrdersPoll({ ...deps(f, sh).deps, displayFeedEnabled: async (shop) => shop !== "marathon-pe" });
    expect(order(f).lines.map((l) => [l.qty, l.source.locationId])).toEqual([[2, "hub2"]]);
  });

  it("other orders' holds count against availability", async () => {
    const f = fakeDb(world({ online_reservations: { SNK: { 8: { other: { qty: 1, ref: "WEB-1", locs: { hub1: 1 } } } } } }));
    const sh = shopify({ orders: [shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[0]] } })] });
    await runOrdersPoll(deps(f, sh).deps);
    expect(order(f).lines.map((l) => [l.qty, l.source.locationId])).toEqual([[2, "hub2"]]);
  });

  it("an unresolvable variant never drops: needs_attention, one email, stamped", async () => {
    const f = fakeDb(world());
    const stray = { id: "gid://shopify/LineItem/9", title: "Mystery", variantTitle: "XL", quantity: 1, currentQuantity: 1, variant: { id: V(999), product: { id: P(999) } } };
    const sh = shopify({ orders: [shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[1], stray] } })] });
    const d = deps(f, sh);
    await runOrdersPoll(d.deps);
    const o = order(f);
    expect(o.status).toBe("needs_attention");
    expect(o.attentionOpen).toBe(true);
    expect(o.attention.kind).toBe("unresolved");
    expect(o.lines.at(-1)).toMatchObject({ title: "Mystery — XL", qty: 1, source: { status: "unresolved" } });
    expect(o.lines.at(-1).reason).toMatch(/not linked/);
    expect(d.mails).toHaveLength(1);
    expect(d.mails[0].subject).toBe("Website order WEB-1801 needs attention");
    expect(order(f).attention.mailedAt).toBe(NOW);
    await runOrdersPoll(d.deps);
    expect(d.mails).toHaveLength(1);
  });

  it("no stock anywhere → no_stock line, needs_attention, and still held for Shopify", async () => {
    const f = fakeDb(world({ stock: {} }));
    const sh = shopify({ orders: [shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[1]] } })] });
    await runOrdersPoll(deps(f, sh).deps);
    expect(order(f).lines).toHaveLength(1);
    expect(lineAt(f, 0).source).toEqual({ status: "no_stock" });
    expect(order(f).attention.kind).toBe("no_stock");
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 2 });
    expect(f.read("online_reservations/TEE/M/9001").locs).toBeUndefined();
  });
});

describe("feed entries", () => {
  it("are created only when the switch is on — and backfilled when it goes on", async () => {
    const f = fakeDb(world());
    const sh = shopify({ orders: [shopifyOrder()] });
    await runOrdersPoll(deps(f, sh).deps);
    expect(f.read("online_picks")).toBeNull();
    await f.db.ref("config/onlineOrders/enabled").set(true);
    await runOrdersPoll(deps(f, shopify()).deps);
    const picks = f.read("online_picks");
    expect(Object.keys(picks).sort()).toEqual(["9001_0", "9001_1", "9001_3"]);
    expect(picks["9001_0"]).toMatchObject({ kind: "online_pick", ref: "WEB-1801", locationId: "hub1", locStatus: "hub1|open", status: "open", qty: 1, size: "8", instruction: "Give to Yasmin at Marathon PE" });
    const display = f.read("displayChecks_active/marathon-pe/online__9001__2");
    expect(display).toMatchObject({ kind: "online_pick", status: "open", ref: "WEB-1801", productId: "TEE", size: "M", sizeKey: "M", qty: 1, orderId: "9001", lineIndex: 2, activatedSaDate: "2026-10-21" });
    expect(display.checkId).toBeTruthy();
    expect(lineAt(f, 0).source.entryKey).toBe("online_picks/9001_0");
    expect(lineAt(f, 2).source.entryKey).toBe("displayChecks_active/marathon-pe/online__9001__2");
    expect(order(f).status).toBe("picking");
    // Idempotent: a further tick creates nothing new.
    const n = f.writes.length;
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(f.writes.slice(n).filter(([, p]) => p.startsWith("online_picks") || p.startsWith("displayChecks_active"))).toEqual([]);
  });

  it("every line handed → ready", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    for (let i = 0; i < 4; i++) await f.db.ref(`online_orders/9001/lines/${i}/source/status`).set("handed");
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(order(f).status).toBe("ready");
    expect(f.read("online_reservations/SNK/8/9001").qty).toBe(2); // still held until the pack
  });
});

describe("cancellation", () => {
  it("before the pack: cancelled, holds released, entries closed, reconciler told", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    const out = await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ cancelledAt: "2026-10-21T09:50:00Z", updatedAt: "2026-10-21T09:50:00Z" })] })).deps);
    expect(out.cancelled).toBe(1);
    expect(order(f).status).toBe("cancelled");
    expect(order(f).lines.every((l) => l.source.status === "cancelled")).toBe(true);
    expect(f.read("online_reservations")).toBeNull();
    expect(f.read("online_picks/9001_0")).toMatchObject({ status: "cancelled", locStatus: "hub1|cancelled" });
    expect(f.read("displayChecks_active/marathon-pe/online__9001__2")).toMatchObject({ status: "completed", result: "cancelled", completedSaDate: "2026-10-21" });
    expect(f.read("shopify_inventory_dirty")).toEqual({ SNK: 2, TEE: 2 });
  });

  it("after the pack: left alone and flagged", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    await f.db.ref("online_orders/9001").update({ status: "packed", pack: { saleId: "S1" }, fulfilState: "done" });
    const d = deps(f, shopify({ orders: [shopifyOrder({ cancelledAt: "2026-10-21T09:50:00Z" })] }));
    const out = await runOrdersPoll(d.deps);
    expect(out.flagged).toBe(1);
    expect(order(f)).toMatchObject({ status: "packed", cancelledAfterPack: true, attentionOpen: true, attention: { kind: "cancelled_after_pack" } });
    expect(d.mails).toHaveLength(1);
  });
});

describe("the old way, while the switch is off", () => {
  it("an order fulfilled in the Shopify admin (rung by hand at a till) is let go: hold released, out of every list", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    const out = await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ displayFulfillmentStatus: "FULFILLED", updatedAt: "2026-10-21T09:55:00Z" })] })).deps);
    expect(out.handledElsewhere).toBe(1);
    expect(order(f).status).toBe("fulfilled_elsewhere");
    expect(f.read("online_reservations")).toBeNull();
  });

  it("with the switch ON the same admin fulfilment keeps the hold until the pack — marked released on Shopify's side", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ displayFulfillmentStatus: "FULFILLED" })] })).deps);
    expect(order(f).status).toBe("picking");
    expect(order(f).shopifyFulfilledAt).toBeTruthy();
    expect(f.read("online_reservations/SNK/8/9001")).toMatchObject({ qty: 2, released: 2 });
    expect(f.read("shopify_inventory_dirty/SNK")).toBe(2); // the push is told
  });

  it("Rung by hand at a till (Settings): entries closed, holds released, fulfilled_elsewhere", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    await f.db.ref("online_orders/9001/status").set("release_requested");
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(order(f).status).toBe("fulfilled_elsewhere");
    expect(f.read("online_reservations")).toBeNull();
    expect(f.read("online_picks/9001_0")).toMatchObject({ status: "cancelled" });
    expect(f.read("displayChecks_active/marathon-pe/online__9001__2")).toMatchObject({ status: "completed", result: "cancelled" });
  });
});

describe("Resolve → re-route", () => {
  it("routes a no_stock line again once stock exists, under a fresh entry key", async () => {
    const f = fakeDb(world({ stock: {}, config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[1]] } })] })).deps);
    expect(lineAt(f, 0).source.status).toBe("no_stock");
    // Stock arrives; Junid presses Resolve (Settings writes exactly this).
    await f.db.ref("stock/trophy/TEE/M/qty").set(1);
    await f.db.ref("stock/hub2/TEE/M/qty").set(1);
    await f.db.ref("online_orders/9001").update({ "lines/0/source/status": "reroute", attention: null, attentionOpen: null, status: "new" });
    await runOrdersPoll(deps(f, shopify()).deps);
    const o = order(f);
    expect(o.lines.map((l) => [l.qty, l.source.locationId, l.source.status, l.routeGen])).toEqual([[1, "trophy", "display", 1], [1, "hub2", "pick", 1]]);
    expect(o.lines[0].lineId).toBe("l0");
    expect(o.lines[0].source.entryKey).toBe("displayChecks_active/trophy/online__9001__0_r1");
    expect(o.lines[1].source.entryKey).toBe("online_picks/9001_1_r1");
    expect(o.status).toBe("picking");
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 2, locs: { trophy: 1, hub2: 1 } });
  });
});

describe("Shopify fulfilment after the pack", () => {
  const packed = (fulfil = {}) => world({
    online_orders: { 9001: { ref: "WEB-1801", shopifyGid: "gid://shopify/Order/9001", status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0, ...fulfil }, lines: [{ pid: "TEE", sizeKey: "M", qty: 1, source: { status: "handed" } }] } },
  });
  const fos = [{ id: "gid://shopify/FulfillmentOrder/7", status: "OPEN", lineItems: { nodes: [{ remainingQuantity: 1 }] } }];

  it("books the (skipped) shipment, fulfils with notifyCustomer and the typed tracking number", async () => {
    const f = fakeDb(packed({ trackingNumber: "TRK123" }));
    const sh = shopify({ fos });
    const out = await runOrdersPoll(deps(f, sh).deps);
    expect(out.fulfilled).toBe(1);
    const create = sh.calls.find((c) => c.query.includes("fulfillmentCreate"));
    expect(create.vars.fulfillment).toEqual({ lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fos[0].id }], notifyCustomer: true, trackingInfo: { number: "TRK123" } });
    expect(order(f)).toMatchObject({ fulfilState: "done", fulfil: { state: "done", attempts: 1 }, shipping: { booking: { skipped: true } } });
  });

  it("pack step with /config/shipping/live false: the dry run is recorded, no shipment call, no network", async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error("network is forbidden in this test"); };
    try {
      const w = packed({ trackingNumber: "TRK9" });
      Object.assign(w.online_orders[9001], {
        customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" },
        shipping: { address: { name: "Thandi M", address1: "5 Esplanade Road", address2: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa" } },
      });
      w.config.shipping = { live: false };
      const f = fakeDb(w);
      const courier = fakeCourier();
      const out = await runOrdersPoll(deps(f, shopify({ fos }), { courier }).deps);
      const booking = order(f).shipping.booking;
      expect(booking.skipped).toBe(true);
      expect(booking.dryRun).toMatchObject({ customer_reference: "WEB-1801", delivery_address: { city: "Cape Town", zone: "WC", code: "7441" } });
      expect(courier.calls.map(([op]) => op)).toEqual(["getRates", "getRates"]);
      expect(fetched).toBe(0);
      expect(out.fulfilled).toBe(1); // the Shopify fulfilment still went ahead
      expect(f.read("online_orders/9001/shipping/provider") == null).toBe(true); // never booked
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a courier failure is recorded and never blocks the fulfilment", async () => {
    const f = fakeDb(packed());
    const courier = { getRates: async () => { throw new Error("x"); } };
    const boom = { ...deps(f, shopify({ fos }), { courier }).deps, db: f.db };
    const out = await runOrdersPoll(boom);
    expect(out.fulfilled).toBe(1);
    expect(order(f).shipping.booking.skipped).toBe(true);
  });

  it("a fulfilment that failed before and now lands clears its attention", async () => {
    const f = fakeDb(packed());
    await f.db.ref("online_orders/9001").update({ attention: { kind: "fulfil_failed", reason: "x", at: 1, mailedAt: 2 }, attentionOpen: true });
    await runOrdersPoll(deps(f, shopify({ fos })).deps);
    expect(order(f).fulfilState).toBe("done");
    expect(order(f).attention).toBeUndefined();
    expect(order(f).attentionOpen).toBeUndefined();
  });

  it("sends no tracking when none was typed", async () => {
    const f = fakeDb(packed());
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh).deps);
    expect(sh.calls.find((c) => c.query.includes("fulfillmentCreate")).vars.fulfillment.trackingInfo).toBeUndefined();
  });

  it("a failure leaves the sale alone: failed, attention, email — and no POS write of any kind", async () => {
    const f = fakeDb(packed());
    const d = deps(f, shopify({ fos, fulfilErrors: ["Fulfillment order is closed"] }));
    const out = await runOrdersPoll(d.deps);
    expect(out.fulfilFailed).toBe(1);
    expect(order(f)).toMatchObject({ status: "packed", fulfilState: "failed", fulfil: { state: "failed", attempts: 1 }, attentionOpen: true, attention: { kind: "fulfil_failed" } });
    expect(d.mails).toHaveLength(1);
    expect(f.writes.some(([, p]) => p.startsWith("pos/"))).toBe(false);
  });

  it("an order already fulfilled in the Shopify admin is simply done", async () => {
    const f = fakeDb(packed());
    const sh = shopify({ fos: [] });
    await runOrdersPoll(deps(f, sh).deps);
    expect(sh.calls.some((c) => c.query.includes("fulfillmentCreate"))).toBe(false);
    expect(order(f)).toMatchObject({ fulfilState: "done", fulfil: { alreadyDone: true } });
  });
});

describe("one bad order never stops the rest", () => {
  it("is parked and retried by id; the cursor moves on", async () => {
    const f = fakeDb(world(), { failWritesUnder: "online_orders/9001" });
    const later = shopifyOrder({ id: "gid://shopify/Order/9002", legacyResourceId: "9002", number: 1802, name: "#1802", updatedAt: "2026-10-21T09:40:00Z" });
    const out = await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder(), later] })).deps);
    expect(out.errors).toHaveLength(1);
    expect(order(f, "9002").ref).toBe("WEB-1802");
    expect(f.read("online_orders_meta/cursorMs")).toBe(Date.parse("2026-10-21T09:40:00Z"));
    expect(f.read("online_orders_meta/retry/9001")).toMatchObject({ name: "#1801", attempts: 1 });
    // The fault clears; the next tick's list no longer carries 9001 — it is fetched by id.
    const g = fakeDb(f.root);
    const out2 = await runOrdersPoll(deps(g, shopify({ orders: [], byId: { 9001: shopifyOrder() } })).deps);
    expect(out2.errors).toEqual([]);
    expect(g.read("online_orders/9001").ref).toBe("WEB-1801");
    expect(g.read("online_orders_meta/retry")).toBeNull();
  });
});

describe("invariants", () => {
  it("never writes stock, the movement ledger or a sale", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ cancelledAt: "2026-10-21T09:50:00Z" })] })).deps);
    const bad = f.writes.filter(([, p]) => /^(stock|stock_movements|pos)\b/.test(p));
    expect(bad).toEqual([]);
    expect(f.read("stock")).toEqual(world().stock);
  });

  it("reads no whole node: every read is an exact path or an indexed query", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    const reads = [];
    const db = { ref: (path) => {
      const r = f.db.ref(path);
      return { ...r, get: () => { reads.push(["get", path]); return r.get(); }, orderByChild: (c) => ({ equalTo: (v) => ({ get: () => { reads.push(["query", `${path}?${c}=${v}`]); return r.orderByChild(c).equalTo(v).get(); } }) }) };
    } };
    await runOrdersPoll({ ...deps(f, shopify({ orders: [shopifyOrder()] })).deps, db });
    // Collections, a whole location's stock, a product's whole reservation
    // node, a store's whole display feed: none of these may be read.
    const WHOLE = [
      /^(online_orders|online_reservations|online_picks|stock|shopify_sync|products|displayChecks_active|users)$/,
      /^stock\/[^/]+(\/[^/]+)?$/,
      /^online_reservations\/[^/]+$/,
      /^displayChecks_active\/[^/]+$/,
      /^shopify_sync\/_claims$/,
    ];
    const whole = reads.filter(([op, p]) => op === "get" && WHOLE.some((re) => re.test(p)));
    expect(whole).toEqual([]);
    expect(reads.filter(([op]) => op === "query").map(([, p]) => p)).toEqual(expect.arrayContaining(["online_orders?status=new", "online_orders?fulfilState=pending", "online_orders?attentionOpen=true"]));
  });

  it("a pack landing while the holds are written can never leave the packed order holding", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    // Junid hands everything over, so the next tick rewrites the rows… and
    // the POS pack lands in the middle of that write.
    await f.db.ref("online_reservations").set(null);
    let packedMidway = false;
    const db = { ref: (path) => {
      const r = f.db.ref(path);
      if (!path.startsWith("online_reservations/")) return r;
      return { ...r, set: async (v) => {
        await r.set(v);
        if (!packedMidway) { packedMidway = true; await f.db.ref("online_orders/9001/status").set("packed"); }
      } };
    } };
    await runOrdersPoll({ ...deps(f, shopify()).deps, db });
    expect(packedMidway).toBe(true);
    expect(f.read("online_reservations")).toBeNull();
  });
});

describe("before the rules are pasted", () => {
  it("still pulls new orders in and holds them when the server refuses the indexed queries", async () => {
    const f = fakeDb(world(), { missingIndexes: ["status", "fulfilState", "attentionOpen"] });
    const out = await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    expect(out.ingested).toBe(1);
    expect(f.read("online_reservations/SNK/8/9001")).toMatchObject({ qty: 2 });
    expect([...out.missingIndex].sort()).toEqual(["attentionOpen", "fulfilState", "status"]);
    expect(out.errors).toEqual([]);
  });
});

describe("attentionMail", () => {
  it("names the order, the reason and where to resolve it", () => {
    const m = attentionMail({ ref: "WEB-1", shopifyName: "#1", customer: { name: "A" }, attention: { reason: "R" } });
    expect(m.subject).toBe("Website order WEB-1 needs attention");
    expect(m.text).toContain("R");
    expect(m.text).toContain("Settings → Online orders");
  });
});
