import { describe, it, expect } from "vitest";
import {
  inferProductType,
  dedupeByOrderNumber,
  returnedOrderNumberSet,
  excludeReturnedOrderNumbers,
  oosEventsForPeriod,
} from "./insights";

// A one-day window. Timestamps use mid-day UTC so the +2h SA shift never crosses
// a date boundary in these fixtures.
const START = "2026-06-16T00:00:00.000Z";
const END = "2026-06-17T00:00:00.000Z";
const oos = (orderNumber, t, extra = {}) => ({ action: "out_of_stock", orderNumber, timestamp: `2026-06-16T${t}:00:00.000Z`, size: "7", productType: "sneaker", ...extra });

describe("inferProductType", () => {
  it("prefers explicit productType", () => {
    expect(inferProductType({ productType: "clothing", size: "7" })).toBe("clothing");
  });
  it("falls back to size-letter heuristic, default sneaker", () => {
    expect(inferProductType({ size: "XL" })).toBe("clothing");
    expect(inferProductType({ size: "8" })).toBe("sneaker");
    expect(inferProductType({})).toBe("sneaker");
  });
});

describe("dedupeByOrderNumber", () => {
  it("collapses same (SA-date, orderNumber) to the earliest, keeps distinct", () => {
    const out = dedupeByOrderNumber([oos("001", "09"), oos("001", "08"), oos("002", "10")]);
    expect(out).toHaveLength(2);
    expect(out.find(e => e.orderNumber === "001").timestamp).toBe("2026-06-16T08:00:00.000Z");
  });
  it("ignores entries with no orderNumber", () => {
    expect(dedupeByOrderNumber([{ timestamp: "x" }, oos("001", "08")])).toHaveLength(1);
  });
});

describe("returnedOrderNumberSet + excludeReturnedOrderNumbers", () => {
  it("drops events whose order was returned in-window (composite-key match)", () => {
    const events = [oos("001", "08"), oos("002", "10")];
    const set = returnedOrderNumberSet([{ orderNumber: "002", timestamp: "2026-06-16T11:00:00.000Z" }], START, END, null);
    const out = excludeReturnedOrderNumbers(events, set);
    expect(out.map(e => e.orderNumber)).toEqual(["001"]);
  });
  it("a return outside the window does not exclude", () => {
    const set = returnedOrderNumberSet([{ orderNumber: "002", timestamp: "2026-06-20T11:00:00.000Z" }], START, END, null);
    expect(excludeReturnedOrderNumbers([oos("002", "10")], set)).toHaveLength(1);
  });
});

describe("oosEventsForPeriod (shared by Overview card + OOS Tracker)", () => {
  it("counts every in-window out_of_stock event, deduping flapped orders", () => {
    const log = [
      oos("001", "08"), oos("001", "09"),          // same order flapped → 1
      oos("002", "10"),
      { action: "ready", orderNumber: "003", timestamp: "2026-06-16T10:00:00.000Z" }, // not OOS
      oos("004", "10", { timestamp: "2026-06-15T10:00:00.000Z" }),                     // out of window
    ];
    const out = oosEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" });
    expect(out).toHaveLength(2);
  });

  it("does NOT collapse many distinct OOS orders to one (the bug it fixes)", () => {
    const log = Array.from({ length: 60 }, (_, i) => oos(String(100 + i), "12"));
    const out = oosEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" });
    expect(out).toHaveLength(60);
  });

  it("excludes returned orders", () => {
    const log = [oos("001", "08"), oos("002", "10")];
    const returnsLog = [{ orderNumber: "002", timestamp: "2026-06-16T11:00:00.000Z" }];
    const out = oosEventsForPeriod({ log, returnsLog, filterStart: START, filterEnd: END, category: "both" });
    expect(out.map(e => e.orderNumber)).toEqual(["001"]);
  });

  it("respects the category filter", () => {
    const log = [oos("001", "08", { productType: "sneaker" }), oos("002", "10", { productType: "clothing", size: "L" })];
    expect(oosEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "sneaker" })).toHaveLength(1);
    expect(oosEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "clothing" })).toHaveLength(1);
    expect(oosEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" })).toHaveLength(2);
  });

  it("is deterministic for identical inputs (Overview card == OOS Tracker)", () => {
    const log = [oos("001", "08"), oos("002", "10")];
    const args = { log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" };
    expect(oosEventsForPeriod(args).length).toBe(oosEventsForPeriod(args).length);
  });

  it("tolerates empty/absent log", () => {
    expect(oosEventsForPeriod({ log: null, returnsLog: null, filterStart: START, filterEnd: END })).toEqual([]);
  });
});
