import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
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
  it("raises a Shop Refill card at Hub 2 carrying the order ref, holds at the shop, and takes over the attention (no email)", async () => {
    const f = fakeDb(world());
    const d = deps(f);
    await runOrdersPoll(d.deps);
    expect(f.read("orders/R001-1")).toMatchObject({
      productId: "TEE", size: "M", qty: 1, customerName: "Shop Refill", hub: "hub2", placedAtHub: "hub2",
      destShop: "marathon-pe", productType: "clothing", status: "incoming", onlineRef: "LEV",
      onlineEscalationKey: "web_9001_0_r1s0",
    });
    expect(f.read("refillCounter")).toMatchObject({ counter: 1 });
    expect(line(f, 0).source).toEqual({ status: "resolving", locationId: "marathon-pe" });
    expect(line(f, 0).escalation).toMatchObject({ chain: "other", home: "marathon-pe", round: 1, idx: 0, phase: "await", request: { kind: "store_order", key: "R001-1", from: "hub2", to: "marathon-pe" } });
    const o = f.read("online_orders/9001");
    expect(o.attention).toBeUndefined();
    expect(o.attentionOpen).toBeUndefined();
    expect(d.mails).toEqual([]);
    expect(f.read("online_reservations/TEE/M/9001")).toMatchObject({ qty: 1, locs: { "marathon-pe": 1 } });
    expect(f.read("online_escalations/9001_0")).toMatchObject({ ref: "LEV", phase: "await", where: "round 1: Hub 2 → Marathon PE requested" });
  });

  it("a second tick raises nothing new (restart / re-run safety)", async () => {
    const f = fakeDb(world());
    await tick(f);
    const n = f.writes.length;
    await tick(f);
    expect(writesUnder(f, n, "orders/")).toEqual([]);
    expect(writesUnder(f, n, "refill_requests/")).toEqual([]);
    expect(writesUnder(f, n, "refillCounter")).toEqual([]);
  });

  it("Hub 2 rejects → a Central → Hub 2 refill row, released at once, carrying the ref", async () => {
    const f = fakeDb(world());
    await tick(f);
    await f.db.ref("orders/R001-1/clothingRefillStatus").set("rejected");
    await tick(f);
    expect(f.read("refill_requests/web_9001_0_r1s1")).toMatchObject({
      productId: "TEE", size: "M", qty: 1, requestingLocation: "hub2", status: "open",
      createdFrom: { manual: true, source: "central", via: "online_escalation", ref: "LEV", orderKey: "9001", lineIndex: 0 },
      earlyRelease: { by: "online-escalation", reason: "Website order LEV" },
      onlineRef: "LEV",
    });
    expect(line(f, 0).source).toEqual({ status: "resolving", locationId: "hub2" });
    expect(f.read("online_reservations/TEE/M/9001").locs).toEqual({ hub2: 1 });
  });

  it("Central sends → nothing until 11:00 SAST next day → a Hub 2 pick → handed ends it", async () => {
    const f = fakeDb(world());
    await tick(f);
    await f.db.ref("orders/R001-1/clothingRefillStatus").set("rejected");
    await tick(f);
    await f.db.ref("refill_requests/web_9001_0_r1s1").update({ status: "fulfilled", resolvedAt: new Date(NOW + 3600e3).toISOString() });
    await tick(f, NOW + 2 * 3600e3);
    expect(line(f, 0).escalation).toMatchObject({ phase: "wait", waitUntil: NEXT_DAY_11, deliverAt: "hub2" });
    await tick(f, NEXT_DAY_11 - 60e3);
    expect(line(f, 0).escalation.phase).toBe("wait");
    expect(f.read("online_picks")).toBeNull();
    await tick(f, NEXT_DAY_11);
    // Back on Hub 2's Warehouse queue as an ordinary hub order (#777's route).
    expect(line(f, 0).source).toMatchObject({ locationId: "hub2", status: "pick", entryKey: "orders/LEV-1r1", orderKeys: ["LEV-1r1"] });
    expect(f.read("orders/LEV-1r1")).toMatchObject({ customerName: "Shopify", channel: "online", hub: "hub2", productId: "TEE", status: "incoming", onlineOrderId: "9001", onlineLineIndex: 0 });
    expect(f.read("orders/LEV-1r1").checkProperly).toBeUndefined();
    // Hub 2 marks it sent (the existing Mark as Sent) → handed → escalation done.
    await f.db.ref("orders/LEV-1r1/status").set("ready");
    await tick(f, NEXT_DAY_11 + 60e3);
    expect(line(f, 0).escalation.phase).toBe("done");
    expect(f.read("online_escalations/9001_0")).toBeNull();
    expect(f.read("online_orders/9001/status")).toBe("ready");
  });

  it("both rounds rejected → unavailable; round 2 re-raises the shop entry with CHECK PROPERLY", async () => {
    const f = fakeDb(world());
    let t = NOW;
    await tick(f, t);
    await f.db.ref("orders/R001-1/clothingRefillStatus").set("rejected");
    await tick(f, (t += 60e3));
    await f.db.ref("refill_requests/web_9001_0_r1s1").update({ status: "cancelled", resolvedAt: "x" });
    await tick(f, (t += 60e3));
    // Round 2: the shop looks again — a fresh display entry, CHECK PROPERLY.
    expect(line(f, 0).source).toMatchObject({ locationId: "marathon-pe", status: "display", checkProperly: true, entryKey: "displayChecks_active/marathon-pe/online__9001__0_r1" });
    expect(f.read("displayChecks_active/marathon-pe/online__9001__0_r1")).toMatchObject({ kind: "online_pick", ref: "LEV", checkProperly: true, status: "open" });
    // Not found again (completeDisplayCheck's write).
    await f.db.ref("online_orders/9001/lines/0/source/status").set("not_found");
    await tick(f, (t += 60e3));
    const card2 = line(f, 0).escalation.request.key;
    expect(card2).toBe("R002-1");
    expect(f.read(`orders/${card2}`)).toMatchObject({ onlineRef: "LEV", onlineEscalationKey: "web_9001_0_r2s1" });
    await f.db.ref(`orders/${card2}/clothingRefillStatus`).set("rejected");
    await tick(f, (t += 60e3));
    expect(f.read("refill_requests/web_9001_0_r2s2")).toMatchObject({ requestingLocation: "hub2" });
    await f.db.ref("refill_requests/web_9001_0_r2s2/status").set("cancelled");
    await tick(f, (t += 60e3));
    expect(line(f, 0).source).toEqual({ status: "unavailable" });
    expect(line(f, 0).escalation.phase).toBe("unavailable");
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    expect(f.read("online_escalations/9001_0")).toMatchObject({ phase: "unavailable", where: "Unavailable" });
    // The handed sneaker still makes the order packable.
    expect(f.read("online_orders/9001/status")).toBe("ready");
    const attempts = Object.values(line(f, 0).escalation.attempts).map((a) => `${a.action}=${a.result}`);
    expect(attempts).toEqual([
      "routed=not_found",
      "store_order:hub2->marathon-pe=raised", "store_order:hub2->marathon-pe=rejected",
      "refill:central->hub2=raised", "refill:central->hub2=rejected",
      "recheck=raised", "recheck=on_path", "recheck=not_found",
      "store_order:hub2->marathon-pe=raised", "store_order:hub2->marathon-pe=rejected",
      "refill:central->hub2=raised", "refill:central->hub2=rejected",
    ]);
  });
});

describe("footwear: the hub marks its order Out of Stock → Central", () => {
  it("raises Central → that hub; Central rejects → the hub checks properly → Out of Stock again → unavailable", async () => {
    const lines = [tee({ source: { locationId: "marathon-pe", status: "handed" } }), snk({ source: { locationId: "hub1", status: "no_stock", reason: "hub1 marked it out of stock", entryKey: "orders/LEV-2", orderKeys: ["LEV-2"] } })];
    const f = fakeDb(world({ lines, order: { attention: { kind: "no_stock", reason: "x", at: NOW }, attentionOpen: true, status: "needs_attention" } }));
    const d = deps(f);
    await runOrdersPoll(d.deps);
    expect(d.mails).toEqual([]);
    expect(f.read("refill_requests/web_9001_1_r1s0")).toMatchObject({ productId: "SNK", size: "8", requestingLocation: "hub1", createdFrom: { via: "online_escalation" } });
    expect(f.read("online_reservations/SNK/8/9001").locs).toEqual({ hub1: 1 });
    await f.db.ref("refill_requests/web_9001_1_r1s0/status").set("cancelled");
    await tick(f, NOW + 60e3);
    expect(line(f, 1).source).toMatchObject({ locationId: "hub1", status: "pick", checkProperly: true, orderKeys: ["LEV-2r1"] });
    expect(f.read("orders/LEV-2r1")).toMatchObject({ channel: "online", hub: "hub1", checkProperly: true, status: "incoming" });
    await f.db.ref("orders/LEV-2r1/status").set("out_of_stock");
    await tick(f, NOW + 120e3);
    expect(line(f, 1).source).toEqual({ status: "unavailable" });
    expect(f.read("online_escalations/9001_1")).toMatchObject({ phase: "unavailable" });
  });
});

describe("crash recovery", () => {
  it("a card write that fails leaves the intent; the next tick writes exactly one card under the SAME number", async () => {
    const broken = fakeDb(world(), { failWritesUnder: "orders/" });
    await tick(broken);
    expect(line(broken, 0).escalation).toMatchObject({ phase: "raise", pending: { kind: "store_order", key: "R001-1", escKey: "web_9001_0_r1s0" } });
    const f = fakeDb(broken.root);
    await tick(f);
    expect(f.read("orders/R001-1")).toMatchObject({ onlineEscalationKey: "web_9001_0_r1s0" });
    expect(f.read("refillCounter/counter")).toBe(1); // never drawn twice
    expect(line(f, 0).escalation).toMatchObject({ phase: "await", request: { key: "R001-1" } });
    expect(line(f, 0).escalation.pending).toBeUndefined();
  });

  it("a crash after the card landed but before the commit: the re-run commits, writes no second card", async () => {
    const f = fakeDb(world());
    await tick(f);
    // Rewind the line to "intent recorded, not committed" — the card stays.
    const esc = line(f, 0).escalation;
    await f.db.ref("online_orders/9001/lines/0/escalation").set({ ...esc, phase: "raise", request: null, pending: { kind: "store_order", from: "hub2", to: "marathon-pe", key: "R001-1", escKey: "web_9001_0_r1s0", at: NOW }, attempts: [esc.attempts[0]] });
    const n = f.writes.length;
    await tick(f);
    expect(writesUnder(f, n, "orders/")).toEqual([]);
    expect(writesUnder(f, n, "refillCounter")).toEqual([]);
    expect(line(f, 0).escalation).toMatchObject({ phase: "await", request: { key: "R001-1" } });
  });

  it("a recycled R-number held by someone else's card is redrawn, never overwritten", async () => {
    const f = fakeDb(world({ over: { orders: { "R001-1": { id: "R001-1", customerName: "Shop Refill", productId: "OTHER" } } } }));
    await tick(f);
    expect(f.read("orders/R001-1/productId")).toBe("OTHER");
    expect(line(f, 0).escalation.pending).toBeUndefined();
    await tick(f, NOW + 60e3);
    expect(f.read("orders/R002-1")).toMatchObject({ productId: "TEE", onlineRef: "LEV" });
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
    expect(fu).toMatchObject({ ref: "LEV-F1", followUpOf: "9001", shopifyGid: "gid://shopify/Order/9001", status: "new" });
    expect(fu.lines[0]).toMatchObject({ pid: "TEE", shopifyLineItemId: LI(2), source: { locationId: "hub2", status: "pick" } });
    expect(f.read("online_orders/9001/followUps")).toEqual({ "9001f0": true });
    // The parent stops holding; next tick the follow-up holds and gets its pick.
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    await tick(f, NEXT_DAY_11 + 60e3);
    expect(f.read("online_reservations/TEE/M/9001f0")).toMatchObject({ qty: 1, locs: { hub2: 1 } });
    expect(f.read("online_orders/9001f0/lines/0/source")).toMatchObject({ status: "pick", orderKeys: ["LEV-F1-1r1"] });
    expect(f.read("orders/LEV-F1-1r1")).toMatchObject({ channel: "online", hub: "hub2", onlineOrderId: "9001f0", status: "incoming" });
  });
});

