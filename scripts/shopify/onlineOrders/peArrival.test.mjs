// ── Stock that lands at Marathon PE for a waiting line (Junid, 25 Oct 16:37) ──
// Through the real poll tick against the fake RTDB.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { peWaiting, peWatchStep, arrivedLine } from "./peArrival.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-25T14:40:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;
const REFILL = "web_9001_0_r1s0";
const OURS = { via: "online_escalation", orderKey: "9001", lineIndex: 0, ref: "#1780", manual: true, source: "central" };

// #1780's shape: Lacoste Slip-On size 6, Hub 1 had none, Central asked for a refill to Hub 1.
const slip = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: LI(1), variantId: V(1006), productGid: P(111), pid: "LAC", size: "6", sizeKey: "6", qty: 1,
  title: "Lacoste Slip-On White Stripe", isFootwear: true, unitPriceCents: 55000, category: "Footwear",
  source: { status: "resolving", locationId: "hub1" },
  escalation: { chain: "footwear", home: "hub1", round: 1, idx: 0, phase: "await", gen: 0, startedAt: NOW - 2 * 86400e3, request: { kind: "refill", key: REFILL, from: "central", to: "hub1", at: NOW - 2 * 86400e3 }, staleMailedAt: NOW - 86400e3, attempts: [{ location: "hub1", action: "routed", result: "no_stock", at: NOW - 2 * 86400e3 }] },
  ...over,
});
// Line 1 like #1780's: a Hub 2 pair, sent, and confirmed at the till.
const kapri = (over = {}) => ({
  lineId: "l1", shopifyLineItemId: LI(2), variantId: V(2006), productGid: P(222), pid: "KAP", size: "6", sizeKey: "6", qty: 1,
  title: "Karl Lagerfeld Kapri White", isFootwear: true, unitPriceCents: 120000, category: "Footwear",
  source: { status: "handed", locationId: "hub2", entryKey: "orders/RKY", orderKeys: ["RKY"], handedBy: "hub" },
  ...over,
});

function world({ lines = [slip(), kapri()], pe = 0, refill = { status: "open" }, enabled = true, escalationOff = false, holds = null, over = {} } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 5 * 86400e3, cursorMs: NOW },
    config: { onlineOrders: { enabled, ...(escalationOff ? { escalationOff: true } : {}) } },
    products: { LAC: { name: "Lacoste Slip-On", categoryKey: "sneakers", category: "Footwear", sizes: ["6", "7"] }, KAP: { name: "Kapri", categoryKey: "sneakers", category: "Footwear", sizes: ["6"] } },
    shopify_sync: { _claims: { 111: "LAC", 222: "KAP" }, LAC: { variants: { 6: { shopifyVariantId: V(1006) } } }, KAP: { variants: { 6: { shopifyVariantId: V(2006) } } } },
    stock: { hub1: {}, hub2: {}, trophy: {}, central: {}, "marathon-pe": pe ? { LAC: { 6: { qty: pe } } } : {} },
    refill_requests: refill ? { [REFILL]: { productId: "LAC", size: "6", qty: 1, requestingLocation: "hub1", createdFrom: OURS, ...refill } } : {},
    online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "await" } },
    orders: { RKY: { channel: "online", onlineOrderId: "9001", onlineLineIndex: 1, onlineUnit: 0, hub: "hub2", status: "ready" } },
    ...(holds ? { online_reservations: holds } : {}),
    online_orders: {
      9001: {
        orderNumber: 1780, shopifyGid: "gid://shopify/Order/9001", shopifyName: "#1780", status: "ready",
        customer: { name: "Nicholas G" }, lines, codesIn: { RKY: true },
      },
    },
    ...over,
  };
}
const wa = [];
const mails = [];
const deps = (f, at) => ({ db: f.db, graphql: null, nowMs: async () => at, send: async (m) => { mails.push(m); }, whatsappJunid: async (m) => { wa.push(m); }, increment, saDate: () => "2026-10-25", log: () => {} });
const tick = (f, at = NOW) => runOrdersPoll(deps(f, at));
const line0 = (f) => f.read("online_orders/9001/lines/0");
// Stock moves between ticks (a manual transfer, a sale): set the cell directly.
const setPe = async (f, qty) => f.db.ref("stock/marathon-pe/LAC/6/qty").set(qty);

beforeEach(() => { wa.length = 0; mails.length = 0; });

describe("Marathon PE watch: stock that lands for a waiting line", () => {
  it("#1780: the shoe lands at Marathon PE by manual transfer — line here, ready to pack, Central's request withdrawn, nothing deducted", async () => {
    const f = fakeDb(world());
    await tick(f);
    // First look: PE has none; the low-water mark is 0 and nothing else moves.
    expect(line0(f)).toMatchObject({ source: { status: "resolving" }, escalation: { phase: "await" }, peWatch: { key: "LAC/6", low: 0 } });
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    const ln = line0(f);
    expect(ln.source).toEqual({ locationId: "marathon-pe", status: "handed", handedAt: NOW + 120e3, handedBy: "pe_stock" });
    expect(ln.escalation).toMatchObject({ phase: "done", doneAt: NOW + 120e3, arrivedAtPe: NOW + 120e3 });
    expect(ln.escalation.request).toBeUndefined();
    expect(ln.escalation.attempts.at(-1)).toMatchObject({ location: "marathon-pe", action: "arrived", result: "handed", key: REFILL });
    expect(ln.escalationGen).toBe(1);
    expect(ln.peWatch).toBeUndefined();
    expect(Object.values(ln.resolution.log)).toEqual([expect.objectContaining({ action: "arrived_at_pe", via: "pe_watch" })]);
    // ONLY this order's piece of the request: withdrawn 1 → 0, logged on the order.
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "cancelled", cancelReason: "no_longer_needed", onlineReleased: { before: 1, after: 0 } });
    expect(Object.values(f.read("online_orders/9001/requestChanges"))).toEqual([expect.objectContaining({ key: REFILL, action: "cancel", before: 1, after: 0 })]);
    expect(f.read("online_escalations/9001_0")).toBeNull();
    // The hold moves to Marathon PE (the walk-in guard protects it); stock is untouched: only the Pack deducts.
    expect(f.read("online_reservations/LAC/6/9001")).toMatchObject({ qty: 1, locs: { "marathon-pe": 1 } });
    expect(f.read("stock/marathon-pe/LAC/6/qty")).toBe(1);
    expect(f.read("online_orders/9001/status")).toBe("ready");
    expect(wa).toEqual([]);
    // No pick: no display entry and no hub order for the line.
    expect(f.read("displayChecks_active")).toBeNull();
    expect(Object.keys(f.read("orders"))).toEqual(["RKY"]);
  });

  it("a second tick does nothing more (no re-raise, no stale email, no second release)", async () => {
    const f = fakeDb(world());
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    const after = JSON.stringify(f.read("online_orders/9001"));
    const refill = JSON.stringify(f.read(`refill_requests/${REFILL}`));
    await tick(f, NOW + 2 * 86400e3);
    expect(JSON.stringify(f.read("online_orders/9001"))).toBe(after);
    expect(JSON.stringify(f.read(`refill_requests/${REFILL}`))).toBe(refill);
    expect(Object.keys(f.read("refill_requests"))).toEqual([REFILL]);
    expect(mails).toEqual([]);
  });

  it("stock that was ALREADY at Marathon PE when the watch began is not an arrival", async () => {
    const f = fakeDb(world({ pe: 1 }));
    await tick(f);
    await tick(f, NOW + 120e3);
    expect(line0(f)).toMatchObject({ source: { status: "resolving", locationId: "hub1" }, peWatch: { low: 1 } });
    expect(f.read(`refill_requests/${REFILL}`).status).toBe("open");
    // …but one that lands on top of it is.
    await setPe(f, 2);
    await tick(f, NOW + 240e3);
    expect(line0(f).source).toMatchObject({ status: "handed", locationId: "marathon-pe" });
  });

  it("a sale lowers the mark; a unit landing after it counts", async () => {
    const f = fakeDb(world({ pe: 1 }));
    await tick(f);
    await setPe(f, 0);
    await tick(f, NOW + 60e3);
    expect(line0(f).peWatch.low).toBe(0);
    expect(line0(f).source.status).toBe("resolving");
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).source).toMatchObject({ status: "handed", locationId: "marathon-pe" });
  });

  it("a unit another website order holds at Marathon PE is not this line's", async () => {
    const f = fakeDb(world({ holds: { LAC: { 6: { 8888: { qty: 1, ref: "#1790", locs: { "marathon-pe": 1 } } } } } }));
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).source.status).toBe("resolving");
    expect(f.read(`refill_requests/${REFILL}`).status).toBe("open");
  });

  it("a request Central is already picking is left to Central: the line is not touched", async () => {
    const f = fakeDb(world({ refill: { status: "open", picking: { by: "MC" } } }));
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f)).toMatchObject({ source: { status: "resolving" }, escalation: { phase: "await" } });
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", picking: { by: "MC" } });
  });

  it("a genuine refill (no website-order tag) is never changed: the line waits and Junid is told once", async () => {
    const f = fakeDb(world({ refill: { status: "open", qty: 3, createdFrom: { manual: false, source: "scan" } } }));
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    await tick(f, NOW + 240e3);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", qty: 3 });
    expect(line0(f).source.status).toBe("resolving");
    expect(wa.length).toBe(1);
    expect(wa[0]).toMatch(/#1780, line 1 .*NOT marked ready/);
  });

  it("a no_stock line (no escalation: the chain is switched off) is marked here and its attention cleared", async () => {
    const ns = slip({ escalation: undefined, source: { status: "no_stock", locationId: null } });
    const f = fakeDb(world({ lines: [ns, kapri()], refill: null, escalationOff: true, over: { online_escalations: {} } }));
    await f.db.ref("online_orders/9001").update({ status: "needs_attention", attention: { kind: "no_stock", reason: "x", at: NOW - 1 }, attentionOpen: true });
    await tick(f);
    expect(line0(f).source.status).toBe("no_stock");
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).source).toMatchObject({ status: "handed", locationId: "marathon-pe", handedBy: "pe_stock" });
    expect(line0(f).escalation).toBeUndefined();
    expect(f.read("online_orders/9001/attention")).toBeNull();
    expect(f.read("online_orders/9001/status")).toBe("ready");
  });

  it("the chain's own delivery keeps its next-morning rule: a FULFILLED request or a line in wait is never marked by the watch", async () => {
    const f = fakeDb(world({ refill: { status: "fulfilled", resolvedAt: new Date(NOW).toISOString() } }));
    await tick(f);
    expect(line0(f).escalation.phase).toBe("wait");
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f)).toMatchObject({ source: { status: "resolving" }, escalation: { phase: "wait" } });
  });

  it("half an arrival is not an arrival: qty 2 with one unit landed waits", async () => {
    const f = fakeDb(world({ lines: [slip({ qty: 2 }), kapri()], refill: { status: "open", qty: 2 } }));
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).source.status).toBe("resolving");
    await setPe(f, 2);
    await tick(f, NOW + 240e3);
    expect(line0(f).source).toMatchObject({ status: "handed", locationId: "marathon-pe" });
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "cancelled", onlineReleased: { before: 2, after: 0 } });
  });

  it("feeds switched off: nothing is watched", async () => {
    const f = fakeDb(world({ enabled: false }));
    await tick(f);
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).peWatch).toBeUndefined();
    expect(line0(f).source.status).toBe("resolving");
  });

  it("an order being packed is left alone", async () => {
    const f = fakeDb(world());
    await tick(f);
    await f.db.ref("online_orders/9001/packClaim").set({ by: "Yasmin", at: NOW });
    await setPe(f, 1);
    await tick(f, NOW + 120e3);
    expect(line0(f).source.status).toBe("resolving");
  });
});

describe("Marathon PE watch: the pure parts", () => {
  it("peWaiting: only lines waiting on stock", () => {
    expect(peWaiting(slip())).toBe(true);
    expect(peWaiting(slip({ escalation: { ...slip().escalation, phase: "raise", request: null } }))).toBe(true);
    expect(peWaiting(slip({ escalation: { ...slip().escalation, phase: "raise", pending: { kind: "refill" } } }))).toBe(false);
    expect(peWaiting(slip({ escalation: { ...slip().escalation, phase: "wait" } }))).toBe(false);
    expect(peWaiting(slip({ escalation: { ...slip().escalation, phase: "deliver" } }))).toBe(false);
    expect(peWaiting(slip({ escalation: undefined, source: { status: "no_stock" } }))).toBe(true);
    expect(peWaiting(slip({ source: { status: "not_found", locationId: "marathon-pe" }, escalation: undefined }))).toBe(false);
    expect(peWaiting(slip({ source: { status: "unavailable" } }))).toBe(false);
    expect(peWaiting(slip({ awaitingCustomer: { since: NOW } }))).toBe(false);
    expect(peWaiting(slip({ escalationOverride: { kind: "resolved" } }))).toBe(false);
    expect(peWaiting(slip({ escalation: undefined, qty: 2, source: { status: "no_stock", orderKeys: ["AAA", "BBB"] } }))).toBe(false);
    expect(peWaiting(kapri())).toBe(false);
  });

  it("peWatchStep: baseline, lower, arrived, none — and a mark for another product is ignored", () => {
    expect(peWatchStep(slip(), 0, 1)).toEqual({ action: "baseline", watch: { key: "LAC/6", low: 0, since: 1 } });
    const w = slip({ peWatch: { key: "LAC/6", low: 1, since: 1 } });
    expect(peWatchStep(w, 1, 2)).toEqual({ action: "none" });
    expect(peWatchStep(w, 0, 2)).toEqual({ action: "lower", watch: { key: "LAC/6", low: 0, since: 1 } });
    expect(peWatchStep(w, 2, 2)).toEqual({ action: "arrived", landed: 1 });
    expect(peWatchStep(slip({ peWatch: { key: "OLD/7", low: 0 } }), 3, 2).action).toBe("baseline");
  });

  it("arrivedLine: handed at Marathon PE, escalation done, everything else kept", () => {
    const out = arrivedLine(slip({ peWatch: { key: "LAC/6", low: 0 } }), { nowMs: 5, landed: 1 });
    expect(out.source).toEqual({ locationId: "marathon-pe", status: "handed", handedAt: 5, handedBy: "pe_stock" });
    expect(out.escalation).toMatchObject({ phase: "done", doneAt: 5, chain: "footwear", round: 1 });
    expect(out.peWatch).toBeUndefined();
    expect(out).toMatchObject({ pid: "LAC", qty: 1, unitPriceCents: 55000, escalationGen: 1 });
  });
});
