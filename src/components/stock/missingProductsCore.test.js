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

describe("groupOf — the chip a product lands under", () => {
  it("is the product's own subcategory, so the chips read as product types", () => {
    expect(groupOf(TEE)).toEqual({ key: "t-shirts", label: "T-Shirts" });
    expect(groupOf(JERSEY)).toEqual({ key: "jerseys", label: "Jerseys" });
    expect(groupOf(WATCH)).toEqual({ key: "watches", label: "Watches" });
    expect(groupOf(BAG)).toEqual({ key: "bags", label: "Bags" });
    expect(groupOf(BELT)).toEqual({ key: "belts", label: "Belts" });
  });
  it("collapses every flavour of 'nobody said what this is' into one chip", () => {
    // 170 of 380 live cards are "Clothing — Uncategorized". Missing, blank and
    // the literal label all mean the same thing to an operator.
    expect(groupOf(UNCAT).key).toBe("uncategorised");
    expect(groupOf({ subcategory: "" }).key).toBe("uncategorised");
    expect(groupOf({ subcategory: "   " }).key).toBe("uncategorised");
    expect(groupOf({}).key).toBe("uncategorised");
    expect(groupOf(null).key).toBe("uncategorised");
    expect(groupOf({ subcategory: "Uncategorised" }).key).toBe("uncategorised");
  });
  it("slugs punctuation and spacing so the key is stable and URL-safe", () => {
    expect(groupOf({ subcategory: "Tracksuits & Sets" })).toEqual({ key: "tracksuits-sets", label: "Tracksuits & Sets" });
    expect(groupOf({ subcategory: "Jeans & Denim" }).key).toBe("jeans-denim");
    expect(groupOf({ subcategory: "  Bags  " })).toEqual({ key: "bags", label: "Bags" });
  });
  it("keeps the label exactly as the catalogue spells it", () => {
    expect(groupOf({ subcategory: "Hoodies & Sweatshirts" }).label).toBe("Hoodies & Sweatshirts");
  });
});

describe("computeMissingProducts — which products are stranded", () => {
  it("flags Central-only stock as 'Only in Central'", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: "t1", source: "central", kind: "Only in Central", units: 5, group: "t-shirts", groupLabel: "T-Shirts" });
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
    central: { t1: { M: cell(4) }, j1: { L: cell(3) }, b1: { _: cell(6) }, w1: { _: cell(2) }, be1: { _: cell(1) }, u1: { M: cell(7) } },
  };
  it("counts cards per product type", () => {
    const counts = countByCategory(computeMissingProducts({ allStock, products: PRODUCTS }));
    expect(counts).toEqual({ "t-shirts": 1, jerseys: 1, bags: 1, watches: 1, belts: 1, uncategorised: 1 });
  });
  it("THE LOAD-BEARING PROPERTY: the chips account for every single card", () => {
    // If this ever fails, stranded stock is invisible in the one tab meant to
    // surface it.
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const summed = Object.values(countByCategory(cards)).reduce((a, b) => a + b, 0);
    expect(summed).toBe(cards.length);
  });
  it("and the count matches the list the tab renders, per chip", () => {
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const counts = countByCategory(cards);
    for (const key of Object.keys(counts)) {
      expect(cards.filter((c) => c.group === key)).toHaveLength(counts[key]);
    }
  });
});

describe("buildChips + pickActiveTab — the chip row's state machine", () => {
  // Cards as the core emits them; buildChips reads group/groupLabel only.
  const card = (group, label) => ({ group, groupLabel: label });
  const many = (n, group, label) => Array.from({ length: n }, () => card(group, label));

  it("shows one chip per product type actually stranded, then Sneakers", () => {
    const chips = buildChips([
      ...many(35, "t-shirts", "T-Shirts"),
      ...many(39, "bags", "Bags"),
      ...many(35, "watches", "Watches"),
    ], 12);
    expect(chips).toEqual([
      ["t-shirts", "T-Shirts", 35], ["bags", "Bags", 39],
      ["watches", "Watches", 35], ["sneakers", "Sneakers", 12],
    ]);
  });
  it("orders by the taxonomy, NOT by count — chips must not reshuffle as stock moves", () => {
    const chips = buildChips([
      ...many(1, "watches", "Watches"),
      ...many(99, "t-shirts", "T-Shirts"),
      ...many(50, "tracksuits-sets", "Tracksuits & Sets"),
    ], 0);
    // T-Shirts precede Tracksuits precede Watches in the taxonomy's own row
    // order, regardless of 99 vs 50 vs 1.
    expect(chips.map(([k]) => k)).toEqual(["t-shirts", "tracksuits-sets", "watches", "sneakers"]);
  });
  it("puts Uncategorised last — visible, but never ahead of a real type", () => {
    const chips = buildChips([
      ...many(170, "uncategorised", "Uncategorised"),
      ...many(2, "watches", "Watches"),
    ], 0);
    expect(chips.map(([k]) => k)).toEqual(["watches", "uncategorised", "sneakers"]);
  });
  it("a type with nothing stranded gets no chip at all", () => {
    const chips = buildChips(many(3, "bags", "Bags"), 0);
    expect(chips.map(([k]) => k)).toEqual(["bags", "sneakers"]);
  });
  it("ranks by slug, so an oddly-spelled legacy record keeps its taxonomy position", () => {
    // "T-shirts" / "  t-shirts  " are the same chip as "T-Shirts" and must sort
    // with it, not fall to the alphabetical tail. (CodeRabbit, PR #308.)
    for (const spelling of ["T-shirts", "  t-shirts  ", "T-SHIRTS"]) {
      const chips = buildChips([card("t-shirts", spelling), card("watches", "Watches")], 0);
      expect(chips.map(([k]) => k)).toEqual(["t-shirts", "watches", "sneakers"]);
    }
  });
  it("a subcategory the taxonomy has never heard of still gets a chip", () => {
    // The point of building from cards: no code change when the catalogue grows.
    const chips = buildChips([card("wetsuits", "Wetsuits"), card("bags", "Bags")], 0);
    expect(chips.map(([k]) => k)).toEqual(["bags", "wetsuits", "sneakers"]);
  });
  it("is never empty — Sneakers is unconditional, so chips[0] always exists", () => {
    for (const cards of [[], undefined, many(1, "bags", "Bags")]) {
      expect(buildChips(cards, 0).length).toBeGreaterThan(0);
    }
    expect(buildChips([], 0)).toEqual([["sneakers", "Sneakers", 0]]);
  });

  it("keeps the user's selection while it still exists", () => {
    const chips = buildChips([...many(5, "bags", "Bags"), ...many(2, "watches", "Watches")], 3);
    expect(pickActiveTab(chips, "watches")).toBe("watches");
    expect(pickActiveTab(chips, "sneakers")).toBe("sneakers");
  });
  it("THE VANISHING CHIP: solving the last bag while viewing Bags falls back, never blanks", () => {
    const after = buildChips(many(5, "watches", "Watches"), 0);
    expect(after.map(([k]) => k)).not.toContain("bags");
    expect(pickActiveTab(after, "bags")).toBe("watches");
  });
  it("opens on the first chip when nothing has been chosen yet", () => {
    const chips = buildChips([...many(2, "t-shirts", "T-Shirts"), ...many(9, "bags", "Bags")], 4);
    expect(pickActiveTab(chips, null)).toBe("t-shirts");
  });
  it("falls back to Sneakers when nothing at all is stranded", () => {
    expect(pickActiveTab(buildChips([], 0), null)).toBe("sneakers");
  });
  it("never returns a key that isn't in the rendered row", () => {
    const chips = buildChips(many(3, "watches", "Watches"), 1);
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
