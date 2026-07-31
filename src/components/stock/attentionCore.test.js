import { describe, it, expect } from "vitest";
import {
  buildAttentionIndex, selectAttentionRows, summarise, brandOptions,
  soldUnitsByProduct, receivedProductIds, sizeBreakdown, rowCostValue,
  findStep, findSort, defaultSortFor,
  VIEW_LOW, VIEW_OVER, VIEW_DEAD, LOW_STEPS, OVER_STEPS, DEAD_MIN_STEPS,
} from "./attentionCore";

const cell = (qty) => ({ qty, v: 1 });

const PRODUCTS = {
  shoe1: { id: "shoe1", name: "Nike Air Max", category: "Footwear", brand: "Nike", stockPrice: 800, retailPrice: 1600 },
  shoe2: { id: "shoe2", name: "Diesel Slide", category: "Footwear", brand: "Diesel", stockPrice: 200 },
  tee1:  { id: "tee1",  name: "Marathon Tee", category: "Clothing", brand: "Marathon", stockPrice: 100 },
  cap1:  { id: "cap1",  name: "Snapback",     category: "Accessories", brand: "Nike" },
  odd1:  { id: "odd1",  name: "Mystery Item" },   // no category → Uncategorized
};

// shoe1: 2 at PE + 1 at Trophy + 10 in hub2. shoe2: 40 in hub2 only.
// tee1: 3 at PE. cap1: 1 at Trophy.
const TREE = {
  "marathon-pe": { shoe1: { 8: cell(2) }, tee1: { M: cell(3) } },
  trophy:        { shoe1: { 9: cell(1) }, cap1: { _: cell(1) } },
  hub2:          { shoe1: { 8: cell(10) }, shoe2: { 9: cell(40) } },
};

describe("buildAttentionIndex", () => {
  it("sums a product across every location into one line", () => {
    // Location is not modelled — 2 at PE + 1 at Trophy + 10 in hub2 is one
    // style with 13 units, full stop.
    const e = buildAttentionIndex(TREE).get("shoe1");
    expect(e.total).toBe(13);
    expect(e.sizes.get("8")).toBe(12);  // 2 (PE) + 10 (hub2)
    expect(e.sizes.get("9")).toBe(1);   // Trophy
  });

  it("merges the raw and encoded spellings of one half-size", () => {
    // The warehouse writes "5.5"; the POS writes "5_5". Same shoe.
    const e = buildAttentionIndex({
      hub1: { shoe1: { "5.5": cell(4) } },
      trophy: { shoe1: { "5_5": cell(3) } },
    }).get("shoe1");
    expect(e.sizes.size).toBe(1);
    expect(e.sizes.get("5.5")).toBe(7);
  });

  it("skips cells with a missing or non-numeric qty rather than reading them as zero", () => {
    const e = buildAttentionIndex({ trophy: { shoe1: { 8: { v: 1 }, 9: { qty: "3" }, 10: cell(5) } } }).get("shoe1");
    expect(e.total).toBe(5);
    expect(e.sizes.has("8")).toBe(false);
  });

  it("survives a malformed tree", () => {
    expect(buildAttentionIndex(null).size).toBe(0);
    expect(buildAttentionIndex({ trophy: null }).size).toBe(0);
    expect(buildAttentionIndex({ trophy: { shoe1: null } }).size).toBe(0);
  });
});

describe("soldUnitsByProduct", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const since = now - 7 * 86400000;

  it("counts sales only — a transfer between our own locations is not a sale", () => {
    const sold = soldUnitsByProduct({
      a: { type: "sold", productId: "shoe1", qty: 2, ts: iso(1) },
      b: { type: "transfer_out", productId: "shoe1", qty: 9, ts: iso(1) },
      c: { type: "received", productId: "shoe1", qty: 9, ts: iso(1) },
      d: { type: "adjustment", productId: "tee1", qty: 5, ts: iso(1) },
    }, since);
    expect(sold.get("shoe1")).toBe(2);
    expect(sold.has("tee1")).toBe(false);
  });

  it("ignores movements outside the window, and unparseable/incomplete rows", () => {
    const sold = soldUnitsByProduct({
      old:  { type: "sold", productId: "shoe1", qty: 1, ts: iso(30) },
      bad:  { type: "sold", productId: "shoe2", qty: 1, ts: "nonsense" },
      noid: { type: "sold", qty: 1, ts: iso(1) },
      ok:   { type: "sold", productId: "tee1", qty: 4, ts: iso(2) },
    }, since);
    expect(Array.from(sold.entries())).toEqual([["tee1", 4]]);
  });
});

describe("receivedProductIds", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const since = now - 7 * 86400000;

  it("collects deliveries inside the window only", () => {
    const arrived = receivedProductIds({
      a: { type: "received", productId: "shoe1", ts: iso(2) },
      b: { type: "received", productId: "tee1", ts: iso(30) },
      c: { type: "transfer_out", productId: "shoe2", ts: iso(1) },
    }, since);
    expect(Array.from(arrived)).toEqual(["shoe1"]);
  });
});

describe("row shaping", () => {
  it("sorts size chips by quantity and labels the one-size sentinel", () => {
    expect(sizeBreakdown(new Map([["M", 2], ["L", 7], ["_", 1], ["S", 0]]))).toEqual([
      { size: "L", qty: 7 }, { size: "M", qty: 2 }, { size: "One size", qty: 1 },
    ]);
  });

  it("values stock at COST, and returns null (not zero) when there's no cost price", () => {
    expect(rowCostValue({ stockPrice: 250 }, 4)).toBe(1000);
    expect(rowCostValue({ stockPrice: 0 }, 4)).toBeNull();
    expect(rowCostValue({}, 4)).toBeNull();
  });

});

describe("selectAttentionRows — LOW", () => {
  const index = buildAttentionIndex(TREE);
  const base = { index, productsById: PRODUCTS, view: VIEW_LOW };

  it("lists styles at or under the chosen rung, fewest first", () => {
    const rows = selectAttentionRows({ ...base, lowStepId: "5" }); // ≤4
    expect(rows.map((r) => [r.id, r.total])).toEqual([["cap1", 1], ["tee1", 3]]);
  });

  it("judges 'low' on the network total, not on any one building", () => {
    // shoe1 is down to 2 on the PE floor but we own 13 — it is not low.
    const rows = selectAttentionRows({ ...base, lowStepId: "3" }).map((r) => r.id);
    expect(rows).not.toContain("shoe1");
    expect(rows).toEqual(["cap1", "tee1"]);
  });

  it("respects the rung boundary exactly", () => {
    expect(selectAttentionRows({ ...base, lowStepId: "1" }).map((r) => r.id)).toEqual(["cap1"]);
    expect(findStep(LOW_STEPS, "3").max).toBe(3);
    expect(findStep(LOW_STEPS, "nope", "5").max).toBe(4);
  });

  it("filters by category and brand", () => {
    const clothing = selectAttentionRows({ ...base, lowStepId: "10", category: "Clothing" });
    expect(clothing.map((r) => r.id)).toEqual(["tee1"]);

    const nike = selectAttentionRows({ ...base, lowStepId: "10", brand: "Nike" });
    expect(nike.map((r) => r.id)).toEqual(["cap1"]); // shoe1 is 13 → above the rung
  });

  it("classifies an uncategorised product rather than dropping it", () => {
    const rows = selectAttentionRows({
      index: buildAttentionIndex({ trophy: { odd1: { _: cell(1) } } }),
      productsById: PRODUCTS, view: VIEW_LOW, lowStepId: "5", category: "Uncategorized",
    });
    expect(rows.map((r) => r.id)).toEqual(["odd1"]);
  });

  it("drops stock whose product has left the catalogue", () => {
    const rows = selectAttentionRows({
      index: buildAttentionIndex({ trophy: { ghost: { 8: cell(1) } } }),
      productsById: PRODUCTS, view: VIEW_LOW, lowStepId: "5",
    });
    expect(rows).toEqual([]);
  });

  it("never lists a style that is simply out of stock", () => {
    const rows = selectAttentionRows({
      index: buildAttentionIndex({ trophy: { tee1: { M: cell(0) } } }),
      productsById: PRODUCTS, view: VIEW_LOW, lowStepId: "5",
    });
    expect(rows).toEqual([]);
  });
});

describe("selectAttentionRows — OVER", () => {
  const index = buildAttentionIndex(TREE);

  it("lists styles at or over the rung", () => {
    const rows = selectAttentionRows({ index, productsById: PRODUCTS, view: VIEW_OVER, overStepId: "20" });
    expect(rows.map((r) => [r.id, r.total])).toEqual([["shoe2", 40]]);
    expect(findStep(OVER_STEPS, "50").min).toBe(50);
  });

  it("values the pile at cost", () => {
    const [row] = selectAttentionRows({ index, productsById: PRODUCTS, view: VIEW_OVER, overStepId: "20" });
    expect(row.costValue).toBe(8000); // 40 × R200
  });

  it("offers the rungs highest-first, with 20+ last", () => {
    expect(OVER_STEPS.map((s) => s.id)).toEqual(["200", "100", "50", "20"]);
  });
});

describe("selectAttentionRows — DEAD", () => {
  const index = buildAttentionIndex(TREE);
  // deadMinId "3" keeps the fixture's 3-unit tee in play; the default is 5.
  const base = { index, productsById: PRODUCTS, view: VIEW_DEAD, deadMinId: "3" };

  it("lists in-stock styles with no sale in the window, biggest pile first", () => {
    const rows = selectAttentionRows({ ...base, soldMap: new Map([["shoe1", 2]]) });
    // shoe1 sold → moving. cap1 has 1 unit → below the floor, not "stagnant".
    expect(rows.map((r) => r.id)).toEqual(["shoe2", "tee1"]);
  });

  it("tags a freshly delivered style instead of calling it dead", () => {
    const rows = selectAttentionRows({ ...base, soldMap: new Map(), arrivedSet: new Set(["shoe2"]) });
    expect(rows.find((r) => r.id === "shoe2").justArrived).toBe(true);
    expect(rows.find((r) => r.id === "tee1").justArrived).toBe(false);
  });

  it("can hide just-arrived stock", () => {
    const rows = selectAttentionRows({ ...base, soldMap: new Map(), arrivedSet: new Set(["shoe2"]), hideJustArrived: true });
    expect(rows.map((r) => r.id)).not.toContain("shoe2");
  });

  it("ignores styles down to their last few — nearly sold out is not stagnant", () => {
    // cap1 holds 1 unit. There is nothing left for it to move.
    const rows = selectAttentionRows({ ...base, soldMap: new Map() });
    expect(rows.map((r) => r.id)).not.toContain("cap1");

    // Raising the floor drops the 3-unit tee too.
    const strict = selectAttentionRows({ ...base, deadMinId: "5", soldMap: new Map() });
    expect(strict.map((r) => r.id)).toEqual(["shoe1", "shoe2"].sort((a, b) => ({ shoe1: 13, shoe2: 40 })[b] - ({ shoe1: 13, shoe2: 40 })[a]));
    expect(DEAD_MIN_STEPS.map((s) => s.min)).toEqual([3, 5, 10, 20]);
  });

  it("still flags a style whose only movements were transfers", () => {
    // soldMap holds sales only, so a transfer-heavy style stays dead.
    const rows = selectAttentionRows({ ...base, soldMap: new Map() });
    expect(rows.map((r) => r.id)).toContain("shoe1");
  });
});

describe("sorting", () => {
  const index = buildAttentionIndex(TREE);
  const rows = (sortId) => selectAttentionRows({ index, productsById: PRODUCTS, view: VIEW_LOW, lowStepId: "20", sortId }).map((r) => r.id);

  it("orders by quantity, value and name", () => {
    expect(rows("qtyAsc")).toEqual(["cap1", "shoe1", "tee1"].sort((a, b) => {
      const q = { cap1: 1, tee1: 3, shoe1: 13 };
      return q[a] - q[b];
    }));
    expect(rows("qtyDesc")[0]).toBe("shoe1");
    // shoe1 = 13 × R800 = R10,400 → highest; cap1 has no cost price → last.
    expect(rows("valueDesc")).toEqual(["shoe1", "tee1", "cap1"]);
    // Marathon Tee → Nike Air Max → Snapback
    expect(rows("name")).toEqual(["tee1", "shoe1", "cap1"]);
  });

  it("falls back to a known sort for an unknown id", () => {
    expect(findSort("nonsense").id).toBe("qtyAsc");
  });
});

describe("summarise + brandOptions", () => {
  const index = buildAttentionIndex(TREE);
  const rows = selectAttentionRows({ index, productsById: PRODUCTS, view: VIEW_LOW, lowStepId: "20" });

  it("adds up styles, units and cash — and reports what it couldn't price", () => {
    const s = summarise(rows);
    expect(s.styles).toBe(3);
    expect(s.units).toBe(17);              // 13 + 3 + 1
    expect(s.value).toBe(10700);           // 13×800 + 3×100; cap1 unpriced
    expect(s.valueMissing).toBe(1);
  });

  it("offers only brands present in the result set, most common first", () => {
    // Nike twice (Air Max + Snapback), Marathon once.
    expect(brandOptions(rows).map((b) => [b.brand, b.count])).toEqual([["Nike", 2], ["Marathon", 1]]);
    expect(brandOptions([])).toEqual([]);
  });
});
