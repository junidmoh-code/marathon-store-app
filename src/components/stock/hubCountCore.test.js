// ─── HUB SNEAKER COUNT — core tests ───────────────────────────────────────────
// Pins the three data facts the feature would silently get wrong: sneaker is
// CATEGORY not productType, the "_" one-size sentinel is excluded, and the
// staleness test is what stops a concurrent counter being overwritten.
import { describe, it, expect } from "vitest";
import {
  hubOptions, buildHubRows, seededRowFor, mergeSeededRows, progressOf,
  isRowSettled, isStaleExpectation, varianceRows, filterRows, cellKey,
  isCountableSizeKey, sizeLabelOf, recoverSeededRows,
} from "./hubCountCore.js";

const SHOE = { id: "sh1", name: "Nike Air Max 1", category: "Footwear", barcode: "10000001", sizes: ["5.5", "6", "7"] };
const SHOE2 = { id: "sh2", name: "Adidas Samba", category: "Footwear", barcode: "10000002", sizes: ["6", "7"] };
// The live-data trap: 858 products carry NO productType, and perfumes carry
// productType "sneaker". Category is the only trustworthy signal.
const NO_TYPE_SHOE = { id: "sh3", name: "Puma Suede", category: "Footwear", sizes: ["8"] };
const FAKE_SNEAKER = { id: "pf1", name: "Some perfume", category: "Perfume", productType: "sneaker", sizes: ["_"] };
const TEE = { id: "cl1", name: "Chelsea jersey", category: "Clothing", productType: "clothing", sizes: ["S", "M"] };
const PRODUCTS = [SHOE, SHOE2, NO_TYPE_SHOE, FAKE_SNEAKER, TEE];

const cell = (qty) => ({ qty, v: 1, mv: "m1", lastType: "received" });

describe("what gets counted", () => {
  it("lists sneaker products holding cells at the hub, by category not productType", () => {
    const rows = buildHubRows({
      products: PRODUCTS,
      hubStock: { sh1: { 6: cell(3) }, sh3: { 8: cell(1) }, cl1: { M: cell(4) } },
    });
    expect(rows.map((r) => r.id)).toEqual(["sh1", "sh3"]);   // clothing excluded
  });

  it("counts a product with NO productType — the 858-record case", () => {
    const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh3: { 8: cell(2) } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Puma Suede");
  });

  it("does NOT count a perfume mislabelled productType 'sneaker'", () => {
    expect(buildHubRows({ products: PRODUCTS, hubStock: { pf1: { _: cell(5) } } })).toEqual([]);
  });

  it("skips a cell whose product record is missing entirely", () => {
    expect(buildHubRows({ products: PRODUCTS, hubStock: { ghost: { 8: cell(9) } } })).toEqual([]);
  });
});

describe("the '_' one-size sentinel and _meta are excluded", () => {
  it("rejects both as countable size keys", () => {
    expect(isCountableSizeKey("_")).toBe(false);
    expect(isCountableSizeKey("_meta")).toBe(false);
    expect(isCountableSizeKey("5_5")).toBe(true);
    expect(isCountableSizeKey("8")).toBe(true);
  });

  it("drops a phantom '_' cell sitting on a shoe, keeping the real sizes", () => {
    const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { _: cell(4), 6: cell(3), 7: cell(2) } } });
    expect(rows[0].sizes.map((s) => s.sizeKey)).toEqual(["6", "7"]);
    expect(rows[0].total).toBe(5);                     // the phantom 4 is NOT in the on-hand total
  });

  it("drops a shoe whose only cell is the sentinel — nothing to count", () => {
    expect(buildHubRows({ products: PRODUCTS, hubStock: { sh1: { _: cell(4) } } })).toEqual([]);
  });

  it("ignores _meta at the product level and the size level", () => {
    const rows = buildHubRows({
      products: PRODUCTS,
      hubStock: { _meta: { anything: 1 }, sh1: { _meta: { x: 1 }, 6: cell(3) } },
    });
    expect(rows.map((r) => r.id)).toEqual(["sh1"]);
    expect(rows[0].sizes).toHaveLength(1);
  });
});

describe("size keys stay encoded and sort numerically", () => {
  it("keeps the stored key as identity and decodes only for display", () => {
    const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 10: cell(1), "5_5": cell(2), 6: cell(3) } } });
    expect(rows[0].sizes.map((s) => s.sizeKey)).toEqual(["5_5", "6", "10"]);
    expect(rows[0].sizes.map((s) => s.label)).toEqual(["5.5", "6", "10"]);
    expect(sizeLabelOf("5_5")).toBe("5.5");
  });
});

describe("on-hand totals stay honest", () => {
  it("does NOT clamp a negative cell — the discrepancy is the point of a count", () => {
    const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(-3), 7: cell(5) } } });
    expect(rows[0].total).toBe(2);
    expect(rows[0].sizes[0].expected).toBe(-3);
  });
});

describe("adding a product that has no cell at this hub", () => {
  it("seeds every size from zero, off the product's own size list", () => {
    const row = seededRowFor(SHOE);
    expect(row.seeded).toBe(true);
    expect(row.total).toBe(0);
    expect(row.sizes.map((s) => s.sizeKey)).toEqual(["5_5", "6", "7"]);
    expect(row.sizes.every((s) => s.expected === 0)).toBe(true);
  });

  it("strips the '_' sentinel from a seeded row too", () => {
    const row = seededRowFor({ id: "x", name: "Odd shoe", category: "Footwear", sizes: ["_", "8"] });
    expect(row.sizes.map((s) => s.sizeKey)).toEqual(["8"]);
  });

  it("returns null when a product has no countable size at all", () => {
    expect(seededRowFor({ id: "x", name: "Belt", sizes: ["_"] })).toBeNull();
  });

  it("never produces a duplicate ROW for a product the hub snapshot already covers", () => {
    const hubRows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(3) } } });
    const merged = mergeSeededRows(hubRows, [seededRowFor(SHOE), seededRowFor(SHOE2)]);
    expect(merged.map((r) => r.id).sort()).toEqual(["sh1", "sh2"]);
  });

  // ── THE SIZE-COLLAPSE REGRESSION ──────────────────────────────────────────
  // Merging by PRODUCT instead of by SIZE silently deletes the sizes the hub has
  // no cell for yet — which is every size the counter has not reached. It is the
  // add-a-missing-product flow eating its own work.
  it("MERGES BY SIZE: a real cell never swallows the seeded sizes beside it", () => {
    const hubRows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(3) } } });
    const merged = mergeSeededRows(hubRows, [seededRowFor(SHOE)]);   // SHOE has 5.5, 6, 7
    const sh1 = merged.find((r) => r.id === "sh1");
    expect(sh1.sizes.map((s) => s.sizeKey)).toEqual(["5_5", "6", "7"]);
    expect(sh1.sizes.find((s) => s.sizeKey === "6").expected).toBe(3);   // real cell wins for 6
    expect(sh1.sizes.find((s) => s.sizeKey === "7").expected).toBe(0);   // seeded size survives
    expect(sh1.total).toBe(3);
  });

  it("reproduces the full sequence: adjust one seeded size, the others must remain", () => {
    // 1. shoe has NO cells here → seeded row with all three sizes
    const seeded = seededRowFor(SHOE);
    expect(mergeSeededRows(buildHubRows({ products: PRODUCTS, hubStock: {} }), [seeded])[0].sizes).toHaveLength(3);
    // 2. counter adjusts size 9 → a REAL cell now exists for that size only
    const afterAdjust = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(3) } } });
    // 3. the rebuild must NOT shrink the row (the old code left exactly one size)
    const merged = mergeSeededRows(afterAdjust, [seeded]);
    expect(merged.find((r) => r.id === "sh1").sizes).toHaveLength(3);
  });
});

describe("recovering seeded rows from what the session recorded", () => {
  const hubStock = { sh2: { 6: cell(1) } };

  it("rebuilds the FULL size run for a product with no cell at this hub", () => {
    const counted = { [cellKey("sh1", "7")]: { productId: "sh1", sizeKey: "7", expected: 0, actual: 0 } };
    const rows = recoverSeededRows({ counted, hubStock, products: PRODUCTS });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("sh1");
    expect(rows[0].sizes.map((s) => s.sizeKey)).toEqual(["5_5", "6", "7"]);
  });

  it("rebuilds ONLY the recorded size when the product does have other cells — never invents sizes", () => {
    const counted = { [cellKey("sh2", "7")]: { productId: "sh2", sizeKey: "7", expected: 0, actual: 0 } };
    const rows = recoverSeededRows({ counted, hubStock, products: PRODUCTS });
    expect(rows).toHaveLength(1);
    expect(rows[0].sizes.map((s) => s.sizeKey)).toEqual(["7"]);   // NOT the whole run
  });

  it("recovers nothing for a size that has a real cell — there is a row already", () => {
    const counted = { [cellKey("sh2", "6")]: { productId: "sh2", sizeKey: "6", expected: 1, actual: 1 } };
    expect(recoverSeededRows({ counted, hubStock, products: PRODUCTS })).toEqual([]);
  });

  it("survives a record whose product is gone from the catalogue", () => {
    const counted = { [cellKey("ghost", "7")]: { productId: "ghost", sizeKey: "7", expected: 0, actual: 0 } };
    expect(recoverSeededRows({ counted, hubStock, products: PRODUCTS })).toEqual([]);
  });

  it("closes the loop: a reload shows the added-from-zero row a counter confirmed", () => {
    const counted = { [cellKey("sh1", "6")]: { productId: "sh1", sizeKey: "6", expected: 0, actual: 0 } };
    const rows = mergeSeededRows(
      buildHubRows({ products: PRODUCTS, hubStock: {} }),
      recoverSeededRows({ counted, hubStock: {}, products: PRODUCTS })
    );
    expect(rows.map((r) => r.id)).toEqual(["sh1"]);
    expect(isRowSettled(rows[0], counted)).toBe(false);          // 1 of 3 sizes done
    expect(progressOf(rows, counted)).toEqual({ done: 1, total: 3 });
  });
});

describe("progress and settling", () => {
  const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(3), 7: cell(1) }, sh2: { 6: cell(2) } } });

  it("counts N of M across every countable cell", () => {
    expect(progressOf(rows, {})).toEqual({ done: 0, total: 3 });
    expect(progressOf(rows, { [cellKey("sh1", "6")]: { actual: 3 } })).toEqual({ done: 1, total: 3 });
  });

  it("settles a row only when every one of its sizes is recorded", () => {
    const sh1 = rows.find((r) => r.id === "sh1");
    expect(isRowSettled(sh1, { [cellKey("sh1", "6")]: {} })).toBe(false);
    expect(isRowSettled(sh1, { [cellKey("sh1", "6")]: {}, [cellKey("sh1", "7")]: {} })).toBe(true);
  });
});

describe("the staleness test — the anti-clobber guard", () => {
  it("is stale exactly when the live value differs from what the counter was shown", () => {
    expect(isStaleExpectation(4, 4)).toBe(false);
    expect(isStaleExpectation(4, 3)).toBe(true);
    expect(isStaleExpectation(0, 0)).toBe(false);
    expect(isStaleExpectation(0, -1)).toBe(true);   // a negative cell is still a real value
  });

  it("compares numerically, so a string-typed value cannot masquerade as a change", () => {
    expect(isStaleExpectation("4", 4)).toBe(false);
  });
});

describe("variance", () => {
  const counted = {
    [cellKey("sh1", "6")]: { productId: "sh1", sizeKey: "6", expected: 5, actual: 5 },
    [cellKey("sh1", "7")]: { productId: "sh1", sizeKey: "7", expected: 5, actual: 2 },
    [cellKey("sh2", "5_5")]: { productId: "sh2", sizeKey: "5_5", expected: 1, actual: 3 },
  };
  const byId = new Map(PRODUCTS.map((p) => [p.id, p]));

  it("lists only the rows where actual disagreed with expected, biggest gap first", () => {
    const v = varianceRows(counted, byId);
    expect(v).toHaveLength(2);
    expect(v[0].delta).toBe(-3);
    expect(v[0].name).toBe("Nike Air Max 1");
    expect(v[1].delta).toBe(2);
    expect(v[1].sizeLabel).toBe("5.5");
  });

  it("is empty when everything matched", () => {
    expect(varianceRows({ [cellKey("sh1", "6")]: { productId: "sh1", sizeKey: "6", expected: 5, actual: 5 } }, byId)).toEqual([]);
  });
});

describe("hub options come from the registry, never a hardcoded list", () => {
  it("offers active warehouses and excludes stores, transit and deactivated locations", () => {
    const registry = {
      hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true },
      hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true },
      central: { id: "central", label: "Central", kind: "warehouse", active: true },
      base: { id: "base", label: "Base", kind: "warehouse", active: false },
      trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
      in_transit: { id: "in_transit", label: "In Transit", kind: "transit", active: true },
    };
    expect(hubOptions(registry).map((h) => h.id)).toEqual(["central", "hub1", "hub2"]);
  });

  it("picks up a hub added to the registry later, with no code change", () => {
    const registry = { hub7: { id: "hub7", label: "Hub 7", kind: "warehouse", active: true } };
    expect(hubOptions(registry).map((h) => h.id)).toEqual(["hub7"]);
  });
});

describe("list filtering", () => {
  const rows = buildHubRows({ products: PRODUCTS, hubStock: { sh1: { 6: cell(1) }, sh2: { 6: cell(1) } } });
  it("matches on name or code, case-insensitively", () => {
    expect(filterRows(rows, "samba").map((r) => r.id)).toEqual(["sh2"]);
    expect(filterRows(rows, "SAMBA").map((r) => r.id)).toEqual(["sh2"]);
    expect(filterRows(rows, "10000001").map((r) => r.id)).toEqual(["sh1"]);
  });

  it("returns the whole list, in name order, for an empty query", () => {
    // Name order, not insertion order: "Adidas Samba" before "Nike Air Max 1".
    expect(filterRows(rows, "").map((r) => r.id)).toEqual(["sh2", "sh1"]);
  });
});
