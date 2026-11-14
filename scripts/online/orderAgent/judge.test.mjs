import { describe, it, expect } from "vitest";
import { judgeOrder, judgeLine, excludedPlaces, lineIsHere } from "./judge.mjs";
import { tradingHoursBetween, inRunWindow, nextRunAt, dayKey } from "./hours.mjs";

const T = (iso) => Date.parse(iso);
const NOW = T("2026-11-14T09:30:00Z"); // Sat 11:30 SAST
const handedPE = (over = {}) => ({ pid: "A", size: "M", sizeKey: "M", qty: 1, title: "Tee", source: { status: "handed", locationId: "marathon-pe" }, ...over });

describe("hours", () => {
  it("counts only trading hours (Mon–Sat 09–18, Sun 09–14 SAST)", () => {
    expect(tradingHoursBetween(T("2026-11-14T06:00:00Z"), T("2026-11-14T09:00:00Z"))).toBe(2); // Sat 08:00→11:00 SAST
    expect(tradingHoursBetween(T("2026-11-14T15:00:00Z"), T("2026-11-16T08:00:00Z"))).toBe(1 + 5 + 1); // Sat 17–18, Sun 9–14, Mon 9–10
    expect(tradingHoursBetween(NOW, NOW - 1)).toBe(0);
  });
  it("runs 08:00–18:15 SAST", () => {
    expect(inRunWindow(T("2026-11-14T05:59:00Z"))).toBe(false);
    expect(inRunWindow(T("2026-11-14T06:00:00Z"))).toBe(true);
    expect(inRunWindow(T("2026-11-14T16:15:00Z"))).toBe(true);
    expect(inRunWindow(T("2026-11-14T16:16:00Z"))).toBe(false);
    expect(nextRunAt(T("2026-11-14T17:00:00Z"))).toBe(T("2026-11-15T06:00:00Z"));
    expect(dayKey(T("2026-11-14T22:30:00Z"))).toBe("2026-11-15");
  });
});

describe("green", () => {
  it("every line physically at PE → green, no reason, no action", () => {
    const v = judgeOrder({ status: "ready", lines: [handedPE(), handedPE({ pid: "B" })] }, {}, NOW);
    expect(v).toMatchObject({ group: "green", reason: null, actions: [], here: 2, total: 2 });
  });
  it("a hub pair is here only once the till confirmed its code", () => {
    const hub = { pid: "S", size: "7", sizeKey: "7", qty: 1, source: { status: "handed", locationId: "hub1", orderKeys: ["ABC"] } };
    expect(lineIsHere({ codesIn: {} }, 0, hub)).toBe(false);
    expect(lineIsHere({ codesIn: { ABC: true } }, 0, hub)).toBe(true);
  });
  it("refunded/resolved lines are off the parcel and do not hold it", () => {
    const v = judgeOrder({ lines: [handedPE(), { pid: "X", source: { status: "resolved" } }] }, {}, NOW);
    expect(v.group).toBe("green");
  });
});

describe("#2085 (walk-in took the held swapped tee; a fresh XXL landed at PE after)", () => {
  const order = {
    status: "needs_attention", attention: { kind: "walkin_override", at: T("2026-11-12T10:18:00Z") },
    overrides: { x: { productId: "GST", size: "XXL", at: T("2026-11-12T10:18:00Z") } },
    lines: [handedPE({ pid: "BEA", size: "_", sizeKey: "_" }), handedPE({ pid: "JEAN", size: "L", sizeKey: "L" }),
      { pid: "GST", size: "XXL", sizeKey: "XXL", qty: 1, title: "G star raw t shirt black", routeGen: 2, swappedFrom: { at: T("2026-11-12T07:54:00Z") }, source: { status: "needs_attention", locationId: "marathon-pe" } }],
    jimmyStatus: { 2: { state: "swapped", pid: "GST", size: "XXL", basisAt: T("2026-11-12T07:54:00Z") } },
  };
  const facts = { lines: { 2: { free: { "marathon-pe": 1 }, stockAt: { "marathon-pe": { qty: 1, updatedAtMs: T("2026-11-12T10:55:42Z"), lastType: "transfer_in" } }, central: 0 } } };
  it("red with a plain reason (never 'Needs attention'), re-picked at PE: a walk-in sale is not a place failing to find it", () => {
    const v = judgeOrder(order, facts, NOW);
    expect(v.group).toBe("red");
    expect(v.reason).toBe("Held item sold at the till — re-picking at Marathon PE");
    expect(v.reason).not.toMatch(/attention/i);
    expect(v.actions).toEqual([expect.objectContaining({ type: "repick", i: 2, to: "marathon-pe", exclude: [] })]);
  });
  it("a NOT FOUND without a restock since skips that place (a ghost count is not a unit); a restock brings it back", () => {
    const nf = { ...order.lines[2], source: { status: "not_found", locationId: "marathon-pe" } };
    expect(excludedPlaces(nf, { stockAt: { "marathon-pe": { qty: 1, updatedAtMs: T("2026-11-01T00:00:00Z"), lastType: "transfer_in" } } }, T("2026-11-12T10:18:00Z"))).toEqual(["marathon-pe"]);
    expect(excludedPlaces(nf, facts.lines[2], T("2026-11-12T10:18:00Z"))).toEqual([]);
    const o = { ...order, attention: { kind: "not_found" }, lines: [order.lines[0], order.lines[1], nf] };
    const stale = { lines: { 2: { free: { "marathon-pe": 1 }, stockAt: { "marathon-pe": { qty: 1, updatedAtMs: T("2026-11-01T00:00:00Z"), lastType: "sale" } }, central: 0 } } };
    const v = judgeOrder(o, stale, NOW);
    expect(v.actions.find((a) => a.type === "repick")).toBeUndefined();
    expect(v.actions).toEqual([expect.objectContaining({ type: "chase", kind: "alternatives_now", i: 2 })]);
  });
});

describe("#2133 shape (29 lines; a not-found today, waits, a refund, a reply owed)", () => {
  const lines = Array.from({ length: 10 }, (_, k) => handedPE({ pid: `H${k}` }));
  lines[0] = { pid: "SM", size: "M", sizeKey: "M", qty: 1, title: "Saint Michael T-Shirt Black", source: { status: "not_found", locationId: "marathon-pe" } };
  lines[5] = { pid: "DSL", size: "L", sizeKey: "L", qty: 1, title: "Diesel t shirt black", source: { status: "unavailable", waiting: { centralQty: 2 } } };
  lines[7] = { pid: "FOG", size: "S", sizeKey: "S", qty: 1, title: "Essentials tee", source: { status: "unavailable", locationId: "marathon-pe" } };
  lines[9] = { pid: "AD", size: "L", sizeKey: "L", qty: 1, title: "Adidas dress", source: { status: "display", locationId: "trophy", entryKey: "displayChecks_active/trophy/x" } };
  lines[8] = { pid: "CAP", size: "_", sizeKey: "_", qty: 1, title: "Nike cap", source: { status: "unavailable", locationId: "marathon-pe" } };
  const order = {
    status: "needs_attention", attention: { kind: "not_found", at: T("2026-11-14T07:43:00Z") }, lines,
    jimmyStatus: {
      5: { state: "chose", pid: "DSL", size: "L", next: "send it when it arrives", customerSaid: { text: "I'll wait", at: T("2026-11-13T06:07:00Z") } },
      7: { state: "refunded", pid: "FOG", size: "S" },
      8: { state: "waiting_reply", pid: "CAP", size: "_", offered: [{ name: "Lacoste cap" }], told: { at: T("2026-11-13T09:02:00Z") }, customerSaid: { at: T("2026-11-13T09:15:00Z") } },
    },
  };
  const facts = { lines: {
    0: { free: { concrete: 2 }, stockAt: { "marathon-pe": { qty: 1, updatedAtMs: T("2026-09-30T09:59:00Z"), lastType: "transfer_out" } }, central: 0 },
    5: { free: {}, central: 2 }, 7: { free: {}, central: 0 }, 8: { free: {}, central: 0 },
    9: { free: { trophy: 1 }, sinceMs: T("2026-11-14T07:00:00Z") },
  } };
  it("red; the customer's open question speaks first; never 'Needs attention'", () => {
    const v = judgeOrder(order, facts, NOW);
    expect(v.group).toBe("red");
    expect(v.reason).toBe("Customer choosing alternative (+4 more)");
    for (const l of v.lines) expect(l.why).not.toMatch(/attention/i);
  });
  it("line 0 not found at PE (PE's count is stale) → re-picked at Concrete, PE excluded", () => {
    const v = judgeOrder(order, facts, NOW);
    expect(v.actions).toContainEqual(expect.objectContaining({ type: "repick", i: 0, to: "concrete", exclude: ["marathon-pe"] }));
    expect(v.lines.find((l) => l.i === 0).why).toBe("Not found at Marathon PE — re-picking at Concrete");
  });
  it("line 5 the customer chose to wait, nothing free → 'Customer waiting for stock', no action", () => {
    const v = judgeOrder(order, facts, NOW);
    expect(v.lines.find((l) => l.i === 5).why).toBe("Customer waiting for stock (coming from Central)");
    expect(v.actions.find((a) => a.i === 5)).toBeUndefined();
  });
  it("line 7 refunded by Jamie, no Shopify record yet → 'Refund being processed'; with Shopify's record 30+ min old → closed", () => {
    expect(judgeOrder(order, facts, NOW).lines.find((l) => l.i === 7).why).toBe("Refund being processed");
    const withRefund = { lines: { ...facts.lines, 7: { free: {}, central: 0, shopifyRefund: { at: NOW - 3600e3, cents: 35000 } } } };
    expect(judgeOrder(order, withRefund, NOW).actions).toContainEqual(expect.objectContaining({ type: "close_refund", i: 7 }));
    const fresh = { lines: { ...facts.lines, 7: { free: {}, central: 0, shopifyRefund: { at: NOW - 60e3, cents: 35000 } } } };
    expect(judgeOrder(order, fresh, NOW).actions.find((a) => a.type === "close_refund")).toBeUndefined();
  });
  it("line 8: the customer answered after Jamie asked → no chase", () => {
    expect(judgeOrder(order, facts, NOW).actions.find((a) => a.type === "chase" && a.i === 8)).toBeUndefined();
  });
  it("line 9 at Trophy for 2.5 trading hours → nudge; at 4+ → Junid", () => {
    expect(judgeOrder(order, facts, NOW).actions).toContainEqual(expect.objectContaining({ type: "nudge", i: 9, location: "trophy" }));
    const later = T("2026-11-14T11:30:00Z");
    expect(judgeOrder(order, facts, later).actions).toContainEqual(expect.objectContaining({ type: "escalate", i: 9, level: "4h" }));
  });
});

describe("the customer and the money", () => {
  const ask = (over) => ({ lines: [{ pid: "C", size: "_", sizeKey: "_", qty: 1, source: { status: "unavailable" } }], jimmyStatus: { 0: { pid: "C", state: "waiting_reply", offered: [{}], ...over } } });
  it("4 h of silence → follow_up; 24 h → no_answer_24h (never both)", () => {
    expect(judgeOrder(ask({ told: { at: NOW - 3 * 3600e3 } }), {}, NOW).actions).toEqual([]);
    expect(judgeOrder(ask({ told: { at: NOW - 5 * 3600e3 } }), {}, NOW).actions).toEqual([expect.objectContaining({ type: "chase", kind: "follow_up" })]);
    expect(judgeOrder(ask({ told: { at: NOW - 25 * 3600e3 } }), {}, NOW).actions).toEqual([expect.objectContaining({ type: "chase", kind: "no_answer_24h" })]);
  });
  it("a dearer pick's unpaid difference → 'R100 difference unpaid' + payment_link, ahead of everything", () => {
    const o = { lines: [handedPE({ pid: "N", source: { status: "pick", locationId: "hub2" } })], jimmyStatus: { 0: { pid: "N", state: "awaiting_payment", diffCents: 10000 } } };
    const v = judgeOrder(o, {}, NOW);
    expect(v.reason).toBe("R100 difference unpaid");
    expect(v.actions).toEqual([expect.objectContaining({ type: "chase", kind: "payment_link" })]);
  });
  it("a hub rejection with nothing anywhere → alternatives_now; with Central stock → waiting on refill, no action", () => {
    const o = { lines: [{ pid: "S", size: "7", sizeKey: "7", qty: 1, isFootwear: true, source: { status: "no_stock", locationId: "hub2", at: NOW - 3600e3 } }] };
    expect(judgeLine(o, 0, o.lines[0], { free: {}, central: 0 }, NOW)).toMatchObject({ why: "Hub 2 rejected — not in stock anywhere, Jamie offering alternatives", actions: [expect.objectContaining({ kind: "alternatives_now" })] });
    expect(judgeLine(o, 0, o.lines[0], { free: {}, central: 3 }, NOW)).toMatchObject({ why: "Hub 2 rejected — waiting on refill from Central", actions: [] });
  });
});

describe("incoming exchanges", () => {
  it("an exchange whose return is not confirmed → its own group", () => {
    expect(judgeOrder({ incoming: { arrival: null }, lines: [handedPE()] }, {}, NOW).group).toBe("incoming");
    expect(judgeOrder({ incoming: { arrival: { state: "done" } }, lines: [handedPE()] }, {}, NOW).group).toBe("green");
  });
});
