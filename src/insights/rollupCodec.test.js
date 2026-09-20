// ─── THE CODEC IS LOSSLESS, PROVEN AGAINST A REAL TRADING DAY ────────────────
//
// The promise the whole rollup rests on: a day of /insights_log put through
// compactDay and back out through expandDay produces the SAME EVENTS, in the
// SAME ORDER, restricted to the fields the rollup keeps. If that holds, every
// figure on Insights, Customers and the admin all-time line is unchanged by
// construction — because those figures are computed by the untouched
// production selectors, from these rows.
//
// So the fixture is not invented. It is 2026-09-18 as it actually happened:
// 1,030 rows, 388 distinct product names, eight distinct actions, pulled live
// by a bounded key-range read. Only the two PII fields are replaced, with
// pseudonyms that preserve cardinality and the name↔phone pairing the customer
// aggregation depends on — this repository is public.
//
// A codec tested only on invented rows is a codec tested on the rows its
// author remembered to invent. Real days contain events with no size, events
// with no productId, an action nobody documented, a timestamp nobody parses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compactDay, expandDay, keptFieldsOf, ROLLUP_SHAPE } from "./rollupCodec";

const DAY = JSON.parse(
  readFileSync(new URL("./__fixtures__/day-2026-09-18.json", import.meta.url), "utf8"),
);

// The writer feeds events in KEY order — which is arrival order, and which
// `groupCount`'s tie-break depends on.
const eventsInKeyOrder = Object.keys(DAY).sort().map((k) => DAY[k]);
const ANCHOR = Date.parse("2026-09-18T00:00:00.000+02:00");
const META = { date: "2026-09-18", anchorMs: ANCHOR, cursorEnd: "-P1qX8R-zzzz" };

describe("rollupCodec — a real day", () => {
  const node = compactDay(eventsInKeyOrder, META);
  const back = expandDay(node);

  it("round-trips every row, in order, field for field", () => {
    expect(back).not.toBeNull();
    expect(back.length).toBe(eventsInKeyOrder.length);
    expect(back).toEqual(eventsInKeyOrder.map(keptFieldsOf));
  });

  it("keeps an ABSENT field absent — not an empty string", () => {
    // inferProductType() branches on `size` being falsy vs a letter size, and
    // the customer grouping branches on `customerPhone` existing at all. A
    // codec that turned undefined into "" would move events between buckets.
    const sizeless = eventsInKeyOrder.findIndex((e) => e.size === undefined);
    expect(sizeless).toBeGreaterThanOrEqual(0);
    expect("size" in back[sizeless]).toBe(false);

    const pidless = eventsInKeyOrder.findIndex((e) => e.productId === undefined);
    if (pidless >= 0) expect("productId" in back[pidless]).toBe(false);
  });

  it("drops only fields no served screen reads", () => {
    const kept = new Set(Object.keys(back[0]));
    const dropped = new Set();
    for (const e of eventsInKeyOrder) for (const k of Object.keys(e)) if (!kept.has(k)) dropped.add(k);
    // Whatever else this day contains, these are the ones it may drop.
    for (const k of dropped) {
      expect(["autoRefill", "source", "saleId", "by", "matchedProductIds",
        "matchedProductNames", "matchedUnits", "qty", "size", "productId",
        "orderNumber", "placedAtHub", "destShop", "customerName", "customerPhone",
        "displayRefilledBy", "productCategory", "productType"]).toContain(k);
    }
    // …and these three may never be dropped, because every window filter and
    // every group-by is built on them.
    for (const k of ["action", "timestamp", "productName"]) expect(kept.has(k)).toBe(true);
  });

  it("is materially smaller than the day it encodes", () => {
    const raw = JSON.stringify(DAY).length;
    const rolled = JSON.stringify(node).length;
    // Measured at the time of writing: 338,290 -> ~64,000. The assertion is
    // deliberately loose — this is a floor the design must clear, not a
    // number to chase.
    expect(rolled).toBeLessThan(raw * 0.35);
  });

  it("stamps its shape, its date and its cursor", () => {
    expect(node.v).toBe(ROLLUP_SHAPE);
    expect(node.date).toBe("2026-09-18");
    expect(node.cursorEnd).toBe("-P1qX8R-zzzz");
    expect(node.n).toBe(eventsInKeyOrder.length);
  });

  it("refuses a node whose shape it does not know, rather than guessing", () => {
    expect(expandDay({ ...node, v: ROLLUP_SHAPE + 1 })).toBeNull();
  });

  it("refuses a node with a dangling dictionary index, rather than half a day", () => {
    const broken = JSON.parse(JSON.stringify(node));
    broken.dict.p = broken.dict.p.slice(0, 2);
    expect(expandDay(broken)).toBeNull();
  });
});

describe("rollupCodec — the awkward rows a real day does not happen to contain", () => {
  const anchor = Date.parse("2026-09-18T00:00:00.000+02:00");
  const meta = { date: "2026-09-18", anchorMs: anchor };

  it("keeps a NON-ISO timestamp verbatim — screens compare the STRING", () => {
    // `e.timestamp >= filterStart` is a string comparison. An offset-encoded
    // round trip would rewrite "+02:00" as "Z" — the same instant, a different
    // string, and a different answer at a window edge.
    const events = [
      { action: "ready", productName: "A", timestamp: "2026-09-18T10:00:00+02:00" },
      { action: "ready", productName: "B", timestamp: "2026-09-18T09:00:00.000Z" },
    ];
    const back = expandDay(compactDay(events, meta));
    expect(back[0].timestamp).toBe("2026-09-18T10:00:00+02:00");
    expect(back[1].timestamp).toBe("2026-09-18T09:00:00.000Z");
  });

  it("survives a missing, empty or unparseable timestamp", () => {
    const events = [
      { action: "ready", productName: "A" },
      { action: "ready", productName: "B", timestamp: "" },
      { action: "ready", productName: "C", timestamp: "not a date" },
    ];
    const back = expandDay(compactDay(events, meta));
    expect("timestamp" in back[0]).toBe(false);
    expect(back[1].timestamp).toBe("");
    expect(back[2].timestamp).toBe("not a date");
  });

  it("survives a row whose timestamp is days from the day's anchor", () => {
    const events = [{ action: "collected", productName: "A", timestamp: "2026-03-01T05:00:00.000Z" }];
    const back = expandDay(compactDay(events, meta));
    expect(back[0].timestamp).toBe("2026-03-01T05:00:00.000Z");
  });

  it("keeps qty 0 distinct from qty absent", () => {
    const events = [
      { action: "placed", productName: "A", qty: 0 },
      { action: "placed", productName: "A" },
    ];
    const back = expandDay(compactDay(events, meta));
    expect(back[0].qty).toBe(0);
    expect("qty" in back[1]).toBe(false);
  });

  it("does not let a product called __proto__ poison the dictionary", () => {
    const events = [
      { action: "placed", productName: "__proto__", timestamp: "2026-09-18T08:00:00.000Z" },
      { action: "placed", productName: "constructor", timestamp: "2026-09-18T08:01:00.000Z" },
    ];
    const back = expandDay(compactDay(events, meta));
    expect(back.map((e) => e.productName)).toEqual(["__proto__", "constructor"]);
  });

  it("an empty day is an empty day, not a null", () => {
    const node = compactDay([], meta);
    expect(node.n).toBe(0);
    expect(expandDay(node)).toEqual([]);
  });
});

// ─── THE STORE BUCKETS ARE THE SCREEN'S OWN PREDICATES ───────────────────────
//
// "N events in view" is not the window's count — it is every event this store
// has ever logged. A reader that fetched only the days in the window could not
// produce it, so the day node carries per-store counts. They are only useful if
// they partition exactly the way `matchesStore` in App.jsx does, so that is
// what is compared: this transcription against the original, over a real day.
describe("storeBucketOf — transcribed from App.jsx matchesStore", () => {
  // Verbatim from src/App.jsx (InsightsView).
  const matchers = {
    pine: (e) => e && (e.destShop === "marathon-pine" || e.placedAtHub === "hub3"),
    trophy: (e) => e && e.destShop === "trophy",
    pe: (e) => e && (e.destShop === "marathon-pe" || (e.destShop == null && e.placedAtHub !== "hub3")),
  };

  it("agrees with the screen's filters on every row of a real day", async () => {
    const { storeBucketOf, countByStore } = await import("./rollupCodec");
    const rows = Object.keys(DAY).sort().map((k) => DAY[k]);
    for (const e of rows) {
      const bucket = storeBucketOf(e);
      for (const [name, match] of Object.entries(matchers)) {
        expect(match(e) ? name : null).toBe(bucket === name ? name : null);
      }
    }
    const counts = countByStore(rows);
    for (const [name, match] of Object.entries(matchers)) {
      expect(counts[name]).toBe(rows.filter(match).length);
    }
  });

  it("puts every row in exactly one bucket, so the three sum to the day", async () => {
    const { countByStore } = await import("./rollupCodec");
    const rows = Object.keys(DAY).sort().map((k) => DAY[k]);
    const c = countByStore(rows);
    expect(c.pe + c.trophy + c.pine + c.other).toBe(rows.length);
  });

  it("counts a destShop nobody filters on separately, never into a store", async () => {
    const { storeBucketOf } = await import("./rollupCodec");
    expect(storeBucketOf({ destShop: "somewhere-new" })).toBe("other");
    for (const m of Object.values(matchers)) expect(!!m({ destShop: "somewhere-new" })).toBe(false);
  });
});
