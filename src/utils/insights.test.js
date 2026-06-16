import { describe, it, expect } from "vitest";
import {
  inferProductType,
  dedupeByOrderNumber,
  returnedOrderNumberSet,
  excludeReturnedOrderNumbers,
  oosEventsForPeriod,
  readyEventsForPeriod,
  clothingRefillEventsForPeriod,
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

const ready = (orderNumber, t, extra = {}) => ({ action: "ready", orderNumber, timestamp: `2026-06-16T${t}:00:00.000Z`, size: "7", productType: "sneaker", ...extra });

describe("readyEventsForPeriod (shared by Overview Net Sales + Sales Summary)", () => {
  it("counts in-window ready events, deduping flapped orders", () => {
    const log = [ready("001", "08"), ready("001", "09"), ready("002", "10"), ready("003", "10", { timestamp: "2026-06-15T10:00:00.000Z" })];
    expect(oosLen(readyEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" }))).toBe(2);
  });

  it("counts ONLY ready events — never out_of_stock (the inflation fix)", () => {
    // An auto-collected OOS order logs `out_of_stock`, never `ready`, so it must
    // not be counted as a sale. Mixed log:
    const log = [
      ready("001", "08"),
      oos("900", "08"), oos("901", "09"), oos("902", "10"), // 3 OOS — must NOT count as sales
    ];
    const out = readyEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" });
    expect(out.map(e => e.orderNumber)).toEqual(["001"]);
  });

  it("excludes returned orders", () => {
    const log = [ready("001", "08"), ready("002", "10")];
    const returnsLog = [{ orderNumber: "002", timestamp: "2026-06-16T11:00:00.000Z" }];
    expect(readyEventsForPeriod({ log, returnsLog, filterStart: START, filterEnd: END, category: "both" }).map(e => e.orderNumber)).toEqual(["001"]);
  });

  it("respects the category filter", () => {
    const log = [ready("001", "08", { productType: "sneaker" }), ready("002", "10", { productType: "clothing", size: "L" })];
    expect(readyEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "sneaker" })).toHaveLength(1);
    expect(readyEventsForPeriod({ log, returnsLog: [], filterStart: START, filterEnd: END, category: "both" })).toHaveLength(2);
  });
});

// tiny helper to read length (keeps assertions terse)
function oosLen(arr) { return arr.length; }

const sumQty = (arr) => arr.reduce((n, e) => n + e.qty, 0);
const placed = (orderNumber, t, extra = {}) => ({ action: "placed", orderNumber, timestamp: `2026-06-16T${t}:00:00.000Z`, productType: "clothing", size: "M", placedAtHub: "hub2", ...extra });

describe("clothingRefillEventsForPeriod", () => {
  describe("past windows (from insights_log)", () => {
    const base = { isToday: false, orders: [], filterStart: START, filterEnd: END };
    it("sums UNITS from qty, falling back to 1 for legacy events with no qty", () => {
      const log = [
        placed("001", "08", { qty: 3 }),   // 3 units
        placed("002", "09"),               // legacy, no qty → 1
      ];
      const out = clothingRefillEventsForPeriod({ ...base, log });
      expect(out).toHaveLength(2);
      expect(sumQty(out)).toBe(4);
    });
    it("excludes Hub C (customer clothing), non-placed, non-clothing, and out-of-window", () => {
      const log = [
        placed("001", "08", { qty: 2 }),
        placed("900", "08", { qty: 5, placedAtHub: "hubC" }),                 // customer clothing
        placed("901", "08", { qty: 5, productType: "sneaker", size: "8" }),   // not clothing
        { action: "ready", orderNumber: "902", productType: "clothing", size: "M", placedAtHub: "hub2", timestamp: "2026-06-16T08:00:00.000Z", qty: 5 }, // not placed
        placed("903", "10", { qty: 5, timestamp: "2026-06-15T10:00:00.000Z" }), // out of window
      ];
      const out = clothingRefillEventsForPeriod({ ...base, log });
      expect(out.map(e => e.orderNumber)).toEqual(["001"]);
      expect(sumQty(out)).toBe(2);
    });
    it("dedupes a re-fired placed event by orderNumber (counts once)", () => {
      const log = [placed("001", "08", { qty: 3 }), placed("001", "09", { qty: 3 })];
      expect(clothingRefillEventsForPeriod({ ...base, log })).toHaveLength(1);
      expect(sumQty(clothingRefillEventsForPeriod({ ...base, log }))).toBe(3);
    });
  });

  describe("today (from live orders)", () => {
    const ord = (id, t, extra = {}) => ({ id, productType: "clothing", placedAtHub: "hub2", createdAt: `2026-06-16T${t}:00:00.000Z`, size: "M", qty: 1, ...extra });
    const base = { isToday: true, log: [], filterStart: START, filterEnd: END };
    it("sums qty from live orders, excluding Hub C / non-clothing / out-of-window", () => {
      const orders = [
        ord("001", "08", { qty: 3 }),
        ord("900", "08", { qty: 5, placedAtHub: "hubC" }),                 // customer
        ord("901", "08", { qty: 5, productType: "sneaker" }),              // not clothing
        ord("902", "10", { qty: 5, createdAt: "2026-06-15T10:00:00.000Z" }), // out of window
      ];
      const out = clothingRefillEventsForPeriod({ ...base, orders });
      expect(out.map(e => e.orderNumber)).toEqual(["001"]);
      expect(sumQty(out)).toBe(3);
    });
    it("defaults qty to 1 when absent on an order", () => {
      const orders = [{ id: "001", productType: "clothing", placedAtHub: "hub2", createdAt: "2026-06-16T08:00:00.000Z", size: "M" }];
      expect(sumQty(clothingRefillEventsForPeriod({ ...base, orders }))).toBe(1);
    });
  });
});
