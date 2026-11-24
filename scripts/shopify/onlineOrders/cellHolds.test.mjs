// Shelf holds in the poller (pickableStock.mjs, Junid 24 Nov 2026): a hub's Out
// of Stock on a website pick takes that cell off the website and out of
// routing until the cell moves — and moves no stock, raises no request.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll, rejectedAt } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { CELL_HOLDS_PATH, forgetPickableRules } from "../pickableStock.mjs";

let fetchGuard;
beforeEach(() => { forgetPickableRules(); fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-24T10:00:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const world = (over = {}) => ({
  online_orders_meta: { goLiveAtMs: NOW - 3600e3 },
  config: { onlineOrders: { enabled: true }, shipping: { deliveryMode: "door" } },
  products: { SNK: { name: "Air Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["8"] } },
  shopify_sync: { _claims: { 111: "SNK" }, SNK: { shopifyProductId: P(111), variants: { 8: { shopifyVariantId: V(1108) } } } },
  stock: {
    hub1: { SNK: { 8: { qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" } } },
    hub2: { SNK: { 8: { qty: 1, updatedAt: "2026-11-20T08:00:00.000Z" } } },
  },
  ...over,
});
const shopifyOrder = (id, number) => ({
  id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), name: `#${number}`, number,
  createdAt: "2026-11-24T09:30:00Z", updatedAt: "2026-11-24T09:31:00Z", cancelledAt: null,
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", email: "buyer@example.com", phone: null,
  customer: { firstName: "T", lastName: "M", defaultPhoneNumber: { phoneNumber: "+27820000000" } },
  shippingAddress: { name: "T M", address1: "1 Main Rd", city: "Gqeberha", zip: "6001", country: "South Africa" },
  currentSubtotalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "ZAR" } }, currentTotalPriceSet: { shopMoney: { amount: "600.00", currencyCode: "ZAR" } },
  totalShippingPriceSet: { shopMoney: { amount: "100.00" } }, currentTotalTaxSet: { shopMoney: { amount: "0" } },
  lineItems: { nodes: [{ id: `gid://shopify/LineItem/${id}1`, title: "Air Runner", variantTitle: "8", quantity: 1, currentQuantity: 1, variant: { id: V(1108), product: { id: P(111) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "500.00" } } }] },
});
const shopify = (orders = []) => async (query) => {
  if (query.includes("orders(")) return { orders: { nodes: orders, pageInfo: { hasNextPage: false } } };
  throw new Error(`unexpected query ${query.slice(0, 40)}`);
};
const deps = (f, orders = [], over = {}) => ({
  db: f.db, graphql: shopify(orders), nowMs: async () => NOW, send: async () => {}, increment, saDate: () => "2026-11-24",
  resolveAssignment: () => null, log: () => {}, courierLog: () => {},
  courier: { getRates: async () => { throw new Error("no courier in this test"); } },
  refRand: (() => { let i = 0; return () => ((i++ * 7) % 24 + 0.5) / 24; })(),
  ...over,
});
const line = (f, id) => f.read(`online_orders/${id}/lines/0`);

// Order 9001 lands, is routed to Hub 1, and Hub 1 marks it Out of Stock.
async function rejectedAtHub1(f) {
  await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
  expect(line(f, "9001").source).toMatchObject({ locationId: "hub1", status: "pick" });
  await f.db.ref(`orders/${line(f, "9001").source.orderKeys[0]}`).update({ status: "out_of_stock", outOfStockByUid: "u-alli" });
  await runOrdersPoll(deps(f));
  expect(line(f, "9001").source.status).toBe("no_stock");
}

describe("a hub's Out of Stock on a website pick", () => {
  it("leaves a hold beside the cell, tells the website, and does NOT touch the count", async () => {
    const f = fakeDb(world());
    await rejectedAtHub1(f);
    expect(f.read(`${CELL_HOLDS_PATH}/SNK/8/hub1`)).toEqual({ at: NOW, kind: "hub_out_of_stock", orderId: "9001", line: 0, qty: 2, by: "u-alli" });
    expect(f.read("stock/hub1/SNK/8")).toEqual({ qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" });
    expect(f.read("shopify_inventory_dirty/SNK")).toBeGreaterThan(0);
    // No stock movement and no request of any kind was written.
    const touched = f.writes.map(([, path]) => String(path).split("/")[0]);
    expect(touched).not.toContain("stock");
    expect(touched).not.toContain("stock_movements");
    expect(touched.filter((p) => /refill|restock/.test(p))).toEqual([]);
  });

  it("tells the website itself (its own bump of the dirty counter, beside the reservation's)", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref(`orders/${line(f, "9001").source.orderKeys[0]}`).update({ status: "out_of_stock" });
    const from = f.writes.length;
    await runOrdersPoll(deps(f));
    const paths = f.writes.slice(from).map(([, path]) => String(path));
    const holdAt = paths.indexOf(`${CELL_HOLDS_PATH}/SNK/8/hub1`);
    expect(holdAt).toBeGreaterThanOrEqual(0);
    // Straight after the hold row, before the order itself is committed.
    expect(paths[holdAt + 1]).toBe("shopify_inventory_dirty/SNK");
  });

  it("a cell that emptied before the hub answered gets no hold (there is nothing on paper to hide)", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref("stock/hub1/SNK/8/qty").set(0);
    await f.db.ref(`orders/${line(f, "9001").source.orderKeys[0]}`).update({ status: "out_of_stock" });
    await runOrdersPoll(deps(f));
    expect(line(f, "9001").source.status).toBe("no_stock");
    expect(f.read(`${CELL_HOLDS_PATH}/SNK`)).toBe(null);
  });

  it("the next order for that size is NOT sent back to the shelf that said no: it goes to the next place", async () => {
    const f = fakeDb(world());
    await rejectedAtHub1(f);
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)]));
    expect(line(f, "9002").source).toMatchObject({ locationId: "hub2", status: "pick" });
  });

  it("with nowhere else holding it, the next order waits (no_stock) instead of being rejected again", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: { qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" } } } } }));
    await rejectedAtHub1(f);
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)]));
    expect(line(f, "9002").source.status).toBe("no_stock");
    expect(line(f, "9002").source.locationId).toBeUndefined();
  });

  it("the hold ends by itself when the cell moves (a delivery, a sale, a count): the shelf is trusted again", async () => {
    const f = fakeDb(world());
    await rejectedAtHub1(f);
    await f.db.ref("stock/hub1/SNK/8").set({ qty: 3, updatedAt: new Date(NOW + 60e3).toISOString() });
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)], { nowMs: async () => NOW + 120e3 }));
    expect(line(f, "9002").source).toMatchObject({ locationId: "hub1", status: "pick" });
  });

  it("Junid's switch (config/onlineOrders/pickable/holdsOff) routes exactly as before", async () => {
    const f = fakeDb(world());
    await rejectedAtHub1(f);
    await f.db.ref("config/onlineOrders/pickable/holdsOff").set(true);
    forgetPickableRules();
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)]));
    expect(line(f, "9002").source).toMatchObject({ locationId: "hub1", status: "pick" });
  });

  it("a hold that cannot be written never stops the order being kept", async () => {
    const f = fakeDb(world(), { failWritesUnder: CELL_HOLDS_PATH });
    await rejectedAtHub1(f);
    expect(f.read(`${CELL_HOLDS_PATH}/SNK`)).toBe(null);
    expect(f.read("online_orders/9001/status")).toBe("needs_attention");
  });
});

describe("the hold is stamped with when the hub said no, not when the tick noticed", () => {
  it("a delivery that reached the shelf between the rejection and the tick ends the hold (the poller can be hours behind)", async () => {
    const f = fakeDb(world());
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref(`orders/${line(f, "9001").source.orderKeys[0]}`).update({ status: "out_of_stock", outOfStockAt: new Date(NOW - 3 * 3600e3).toISOString() });
    await f.db.ref("stock/hub1/SNK/8").set({ qty: 4, updatedAt: new Date(NOW - 3600e3).toISOString() }); // delivered an hour ago
    await runOrdersPoll(deps(f));
    expect(f.read(`${CELL_HOLDS_PATH}/SNK/8/hub1/at`)).toBe(NOW - 3 * 3600e3);
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)]));
    expect(line(f, "9002").source).toMatchObject({ locationId: "hub1", status: "pick" });
  });
  it("rejectedAt: the hub's own time when it is sane; the tick's time for a clock ahead, an old stamp or no stamp", () => {
    expect(rejectedAt(new Date(NOW - 60e3).toISOString(), NOW)).toBe(NOW - 60e3);
    expect(rejectedAt(new Date(NOW + 60e3).toISOString(), NOW)).toBe(NOW);
    expect(rejectedAt(new Date(NOW - 8 * 864e5).toISOString(), NOW)).toBe(NOW);
    expect(rejectedAt(undefined, NOW)).toBe(NOW);
    expect(rejectedAt("yesterday-ish", NOW)).toBe(NOW);
  });
});

describe("a held shelf and the lines that are waiting", () => {
  it("a line that waited because the only shelf was held routes itself once that shelf moves", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: { qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" } } } } }));
    await rejectedAtHub1(f);
    await runOrdersPoll(deps(f, [shopifyOrder(9002, 2502)]));
    expect(line(f, "9002").source.status).toBe("no_stock");
    await runOrdersPoll(deps(f)); // nothing moved: still waiting, not bounced back to Hub 1
    expect(line(f, "9002").source.status).toBe("no_stock");
    await f.db.ref("stock/hub1/SNK/8").set({ qty: 3, updatedAt: new Date(NOW + 60e3).toISOString() });
    await runOrdersPoll(deps(f, [], { nowMs: async () => NOW + 120e3 }));
    expect(line(f, "9002").source).toMatchObject({ locationId: "hub1", status: "pick" });
  });

  it("Order it now on the held shelf: the person who found it wins — the line is picked there and the hold is lifted", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: { qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" } } } } }));
    await rejectedAtHub1(f);
    expect(f.read(`${CELL_HOLDS_PATH}/SNK/8/hub1`)).not.toBe(null);
    const l = line(f, "9001");
    await f.db.ref("online_orders/9001/orderNowRequests/0_0").set({ lineIndex: 0, expectPid: "SNK", expectSizeKey: "8", expectStatus: l.source.status, expectRouteGen: l.routeGen || 0, by: { uid: "u-yasmin", name: "Yasmin" }, at: NOW, state: "pending" });
    await runOrdersPoll(deps(f));
    expect(f.read("online_orders/9001/orderNowRequests/0_0/state")).toBe("ordered");
    expect(line(f, "9001").source).toMatchObject({ locationId: "hub1", status: "pick" });
    expect(line(f, "9001").routeGen).toBe(1);
    expect(f.read(`${CELL_HOLDS_PATH}/SNK`)).toBe(null);
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(2); // and still no stock moved
  });

  it("a line sent back by Settings → Resolve (no Order it now) does NOT get past the hold", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: { qty: 2, updatedAt: "2026-11-01T08:00:00.000Z" } } } } }));
    await rejectedAtHub1(f);
    await f.db.ref("online_orders/9001/lines/0/source/status").set("reroute");
    await runOrdersPoll(deps(f));
    expect(line(f, "9001").source.status).toBe("no_stock");
    expect(line(f, "9001").source.locationId).toBeUndefined();
    expect(f.read(`${CELL_HOLDS_PATH}/SNK/8/hub1`)).not.toBe(null);
  });
});

