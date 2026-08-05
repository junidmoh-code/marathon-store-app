import { describe, it, expect } from "vitest";
import {
  computeMissingProducts, groupOf, countByCategory, isClothing,
  buildChips, pickActiveTab,
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

// Owner directive 2026-08-05: exactly two chips — Sneakers and Clothing, with
// Clothing holding EVERYTHING non-sneaker. This supersedes the 2026-08-04
// per-subcategory chips (PR #308); these tests pin the new contract so a revert
// to per-type chips fails here.
describe("groupOf — everything in this tab is Clothing", () => {
  it("puts every product type under the ONE Clothing chip", () => {
    for (const p of [TEE, JERSEY, BAG, WATCH, BELT, UNCAT]) {
      expect(groupOf(p)).toEqual({ key: "clothing", label: "Clothing" });
    }
  });
  it("uncategorised is not split out — it is simply part of Clothing", () => {
    // Under #308 this was its own chip (45% of the tab). The 2026-08-05
    // directive folds it in: nothing is hidden, because the Clothing chip IS
    // the whole tab.
    expect(groupOf(UNCAT).key).toBe("clothing");
    expect(groupOf({ subcategory: "" }).key).toBe("clothing");
    expect(groupOf({}).key).toBe("clothing");
    expect(groupOf(null).key).toBe("clothing");
  });
});

describe("computeMissingProducts — which products are stranded", () => {
  it("flags Central-only stock as 'Only in Central'", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: "t1", source: "central", kind: "Only in Central", units: 5, group: "clothing", groupLabel: "Clothing" });
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
  it("bags and watches land in the tab — under Clothing", () => {
    const cards = computeMissingProducts({
      allStock: { central: { b1: { _: cell(6) }, w1: { _: cell(2) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.group))).toEqual(new Set(["clothing"]));
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
    central: { t1: { M: cell(4) }, j1: { L: cell(3) }, b1: { _: cell(6) }, w1: { _: cell(2) }, be1: { _: cell(1) }, u1: { M: cell(7) } },
  };
  it("every card counts under the one Clothing chip", () => {
    const counts = countByCategory(computeMissingProducts({ allStock, products: PRODUCTS }));
    expect(counts).toEqual({ clothing: 6 });
  });
  it("THE LOAD-BEARING PROPERTY: the chips account for every single card", () => {
    // If this ever fails, stranded stock is invisible in the one tab meant to
    // surface it. With one Clothing bucket this reduces to "the chip count IS
    // the card count" — asserted directly.
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const summed = Object.values(countByCategory(cards)).reduce((a, b) => a + b, 0);
    expect(summed).toBe(cards.length);
  });
  it("and the Clothing chip's count matches the list the tab renders", () => {
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    expect(cards.filter((c) => c.group === "clothing")).toHaveLength(countByCategory(cards).clothing);
  });
});

describe("buildChips + pickActiveTab — two fixed chips", () => {
  const card = () => ({ group: "clothing", groupLabel: "Clothing" });
  const many = (n) => Array.from({ length: n }, card);

  it("is always exactly [Clothing, Sneakers] — no per-type chips", () => {
    expect(buildChips(many(41), 12)).toEqual([
      ["clothing", "Clothing", 41],
      ["sneakers", "Sneakers", 12],
    ]);
  });
  it("both chips render even at zero, so the row never reshuffles", () => {
    expect(buildChips([], 0)).toEqual([
      ["clothing", "Clothing", 0],
      ["sneakers", "Sneakers", 0],
    ]);
    expect(buildChips(undefined, undefined)).toEqual([
      ["clothing", "Clothing", 0],
      ["sneakers", "Sneakers", 0],
    ]);
  });
  it("keeps the user's selection while it still exists", () => {
    const chips = buildChips(many(5), 3);
    expect(pickActiveTab(chips, "clothing")).toBe("clothing");
    expect(pickActiveTab(chips, "sneakers")).toBe("sneakers");
  });
  it("a stale per-type selection from before this change falls back, never blanks", () => {
    // An operator could have "bags" persisted from the #308 chip row.
    const chips = buildChips(many(5), 3);
    for (const stale of ["bags", "watches", "uncategorised", "nonsense", null, undefined]) {
      expect(pickActiveTab(chips, stale)).toBe("clothing");
    }
  });
  it("opens on Clothing when nothing has been chosen yet", () => {
    expect(pickActiveTab(buildChips(many(2), 4), null)).toBe("clothing");
  });
  it("never returns a key that isn't in the rendered row", () => {
    const chips = buildChips(many(3), 1);
    const keys = chips.map(([k]) => k);
    for (const sel of ["bags", "t-shirts", "nonsense", undefined, null]) {
      expect(keys).toContain(pickActiveTab(chips, sel));
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
