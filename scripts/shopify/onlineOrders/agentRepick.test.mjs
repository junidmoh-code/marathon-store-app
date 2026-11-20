// ── The order agent's re-pick → poller → the line's route, KEEPING its item (Junid, 14 Nov 2026) ──
// Through the real poll tick against the fake RTDB (empty arrays and nulls dropped, cold-cache txn pass).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { repickBlocker, planRepick, REPICK } from "./agentRepick.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-14T09:30:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;

// #2085's shape: beanie + jeans handed at PE; line 2 swapped to a G-Star tee XXL, then a walk-in took the held unit.
const beanie = () => ({ lineId: "l0", shopifyLineItemId: LI(1), variantId: V(1), productGid: P(1), pid: "BEA", size: "_", sizeKey: "_", qty: 1, title: "Hugo Boss beanie", isFootwear: false, unitPriceCents: 18000, source: { status: "handed", locationId: "marathon-pe", entryKey: "displayChecks_active/marathon-pe/online__2085__0" } });
const tee = (over = {}) => ({
  lineId: "l2", shopifyLineItemId: LI(3), variantId: V(3), productGid: P(3), pid: "GST", size: "XXL", sizeKey: "XXL", qty: 1, title: "G star raw t shirt black", isFootwear: false, unitPriceCents: 35000, routeGen: 2,
  swappedFrom: { pid: "YOMO", size: "XL", at: NOW - 2 * 86400e3 }, resolution: { outcome: { kind: "swap", pid: "GST", size: "XXL", at: NOW - 2 * 86400e3 } },
  source: { status: "needs_attention", locationId: "marathon-pe", entryKey: "displayChecks_active/marathon-pe/online__2085__1_r2" },
  ...over,
});
const ask = (i, line, over = {}) => ({ lineIndex: i, expectPid: line.pid, expectSizeKey: line.sizeKey, expectStatus: line.source.status, expectRouteGen: line.routeGen || 0, exclude: [], by: "order-agent", at: NOW - 60e3, state: "pending", ...over });

function world({ lines = [beanie(), tee()], stock = {}, repicks = null, holds = {}, enabled = true } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 9 * 86400e3, cursorMs: NOW },
    config: { onlineOrders: { enabled, escalationOff: true } },
    products: { BEA: { name: "Hugo Boss beanie", category: "Clothing", sizes: ["_"] }, GST: { name: "G star raw t shirt black", category: "Clothing", sizes: ["XL", "XXL"] } },
    stock: { hub1: {}, hub2: {}, "marathon-pe": {}, trophy: {}, concrete: {}, central: {}, ...stock },
    online_reservations: holds,
    displayChecks_active: { "marathon-pe": { "online__2085__1_r2": { status: "open", kind: "online_pick" } } },
    online_orders: {
      2085: {
        orderNumber: 2085, shopifyGid: "gid://shopify/Order/2085", shopifyName: "#2085", status: "needs_attention",
        attention: { kind: "walkin_override", reason: "Walk-in sale took a unit held for #2085", at: NOW - 2 * 86400e3 }, attentionOpen: true,
        customer: { name: "Motlhabane P" }, lines,
        ...(repicks ? { agentRepicks: repicks } : {}),
      },
    },
  };
}
const deps = (f) => ({ db: f.db, graphql: null, nowMs: async () => NOW, send: async () => {}, increment, saDate: () => "2026-11-14", log: () => {} });
const tick = (f) => runOrdersPoll(deps(f));
const reqOf = (f, rid = "1_2") => f.read(`online_orders/2085/agentRepicks/${rid}`);
const line1 = (f) => f.read("online_orders/2085/lines/1");

describe("agent re-pick (#2085: a swapped line a walk-in took, stock back at PE)", () => {
  it("puts the line back on Marathon PE's strip with its SWAPPED item, new routeGen, old entry closed, attention cleared, order ready to pick", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { GST: { XXL: { qty: 1 } } } }, repicks: { "1_2": ask(1, tee()) } }));
    await tick(f);
    expect(reqOf(f)).toMatchObject({ state: REPICK.ORDERED, routedTo: "marathon-pe" });
    const l = line1(f);
    expect(l).toMatchObject({ pid: "GST", size: "XXL", routeGen: 3, swappedFrom: { pid: "YOMO" }, source: { status: "display", locationId: "marathon-pe" } });
    expect(l.source.entryKey).toMatch(/^displayChecks_active\/marathon-pe\//);
    expect(l.source.entryKey).not.toBe("displayChecks_active/marathon-pe/online__2085__1_r2");
    expect(l.repick).toMatchObject({ to: "marathon-pe", from: { status: "needs_attention", locationId: "marathon-pe" } });
    expect(f.read("displayChecks_active/marathon-pe/online__2085__1_r2")).toMatchObject({ status: "completed", result: "cancelled" });
    const o = f.read("online_orders/2085");
    expect(o.attention).toBeUndefined();
    expect(o.status).toBe("picking");
    // The hold follows the line, at its new place.
    expect(f.read("online_reservations/GST/XXL/2085")).toMatchObject({ locs: { "marathon-pe": 1 } });
    // Nothing touched outside the order, its strip and its hold: no request of any kind.
    expect(f.writes.filter(([, p]) => /^(refill_requests|stock\/)/.test(p))).toEqual([]);
  });

  it("an excluded place is skipped: the next place on the route with a free unit gets it", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { GST: { XXL: { qty: 1 } } }, concrete: { GST: { XXL: { qty: 2 } } } }, repicks: { "1_2": ask(1, tee(), { exclude: ["marathon-pe"] }) } }));
    await tick(f);
    expect(reqOf(f)).toMatchObject({ state: REPICK.ORDERED, routedTo: "concrete" });
    expect(line1(f).source).toMatchObject({ status: "display", locationId: "concrete" });
  });

  it("units other website orders hold are not free: nothing anywhere → not_in_stock, line untouched", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { GST: { XXL: { qty: 1 } } } }, holds: { GST: { XXL: { 9999: { qty: 1, locs: { "marathon-pe": 1 } } } } }, repicks: { "1_2": ask(1, tee()) } }));
    await tick(f);
    expect(reqOf(f).state).toBe(REPICK.NOT_IN_STOCK);
    expect(line1(f)).toMatchObject({ routeGen: 2, source: { status: "needs_attention" } });
  });

  it("a line that changed since the agent looked is refused, never moved", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { GST: { XXL: { qty: 1 } } } }, repicks: { "1_2": ask(1, tee(), { expectRouteGen: 1 }) } }));
    await tick(f);
    expect(reqOf(f)).toMatchObject({ state: REPICK.REFUSED });
    expect(reqOf(f).why).toMatch(/routed again/);
    expect(line1(f).source.status).toBe("needs_attention");
  });

  it("runs once: a second tick does not re-pick again", async () => {
    const f = fakeDb(world({ stock: { "marathon-pe": { GST: { XXL: { qty: 2 } } } }, repicks: { "1_2": ask(1, tee()) } }));
    await tick(f);
    const first = line1(f);
    await tick(f);
    expect(line1(f).routeGen).toBe(first.routeGen);
    expect(line1(f).source.entryKey).toBe(first.source.entryKey);
  });
});

describe("repickBlocker / planRepick (pure)", () => {
  const req = (line) => ask(1, line);
  it("refuses lines it must never move", () => {
    expect(repickBlocker({ line: tee(), req: req(tee()), enabled: false })).toMatch(/switched off/);
    expect(repickBlocker({ line: tee({ escalation: { phase: "await" } }), req: req(tee()), enabled: true })).toMatch(/escalation/);
    expect(repickBlocker({ line: tee({ awaitingCustomer: { since: 1 } }), req: req(tee()), enabled: true })).toMatch(/customer/);
    expect(repickBlocker({ line: tee({ resolution: { outcome: { kind: "refund" } } }), req: req(tee()), enabled: true })).toMatch(/settled/);
    expect(repickBlocker({ line: tee({ resolution: { money: { state: "done" } } }), req: req(tee()), enabled: true })).toMatch(/money/);
    const handed = tee({ source: { status: "handed", locationId: "marathon-pe" } });
    expect(repickBlocker({ line: handed, req: { ...req(tee()), expectStatus: null }, enabled: true })).toMatch(/not one a place failed/);
    expect(repickBlocker({ line: tee(), req: req(tee()), enabled: true, order: { basket: { 1: true } }, i: 1 })).toMatch(/basket/);
    expect(repickBlocker({ line: tee(), req: req(tee()), enabled: true })).toBeNull(); // a swap outcome is fine: the item is kept
  });
  it("one place for the whole line, never a split", () => {
    const two = tee({ qty: 2 });
    expect(planRepick({ line: two, available: { "marathon-pe": 1, trophy: 1 } }).pieces).toEqual([]);
    expect(planRepick({ line: two, available: { "marathon-pe": 1, trophy: 2 } }).pieces).toEqual([{ qty: 2, locationId: "trophy", status: "display" }]);
    expect(planRepick({ line: tee(), available: { "marathon-pe": 1, hub2: 1 }, exclude: ["marathon-pe"] }).pieces).toEqual([{ qty: 1, locationId: "hub2", status: "pick" }]);
  });
});

describe("a line the customer chose to wait for (#2133 line 18 shape)", () => {
  const waiting = () => tee({ swappedFrom: undefined, resolution: undefined, routeGen: 0, source: { status: "unavailable", locationId: "marathon-pe" } });
  const chose = { 1: { state: "chose", pid: "GST", size: "XXL", next: "send it when it arrives", customerSaid: { text: "I'll wait for the stock" } } };
  it("goes on a pick once a place has it, keeping its item", async () => {
    const w = world({ lines: [beanie(), waiting()], stock: { concrete: { GST: { XXL: { qty: 1 } } } }, repicks: { "1_0": ask(1, waiting(), { exclude: ["marathon-pe"] }) } });
    w.online_orders[2085].jimmyStatus = chose;
    const f = fakeDb(w);
    await tick(f);
    expect(reqOf(f, "1_0")).toMatchObject({ state: REPICK.ORDERED, routedTo: "concrete" });
    expect(line1(f).source).toMatchObject({ status: "display", locationId: "concrete" });
  });
  it("without the customer's wait on record an unavailable line is refused", async () => {
    const f = fakeDb(world({ lines: [beanie(), waiting()], stock: { concrete: { GST: { XXL: { qty: 1 } } } }, repicks: { "1_0": ask(1, waiting()) } }));
    await tick(f);
    expect(reqOf(f, "1_0").state).toBe(REPICK.REFUSED);
    expect(line1(f).source.status).toBe("unavailable");
  });
});

describe("Jamie's relocate of a line the packer marked Not available / Damaged (Junid, 20 Nov 2026)", () => {
  // The POS commit's shape (functions/lib/lineUnavailableLogic.js unavailableLine): source { status } only, the record on
  // line.unavailable, escalation phase "unavailable"; the dead unit was in the basket.
  const marked = (reason = "not_here", from = { status: "handed", locationId: "hub2", orderKeys: ["ABC"] }) => tee({
    swappedFrom: undefined, resolution: undefined, routeGen: 0, source: { status: "unavailable" },
    escalation: { phase: "unavailable", attempts: [{ location: "marathon-pe", action: "packing_check", result: reason === "damaged" ? "unavailable" : "not_found" }] },
    unavailable: { reason, rid: "r1", gen: 1, at: NOW - 300e3, fromSource: from },
  });
  const relocate = (line, over = {}) => ask(1, line, { by: "jamie-relocate", exclude: ["hub2"], ...over });
  it("goes on a pick at another place, basket tick and dead codes cleared, escalation closed, Not here's source remembered", async () => {
    const w = world({ lines: [beanie(), marked()], stock: { concrete: { GST: { XXL: { qty: 1 } } } }, repicks: { relocate_1_0: relocate(marked()) } });
    w.online_orders[2085].basket = { 1: true };
    w.online_orders[2085].codesIn = { ABC: true };
    const f = fakeDb(w);
    await tick(f);
    expect(reqOf(f, "relocate_1_0")).toMatchObject({ state: REPICK.ORDERED, routedTo: "concrete" });
    const l = line1(f);
    expect(l.source).toMatchObject({ status: "display", locationId: "concrete" });
    expect(l.escalation ?? null).toBeNull();
    expect(l.relocatedFrom).toMatchObject({ reason: "not_here", from: "hub2" });
    expect(l.failedPlaces).toHaveProperty("hub2");
    expect(f.read("online_orders/2085/basket/1") ?? null).toBeNull();
    expect(f.read("online_orders/2085/codesIn/ABC") ?? null).toBeNull();
  });
  it("the same line asked by the order agent (not Jamie's relocate) is still refused", async () => {
    const f = fakeDb(world({ lines: [beanie(), marked()], stock: { concrete: { GST: { XXL: { qty: 1 } } } }, repicks: { "1_0": ask(1, marked()) } }));
    await tick(f);
    expect(reqOf(f, "1_0").state).toBe(REPICK.REFUSED);
    expect(line1(f).source.status).toBe("unavailable");
  });
  it("never once the customer is being asked, never over money; nothing free elsewhere → not_in_stock", async () => {
    const asked = marked();
    asked.awaitingCustomer = { since: NOW, by: "jamie" };
    const f1 = fakeDb(world({ lines: [beanie(), asked], stock: { concrete: { GST: { XXL: { qty: 1 } } } }, repicks: { relocate_1_0: relocate(asked) } }));
    await tick(f1);
    expect(reqOf(f1, "relocate_1_0").state).toBe(REPICK.REFUSED);
    const f2 = fakeDb(world({ lines: [beanie(), marked()], stock: { hub2: { GST: { XXL: { qty: 2 } } } }, repicks: { relocate_1_0: relocate(marked()) } }));
    await tick(f2);
    expect(reqOf(f2, "relocate_1_0").state).toBe(REPICK.NOT_IN_STOCK);
    expect(line1(f2).source.status).toBe("unavailable");
  });
  it("pure: relocate passes the unavailable status and the closed escalation only for Jamie's request", () => {
    const l = marked("damaged");
    expect(repickBlocker({ line: l, req: relocate(l), enabled: true, order: { basket: { 1: true } }, i: 1 })).toBeNull();
    expect(repickBlocker({ line: l, req: ask(1, l), enabled: true, order: {}, i: 1 })).toMatch(/not one a place failed/);
    const live = { ...l, escalation: { phase: "await" } };
    expect(repickBlocker({ line: live, req: relocate(live), enabled: true, order: {}, i: 1 })).toMatch(/escalation/);
  });
});
