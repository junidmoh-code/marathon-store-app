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

  it("drops EXACTLY the fields no served screen reads — no more, no less", () => {
    // The first version of this compared against an allow-list that contained
    // most of the KEPT fields, so the codec could have dropped `size`,
    // `orderNumber` or `customerPhone` and it would still have passed. It was
    // a test of nothing. (Fable-vs-spec review.)
    //
    // Now: every field ANY row of the real day carries, minus every field the
    // codec kept, must equal the known-unused set exactly.
    const present = new Set();
    for (const e of eventsInKeyOrder) for (const k of Object.keys(e)) present.add(k);
    const kept = new Set();
    for (const e of back) for (const k of Object.keys(e)) kept.add(k);

    const dropped = [...present].filter((k) => !kept.has(k)).sort();
    expect(dropped).toEqual([
      // The refill engine's own marker, POS sale identity, and the
      // duplicate-audit trail. No screen served from this node reads any of
      // them — `autoRefill` in particular is read by the WAREHOUSE batch card
      // off /orders, never off an insights_log row, and none of the Insights
      // selectors exclude engine events. Adding a reader means adding a column
      // and bumping ROLLUP_SHAPE, not reading around the rollup.
      "autoRefill", "by", "matchedProductIds", "matchedProductNames",
      "matchedUnits", "saleId", "source",
    ].sort());

    // …and every field the screens DO read survived, on this real day.
    for (const k of ["action", "timestamp", "productName", "productId", "size",
      "productType", "productCategory", "orderNumber", "placedAtHub", "destShop",
      "qty", "customerName", "customerPhone"]) {
      expect(kept.has(k), `${k} must survive the codec`).toBe(true);
    }
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

// ─── A DAY THE SHOP LOGGED NOTHING ON ────────────────────────────────────────
//
// RTDB cannot store an empty array or an empty object — writing one removes the
// key — so a day with no events comes back with no `rows` and no `dict` at all.
// Treating that as a broken node meant every window containing 2026-06-30 (a
// real, genuinely empty day) did a needless live read and warned about a node
// that was perfectly correct. Found on production by
// scripts/verify-insights-rollup.mjs, not here, which is why this test exists.
describe("an empty day, as RTDB actually returns it", () => {
  it("decodes to an empty day, not to a refusal", async () => {
    const { expandDay: ex, ROLLUP_SHAPE: V } = await import("./rollupCodec");
    // Exactly what the live node for 2026-06-30 looks like: no rows, no dict.
    const stored = { v: V, n: 0, date: "2026-06-30", anchorMs: 0, cursorEnd: null, byStore: { pe: 0, trophy: 0, pine: 0, other: 0 } };
    expect(ex(stored)).toEqual([]);
  });

  it("still refuses a node that claims rows and carries none", async () => {
    const { expandDay: ex, ROLLUP_SHAPE: V } = await import("./rollupCodec");
    expect(ex({ v: V, n: 12, date: "2026-06-30", anchorMs: 0 })).toBeNull();
  });

  it("a compacted empty day survives the round trip RTDB would give it", () => {
    const node = compactDay([], { date: "2026-06-30", anchorMs: 0 });
    // Strip what RTDB strips: empty arrays and empty objects.
    const stored = JSON.parse(JSON.stringify(node, (k, v) => {
      if (Array.isArray(v) && v.length === 0) return undefined;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return undefined;
      return v;
    }));
    expect(stored.rows).toBeUndefined();
    expect(expandDay(stored)).toEqual([]);
  });
});
