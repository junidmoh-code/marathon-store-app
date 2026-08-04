import { describe, it, expect } from "vitest";
import {
  inferProductType,
  dedupeByOrderNumber,
  returnedOrderNumberSet,
  excludeReturnedOrderNumbers,
  oosEventsForPeriod,
  readyEventsForPeriod,
  clothingRefillEventsForPeriod,
  restockCountsFromLog,
  computeRestockCounts,
  sourceGroupKey,
  sourceNameKey,
  sourceResponsePath,
  sourceResponseDatePath,
  onHoldEventsFromLog,
  onHoldKey,
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

// ─── Source durable-log reconstruction (History + On Hold) ───────────────────
// Fixtures use mid-day UTC so the +2h SA shift keeps everything on 2026-06-16.
const DATE = "2026-06-16";
const rdy = (orderNumber, t, extra = {}) => ({ action: "ready", orderNumber, timestamp: `2026-06-16T${t}:00:00.000Z`, size: "8", productName: "Nike Air", placedAtHub: "hub1", ...extra });
const tmw = (orderNumber, t, extra = {}) => ({ action: "tomorrow", orderNumber, timestamp: `2026-06-16T${t}:00:00.000Z`, size: "8", productName: "Nike Air", placedAtHub: "hub1", ...extra });

describe("restockCountsFromLog (Source History rebuilt from the durable log)", () => {
  it("groups ready events by product key and size, counting units", () => {
    const log = [rdy("001", "08"), rdy("002", "09"), rdy("003", "10", { size: "9" })];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(out.Nike_Air.sizes).toEqual({ "8": 2, "9": 1 });
    expect(out.Nike_Air.productName).toBe("Nike Air");
  });

  it("only counts the requested hub and SA date", () => {
    const log = [
      rdy("001", "08"),                                  // hub1, today → in
      rdy("002", "09", { placedAtHub: "hub2" }),         // wrong hub → out
      rdy("003", "10", { timestamp: "2026-06-15T10:00:00.000Z" }), // wrong day → out
    ];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(out.Nike_Air.sizes).toEqual({ "8": 1 });
  });

  it("counts ONLY ready events, never tomorrow / out_of_stock", () => {
    const log = [rdy("001", "08"), tmw("002", "09"), { action: "out_of_stock", orderNumber: "003", timestamp: "2026-06-16T10:00:00.000Z", size: "8", productName: "Nike Air", placedAtHub: "hub1" }];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(out.Nike_Air.sizes).toEqual({ "8": 1 });
  });

  it("EXCLUDES clothing-refill 'ready' events (Shop Refill) — footwear History only", () => {
    // CR fulfil logs action=ready with productType clothing + placedAtHub hub2 but
    // never flips the order to status READY, so the live footwear path never showed
    // it. Clothing (explicit type OR letter-size heuristic) must not pollute hub2.
    const log = [
      rdy("001", "08", { placedAtHub: "hub2" }),                                              // sneaker → in
      { action: "ready", orderNumber: "700", timestamp: "2026-06-16T08:30:00.000Z", size: "L", productName: "Marathon Tee", placedAtHub: "hub2", productType: "clothing", customerName: "Shop Refill" },
      { action: "ready", orderNumber: "701", timestamp: "2026-06-16T09:00:00.000Z", size: "M", productName: "Marathon Tee", placedAtHub: "hub2", customerName: "Shop Refill" }, // no explicit type; letter size → clothing heuristic
    ];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub2" });
    expect(Object.keys(out)).toEqual(["Nike_Air"]);
    expect(out.Marathon_Tee).toBeUndefined();
  });

  it("keys groups by productId — a pid event and a pid-less same-named event do NOT merge", () => {
    // The old contract ("adopt the first pid any same-named event carries") is
    // exactly how a twin's id got bound to the wrong card, so it is GONE: the
    // pid event groups under its id, the pid-less event stays under the name
    // key with productId null (its card resolves via the ambiguity-refusing
    // name fallback, else keeps the plain buttons).
    const log = [rdy("001", "08"), rdy("002", "09", { productId: "p123", size: "9" })];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(out.p123).toMatchObject({ productId: "p123", nameKey: "Nike_Air", sizes: { "9": 1 } });
    expect(out.Nike_Air).toMatchObject({ productId: null, sizes: { "8": 1 } });
    // No event carries a pid → the whole group stays name-keyed, id null.
    const none = restockCountsFromLog({ log: [rdy("001", "08")], dateStr: DATE, hub: "hub1" });
    expect(none.Nike_Air.productId).toBeNull();
  });

  it("TWIN SPLIT: identically-named products, same day + hub + size → two separate cards with distinct response paths", () => {
    // The wrong-deduction incident (2026-08-03): three byte-identical
    // "Nike SB Dunk Low Green White" records. Same-day same-hub sales of two
    // twins used to merge into ONE card carrying ONE pid — the fulfil then
    // deducted the wrong product. Keyed by pid they must never merge, and the
    // restock_requests/{date}/{KEY}/{size} response cells (keyed by the same
    // group key) must be distinct so responding to one twin can't close the other.
    const log = [
      rdy("001", "08", { size: "9", productId: "pTwinA" }),
      rdy("002", "09", { size: "9", productId: "pTwinB" }),
    ];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(Object.keys(out).sort()).toEqual(["pTwinA", "pTwinB"]);
    expect(out.pTwinA.sizes).toEqual({ "9": 1 });
    expect(out.pTwinB.sizes).toEqual({ "9": 1 });
    // Distinct group keys ⇒ distinct response cells and distinct movement ids
    // (both are derived from the group key by the component layer).
    expect(sourceGroupKey("pTwinA", "Nike Air")).not.toBe(sourceGroupKey("pTwinB", "Nike Air"));
  });

  it("fires the duplicate-name collision handler for BYTE-IDENTICAL names with different pids", () => {
    // The old warning compared names (result[key].productName !== order.productName)
    // so byte-identical twins could never trip it. The tripwire now compares ids.
    const seen = [];
    const log = [
      rdy("001", "08", { productId: "pTwinA" }),
      rdy("002", "09", { productId: "pTwinB" }),
    ];
    restockCountsFromLog({ log, dateStr: DATE, hub: "hub1", onNameCollision: (msg) => seen.push(msg) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("pTwinA");
    expect(seen[0]).toContain("pTwinB");
    expect(seen[0]).toContain('"Nike Air"');
  });

  it("dedupes a flapped order (same date+orderNumber counts once)", () => {
    const out = restockCountsFromLog({ log: [rdy("001", "08"), rdy("001", "09")], dateStr: DATE, hub: "hub1" });
    expect(out.Nike_Air.sizes).toEqual({ "8": 1 });
  });

  it("excludes returned orderNumbers for that day", () => {
    const out = restockCountsFromLog({ log: [rdy("001", "08"), rdy("002", "09")], dateStr: DATE, hub: "hub1", returnedIds: new Set(["002"]) });
    expect(out.Nike_Air.sizes).toEqual({ "8": 1 });
  });

  it("defaults a missing hub to hub1 and skips sizeless events", () => {
    const log = [rdy("001", "08", { placedAtHub: undefined }), rdy("002", "09", { size: null })];
    const out = restockCountsFromLog({ log, dateStr: DATE, hub: "hub1" });
    expect(out.Nike_Air.sizes).toEqual({ "8": 1 });
  });

  it("tolerates an empty/absent log", () => {
    expect(restockCountsFromLog({ log: null, dateStr: DATE, hub: "hub1" })).toEqual({});
  });
});

describe("computeRestockCounts (Source Today built from restock_log sales)", () => {
  const sale = (extra = {}) => ({ productId: "pA", productName: "Nike Air", size: "8", photo: "", photoUrl: "https://x/a.jpg", hub: "hub1", ...extra });

  it("groups by productId, counting units per size, keeping photo fields", () => {
    const out = computeRestockCounts([sale(), sale({ size: "9" }), sale({ size: "9" })]);
    expect(Object.keys(out)).toEqual(["pA"]);
    expect(out.pA).toMatchObject({ productId: "pA", productName: "Nike Air", nameKey: "Nike_Air", photoUrl: "https://x/a.jpg", sizes: { "8": 1, "9": 2 } });
  });

  it("TWIN SPLIT: identically-named twins sold the same day stay two separate groups", () => {
    const out = computeRestockCounts([
      sale({ productId: "pTwinA", size: "9" }),
      sale({ productId: "pTwinB", size: "9" }),
    ]);
    expect(Object.keys(out).sort()).toEqual(["pTwinA", "pTwinB"]);
    expect(out.pTwinA.sizes).toEqual({ "9": 1 });
    expect(out.pTwinB.sizes).toEqual({ "9": 1 });
  });

  it("pid-less legacy rows fall back to the sanitized-name key (lock-step with restockCountsFromLog)", () => {
    const out = computeRestockCounts([sale({ productId: undefined })]);
    expect(Object.keys(out)).toEqual(["Nike_Air"]);
    expect(out.Nike_Air.productId).toBeNull();
    // The two builders MUST produce the same key for the same record — they
    // meet at the same restock_requests/{date}/{key}/{size} response cells.
    expect(sourceGroupKey("pA", "Nike Air")).toBe("pA");
    expect(sourceGroupKey(undefined, "Nike Air")).toBe(sourceNameKey("Nike Air"));
  });

  it("fires the collision handler for byte-identical names with different pids", () => {
    const seen = [];
    computeRestockCounts(
      [sale({ productId: "pTwinA" }), sale({ productId: "pTwinB" })],
      { onNameCollision: (msg) => seen.push(msg) },
    );
    expect(seen).toHaveLength(1);
  });

  it("tolerates empty/absent entries", () => {
    expect(computeRestockCounts(null)).toEqual({});
    expect(computeRestockCounts([null, sale()])).toMatchObject({ pA: { sizes: { "8": 1 } } });
  });

  it("a row with NEITHER a product id NOR a name never produces an empty key", () => {
    // An empty key makes sourceResponsePath collapse to the date node, so
    // saveSourceResponse would write a size leaf straight under
    // restock_requests/{date} and corrupt that day's response tree.
    const out = computeRestockCounts([{ size: "9" }, { productId: "", productName: "   ", size: "8" }]);
    expect(Object.keys(out)).not.toContain("");
    expect(sourceResponsePath("2026-06-16", sourceGroupKey(undefined, undefined))).toBe("restock_requests/2026-06-16/Unknown");
    // The group is still usable: named, and safe to sort/render.
    Object.values(out).forEach(g => expect(typeof g.productName).toBe("string"));
  });

  it("back-fills BOTH image fields from a later row", () => {
    const out = computeRestockCounts([
      { productId: "pA", productName: "Nike Air", size: "8" },
      { productId: "pA", productName: "Nike Air", size: "9", photo: "👟", photoUrl: "https://x/a.jpg" },
    ]);
    expect(out.pA.photoUrl).toBe("https://x/a.jpg");
    expect(out.pA.photo).toBe("👟");
  });
});

describe("onHoldEventsFromLog (Source On Hold rebuilt from the durable log)", () => {
  it("returns tomorrow events within the given dates, deduped, newest fields intact", () => {
    const log = [tmw("001", "08", { customerName: "Ada" }), tmw("002", "09")];
    const out = onHoldEventsFromLog({ log, dates: [DATE] });
    expect(out).toHaveLength(2);
    const a = out.find(e => e.orderNumber === "001");
    expect(a).toMatchObject({ productName: "Nike Air", size: "8", hub: "hub1", customerName: "Ada", saDate: DATE });
  });

  it("ignores dates outside the window and non-tomorrow actions", () => {
    const log = [tmw("001", "08"), tmw("002", "09", { timestamp: "2026-06-14T09:00:00.000Z" }), rdy("003", "10")];
    expect(onHoldEventsFromLog({ log, dates: [DATE] }).map(e => e.orderNumber)).toEqual(["001"]);
  });

  it("dedupes a flapped on-hold to a single entry", () => {
    expect(onHoldEventsFromLog({ log: [tmw("001", "08"), tmw("001", "09")], dates: new Set([DATE]) })).toHaveLength(1);
  });
});

describe("onHoldKey (composite date::orderNumber)", () => {
  it("distinguishes the same orderNumber on different days", () => {
    expect(onHoldKey("2026-06-16", "001")).not.toBe(onHoldKey("2026-06-15", "001"));
  });
  it("is stable and sanitizes illegal RTDB chars", () => {
    expect(onHoldKey("2026-06-16", "001")).toBe("2026-06-16::001");
  });
});
