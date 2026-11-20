import { describe, it, expect } from "vitest";
import { planUnitSplit, migrateOrderUnits, describePlan, splitCentsFields } from "./unitSplit.mjs";
import { packedLineItems } from "./partialFulfil.mjs";
import { holdRowsFor } from "./orderModel.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";

const LI = "gid://shopify/LineItem/";
const tee = (over = {}) => ({ lineId: "l0", pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Tee", unitPriceCents: 25000, shopifyLineItemId: `${LI}1`, source: { status: "display", locationId: "marathon-pe", entryKey: "displayChecks_active/marathon-pe/online__9__0" }, ...over });
// #2239's shape: a swapped ×2 sneaker line handed by Hub 1 on two hub orders, money on the line.
const sneaker = () => ({
  lineId: "l1", pid: "SNK", size: "10", sizeKey: "10", qty: 2, title: "Lacoste", unitPriceCents: 50000, shopifyLineItemId: `${LI}2`, isFootwear: true,
  routeGen: 1, escalationGen: 1,
  ledger: { paidCents: 95000, nowCents: 100000, extraCents: 5000, creditCents: 0, settledCents: 0, swaps: 1, priceDecision: "allow_higher" },
  resolution: { log: { swap_r1: { action: "swapped", at: 1 } }, outcome: { kind: "swap", extraCents: 10000, creditCents: 0 }, moneyIn: { m1: { amountCents: 5001, ref: "341872327", state: "done" } } },
  swappedFrom: { pid: "OLD", qty: 2, hubOrders: ["GFZ", "VQM"], unitPriceCents: 45000 },
  source: { status: "handed", locationId: "hub1", entryKey: "orders/AYT", orderKeys: ["AYT", "ZCQ"], handedBy: "hub" },
});
const order = (lines, over = {}) => ({ orderNumber: 2239, shopifyName: "#2239", status: "ready", lines, ...over });

describe("planUnitSplit", () => {
  it("keeps line i as unit 1 and APPENDS the other units — no line moves index", () => {
    const o = order([tee(), sneaker(), tee({ lineId: "l2", shopifyLineItemId: `${LI}3` })], { jimmyStatus: { 1: { line: 1, state: "swapped" } }, basket: [true, true, true] });
    const p = planUnitSplit(o, { nowMs: 7 });
    expect(p.status).toBe("split");
    const L = p.next.lines;
    expect(L.map((l) => [l.lineId, l.qty, l.unit, l.units, l.splitFrom])).toEqual([
      ["l0", 1, undefined, undefined, undefined],
      ["l1", 1, 1, 2, undefined],
      ["l2", 1, undefined, undefined, undefined],
      ["l1u2", 1, 2, 2, 1],
    ]);
    // Each unit its own hub order; the unit-2 record is re-pointed at line 3.
    expect(L[1].source).toMatchObject({ orderKeys: ["AYT"], entryKey: "orders/AYT", status: "handed" });
    expect(L[3].source).toMatchObject({ orderKeys: ["ZCQ"], entryKey: "orders/ZCQ", status: "handed", locationId: "hub1" });
    expect(p.hubRepoints).toEqual([{ key: "ZCQ", from: 1, index: 3, unit: 1 }]);
    // Money shared over the units, summing back to the line.
    expect([L[1].ledger.paidCents, L[3].ledger.paidCents]).toEqual([47500, 47500]);
    expect([L[1].resolution.outcome.extraCents, L[3].resolution.outcome.extraCents]).toEqual([5000, 5000]);
    expect([L[1].resolution.moneyIn.m1.amountCents, L[3].resolution.moneyIn.m1.amountCents]).toEqual([2501, 2500]);
    expect(L[3].resolution.moneyIn.m1).toMatchObject({ ref: "341872327", splitOfCents: 5001 });
    expect(L[3].ledger.priceDecision).toBe("allow_higher");
    expect(L[1].unitPriceCents + L[3].unitPriceCents).toBe(100000);
    expect([L[1].swappedFrom, L[3].swappedFrom].map((s) => [s.qty, s.hubOrders])).toEqual([[1, ["GFZ"]], [1, ["VQM"]]]);
    // Per-line order maps follow the unit to its new index.
    expect(p.next.jimmyStatus[3]).toEqual({ line: 3, state: "swapped" });
    expect(p.next.basket).toEqual([true, true, true, true]);
    expect(p.next.unitSplit).toEqual({ v: 1, at: 7, linesBefore: 3, appended: [{ from: 1, index: 3, unit: 2, units: 2 }] });
    expect(describePlan("9", o, p).join("\n")).toMatch(/orders\/ZCQ: onlineLineIndex 1 → 3/);
  });

  it("holds and the Shopify fulfil quantity are the same before and after", () => {
    const before = order([tee({ qty: 3, source: { status: "display", locationId: "marathon-pe" } }), sneaker()], { status: "picking" });
    const after = planUnitSplit(before).next;
    expect(holdRowsFor(after)).toEqual(holdRowsFor(before));
    // A partial pack of everything but the original line 0 unit 1: Shopify gets 2 of line item 1, 2 of line item 2.
    const packed = { 0: false, 1: true, 2: true, 3: true, 4: true };
    expect(packedLineItems({ ...after, packedLines: packed })).toEqual({ [`${LI}1`]: 2, [`${LI}2`]: 2 });
    // A unit left out reduces its Shopify line item by one.
    expect(packedLineItems({ ...after, packedLines: { 0: true, 1: true, 2: true, 3: false, 4: true } })).toEqual({ [`${LI}1`]: 2, [`${LI}2`]: 2 });
    expect(packedLineItems({ ...after, packedLines: { 0: true, 1: true, 2: true, 3: true, 4: false } })).toEqual({ [`${LI}1`]: 3, [`${LI}2`]: 1 });
  });

  it("an open strip entry stays with unit 1 (set to qty 1); the other units get none yet — the poller makes theirs", () => {
    const p = planUnitSplit(order([tee({ qty: 2 })], { status: "picking" }));
    expect(p.stripEntries).toEqual(["displayChecks_active/marathon-pe/online__9__0"]);
    expect(p.next.lines[0].source.entryKey).toBe("displayChecks_active/marathon-pe/online__9__0");
    expect(p.next.lines[1].source).toEqual({ status: "display", locationId: "marathon-pe" });
  });

  it("idempotent: a split order is done; an order with no qty > 1 or a closed order is left alone", () => {
    const p = planUnitSplit(order([sneaker()]));
    expect(planUnitSplit(p.next).status).toBe("done");
    expect(planUnitSplit(order([tee()])).status).toBe("nothing");
    expect(planUnitSplit(order([sneaker()], { status: "packed" })).status).toBe("closed");
  });

  it("refuses the whole order while a qty > 1 line is mid-flight", () => {
    const cases = [
      [{ escalation: { phase: "requested" } }, /escalation/],
      [{ awaitingCustomer: { what: "pick an alternative" } }, /customer/],
      [{ source: { status: "unavailable" } }, /Jamie/],
      [{ source: { status: "pick", locationId: "hub1", orderKeys: ["AYT"] } }, /1 hub order/],
    ];
    for (const [over, why] of cases) {
      const p = planUnitSplit(order([{ ...sneaker(), ...over }]));
      expect(p.status).toBe("blocked");
      expect(p.blocked[0].why).toMatch(why);
    }
    expect(planUnitSplit(order([sneaker()], { packClaim: { by: "x" } })).blocked[0].why).toMatch(/pack/);
    expect(planUnitSplit(order([sneaker()], { agentRepicks: { r: { lineIndex: 0, state: "pending" } } })).blocked[0].why).toMatch(/agentRepicks/);
    expect(planUnitSplit(order([sneaker()], { agentRepicks: { r: { lineIndex: 0, state: "ordered" } } })).status).toBe("split");
  });

  it("splitCentsFields shares only *Cents numbers", () => {
    expect(splitCentsFields({ paidCents: 3, swaps: 1, note: "x" }, 2)).toEqual([{ paidCents: 2, swaps: 1, note: "x" }, { paidCents: 1, swaps: 1, note: "x" }]);
  });
});

describe("migrateOrderUnits against the fake RTDB", () => {
  const world = () => ({
    online_orders: { 9: order([tee(), sneaker()], { status: "picking" }) },
    orders: {
      AYT: { channel: "online", onlineOrderId: "9", onlineLineIndex: 1, onlineUnit: 0, status: "ready" },
      ZCQ: { channel: "online", onlineOrderId: "9", onlineLineIndex: 1, onlineUnit: 1, status: "ready" },
    },
  });

  it("dry run writes nothing", async () => {
    const f = fakeDb(world());
    const out = await migrateOrderUnits(f.db, "9", f.read("online_orders/9"), { nowMs: 5 });
    expect(out.status).toBe("split");
    expect(f.writes).toEqual([]);
  });

  it("--apply splits the order and re-points the unit's hub order; a second run changes nothing", async () => {
    const f = fakeDb(world());
    const said = [];
    await migrateOrderUnits(f.db, "9", f.read("online_orders/9"), { nowMs: 5, apply: true, say: (s) => said.push(s) });
    const o = f.read("online_orders/9");
    expect(o.lines).toHaveLength(3);
    expect(o.lines[2]).toMatchObject({ splitFrom: 1, unit: 2, qty: 1, source: { orderKeys: ["ZCQ"] } });
    expect(f.read("orders/ZCQ")).toMatchObject({ onlineLineIndex: 2, onlineUnit: 0, splitFromLine: 1, splitFromUnit: 1 });
    expect(f.read("orders/AYT")).toMatchObject({ onlineLineIndex: 1, onlineUnit: 0 });
    const n = f.writes.length;
    const again = await migrateOrderUnits(f.db, "9", o, { nowMs: 6, apply: true });
    expect(again.status).toBe("done");
    expect(f.writes.slice(n).filter(([op]) => op !== "transaction-abort")).toEqual([]);
  });

  it("a re-run finishes a hub re-point an interrupted run left", async () => {
    const f = fakeDb(world());
    const split = planUnitSplit(f.read("online_orders/9"), { nowMs: 5 }).next;
    await f.db.ref("online_orders/9").set(split); // the order landed, the re-point did not
    await migrateOrderUnits(f.db, "9", f.read("online_orders/9"), { nowMs: 6, apply: true });
    expect(f.read("orders/ZCQ")).toMatchObject({ onlineLineIndex: 2, onlineUnit: 0 });
  });
});

describe("architect review fixes", () => {
  it("refuses a line with money given back or moving, a customer conversation, or a hub line whose codes are not made yet", () => {
    for (const [over, why] of [
      [{ resolution: { money: { kind: "refund", state: "claimed", amountCents: 1 } } }, /money/],
      [{ resolution: { moneySettled: { a: { amountCents: 1 } } } }, /money/],
      [{ resolution: { conversation: { state: "offering" } } }, /customer agent/],
      [{ source: { status: "pick", locationId: "hub1" } }, /hub orders are being made/],
    ]) {
      const p = planUnitSplit(order([{ ...sneaker(), ...over }]));
      expect(p.status).toBe("blocked");
      expect(p.blocked[0].why).toMatch(why);
    }
  });

  it("units count over every line of the Shopify item (#2261: ×3 at PE + 1 at Hub 2 = 4 units)", () => {
    const pe = tee({ qty: 3, shopifyLineItemId: `${LI}9`, source: { status: "handed", locationId: "marathon-pe", entryKey: "displayChecks_active/marathon-pe/online__9__0" } });
    const hub = tee({ lineId: "l1", shopifyLineItemId: `${LI}9`, source: { status: "handed", locationId: "hub2", orderKeys: ["BWU"], entryKey: "orders/BWU" } });
    const L = planUnitSplit(order([pe, hub])).next.lines;
    expect(L.map((l) => [l.unit, l.units, l.source.locationId])).toEqual([[1, 4, "marathon-pe"], [4, 4, "hub2"], [2, 4, "marathon-pe"], [3, 4, "marathon-pe"]]);
  });

  it("a half-confirmed ×2 hub line: the unit whose code is in goes into the basket", () => {
    const o = order([{ ...sneaker(), source: { status: "pick", locationId: "hub1", orderKeys: ["AYT", "ZCQ"], entryKey: "orders/AYT" } }], { codesIn: { ZCQ: true } });
    const p = planUnitSplit(o);
    expect(p.next.basket[1]).toBe(true);
    expect(p.next.basket[0] ?? null).toBeNull();
  });

  it("a re-run after an interrupted apply still sets unit 1's open strip entry to qty 1", async () => {
    const f = fakeDb({
      online_orders: { 9: order([tee({ qty: 2 })], { status: "picking" }) },
      displayChecks_active: { "marathon-pe": { online__9__0: { status: "open", qty: 2, saleCount: 2 } } },
    });
    await f.db.ref("online_orders/9").set(planUnitSplit(f.read("online_orders/9"), { nowMs: 5 }).next); // order landed, entry not
    await migrateOrderUnits(f.db, "9", f.read("online_orders/9"), { nowMs: 6, apply: true });
    expect(f.read("displayChecks_active/marathon-pe/online__9__0")).toMatchObject({ qty: 1, saleCount: 1 });
  });
});
