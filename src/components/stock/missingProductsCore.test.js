import { describe, it, expect } from "vitest";
import {
  computeMissingProducts, categoryOf, countByCategory, isClothing, MISSING_CATEGORIES,
} from "./missingProductsCore";

// Live catalogue shapes (2026-08-03). Bags, watches and belts are all recorded
// as productType "clothing" — that is why they appear in this tab at all.
const TEE     = { id: "t1", name: "Nike Tee",     category: "Clothing",    subcategory: "T-Shirts", productType: "clothing", sizes: ["S", "M", "L"] };
const JERSEY  = { id: "j1", name: "Real Madrid",  category: "Clothing",    subcategory: "Jerseys",  productType: "clothing", sizes: ["M", "L"] };
const UNCAT   = { id: "u1", name: "Mystery top",  category: "Clothing",    subcategory: "Clothing — Uncategorized", productType: "clothing", sizes: ["M"] };
const BAG     = { id: "b1", name: "Nike Duffel",  category: "Accessories", subcategory: "Bags",     productType: "clothing", sizes: ["_"] };
const WATCH   = { id: "w1", name: "Swarovski",    category: "Accessories", subcategory: "Watches",  productType: "clothing", sizes: ["_"] };
const BELT    = { id: "be1", name: "Belt Premium", category: "Accessories", subcategory: "Belts",   productType: "clothing", sizes: ["_"] };
const SNEAKER = { id: "s1", name: "Air Force 1",  category: "Footwear",    subcategory: "Sneakers", productType: "sneaker",  sizes: ["8", "9"] };
const PERFUME = { id: "pf1", name: "Queen of Fire", category: "Perfume",   subcategory: "Perfume",  sizes: ["_"] };

const PRODUCTS = [TEE, JERSEY, UNCAT, BAG, WATCH, BELT, SNEAKER, PERFUME];
const cell = (qty) => ({ qty });

describe("categoryOf — the chip a product lands under", () => {
  it("keys watches and bags off subcategory, everything clothing off category", () => {
    expect(categoryOf(WATCH)).toBe("watches");
    expect(categoryOf(BAG)).toBe("bags");
    expect(categoryOf(TEE)).toBe("clothing");
    expect(categoryOf(JERSEY)).toBe("clothing");
    expect(categoryOf(UNCAT)).toBe("clothing");
  });
  it("sends every other accessory to the catch-all rather than nowhere", () => {
    expect(categoryOf(BELT)).toBe("other");
    expect(categoryOf({ category: "Accessories", subcategory: "Eyewear" })).toBe("other");
    expect(categoryOf({ category: "Accessories", subcategory: "Jewellery" })).toBe("other");
    expect(categoryOf(PERFUME)).toBe("other");
  });
  it("is case- and whitespace-insensitive, and survives missing fields", () => {
    expect(categoryOf({ subcategory: "  watches " })).toBe("watches");
    expect(categoryOf({ subcategory: "BAGS" })).toBe("bags");
    expect(categoryOf({ category: "clothing" })).toBe("clothing");
    expect(categoryOf({})).toBe("other");
    expect(categoryOf(null)).toBe("other");
  });
  it("only ever returns a key the chip row knows about", () => {
    const keys = new Set(MISSING_CATEGORIES.map((c) => c.key));
    for (const p of PRODUCTS) expect(keys.has(categoryOf(p))).toBe(true);
  });
});

describe("computeMissingProducts — which products are stranded", () => {
  it("flags Central-only stock as 'Only in Central'", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: "t1", source: "central", kind: "Only in Central", units: 5, category: "clothing" });
    expect(cards[0].missing).toEqual(["hub2", "marathon-pe", "trophy"]);
  });
  it("flags Hub 2 stock no shop carries as 'Only in Hub 2'", () => {
    const cards = computeMissingProducts({
      allStock: { hub2: { t1: { M: cell(3) } } }, products: PRODUCTS,
    });
    expect(cards[0]).toMatchObject({ source: "hub2", kind: "Only in Hub 2" });
    expect(cards[0].missing).toEqual(["marathon-pe", "trophy"]);
  });
  it("a shop CARRYING it retires the card, even at qty 0 — that's what Solve does", () => {
    const carriedZero = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } }, trophy: { t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(carriedZero).toHaveLength(0);
  });
  it("Central stock already buffered at Hub 2 is not stranded", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } }, hub2: { t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("excludes sneakers (their own tab) and anything with no upstream units", () => {
    const cards = computeMissingProducts({
      allStock: { central: { s1: { 9: cell(10) }, t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("excludes perfume — no productType and no garment size means not clothing", () => {
    const cards = computeMissingProducts({
      allStock: { central: { pf1: { _: cell(9) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("negative cells never count as available units", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(-4), L: cell(2) } } }, products: PRODUCTS,
    });
    expect(cards[0].units).toBe(2);
    expect(cards[0].sizes.map((s) => s.size)).toEqual(["L"]);
  });
  it("sorts by units, heaviest first", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(2) }, j1: { L: cell(9) }, b1: { _: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards.map((c) => c.pid)).toEqual(["j1", "b1", "t1"]);
  });
  it("survives empty, absent and MALFORMED input without throwing", () => {
    expect(computeMissingProducts({ allStock: {}, products: [] })).toEqual([]);
    expect(computeMissingProducts({})).toEqual([]);
    expect(computeMissingProducts()).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { ghost: { M: cell(3) } } }, products: PRODUCTS })).toEqual([]);
    // The shapes that actually threw before hardening: the raw /products MAP
    // instead of the array the app passes, and null/undefined members. A crash
    // here blanks the whole Health screen, so it must degrade to "nothing
    // stranded" instead. (Codex review, PR #308.)
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: {} })).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: null })).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: "nope" })).toEqual([]);
    expect(() => computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: [null, undefined, TEE] })).not.toThrow();
  });
});

describe("countByCategory — the chip numbers", () => {
  const allStock = {
    central: { t1: { M: cell(4) }, j1: { L: cell(3) }, b1: { _: cell(6) }, w1: { _: cell(2) }, be1: { _: cell(1) } },
  };
  it("counts cards per chip", () => {
    const counts = countByCategory(computeMissingProducts({ allStock, products: PRODUCTS }));
    expect(counts).toEqual({ clothing: 2, bags: 1, watches: 1, other: 1 });
  });
  it("reports every chip key even at zero, so the row never guesses", () => {
    expect(Object.keys(countByCategory([])).sort()).toEqual(MISSING_CATEGORIES.map((c) => c.key).sort());
  });
  it("THE LOAD-BEARING PROPERTY: the chips account for every single card", () => {
    // If this ever fails, stranded stock is invisible in the one tab meant to
    // surface it — the whole reason "other" exists.
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const counts = countByCategory(cards);
    const summed = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(cards.length);
  });
  it("and the count matches the list the tab renders, per chip", () => {
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const counts = countByCategory(cards);
    for (const { key } of MISSING_CATEGORIES) {
      expect(cards.filter((c) => c.category === key)).toHaveLength(counts[key]);
    }
  });
});

describe("isClothing — unchanged from the engine's definition", () => {
  it("prefers the explicit flag", () => {
    expect(isClothing(TEE)).toBe(true);
    expect(isClothing(BAG)).toBe(true);
    expect(isClothing(SNEAKER)).toBe(false);
  });
  it("falls back to the garment-size heuristic when productType is absent", () => {
    expect(isClothing({ sizes: ["M", "L"] })).toBe(true);
    expect(isClothing({ sizes: ["_"] })).toBe(false);
    expect(isClothing({ sizes: ["9", "10"] })).toBe(false);
    expect(isClothing(null)).toBe(false);
  });
});
