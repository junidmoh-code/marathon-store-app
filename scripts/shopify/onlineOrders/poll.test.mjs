import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll, attentionMail } from "./poll.mjs";
import { candidateCode } from "./orderRefs.mjs";
// The hub-unit code poll.mjs mints for order 9001 line i, unit u, routeGen g (attempt k).
const C = (i, u = 0, g = 0, k = 0, id = "9001") => candidateCode(`${id}:${i}:${u}:${g}`, k);
import { hubOrderRecord } from "./orderModel.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import doorRates from "../../shipping/fixtures/rates-door-capetown.json";
import lockerRates from "../../shipping/fixtures/rates-locker-capetown.json";

// NO TEST IN THIS FILE MAY REACH THE NETWORK (Courier Guy, Shopify, mail):
// fetch throws for every test, and a test that wants to count calls swaps in
// its own counter.
let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

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

// Deterministic order codes: draws spell KQZ, then BCD, then EFG, … (a code
// already claimed by another order is skipped by the mint, exactly as live).
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function codeSeq(codes = ["KQZ", "BCD", "EFG", "HJK"]) {
  const draws = codes.flatMap((c) => [...c].map((ch) => (ALPHA.indexOf(ch) + 0.5) / ALPHA.length));
  let i = 0;
  return () => draws[i++ % draws.length];
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
      courierLog: () => {}, // never write logs/courier.log from a test
      refRand: codeSeq(),
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
    expect(o).toMatchObject({ orderNumber: 1801, status: "new", customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" } });
    expect(o.totals).toEqual({ subtotalCents: 150000, shippingCents: 10000, taxCents: 19565, totalCents: 160000, currency: "ZAR" });
    expect(o.lines.map((l) => [l.pid, l.size, l.qty, l.source.locationId, l.source.status])).toEqual([
      ["SNK", "8", 1, "hub1", "pick"],
      ["SNK", "8", 1, "hub2", "pick"],
      ["TEE", "M", 1, "marathon-pe", "display"],
      ["TEE", "M", 1, "hub2", "pick"],
    ]);
    expect(lineAt(f, 2)).toMatchObject({ barcode: "6001", isFootwear: false, unitPriceCents: 25000, photoUrl: "https://x/tee.jpg" });
    expect(lineAt(f, 0)).toMatchObject({ isFootwear: true });
    expect(f.read("online_reservations/SNK/8/9001")).toMatchObject({ qty: 2, ref: "#1801", locs: { hub1: 1, hub2: 1 } });
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 2, locs: { "marathon-pe": 1, hub2: 1 } });
    // The reconciler is told: both products' markers moved.
    expect(f.read("shopify_inventory_dirty")).toEqual({ SNK: 1, TEE: 1 });
    // Switch off → no feed anywhere: no hub order, no display entry.
    expect(f.read("orders")).toBeNull();
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
    expect(d.mails[0].subject).toBe("Website order #1801 needs attention");
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
    expect(f.read("orders")).toBeNull();
    await f.db.ref("config/onlineOrders/enabled").set(true);
    await runOrdersPoll(deps(f, shopify()).deps);
    // HUB-ROUTED LINES ARE HUB ORDERS — the Assistant's /orders shape, field for
    // field, each UNIT keyed by its own three-letter code (three hub units → three codes).
    const hubOrders = f.read("orders");
    expect(Object.keys(hubOrders).sort()).toEqual([C(0), C(1), C(3)].sort());
    const expected = {
      id: C(0), productId: "SNK", productName: "Air Runner", productPhoto: null, productPhotoUrl: "https://x/snk.jpg",
      size: "8", sentSize: null, productType: "sneaker",
      customerName: "Shopify", customerPhone: null, customerId: null, customerCode: null, customerPending: false,
      hub: "hub1", placedAtHub: "hub1", placedStore: "central", destShop: "marathon-pe", section: 2,
      requestDisplay: false, requestDisplayPartner: false, displayPairRequest: false, displayPairStore: null,
      status: "incoming", createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z",
      readyAt: null, outOfStockAt: null, comingTomorrowAt: null, collectedAt: null,
      displayRefillScheduledAt: null, displayRefillHub: null, displayRefillStatus: null, displayRefilledAt: null,
      displayRefillStockDepletedAt: null, displayRefilledBy: null,
      channel: "online", onlineOrderId: "9001", onlineLineIndex: 0, onlineOrderNumber: 1801, onlineUnit: 0,
    };
    // The pure record carries every Assistant field (nulls included)…
    expect(hubOrderRecord({ key: C(0), line: lineAt(f, 0), onlineOrderId: "9001", lineIndex: 0, section: 2, nowIso: "2026-10-21T10:00:00.000Z", orderNumber: 1801, unit: 0 })).toEqual(expected);
    // …and RTDB stores it as it stores an Assistant order: nulls dropped.
    expect(hubOrders[C(0)]).toEqual(Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== null)));
    expect(hubOrders[C(3)]).toMatchObject({ productType: "clothing", hub: "hub2", size: "M" });
    expect(f.read("online_picks")).toBeNull(); // the old hub feed is gone
    const display = f.read("displayChecks_active/marathon-pe/online__9001__2");
    expect(display).toMatchObject({ kind: "online_pick", status: "open", ref: "#1801", orderNumber: 1801, productId: "TEE", size: "M", sizeKey: "M", qty: 1, orderId: "9001", lineIndex: 2, activatedSaDate: "2026-10-21" });
    expect(display.checkId).toBeTruthy();
    expect(lineAt(f, 0).source).toMatchObject({ entryKey: `orders/${C(0)}`, orderKeys: [C(0)] });
    expect(lineAt(f, 2).source.entryKey).toBe("displayChecks_active/marathon-pe/online__9001__2");
    expect(order(f).status).toBe("picking");
    // Idempotent: a further tick creates nothing new.
    const n = f.writes.length;
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(f.writes.slice(n).filter(([, p]) => p.startsWith("orders") || p.startsWith("displayChecks_active"))).toEqual([]);
  });

  describe("hub orders follow what the hub does (the existing store-order route)", () => {
    const on = () => fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    const tick = async (f) => runOrdersPoll(deps(f, shopify()).deps);
    const first = async (f) => runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);

    it("Mark as Sent (ready) → the line is handed, from the hub that sent it (the Pack deducts there)", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(1)}`).update({ status: "ready", readyAt: "x" }); // Hub 2 sent line 1
      await tick(f);
      expect(lineAt(f, 1).source).toMatchObject({ status: "handed", locationId: "hub2", handedBy: "hub" });
      expect(lineAt(f, 0).source.status).toBe("pick"); // hub1 has not sent yet
    });

    it("escalation off: Out of Stock at the hub → no_stock, the order needs attention, Junid is emailed", async () => {
      const f = on(); await first(f);
      await f.db.ref("config/onlineOrders/escalationOff").set(true);
      await f.db.ref(`orders/${C(0)}`).update({ status: "out_of_stock" });
      const d = deps(f, shopify());
      await runOrdersPoll(d.deps);
      expect(lineAt(f, 0).source).toMatchObject({ status: "no_stock", reason: "hub1 marked it out of stock" });
      expect(order(f)).toMatchObject({ status: "needs_attention", attentionOpen: true });
      expect(order(f).attention.reason).toMatch(/hub1 marked it out of stock/);
      expect(d.mails).toHaveLength(1);
    });

    it("escalation on: Out of Stock at the hub → Central is asked for that hub IN THE SAME TICK, and nobody is emailed", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(0)}`).update({ status: "out_of_stock" });
      const d = deps(f, shopify());
      await runOrdersPoll(d.deps);
      expect(lineAt(f, 0).source).toEqual({ status: "resolving", locationId: "hub1" });
      expect(lineAt(f, 0).escalation).toMatchObject({ chain: "footwear", home: "hub1", phase: "await", request: { kind: "refill", from: "central", to: "hub1" } });
      expect(f.read(`refill_requests/${lineAt(f, 0).escalation.request.key}`)).toMatchObject({ requestingLocation: "hub1", createdFrom: { via: "online_escalation", ref: "#1801" }, onlineRef: "#1801" });
      expect(order(f).attentionOpen).toBeUndefined();
      expect(d.mails).toEqual([]);
    });

    it("sent in another size → needs attention (Shopify sold the ordered size), never silently handed", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(0)}`).update({ status: "ready", sentSize: "9" });
      await tick(f);
      expect(lineAt(f, 0).source).toMatchObject({ status: "needs_attention", reason: "hub1 sent size 9, the website sold size 8" });
      expect(order(f).status).toBe("needs_attention");
    });

    it("after the Pack the hub orders close as collected (off the Warehouse queue and the TV)", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(0)}`).update({ status: "ready" });
      await f.db.ref(`orders/${C(3)}`).update({ status: "out_of_stock" });
      await f.db.ref("online_orders/9001").update({ status: "packed", pack: { saleId: "S1" }, fulfilState: "pending", fulfil: { state: "pending", attempts: 0 } });
      await runOrdersPoll(deps(f, shopify({ fos: [] })).deps);
      expect(f.read(`orders/${C(0)}`)).toMatchObject({ status: "collected", collectedAt: "2026-10-21T10:00:00.000Z" });
      expect(f.read(`orders/${C(1)}`)).toMatchObject({ status: "collected" });
      expect(f.read(`orders/${C(3)}`).status).toBe("out_of_stock"); // never rewritten
    });

    it("a cancelled order whose unit was already SENT leaves that hub order alone", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(0)}`).update({ status: "ready" });
      await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder({ cancelledAt: "2026-10-21T09:50:00Z", updatedAt: "2026-10-21T09:50:00Z" })] })).deps);
      expect(f.read(`orders/${C(0)}`).status).toBe("ready");
      expect(f.read(`orders/${C(1)}`)).toBeNull();
    });

    it("a key already holding SOMEONE ELSE's record (a code reused after 180 days) is never adopted — the line gets its own", async () => {
      const f = on();
      await f.db.ref(`orders/${C(0)}`).set({ id: C(0), channel: "online", onlineOrderId: "7000", onlineLineIndex: 0, status: "collected", hub: "hub1" });
      await first(f);
      expect(lineAt(f, 0).source.orderKeys).toEqual([C(0, 0, 0, 1)]);
      expect(f.read(`orders/${C(0, 0, 0, 1)}`)).toMatchObject({ onlineOrderId: "9001", onlineLineIndex: 0, status: "incoming" });
      expect(f.read(`orders/${C(0)}`).onlineOrderId).toBe("7000"); // untouched
      await tick(f);
      expect(lineAt(f, 0).source.status).toBe("pick"); // the old order's "collected" was never read as ours
    });

    it("a cancelled order whose pair the hub already SENT raises an attention (return it to the hub)", async () => {
      const f = on(); await first(f);
      await f.db.ref(`orders/${C(0)}`).update({ status: "ready" });
      const d = deps(f, shopify({ orders: [shopifyOrder({ cancelledAt: "2026-10-21T09:50:00Z", updatedAt: "2026-10-21T09:50:00Z" })] }));
      await runOrdersPoll(d.deps);
      expect(order(f)).toMatchObject({ status: "cancelled", attentionOpen: true });
      expect(order(f).attention.reason).toMatch(new RegExp(`${C(0)} from hub1.*return it to the hub`));
    });

    it("never touches a shop's own order that happens to share a key", async () => {
      const f = on();
      await f.db.ref(`orders/${C(0)}`).set({ id: C(0), customerName: "Thabo", status: "incoming" });
      await first(f);
      expect(f.read(`orders/${C(0)}`)).toEqual({ id: C(0), customerName: "Thabo", status: "incoming" }); // create-if-absent
      expect(lineAt(f, 0).source.orderKeys).toEqual([C(0, 0, 0, 1)]);
    });
  });

  it("the parcels the POS shows before Pack are on the order (the parcel rule), rewritten only when the lines change", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    const est = order(f).shipping.estimate;
    // 2 pairs (SNK ×2) = ONE parcel, the two shoeboxes stacked (34×23×26); the 2 tees ride inside.
    expect(est).toMatchObject({ parcelCount: 1 });
    expect(est.parcels).toHaveLength(1);
    expect(est.parcels[0]).toMatchObject({ kind: "shoebox", lengthCm: 34, widthCm: 23, heightCm: 26, pairs: 2 });
    const n = f.writes.length;
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(f.writes.slice(n).filter(([, p]) => p.includes("/shipping/estimate"))).toEqual([]);
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
    expect(f.read(`orders/${C(0)}`)).toBeNull(); // not yet sent → off the hub's queue
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
    expect(f.read(`orders/${C(0)}`)).toBeNull();
    expect(f.read("displayChecks_active/marathon-pe/online__9001__2")).toMatchObject({ status: "completed", result: "cancelled" });
  });
});

describe("Resolve → re-route", () => {
  it("routes a no_stock line again once stock exists, under a fresh entry key", async () => {
    const f = fakeDb(world({ stock: {}, config: { onlineOrders: { enabled: true, escalationOff: true } } }));
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
    expect(o.lines[1].source).toMatchObject({ entryKey: `orders/${C(1, 0, 1)}`, orderKeys: [C(1, 0, 1)] });
    expect(o.status).toBe("picking");
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 2, locs: { trophy: 1, hub2: 1 } });
  });
});

describe("Shopify fulfilment after the pack", () => {
  const packed = (fulfil = {}) => world({
    online_orders: { 9001: { ref: "KQZ", shopifyGid: "gid://shopify/Order/9001", status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0, ...fulfil }, lines: [{ pid: "TEE", sizeKey: "M", qty: 1, source: { status: "handed" } }] } },
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
      expect(booking.dryRun).toMatchObject({ customer_reference: "KQZ", delivery_address: { city: "Cape Town", zone: "WC", code: "7441" } });
      expect(courier.calls.map(([op]) => op)).toEqual(["getRates"]); // door-to-door: one quote
      // The fake client is the network boundary; this proves nothing behind
      // it (or beside it) reached for fetch either.
      expect(fetched).toBe(0);
      expect(out.fulfilled).toBe(1); // the Shopify fulfilment still went ahead
      expect(f.read("online_orders/9001/shipping/provider") == null).toBe(true); // never booked
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a real booking's waybill becomes the Shopify tracking number when none was typed", async () => {
    const w = packed();
    Object.assign(w.online_orders[9001], {
      customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" },
      shipping: { address: { address1: "5 Esplanade Road", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa" } },
    });
    w.config.shipping = { live: true, collectionContact: { name: "The Marathon", mobile_number: "0310000000" } };
    const f = fakeDb(w);
    const courier = { ...fakeCourier(), createShipment: async () => ({ id: 7, short_tracking_reference: "ABC123", charged_amount: 100 }) };
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh, { courier }).deps);
    expect(sh.calls.find((c) => c.query.includes("fulfillmentCreate")).vars.fulfillment.trackingInfo).toEqual({ number: "ABC123", company: "The Courier Guy" });
    expect(order(f).shipping).toMatchObject({ provider: "courier_guy", waybill: "ABC123", booking: { waybill: "ABC123" } });
  });

  describe("LIVE: no waybill, no fulfilment (go-live from order 1768)", () => {
    const liveOrder = (cfg = {}) => {
      const w = packed();
      Object.assign(w.online_orders[9001], {
        customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" },
        shipping: { address: { address1: "5 Esplanade Road", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa" } },
      });
      w.config.shipping = { live: true, collectionContact: { name: "The Marathon", mobile_number: "0310000000" }, ...cfg };
      return w;
    };
    const failing = (err) => ({ ...fakeCourier(), createShipment: async () => { throw err; } });

    it("a failed live booking holds the fulfilment: courier_failed, attention, Junid emailed, no Shopify write", async () => {
      const f = fakeDb(liveOrder());
      const sh = shopify({ fos });
      const d = deps(f, sh, { courier: failing(Object.assign(new Error("HTTP 400 bad address"), { status: 400 })) });
      const out = await runOrdersPoll(d.deps);
      expect(out.fulfilled).toBe(0);
      expect(sh.calls.some((c) => c.query.includes("fulfillmentCreate"))).toBe(false);
      expect(order(f)).toMatchObject({ status: "packed", fulfilState: "courier_failed", attentionOpen: true, attention: { kind: "courier_failed" } });
      expect(order(f).courierError).toMatch(/400/);
      expect(d.mails).toHaveLength(1);
      expect(f.writes.some(([, p]) => p.startsWith("pos/"))).toBe(false); // never a second sale
    });

    it("a live booking refused before the call (over the ceiling) also holds", async () => {
      const f = fakeDb(liveOrder({ maxChargeRand: 10 }));
      const sh = shopify({ fos });
      await runOrdersPoll(deps(f, sh).deps);
      expect(order(f).fulfilState).toBe("courier_failed");
      expect(order(f).courierError).toMatch(/ceiling/);
      expect(sh.calls.some((c) => c.query.includes("fulfillmentCreate"))).toBe(false);
    });

    it("Retry (back to pending) re-runs the booking only, then fulfils with the waybill and clears the attention", async () => {
      const f = fakeDb(liveOrder());
      await runOrdersPoll(deps(f, shopify({ fos }), { courier: failing(Object.assign(new Error("HTTP 400"), { status: 400 })) }).deps);
      expect(order(f).fulfilState).toBe("courier_failed");
      await f.db.ref("online_orders/9001").update({ fulfilState: "pending", "fulfil/state": "pending" }); // the POS Retry
      const sh = shopify({ fos });
      const courier = { ...fakeCourier(), createShipment: async () => ({ id: 8, short_tracking_reference: "RTY777", charged_amount: 120 }) };
      await runOrdersPoll(deps(f, sh, { courier }).deps);
      expect(sh.calls.find((c) => c.query.includes("fulfillmentCreate")).vars.fulfillment.trackingInfo).toEqual({ number: "RTY777", company: "The Courier Guy" });
      expect(order(f)).toMatchObject({ fulfilState: "done", shipping: { waybill: "RTY777" } });
      expect(order(f).attention).toBeUndefined();
      expect(order(f).courierError).toBeUndefined();
    });

    it("an already-booked order fulfils with the waybill it has", async () => {
      const w = liveOrder();
      w.online_orders[9001].shipping = { ...w.online_orders[9001].shipping, provider: "courier_guy", shipmentId: 5, waybill: "LD-1" };
      const f = fakeDb(w);
      const sh = shopify({ fos });
      await runOrdersPoll(deps(f, sh).deps);
      expect(sh.calls.find((c) => c.query.includes("fulfillmentCreate")).vars.fulfillment.trackingInfo).toEqual({ number: "LD-1", company: "The Courier Guy" });
    });

    it("live OFF: a courier error never holds the fulfilment", async () => {
      const w = liveOrder(); w.config.shipping.live = false;
      const f = fakeDb(w);
      const out = await runOrdersPoll(deps(f, shopify({ fos }), { courier: { getRates: async () => { throw new Error("down"); } } }).deps);
      expect(out.fulfilled).toBe(1);
    });
  });

  it("a courier failure is recorded and never blocks the fulfilment", async () => {
    const f = fakeDb(packed());
    const courier = { getRates: async () => { throw new Error("x"); } };
    const boom = { ...deps(f, shopify({ fos }), { courier }).deps, db: f.db };
    const out = await runOrdersPoll(boom);
    expect(out.fulfilled).toBe(1);
    expect(order(f).shipping.booking.skipped).toBe(true);
  });

  it("a booking record that cannot be written never blocks the fulfilment", async () => {
    const f = fakeDb(packed());
    const realRef = f.db.ref.bind(f.db);
    const db = { ...f.db, ref: (path) => {
      const r = realRef(path);
      return path === "online_orders/9001/shipping/booking" ? { ...r, set: async () => { throw new Error("Cannot set NaN"); } } : r;
    } };
    const out = await runOrdersPoll({ ...deps(f, shopify({ fos })).deps, db });
    expect(out.fulfilled).toBe(1);
    expect(order(f).fulfilState).toBe("done");
  });

  it("a real booking replaces a recorded dry run; the whole shipping node is never nested", async () => {
    const f = fakeDb(packed());
    await f.db.ref("online_orders/9001/shipping").update({ booking: { skipped: true, dryRun: { x: 1 } }, shipmentId: 5, provider: "courier_guy", waybill: "LD-1" });
    await runOrdersPoll(deps(f, shopify({ fos })).deps);
    // shipmentId present → bookShipment says "already booked" (skipped) — the dry run stays, nothing nested
    expect(order(f).shipping.booking).toMatchObject({ skipped: true, dryRun: { x: 1 } });
    expect(order(f).shipping.booking.shipping).toBeUndefined();
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

// An online EXCHANGE's replacement (Jimmy, marathon-dm-agent src/jimmy/reserve.js):
// /online_orders/exchange-<orderNumber>-<paidAtMs>, NO shopifyGid. Packed by the
// POS like any website order; shipped through this same flow; finished with
// no Shopify call at all (owner decision 2026-10-30).
describe("an online exchange ships through the normal pack/courier flow", () => {
  const EX = "exchange-1789-1761800000000";
  const exchangeWorld = (cfg = {}, over = {}) => world({
    config: { onlineOrders: { enabled: false }, shipping: { collectionContact: { name: "The Marathon", mobile_number: "0310000000" }, ...cfg } },
    online_orders: {
      [EX]: {
        orderNumber: "1789-EX", shopifyName: "#1789-EX",
        customer: { name: "Thandi M" },
        shipping: { address: { name: "Thandi M", address1: "5 Esplanade Road", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa", phone: "0829999999" } },
        totals: { subtotalCents: 0, totalCents: 0 },
        status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0 },
        lines: [{ pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee", isFootwear: false, unitPriceCents: 0, exchangeFor: "SNK", source: { locationId: "marathon-pe", status: "handed" } }],
        exchange: { kind: "size", paidCents: 21800, paidVia: "payfast", paidAt: 1761800000000, ref: "EX1789", contactPhone: "+27821234567", relatedOrders: ["9001"] },
        ...over,
      },
    },
  });
  const fos = [{ id: "gid://shopify/FulfillmentOrder/7", status: "OPEN", lineItems: { nodes: [{ remainingQuantity: 1 }] } }];
  const shopifyWrites = (sh) => sh.calls.filter((c) => /fulfillmentCreate|fulfillmentOrders\(|order\(id:/.test(c.query));

  it("live: books Courier Guy with the record's address, contactPhone and #1789-EX, then finishes WITHOUT Shopify", async () => {
    const f = fakeDb(exchangeWorld({ live: true }));
    const sent = [];
    const courier = { ...fakeCourier(), createShipment: async (body) => { sent.push(body); return { id: 42, short_tracking_reference: "EXW123", charged_amount: 99 }; } };
    const sh = shopify({ fos });
    const out = await runOrdersPoll(deps(f, sh, { courier }).deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      customer_reference: "#1789-EX",
      delivery_contact: { name: "Thandi M", mobile_number: "+27821234567" },
      delivery_address: { street_address: "5 Esplanade Road", city: "Cape Town", zone: "WC", code: "7441" },
    });
    expect(shopifyWrites(sh)).toEqual([]); // never a Shopify fulfilment call (no shopifyGid)
    expect(out.fulfilled).toBe(1);
    const o = order(f, EX);
    expect(o).toMatchObject({
      status: "packed", fulfilState: "done",
      fulfil: { state: "done", attempts: 1, at: NOW, note: expect.stringMatching(/No Shopify order/) },
      shipping: { provider: "courier_guy", shipmentId: 42, waybill: "EXW123", courierBooking: { state: "booked" }, booking: { waybill: "EXW123" } },
    });
    expect(o.shopifyGid).toBeUndefined();
    expect(o.courierError).toBeUndefined();
    expect(f.writes.some(([, p]) => p.startsWith("pos/"))).toBe(false);
  });

  it("live off: the dry run is recorded with the same payload; finished without Shopify, nothing booked", async () => {
    const f = fakeDb(exchangeWorld({ live: false }));
    const courier = fakeCourier();
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh, { courier }).deps);
    const booking = order(f, EX).shipping.booking;
    expect(booking).toMatchObject({ skipped: true, dryRun: { customer_reference: "#1789-EX", delivery_contact: { mobile_number: "+27821234567" } } });
    expect(courier.calls.map(([op]) => op)).toEqual(["getRates"]);
    expect(shopifyWrites(sh)).toEqual([]);
    expect(order(f, EX)).toMatchObject({ fulfilState: "done", fulfil: { state: "done", note: expect.stringMatching(/No Shopify order/) } });
    expect(order(f, EX).shipping.provider).toBeUndefined();
  });

  it("live off, the plan itself fails (no address): courier_failed, never finished (CodeRabbit #815)", async () => {
    const f = fakeDb(exchangeWorld({ live: false }, { shipping: {} }));
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh, { courier: fakeCourier() }).deps);
    expect(shopifyWrites(sh)).toEqual([]);
    expect(order(f, EX)).toMatchObject({ fulfilState: "courier_failed", attentionOpen: true });
  });

  it("Junid's condition hold (the returned item not in good condition): nothing booked, held with the reason; cleared → booked", async () => {
    const f = fakeDb(exchangeWorld({ live: true }, { incoming: { conditionHold: { at: 1, by: { uid: "system:jimmy-exchange-return" }, words: "torn sole" } } }));
    const sent = [];
    const courier = { ...fakeCourier(), createShipment: async (body) => { sent.push(body); return { id: 43, short_tracking_reference: "EXW124", charged_amount: 99 }; } };
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh, { courier }).deps);
    expect(sent).toHaveLength(0);
    expect(courier.calls).toEqual([]);
    expect(order(f, EX)).toMatchObject({ fulfilState: "courier_failed", attentionOpen: true, attention: { kind: "courier_failed", reason: expect.stringMatching(/not in good condition/) } });
    // He says good (the hold goes) and the POS Retry puts it back to pending: booked.
    await f.db.ref(`online_orders/${EX}/incoming/conditionHold`).set(null);
    await f.db.ref(`online_orders/${EX}`).update({ fulfilState: "pending", "fulfil/state": "pending" });
    await runOrdersPoll(deps(f, sh, { courier }).deps);
    expect(sent).toHaveLength(1);
    expect(order(f, EX).fulfilState).toBe("done");
  });

  it("live, booking fails: held as courier_failed exactly like a website order (no Shopify either way)", async () => {
    const f = fakeDb(exchangeWorld({ live: true }));
    const courier = { ...fakeCourier(), createShipment: async () => { throw Object.assign(new Error("HTTP 400 bad address"), { status: 400 }); } };
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh, { courier }).deps);
    expect(shopifyWrites(sh)).toEqual([]);
    expect(order(f, EX)).toMatchObject({ status: "packed", fulfilState: "courier_failed", attentionOpen: true, attention: { kind: "courier_failed" } });
  });

  it("a non-exchange record with no shopifyGid is never sent to Shopify with a missing id", async () => {
    const w = world({ online_orders: { 9001: { ref: "KQZ", status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0 }, lines: [{ pid: "TEE", sizeKey: "M", qty: 1, source: { status: "handed" } }] } } });
    const f = fakeDb(w);
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh).deps);
    expect(sh.calls.some((c) => c.query.includes("fulfillmentCreate"))).toBe(false);
    expect(order(f)).toMatchObject({ fulfilState: "failed", fulfil: { error: expect.stringMatching(/no shopifyGid/) } });
  });

  it("numeric orders unchanged: a website order still fulfils on Shopify, with no exchange note", async () => {
    const f = fakeDb(world({ online_orders: { 9001: { ref: "KQZ", shopifyGid: "gid://shopify/Order/9001", status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0 }, lines: [{ pid: "TEE", sizeKey: "M", qty: 1, source: { status: "handed" } }] } } }));
    const sh = shopify({ fos });
    await runOrdersPoll(deps(f, sh).deps);
    expect(sh.calls.filter((c) => c.query.includes("fulfillmentCreate"))).toHaveLength(1);
    expect(order(f)).toMatchObject({ fulfilState: "done", fulfil: { state: "done", attempts: 1 } });
    expect(order(f).fulfil.note).toBeUndefined();
  });
});

describe("one bad order never stops the rest", () => {
  it("is parked and retried by id; the cursor moves on", async () => {
    const f = fakeDb(world(), { failWritesUnder: "online_orders/9001" });
    const later = shopifyOrder({ id: "gid://shopify/Order/9002", legacyResourceId: "9002", number: 1802, name: "#1802", updatedAt: "2026-10-21T09:40:00Z" });
    const out = await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder(), later] })).deps);
    expect(out.errors).toHaveLength(1);
    expect(order(f, "9002")).toMatchObject({ orderNumber: 1802 }); // named by its Shopify number; no per-order code
    expect(f.read("online_orders_meta/cursorMs")).toBe(Date.parse("2026-10-21T09:40:00Z"));
    expect(f.read("online_orders_meta/retry/9001")).toMatchObject({ name: "#1801", attempts: 1 });
    // The fault clears; the next tick's list no longer carries 9001 — it is fetched by id.
    const g = fakeDb(f.root);
    const out2 = await runOrdersPoll(deps(g, shopify({ orders: [], byId: { 9001: shopifyOrder() } })).deps);
    expect(out2.errors).toEqual([]);
    expect(g.read("online_orders/9001")).toMatchObject({ orderNumber: 1801 });
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
      /^(online_orders|online_reservations|online_order_refs|orders|network|stock|shopify_sync|products|displayChecks_active|users)$/,
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
    expect(m.subject).toBe("Website order #1 needs attention"); // the Shopify name, never the old code
    expect(m.text).toContain("R");
    expect(m.text).toContain("Settings → Online orders");
  });
});

describe("one three-letter code per hub order UNIT (owner decision 2026-10-21)", () => {
  const twoPairs = () => shopifyOrder({ lineItems: { nodes: [shopifyOrder().lineItems.nodes[0]] } }); // Air Runner 8 ×2 → hub1 + hub2

  it("two pairs on one order → two hub orders, two DIFFERENT letter-only codes (no I, no O), both claimed", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [twoPairs()] })).deps);
    const codes = Object.keys(f.read("orders"));
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z]{3}$/);
    for (const c of codes) expect(f.read(`online_order_refs/${c}`)).toMatchObject({ kind: "hub_unit" });
    expect(order(f).ref).toBeUndefined(); // the order itself has no code — it is #1801
    expect(Object.values(f.read("orders")).map((r) => r.onlineOrderNumber)).toEqual([1801, 1801]);
  });

  it("a re-run lands on the SAME codes — never a second hub order for one pair", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [twoPairs()] })).deps);
    const before = Object.keys(f.read("orders")).sort();
    // A crash after the hub orders landed but before the line recorded them:
    for (const i of [0, 1]) await f.db.ref(`online_orders/9001/lines/${i}/source`).set({ locationId: lineAt(f, i).source.locationId, status: "pick" });
    await runOrdersPoll(deps(f, shopify()).deps);
    expect(Object.keys(f.read("orders")).sort()).toEqual(before);
    expect([lineAt(f, 0).source.orderKeys, lineAt(f, 1).source.orderKeys].flat().sort()).toEqual(before);
  });

  it("a code another unit holds (< 180 days) is never reused — the next candidate is taken", async () => {
    const f = fakeDb(world({ config: { onlineOrders: { enabled: true } }, online_order_refs: { [C(0)]: { orderId: "7777:0:0:0", at: Date.parse("2026-10-20T00:00:00Z") } } }));
    await runOrdersPoll(deps(f, shopify({ orders: [shopifyOrder()] })).deps);
    expect(lineAt(f, 0).source.orderKeys).toEqual([C(0, 0, 0, 1)]);
    expect(f.read(`online_order_refs/${C(0)}/orderId`)).toBe("7777:0:0:0");
  });
});
