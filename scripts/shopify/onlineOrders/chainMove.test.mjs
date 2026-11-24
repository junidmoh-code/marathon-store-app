// Junid, 24 Nov 2026: a rejection moves the line on in the SAME tick (chainMove.mjs),
// and corrects the count when the rejecting shelf showed exactly one piece
// (functions/lib/web-writedown.cjs). Through the real poll tick against the fake RTDB.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { CELL_HOLDS_PATH, forgetPickableRules } from "../pickableStock.mjs";
import { chainCandidate, chainKey, CHAIN_MAX_AGE_MS } from "./chainMove.mjs";
import { WRITEDOWNS_PATH, sweepDecision, SWEEP_EVERY_MS } from "./writeDown.mjs";

let fetchGuard;
beforeEach(() => { forgetPickableRules(); fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-24T10:00:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const FRESH = "2026-11-22T08:00:00.000Z";
const cell = (qty, updatedAt = FRESH) => ({ qty, updatedAt, mv: "seed", v: 1, lastType: "received" });
const world = ({ stock = {}, config = {}, over = {} } = {}) => ({
  online_orders_meta: { goLiveAtMs: NOW - 3600e3 },
  config: { onlineOrders: { enabled: true, ...config }, shipping: { deliveryMode: "door" } },
  products: {
    SNK: { name: "Air Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["8"] },
    TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", sizes: ["M"] },
  },
  shopify_sync: {
    _claims: { 111: "SNK", 222: "TEE" },
    SNK: { shopifyProductId: P(111), variants: { 8: { shopifyVariantId: V(1108) } } },
    TEE: { shopifyProductId: P(222), variants: { M: { shopifyVariantId: V(2201) } } },
  },
  stock,
  ...over,
});
const shopifyOrder = (id, number, { tee = false } = {}) => ({
  id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), name: `#${number}`, number,
  createdAt: "2026-11-24T09:30:00Z", updatedAt: "2026-11-24T09:31:00Z", cancelledAt: null,
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", email: "buyer@example.com", phone: null,
  customer: { firstName: "T", lastName: "M", defaultPhoneNumber: { phoneNumber: "+27820000000" } },
  shippingAddress: { name: "T M", address1: "1 Main Rd", city: "Gqeberha", zip: "6001", country: "South Africa" },
  currentSubtotalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "ZAR" } }, currentTotalPriceSet: { shopMoney: { amount: "600.00", currencyCode: "ZAR" } },
  totalShippingPriceSet: { shopMoney: { amount: "100.00" } }, currentTotalTaxSet: { shopMoney: { amount: "0" } },
  lineItems: { nodes: [tee
    ? { id: `gid://shopify/LineItem/${id}1`, title: "Club Tee", variantTitle: "M", quantity: 1, currentQuantity: 1, variant: { id: V(2201), product: { id: P(222) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "500.00" } } }
    : { id: `gid://shopify/LineItem/${id}1`, title: "Air Runner", variantTitle: "8", quantity: 1, currentQuantity: 1, variant: { id: V(1108), product: { id: P(111) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "500.00" } } }] },
});
const shopify = (orders = []) => async (query) => {
  if (query.includes("orders(")) return { orders: { nodes: orders, pageInfo: { hasNextPage: false } } };
  throw new Error(`unexpected query ${query.slice(0, 40)}`);
};
const logs = [];
const deps = (f, orders = [], at = NOW) => ({
  db: f.db, graphql: shopify(orders), nowMs: async () => at, send: async () => {}, increment, saDate: () => "2026-11-24",
  resolveAssignment: () => null, log: (m) => logs.push(m), courierLog: () => {},
  courier: { getRates: async () => { throw new Error("no courier in this test"); } },
  refRand: (() => { let i = 0; return () => ((i++ * 7) % 24 + 0.5) / 24; })(),
});
const line = (f, id = "9001") => f.read(`online_orders/${id}/lines/0`);
const movementsOf = (f, type) => Object.entries(f.read("stock_movements") || {}).filter(([, m]) => m.type === type);

/** Order 9001 arrives and its hub marks the pick Out of Stock; the NEXT tick is the one under test. */
async function hubSaysNo(f, hub = "hub1") {
  await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
  expect(line(f).source).toMatchObject({ locationId: hub, status: "pick" });
  const code = line(f).source.orderKeys[0];
  await f.db.ref(`orders/${code}`).update({ status: "out_of_stock", outOfStockByUid: "u-alli", outOfStockAt: new Date(NOW - 30e3).toISOString() });
  await runOrdersPoll(deps(f));
  return code;
}

describe("a hub's Out of Stock moves the line on in the same tick", () => {
  it("to the next hub on its chain, with a new three-letter code; the hold follows the line to that ONE place", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(2) } }, hub2: { SNK: { 8: cell(3) } } } }));
    const old = await hubSaysNo(f);
    const l = line(f);
    expect(l.source).toMatchObject({ locationId: "hub2", status: "pick", why: "next place on the chain with it" });
    expect(l.routeGen).toBe(1);
    expect(l.failedPlaces).toHaveProperty("hub1");
    expect(l.source.orderKeys[0]).not.toBe(old);
    expect(f.read(`orders/${l.source.orderKeys[0]}`)).toMatchObject({ hub: "hub2", customerName: "Shopify", channel: "online", status: "incoming" });
    expect(f.read("online_reservations/SNK/8/9001").locs).toEqual({ hub2: 1 });
    expect(f.read(`online_orders/9001/agentRepicks/${chainKey(0, 0)}`)).toMatchObject({ by: "chain", state: "ordered", routedTo: "hub2", exclude: ["hub1"] });
    expect(f.read("online_orders/9001/attention") ?? null).toBeNull();
    // Nothing was requested from anyone.
    expect(f.writes.map(([, p]) => String(p).split("/")[0]).filter((p) => /refill|restock/.test(p))).toEqual([]);
  });

  it("two or more on the rejecting shelf: the count is NOT changed — the shelf hold keeps it off the website", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(2) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await hubSaysNo(f);
    expect(f.read("stock/hub1/SNK/8")).toEqual(cell(2));
    expect(f.read("stock_movements") ?? null).toBeNull();
    expect(f.read(WRITEDOWNS_PATH) ?? null).toBeNull();
    expect(f.read(`${CELL_HOLDS_PATH}/SNK/8/hub1`)).toMatchObject({ kind: "hub_out_of_stock", qty: 2, orderId: "9001" });
  });

  it("exactly one on the rejecting shelf: written to zero as its own movement type, with who, when and the order", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await hubSaysNo(f);
    expect(f.read("stock/hub1/SNK/8")).toMatchObject({ qty: 0, lastType: "adjustment", updatedBy: "u-alli" });
    const [[id, mv]] = movementsOf(f, "web_not_found");
    expect(id).toBe("web_nf_9001_0_g0_hub1");
    expect(mv).toMatchObject({ productId: "SNK", size: "8", qty: 1, from: "hub1", before: { hub1: 1 }, after: { hub1: 0 }, actor: "u-alli", link: { orderId: "9001" }, web: { kind: "hub_out_of_stock", orderNumber: 2501, line: 0, by: "u-alli", rejectedAt: NOW - 30e3 } });
    expect(mv.reason).toMatch(/website pick not found #2501/);
    expect(f.read(`${WRITEDOWNS_PATH}/SNK/8/hub1`)).toMatchObject({ at: NOW - 30e3, mvId: id, qty: 1, kind: "hub_out_of_stock", orderId: "9001", orderNumber: 2501 });
    expect(f.read("shopify_inventory_dirty/SNK")).toBeGreaterThan(0);
    expect(line(f).source).toMatchObject({ locationId: "hub2", status: "pick" });
  });

  it("a repeat tick writes nothing twice (one movement, one request, one move)", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await hubSaysNo(f);
    const before = JSON.stringify([f.read("stock"), f.read("stock_movements"), line(f).routeGen, Object.keys(f.read("online_orders/9001/agentRepicks"))]);
    await runOrdersPoll(deps(f, [], NOW + 120e3));
    expect(JSON.stringify([f.read("stock"), f.read("stock_movements"), line(f).routeGen, Object.keys(f.read("online_orders/9001/agentRepicks"))])).toBe(before);
  });

  it("Junid's switch /config/onlineOrders/writeDown/off leaves every count alone", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } }, config: { writeDown: { off: true } } }));
    await hubSaysNo(f);
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(1);
    expect(f.read("stock_movements") ?? null).toBeNull();
  });

  it("the shelf moved AFTER the hub said no (a delivery): newer evidence, no write-down", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(2) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref(`orders/${line(f).source.orderKeys[0]}`).update({ status: "out_of_stock", outOfStockAt: new Date(NOW - 600e3).toISOString() });
    await f.db.ref("stock/hub1/SNK/8").set(cell(1, new Date(NOW - 60e3).toISOString()));
    await runOrdersPoll(deps(f));
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(1);
    expect(f.read("stock_movements") ?? null).toBeNull();
  });

  it("only Central is left: the line goes on Central's strip", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, central: { SNK: { 8: cell(4) } } } }));
    await hubSaysNo(f);
    expect(line(f).source).toMatchObject({ locationId: "central", status: "display" });
    expect(line(f).source.why).toMatch(/^last stop/);
    expect(f.read(line(f).source.entryKey)).toMatchObject({ kind: "online_pick", status: "open" });
    expect(f.read("online_reservations/SNK/8/9001").locs).toEqual({ central: 1 });
  });

  it("nowhere left on the chain: the line is stamped for Jamie, once, and is not asked again", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } } } }));
    await hubSaysNo(f);
    const l = line(f);
    expect(l.source).toMatchObject({ status: "no_stock", locationId: "hub1", failedAt: NOW });
    expect(l.chain).toMatchObject({ gen: 0, rid: chainKey(0, 0), at: NOW, result: "nowhere" });
    expect(l.chain.why).toMatch(/Hub 1: skipped, Hub 2: 0 free, Hub 3: 0 free, Central: 0 free/);
    const from = f.writes.length;
    await runOrdersPoll(deps(f, [], NOW + 120e3));
    expect(f.writes.slice(from).filter(([, p]) => /agentRepicks|\/chain/.test(String(p)))).toEqual([]);
  });

  it("a chain move still being applied stamps nothing: Jamie is not told the chain ran out while it has not", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref("online_orders/9001/lines/0/source").update({ status: "no_stock", failedAt: NOW - 1000 });
    await f.db.ref("online_orders/9001/status").set("needs_attention");
    // Another process claimed the move a moment ago and has not finished it.
    await f.db.ref(`online_orders/9001/agentRepicks/${chainKey(0, 0)}`).set({ lineIndex: 0, expectPid: "SNK", expectSizeKey: "8", expectStatus: "no_stock", expectRouteGen: 0, exclude: ["hub1"], by: "chain", at: NOW - 500, state: "applying", claimedAt: NOW - 400 });
    await runOrdersPoll(deps(f));
    expect(line(f).chain ?? null).toBeNull();
    expect(f.read(`online_orders/9001/agentRepicks/${chainKey(0, 0)}`).state).toBe("applying");
  });

  it("a move answered on a LATER tick than it was raised still stamps the line (a claim that went stale is finished, then Jamie is told)", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } } } }));
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    await f.db.ref("online_orders/9001/lines/0/source").update({ status: "no_stock", failedAt: NOW - 1000 });
    await f.db.ref("online_orders/9001/status").set("needs_attention");
    await f.db.ref(`online_orders/9001/agentRepicks/${chainKey(0, 0)}`).set({ lineIndex: 0, expectPid: "SNK", expectSizeKey: "8", expectStatus: "no_stock", expectRouteGen: 0, exclude: ["hub1"], by: "chain", at: NOW - 500, state: "applying", claimedAt: NOW - 400 });
    await runOrdersPoll(deps(f, [], NOW + 6 * 60e3)); // the claim is stale now: the tick finishes it — nowhere has the size
    expect(f.read(`online_orders/9001/agentRepicks/${chainKey(0, 0)}`).state).toBe("not_in_stock");
    expect(line(f).chain).toMatchObject({ gen: 0, result: "nowhere", at: NOW + 6 * 60e3 });
  });

  it("a shelf that rejected a website pick lately is doubtful even after it moved: a new order goes to the trusted shelf first", async () => {
    const f = fakeDb(world({
      stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } },
      // Hub 1 said no three days ago; its shelf has moved since (FRESH is later), so the hold no longer stands…
      over: { online_cell_holds: { SNK: { 8: { hub1: { at: Date.parse(FRESH) - 864e5, kind: "hub_out_of_stock", orderId: "8000", line: 0 } } } } },
    }));
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501)]));
    // …but one piece + a recent rejection is two points: Hub 2 is asked first, and the line says why.
    expect(line(f).source).toMatchObject({ locationId: "hub2", status: "pick" });
    expect(line(f).source.why).toMatch(/^trusted shelf, ahead of hub1 \(one piece, rejected a website pick \d+ days ago\)$/);
  });

  it("a doubtful shelf is asked after a trusted one, and before Central", async () => {
    const stale = "2026-10-01T08:00:00.000Z";
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(1, stale) } }, hub3: { SNK: { 8: cell(2) } }, central: { SNK: { 8: cell(9) } } } }));
    await hubSaysNo(f, "hub1");
    expect(line(f).source).toMatchObject({ locationId: "hub3", status: "pick" });
  });
});

describe("a shop's Not found and the packer's Not here move on the same way", () => {
  const notFoundAtPe = (at = NOW - 60e3) => ({ status: "not_found", locationId: "marathon-pe", failedAt: at, entryKey: "displayChecks_active/marathon-pe/online__9001__0" });
  async function teeOrder(f, source, extra = {}) {
    await runOrdersPoll(deps(f, [shopifyOrder(9001, 2501, { tee: true })]));
    await f.db.ref("online_orders/9001/lines/0").update({ source, ...extra });
    await f.db.ref("online_orders/9001/status").set("needs_attention");
    await runOrdersPoll(deps(f));
  }

  it("Not found at Marathon PE → Hub 2, as a hub order with a three-letter code, exactly like sneakers", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { TEE: { M: cell(1) } }, hub2: { TEE: { M: cell(2) } } } }));
    await teeOrder(f, notFoundAtPe());
    const l = line(f);
    expect(l.source).toMatchObject({ locationId: "hub2", status: "pick" });
    expect(l.source.orderKeys[0]).toMatch(/^[A-HJ-NP-Z]{3}$/);
    expect(f.read(`orders/${l.source.orderKeys[0]}`)).toMatchObject({ hub: "hub2", customerName: "Shopify" });
    expect(f.read("online_reservations/TEE/M/9001").locs).toEqual({ hub2: 1 });
  });

  it("a rejection from before the chain move existed (no failedAt), or older than a day, is not swept up", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { TEE: { M: cell(1) } }, hub2: { TEE: { M: cell(2) } } } }));
    await teeOrder(f, { status: "not_found", locationId: "marathon-pe" });
    expect(line(f).source).toMatchObject({ status: "not_found", locationId: "marathon-pe" });
    expect(chainCandidate({ pid: "TEE", sizeKey: "M", source: notFoundAtPe(NOW - CHAIN_MAX_AGE_MS - 1) }, NOW)).toBeNull();
    expect(chainCandidate({ pid: "TEE", sizeKey: "M", source: notFoundAtPe(NOW - CHAIN_MAX_AGE_MS) }, NOW)).toMatchObject({ loc: "marathon-pe", exclude: ["marathon-pe"] });
  });

  it("every place that already failed the line is skipped, not only the last one", () => {
    const c = chainCandidate({ pid: "TEE", sizeKey: "M", failedPlaces: { "marathon-pe": 1, trophy: 2 }, source: { status: "no_stock", locationId: "hub2", failedAt: NOW } }, NOW);
    expect(c.exclude.sort()).toEqual(["hub2", "marathon-pe", "trophy"]);
  });

  it("the packer's Not here skips the place that sent it; Damaged does not (another piece there may be fine); a line Jamie parked is Jamie's", () => {
    const base = { pid: "TEE", sizeKey: "M", source: { status: "unavailable" } };
    expect(chainCandidate({ ...base, unavailable: { reason: "not_here", at: NOW, fromSource: { locationId: "trophy" } } }, NOW)).toMatchObject({ exclude: ["trophy"], loc: "trophy" });
    expect(chainCandidate({ ...base, unavailable: { reason: "damaged", at: NOW, fromSource: { locationId: "trophy" } } }, NOW)).toMatchObject({ exclude: [] });
    expect(chainCandidate({ ...base, source: { status: "unavailable", by: "jamie", was: "no_stock" }, unavailable: { reason: "not_here", at: NOW } }, NOW)).toBeNull();
    expect(chainCandidate({ ...base }, NOW)).toBeNull();
  });

  it("the customer is already being asked: the move is refused and the line says why", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { TEE: { M: cell(1) } }, hub2: { TEE: { M: cell(2) } } } }));
    await teeOrder(f, notFoundAtPe(), { awaitingCustomer: { since: NOW - 60e3, by: "jamie" } });
    expect(line(f).source.status).toBe("not_found");
    expect(line(f).chain).toMatchObject({ result: "blocked" });
    expect(line(f).chain.why).toMatch(/customer/);
  });

  it("Junid's switch /config/onlineOrders/routing/chainOff leaves the line where it failed", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { TEE: { M: cell(1) } }, hub2: { TEE: { M: cell(2) } } }, config: { routing: { chainOff: true } } }));
    await teeOrder(f, notFoundAtPe());
    expect(line(f).source.status).toBe("not_found");
    expect(f.read("online_orders/9001/agentRepicks") ?? null).toBeNull();
  });
});

describe("a write-down undoes itself", () => {
  async function writtenDown() {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: cell(1) } }, hub2: { SNK: { 8: cell(3) } } } }));
    await hubSaysNo(f);
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(0);
    return f;
  }
  const LATER = NOW + SWEEP_EVERY_MS + 1;

  it("the piece is sold at a till there (the shelf goes below zero): put back, logged, row closed — the shelf ends on zero", async () => {
    const f = await writtenDown();
    await f.db.ref("stock/hub1/SNK/8").update({ qty: -1, mv: "sale-1", lastType: "sold", updatedAt: new Date(NOW + 60e3).toISOString() });
    await runOrdersPoll(deps(f, [], LATER));
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(0);
    const [[id, mv]] = movementsOf(f, "web_found");
    expect(id).toBe("web_found_web_nf_9001_0_g0_hub1");
    expect(mv).toMatchObject({ to: "hub1", qty: 1, before: { hub1: -1 }, after: { hub1: 0 }, web: { kind: "sold_or_picked", undoes: "web_nf_9001_0_g0_hub1", orderNumber: 2501 } });
    expect(f.read(WRITEDOWNS_PATH) ?? null).toBeNull();
  });

  it("a delivery or a count lands on the shelf: the question is settled, the row closes and nothing is added", async () => {
    const f = await writtenDown();
    await f.db.ref("stock/hub1/SNK/8").update({ qty: 2, mv: "refill-1", lastType: "transfer_in", updatedAt: new Date(NOW + 60e3).toISOString() });
    await runOrdersPoll(deps(f, [], LATER));
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(2);
    expect(movementsOf(f, "web_found")).toEqual([]);
    expect(f.read(WRITEDOWNS_PATH) ?? null).toBeNull();
  });

  it("untouched: the row waits; the sweep runs at most every ten minutes", async () => {
    const f = await writtenDown();
    await f.db.ref("stock/hub1/SNK/8").update({ qty: -1, mv: "sale-1", lastType: "sold" });
    await runOrdersPoll(deps(f, [], NOW + 60e3));   // the sweep ran at NOW: too soon
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(-1);
    await runOrdersPoll(deps(f, [], LATER));
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(0);
  });

  it("sweepDecision (pure)", () => {
    const row = { mvId: "m1", at: NOW };
    expect(sweepDecision(row, { qty: 0, mv: "m1" }, NOW)).toBe("keep");
    expect(sweepDecision(row, { qty: -1, mv: "s" }, NOW)).toBe("restore");
    expect(sweepDecision(row, { qty: 0, mv: "s" }, NOW)).toBe("close");
    expect(sweepDecision(row, { qty: 3, mv: "s" }, NOW)).toBe("close");
    expect(sweepDecision(row, { qty: 0, mv: "m1" }, NOW + 121 * 864e5)).toBe("close");
    expect(sweepDecision({}, { qty: 0 }, NOW)).toBe("close");
  });
});
