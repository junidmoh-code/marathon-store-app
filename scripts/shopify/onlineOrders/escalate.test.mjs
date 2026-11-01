import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { candidateCode } from "./orderRefs.mjs";
const C = (i, u = 0, g = 0, k = 0, id = "9001") => candidateCode(`${id}:${i}:${u}:${g}`, k);
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import doorRates from "../../shipping/fixtures/rates-door-capetown.json";
import lockerRates from "../../shipping/fixtures/rates-locker-capetown.json";

// NO TEST HERE REACHES THE NETWORK.
let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-21T10:00:00Z"); // Wed 12:00 SAST
const NEXT_DAY_11 = Date.parse("2026-10-22T09:00:00Z"); // Thu 11:00 SAST
const LI = (n) => `gid://shopify/LineItem/${n}`;

function fakeCourier() {
  return {
    getRates: async (body) => (body.collection_pickup_point_id ? lockerRates : doorRates),
    createShipment: async () => { throw new Error("createShipment must not be reached"); },
    cancelShipment: async () => { throw new Error("cancelShipment must not be reached"); },
  };
}

const tee = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: LI(2), pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee",
  isFootwear: false, unitPriceCents: 25000, category: "Clothing", photoUrl: "https://x/tee.jpg",
  source: { locationId: "marathon-pe", status: "not_found", entryKey: "displayChecks_active/marathon-pe/online__9001__0" },
  ...over,
});
const snk = (over = {}) => ({
  lineId: "l1", shopifyLineItemId: LI(1), pid: "SNK", size: "8", sizeKey: "8", qty: 1, title: "Air Runner",
  isFootwear: true, unitPriceCents: 50000, category: "Footwear",
  source: { locationId: "hub1", status: "handed", entryKey: "orders/LEV-2", orderKeys: ["LEV-2"] },
  ...over,
});

function world({ lines = [tee(), snk()], order = {}, enabled = true, over = {} } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 3600e3 },
    config: { onlineOrders: { enabled } },
    products: { TEE: { name: "Club Tee", sizes: ["M"] }, SNK: { name: "Air Runner", sizes: ["8"] } },
    stock: { "marathon-pe": { TEE: { M: { qty: 1 } } }, hub2: { TEE: { M: { qty: 1 } } }, hub1: { SNK: { 8: { qty: 1 } } } },
    online_orders: {
      9001: {
        ref: "LEV", orderNumber: 1801, shopifyGid: "gid://shopify/Order/9001", shopifyName: "#1801",
        status: "needs_attention", customer: { name: "Thandi M", email: "buyer@example.com" },
        attention: { kind: "not_found", reason: "Not found at Marathon PE", at: NOW - 60e3 }, attentionOpen: true,
        lines, ...order,
      },
    },
    ...over,
  };
}

function deps(f, at = NOW, over = {}) {
  const mails = [];
  const logs = [];
  return {
    mails, logs,
    deps: {
      db: f.db, graphql: null, nowMs: async () => at,
      send: async (m) => { mails.push(m); },
      increment, saDate: () => "2026-10-21",
      log: (l) => logs.push(l), courier: fakeCourier(), courierLog: () => {},
      ...over,
    },
  };
}
const tick = (f, at = NOW, over = {}) => runOrdersPoll(deps(f, at, over).deps);
const line = (f, i, id = "9001") => f.read(`online_orders/${id}/lines/${i}`);
const writesUnder = (f, from, prefix) => f.writes.slice(from).filter(([, p]) => p.startsWith(prefix));

describe("non-footwear: shop Not found → Hub 2 → Central", () => {

  it("a second tick raises nothing new (restart / re-run safety)", async () => {
    const f = fakeDb(world());
    await tick(f);
    const n = f.writes.length;
    await tick(f);
    expect(writesUnder(f, n, "orders/")).toEqual([]);
    expect(writesUnder(f, n, "refill_requests/")).toEqual([]);
    expect(writesUnder(f, n, "refillCounter")).toEqual([]);
  });



});

describe("switches", () => {
  it("feeds off → nothing escalates (staff-visible requests need the switch)", async () => {
    const f = fakeDb(world({ enabled: false }));
    await tick(f);
    expect(f.read("orders")).toBeNull();
    expect(line(f, 0).escalation).toBeUndefined();
  });
  it("escalationOff → nothing escalates", async () => {
    const f = fakeDb(world({ over: { config: { onlineOrders: { enabled: true, escalationOff: true } } } }));
    await tick(f);
    expect(f.read("orders")).toBeNull();
  });
});

describe("Junid's escape hatches", () => {
  it("mark unavailable now — on a line that was never escalated — closes its entry and releases its hold", async () => {
    const lines = [tee({ source: { locationId: "marathon-pe", status: "display", entryKey: "displayChecks_active/marathon-pe/online__9001__0" }, escalationOverride: { kind: "unavailable", by: "junid", at: NOW } }), snk()];
    const f = fakeDb(world({ lines, order: { attention: null, attentionOpen: null, status: "picking" }, over: { displayChecks_active: { "marathon-pe": { online__9001__0: { kind: "online_pick", status: "open" } } } } }));
    await tick(f);
    expect(line(f, 0).source).toEqual({ status: "unavailable" });
    expect(line(f, 0).escalationOverride.appliedAt).toBe(NOW);
    expect(f.read("displayChecks_active/marathon-pe/online__9001__0")).toMatchObject({ status: "completed", result: "cancelled" });
    expect(f.read("orders")).toBeNull();
  });
  it("resolved by hand stops the chain and drops the registry row", async () => {
    const f = fakeDb(world());
    await tick(f);
    await f.db.ref("online_orders/9001/lines/0/escalationOverride").set({ kind: "resolved", by: "junid", at: NOW });
    await tick(f, NOW + 60e3);
    expect(line(f, 0).source).toEqual({ status: "resolved" });
    expect(f.read("online_escalations/9001_0")).toBeNull();
  });
});

describe("after a partial pack: a line that comes good ships as a follow-up", () => {
  it("the packed order keeps holding the resolving line; when it comes good a follow-up order carries it", async () => {
    const waiting = {
      chain: "other", home: "marathon-pe", round: 1, idx: 1, phase: "wait", waitUntil: NEXT_DAY_11, deliverAt: "hub2",
      request: { kind: "refill", key: "web_9001_0_r1s1", from: "central", to: "hub2" }, attempts: [{ action: "routed", result: "not_found", at: NOW }],
    };
    const lines = [tee({ source: { status: "resolving", locationId: "hub2" }, escalation: waiting }), snk()];
    const f = fakeDb(world({
      lines,
      order: { status: "packed", packedLines: { 1: true }, attention: null, attentionOpen: null, fulfilState: "done", pack: { saleId: "S1" } },
      over: { online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "wait" } } },
    }));
    await tick(f, NOW);
    // Still held while it waits (the pack nulled nothing that matters).
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 1, locs: { hub2: 1 } });
    await tick(f, NEXT_DAY_11);
    expect(line(f, 0).source).toEqual({ status: "moved", movedTo: "9001f0" });
    const fu = f.read("online_orders/9001f0");
    expect(fu).toMatchObject({ followUpOf: "9001", shopifyGid: "gid://shopify/Order/9001", status: "picking" });
    // No hold gap: the follow-up holds in the SAME tick the parent let go.
    expect(f.read("online_reservations/TEE/M/9001f0")).toMatchObject({ qty: 1, locs: { hub2: 1 } });
    expect(fu.lines[0]).toMatchObject({ pid: "TEE", shopifyLineItemId: LI(2), source: { locationId: "hub2", status: "pick", orderKeys: [C(0, 0, 1, 0, "9001f0")] } });
    expect(f.read("online_orders/9001/followUps")).toEqual({ "9001f0": true });
    // The parent stops holding; next tick the follow-up holds and gets its pick.
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    await tick(f, NEXT_DAY_11 + 60e3);
    expect(f.read("online_reservations/TEE/M/9001f0")).toMatchObject({ qty: 1, locs: { hub2: 1 } });
    expect(f.read("online_orders/9001f0/lines/0/source")).toMatchObject({ status: "pick", orderKeys: [C(0, 0, 1, 0, "9001f0")] });
    expect(f.read(`orders/${C(0, 0, 1, 0, "9001f0")}`)).toMatchObject({ channel: "online", hub: "hub2", onlineOrderId: "9001f0", status: "incoming" });
  });
});


describe("cancelled on Shopify after a partial pack", () => {
  it("the follow-up is cancelled, the parent's resolving line stops, holds and registry rows go", async () => {
    const waiting = { chain: "other", home: "marathon-pe", round: 1, idx: 1, phase: "wait", waitUntil: NEXT_DAY_11, deliverAt: "hub2", request: { kind: "refill", key: "k", from: "central", to: "hub2" }, attempts: [] };
    const f = fakeDb(world({
      lines: [tee({ source: { status: "resolving", locationId: "hub2" }, escalation: waiting }), snk(), tee({ lineId: "l2", source: { status: "resolving", locationId: "hub2" }, escalation: { ...waiting } })],
      order: { status: "packed", packedLines: { 1: true }, attention: null, attentionOpen: null, fulfilState: "done", pack: { saleId: "S1" } },
      over: { online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "wait" }, "9001_2": { orderId: "9001", lineIndex: 2, phase: "wait" } } },
    }));
    await tick(f, NEXT_DAY_11); // line 0 comes good → follow-up; line 2 too
    expect(f.read("online_orders/9001f0/status")).toBe("picking");
    const cancelled = { id: "gid://shopify/Order/9001", legacyResourceId: "9001", name: "#1801", number: 1801, cancelledAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z", displayFinancialStatus: "REFUNDED", displayFulfillmentStatus: "PARTIALLY_FULFILLED", lineItems: { nodes: [] } };
    const graphql = async (q) => (q.includes("orders(") ? { orders: { nodes: [cancelled], pageInfo: { hasNextPage: false } } } : { order: null });
    await runOrdersPoll(deps(f, NEXT_DAY_11 + 60e3, { graphql }).deps);
    expect(f.read("online_orders/9001").cancelledAfterPack).toBe(true);
    expect(f.read("online_orders/9001f0/status")).toBe("cancelled");
    expect(f.read("online_reservations/TEE/M/9001f0")).toBeNull();
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    expect(f.read("online_escalations")).toBeNull();
  });
});

describe("Sonnet-review guards", () => {
  it("a pack that landed without a line already back on a list: the line moves to a follow-up (never stranded)", async () => {
    const delivered = { chain: "other", home: "marathon-pe", round: 1, idx: 1, phase: "deliver", deliverAt: "hub2", delivered: true, checkProperly: false, attempts: [] };
    const f = fakeDb(world({
      lines: [tee({ routeGen: 1, source: { locationId: "hub2", status: "pick", entryKey: "orders/LEV-1r1", orderKeys: ["LEV-1r1"] }, escalation: delivered }), snk()],
      order: { status: "packed", packedLines: { 1: true }, attention: null, attentionOpen: null, fulfilState: "done", pack: { saleId: "S1" } },
      over: {
        online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "deliver" } },
        orders: { "LEV-1r1": { id: "LEV-1r1", channel: "online", onlineOrderId: "9001", onlineLineIndex: 0, hub: "hub2", status: "incoming" } },
      },
    }));
    await tick(f);
    expect(line(f, 0).source).toEqual({ status: "moved", movedTo: "9001f0" });
    expect(f.read("orders/LEV-1r1")).toBeNull(); // the parent's unsent hub order is withdrawn
    expect(f.read("online_orders/9001f0/lines/0/source")).toMatchObject({ locationId: "hub2", status: "pick" });
  });



  it("a multi-unit hub line with mixed answers is Junid's — never re-requested whole", async () => {
    const f = fakeDb(world({ lines: [snk({ qty: 2, source: { locationId: "hub1", status: "no_stock", entryKey: "orders/LEV-2-1", orderKeys: ["LEV-2-1", "LEV-2-2"] } })], order: { attention: { kind: "no_stock", reason: "x", at: NOW }, attentionOpen: true } }));
    await tick(f);
    expect(line(f, 0).escalation).toBeUndefined();
    expect(f.read("refill_requests")).toBeNull();
    expect(f.read("online_orders/9001/attentionOpen")).toBe(true);
  });
});


// ── THE SCAN IS THE ONLY REQUESTER (Junid, 1 Nov 2026) ──────────────────────
// The chain no longer raises: no Shop Refill card, no Central → hub row. A
// failed line waits; a chain under way is stopped and its open request is
// left exactly as it is (scripts/refill/scan-only-cancel.mjs decides it).
const awaitEsc = (request, over = {}) => ({
  chain: "other", home: "marathon-pe", round: 1, idx: 0, phase: "await", startedAt: NOW - 3600e3, gen: 0,
  attempts: [{ location: "marathon-pe", action: "routed", result: "not_found", at: NOW - 3600e3 }],
  request, ...over,
});

describe("the scan is the only requester (Junid, 1 Nov 2026)", () => {
  it("a shop Not found line raises nothing — no card, no refill row, no R-number — and waits on the attention list", async () => {
    const f = fakeDb(world());
    const n = f.writes.length;
    const d = deps(f);
    await runOrdersPoll(d.deps);
    expect(writesUnder(f, n, "orders/")).toEqual([]);
    expect(writesUnder(f, n, "refill_requests/")).toEqual([]);
    expect(writesUnder(f, n, "refillCounter")).toEqual([]);
    expect(line(f, 0).escalation).toBeUndefined();
    expect(line(f, 0).source.status).toBe("not_found");
    expect(f.read("online_orders/9001").attentionOpen).toBe(true);
  });

  it("a footwear hub Out of Stock line raises no Central → hub row", async () => {
    const f = fakeDb(world({ lines: [tee({ source: { locationId: "marathon-pe", status: "handed", entryKey: "x" } }), snk({ source: { locationId: "hub1", status: "no_stock", orderKeys: ["LEV-2"] } })] }));
    const n = f.writes.length;
    await tick(f);
    expect(writesUnder(f, n, "refill_requests/")).toEqual([]);
    expect(writesUnder(f, n, "orders/R")).toEqual([]);
    expect(line(f, 1).escalation).toBeUndefined();
  });

  it("a chain waiting on its Shop Refill card is stopped: the card is left as it is, the line waits not_found again, the registry row goes", async () => {
    const req = { kind: "store_order", key: "R001-1", from: "hub2", to: "marathon-pe", at: NOW - 3600e3 };
    const f = fakeDb(world({
      lines: [tee({ escalation: awaitEsc(req), source: { status: "resolving", locationId: "marathon-pe" } }), snk()],
      over: {
        orders: { "R001-1": { id: "R001-1", productId: "TEE", size: "M", qty: 1, customerName: "Shop Refill", hub: "hub2", destShop: "marathon-pe", status: "incoming", clothingRefillStatus: null, onlineEscalationKey: "web_9001_0_r1s0" } },
        online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "await" } },
      },
    }));
    await tick(f);
    expect(f.read("orders/R001-1")).toMatchObject({ status: "incoming", onlineEscalationKey: "web_9001_0_r1s0" });
    expect(line(f, 0).escalation ?? null).toBeNull();
    expect(line(f, 0).source).toEqual({ status: "not_found", locationId: "marathon-pe" });
    expect(line(f, 0).escalationStopped).toMatchObject({ why: "scan_only", phase: "await", request: { key: "R001-1" } });
    expect(f.read("online_escalations/9001_0")).toBeNull();
  });

  it("a chain waiting on a Central → Hub 2 refill row: the row is left open (never yanked from Central's queue); nothing new is raised", async () => {
    const req = { kind: "refill", key: "web_9001_0_r1s1", from: "central", to: "hub2", at: NOW - 3600e3 };
    const f = fakeDb(world({
      lines: [tee({ escalation: awaitEsc(req, { idx: 1 }), source: { status: "resolving", locationId: "hub2" } }), snk()],
      over: { refill_requests: { web_9001_0_r1s1: { productId: "TEE", size: "M", qty: 1, requestingLocation: "hub2", status: "open", createdFrom: { manual: true, source: "central", via: "online_escalation", orderKey: "9001", lineIndex: 0 } } } },
    }));
    const n = f.writes.length;
    await tick(f);
    expect(f.read("refill_requests/web_9001_0_r1s1")).toMatchObject({ status: "open", qty: 1 });
    expect(writesUnder(f, n, "refill_requests/")).toEqual([]);
    expect(line(f, 0).source.status).toBe("not_found");
  });

});
