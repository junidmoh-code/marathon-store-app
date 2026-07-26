import { describe, it, expect } from "vitest";
import {
  TAXONOMY_SEED, SIZES_APPAREL, SIZES_FOOTWEAR, SIZES_KIDS, SIZES_GLOVES, ONE_SIZE_SENTINEL,
  catByKey, isOneSize, sizesOf, legacyFor, groupedCategories, allCategories, labelForKey,
  isAssigned, isLegacySneaker, needsAssignment, effectiveCategoryKey,
} from "./productTaxonomy.js";
import { CATEGORY_TREE } from "./productCategory.js";

const REG = TAXONOMY_SEED;

describe("registry shape", () => {
  it("has 31 categories", () => expect(Object.keys(REG.cats)).toHaveLength(31));

  it("every category key matches its record key", () => {
    for (const [k, c] of Object.entries(REG.cats)) expect(c.key).toBe(k);
  });

  it("every category has a label, a top, sizes and a legacy triple", () => {
    for (const c of Object.values(REG.cats)) {
      expect(c.label).toBeTruthy();
      expect(REG.tops[c.top]).toBeTruthy();
      expect(sizesOf(c).length).toBeGreaterThan(0);
      expect(c.legacy).toBeTruthy();
      expect(c.legacy.category).toBeTruthy();
    }
  });

  it("ships the behaviour flags as EMPTY, unused slots", () => {
    for (const c of Object.values(REG.cats)) {
      expect(c.flags).toEqual({ refillManaged: null, displayChecks: null, oneSize: null });
    }
  });

  it("orders are unique so the dropdown is stable", () => {
    const orders = Object.values(REG.cats).map((c) => c.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("size sets", () => {
  // Live-data check 2026-07-26: 460 products / 504 stock cells / 800 units on 5.5.
  it("footwear keeps 5.5 — it is in heavy live use", () => {
    expect(SIZES_FOOTWEAR).toContain("5.5");
  });

  // Live-data check 2026-07-26: ZERO products and ZERO stock cells use XS.
  it("apparel excludes XS and matches the engine's standard run exactly", () => {
    expect(SIZES_APPAREL).toEqual(["S", "M", "L", "XL", "XXL", "XXXL"]);
    expect(SIZES_APPAREL).not.toContain("XS");
  });

  it("kids shoes are 26–33", () => {
    expect(SIZES_KIDS[0]).toBe("26");
    expect(SIZES_KIDS[SIZES_KIDS.length - 1]).toBe("33");
  });

  it("all six footwear categories share one size list", () => {
    for (const k of ["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers"]) {
      expect(sizesOf(catByKey(REG, k))).toEqual(SIZES_FOOTWEAR);
    }
  });

  it("all fifteen apparel categories share one size list", () => {
    const apparel = ["t-shirts", "golf-t-shirts", "hoodies", "sweaters", "jackets", "tracksuits",
      "pants", "jeans", "shorts", "cargo-pants", "basketball-vests", "baseball-shirts",
      "soccer-jerseys", "dresses", "underwear"];
    expect(apparel).toHaveLength(15);
    for (const k of apparel) expect(sizesOf(catByKey(REG, k))).toEqual(SIZES_APPAREL);
  });

  it("gloves are M and L only", () => expect(sizesOf(catByKey(REG, "gloves"))).toEqual(SIZES_GLOVES));

  it("fitted caps are 55–63", () => {
    const s = sizesOf(catByKey(REG, "fitted-caps"));
    expect(s[0]).toBe("55");
    expect(s[s.length - 1]).toBe("63");
  });
});

describe("one-size categories", () => {
  const ONE = ["bags", "belts", "watches", "chains-bracelets", "sunglasses", "caps-beanies", "perfumes"];

  it("are exactly the seven specced", () => {
    const found = Object.values(REG.cats).filter(isOneSize).map((c) => c.key).sort();
    expect(found).toEqual([...ONE].sort());
  });

  it('each carries the single "_" sentinel', () => {
    for (const k of ONE) expect(sizesOf(catByKey(REG, k))).toEqual([ONE_SIZE_SENTINEL]);
  });

  it("sized categories are never one-size", () => {
    expect(isOneSize(catByKey(REG, "t-shirts"))).toBe(false);
    expect(isOneSize(catByKey(REG, "sneakers"))).toBe(false);
    expect(isOneSize(catByKey(REG, "gloves"))).toBe(false);
  });
});

// ── THE DERIVATION TABLE ─────────────────────────────────────────────────────
// This is the table the owner signed off in Phase 1. Any diff here is a live
// automation behaviour change (refill lane / Display Checks / POS browse), so it
// is asserted literally, category by category.
describe("legacyFor — the signed-off derivation table", () => {
  const TABLE = {
    // footwear-sized → productType "sneaker" → OUT of the refill + display-check lanes
    "sneakers":         { category: "Footwear",    subcategory: "Sneakers",              productType: "sneaker" },
    "running-shoes":    { category: "Footwear",    subcategory: "Sneakers",              productType: "sneaker" },
    "boots":            { category: "Footwear",    subcategory: "Boots",                 productType: "sneaker" },
    "soccer-boots":     { category: "Footwear",    subcategory: "Soccer Boots",          productType: "sneaker" },
    "slides":           { category: "Footwear",    subcategory: "Sandals & Slides",      productType: "sneaker" },
    "loafers":          { category: "Footwear",    subcategory: null,                    productType: "sneaker" },
    "kids-shoes":       { category: "Footwear",    subcategory: "Sneakers",              productType: "sneaker" },
    // apparel → productType "clothing"
    "t-shirts":         { category: "Clothing",    subcategory: "T-Shirts",              productType: "clothing" },
    "golf-t-shirts":    { category: "Clothing",    subcategory: "Polos",                 productType: "clothing" },
    "hoodies":          { category: "Clothing",    subcategory: "Hoodies & Sweatshirts", productType: "clothing" },
    "sweaters":         { category: "Clothing",    subcategory: "Hoodies & Sweatshirts", productType: "clothing" },
    "jackets":          { category: "Clothing",    subcategory: "Jackets & Coats",       productType: "clothing" },
    "tracksuits":       { category: "Clothing",    subcategory: "Tracksuits & Sets",     productType: "clothing" },
    "pants":            { category: "Clothing",    subcategory: "Cargos & Pants",        productType: "clothing" },
    "jeans":            { category: "Clothing",    subcategory: "Jeans & Denim",         productType: "clothing" },
    "shorts":           { category: "Clothing",    subcategory: "Shorts & Vests",        productType: "clothing" },
    "cargo-pants":      { category: "Clothing",    subcategory: "Cargos & Pants",        productType: "clothing" },
    "basketball-vests": { category: "Clothing",    subcategory: "Shorts & Vests",        productType: "clothing" },
    "baseball-shirts":  { category: "Clothing",    subcategory: "Jerseys",               productType: "clothing" },
    "soccer-jerseys":   { category: "Clothing",    subcategory: "Jerseys",               productType: "clothing" },
    "dresses":          { category: "Clothing",    subcategory: null,                    productType: "clothing" },
    "underwear":        { category: "Clothing",    subcategory: "Underwear & Socks",     productType: "clothing" },
    // own size sets
    "fitted-caps":      { category: "Clothing",    subcategory: "Caps & Hats",           productType: "clothing" },
    "gloves":           { category: "Accessories", subcategory: "Gloves",                productType: "clothing" },
    // one-size
    "bags":             { category: "Accessories", subcategory: "Bags",                  productType: "clothing" },
    "belts":            { category: "Accessories", subcategory: "Belts",                 productType: "clothing" },
    "watches":          { category: "Accessories", subcategory: "Watches",               productType: "clothing" },
    "chains-bracelets": { category: "Accessories", subcategory: "Jewellery",             productType: "clothing" },
    "sunglasses":       { category: "Accessories", subcategory: "Eyewear",               productType: "clothing" },
    "caps-beanies":     { category: "Clothing",    subcategory: "Caps & Hats",           productType: "clothing" },
    // the ONE category that omits productType — matches the 53 live perfume records
    "perfumes":         { category: "Perfume",     subcategory: "Perfume",               productType: null },
  };

  it("covers every category in the registry", () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(REG.cats).sort());
  });

  for (const [key, expected] of Object.entries(TABLE)) {
    it(`${key} → ${expected.category}/${expected.subcategory ?? "(omitted)"}/${expected.productType ?? "(omitted)"}`,
      () => expect(legacyFor(REG, key)).toEqual(expected));
  }

  it("returns null for an unknown key so a save can be refused, not half-written", () => {
    expect(legacyFor(REG, "not-a-category")).toBeNull();
    expect(legacyFor(REG, "")).toBeNull();
    expect(legacyFor(null, "t-shirts")).toBeNull();
  });
});

describe("derivation ↔ live automation contracts", () => {
  it("every legacy subcategory that IS written exists in the live CATEGORY_TREE", () => {
    const leaves = new Set(Object.values(CATEGORY_TREE).flat());
    for (const c of Object.values(REG.cats)) {
      if (c.legacy.subcategory == null) continue;
      expect(leaves.has(c.legacy.subcategory)).toBe(true);
    }
  });

  it("every legacy top-level category exists in the live CATEGORY_TREE", () => {
    for (const c of Object.values(REG.cats)) {
      expect(CATEGORY_TREE[c.legacy.category]).toBeTruthy();
    }
  });

  it('never writes the review-backlog string "Clothing — Uncategorized"', () => {
    for (const c of Object.values(REG.cats)) {
      expect(c.legacy.subcategory).not.toBe("Clothing — Uncategorized");
    }
  });

  it("productType is only ever clothing, sneaker, or omitted", () => {
    for (const c of Object.values(REG.cats)) {
      expect([null, "clothing", "sneaker"]).toContain(c.legacy.productType);
    }
  });

  // The refill engine's isClothing() gate: productType wins when present.
  it("footwear categories stay OUT of the refill clothing lane", () => {
    for (const k of ["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes"]) {
      expect(legacyFor(REG, k).productType).toBe("sneaker");
    }
  });

  // Display Checks: category === "Perfume" OR productType === "clothing".
  it("perfume keeps display checks via CATEGORY while staying out of refill", () => {
    const p = legacyFor(REG, "perfumes");
    expect(p.category).toBe("Perfume");       // → display check fires
    expect(p.productType).toBeNull();          // → refill isClothing() falls to the "_" size heuristic → false
  });

  it("one-size accessories keep display checks via productType (owner decision)", () => {
    for (const k of ["bags", "belts", "watches", "chains-bracelets", "sunglasses", "caps-beanies"]) {
      expect(legacyFor(REG, k).productType).toBe("clothing");
    }
  });
});

describe("groupedCategories", () => {
  it("groups into Footwear then Clothing", () => {
    const g = groupedCategories(REG);
    expect(g.map((x) => x.top)).toEqual(["footwear", "clothing"]);
    expect(g.map((x) => x.label)).toEqual(["Footwear", "Clothing"]);
  });

  it("every shoe category sits under Footwear, not Clothing", () => {
    const g = groupedCategories(REG);
    expect(g[0].options.map((c) => c.key)).toEqual([
      "sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes",
    ]);
    expect(g[1].options).toHaveLength(24);
    // The heading a shoe appears under must never read "Clothing".
    for (const c of g[1].options) expect(c.legacy.category).not.toBe("Footwear");
  });

  it("shows an unknown top as \"Other\" instead of dropping the category", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: { ...REG.cats.belts, top: "typo-group" } } };
    const g = groupedCategories(reg);
    const other = g.find((x) => x.label === "Other");
    expect(other).toBeTruthy();
    expect(other.options.map((c) => c.key)).toEqual(["belts"]);
    // Still reachable, still fully derivable — nothing silently disappears.
    expect(allCategories(reg)).toHaveLength(31);
    expect(legacyFor(reg, "belts").subcategory).toBe("Belts");
  });

  it("hides inactive categories without breaking the rest", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: { ...REG.cats.belts, active: false } } };
    expect(allCategories(reg).map((c) => c.key)).not.toContain("belts");
    expect(allCategories(reg)).toHaveLength(30);
  });

  it("survives a missing / garbled registry instead of throwing", () => {
    expect(groupedCategories(null)).toEqual([]);
    expect(groupedCategories({})).toEqual([]);
    expect(groupedCategories({ cats: { junk: "not an object" } })).toEqual([]);
  });

  // Regrouping is a data edit. Proven by REGROUPING EVERYTHING and asserting
  // that every behaviour-carrying output is byte-identical.
  it("grouping is DISPLAY-ONLY — no predicate or derivation depends on `top`", () => {
    const scrambled = {
      ...REG,
      tops: { everything: { key: "everything", label: "Everything", order: 1 } },
      cats: Object.fromEntries(Object.entries(REG.cats).map(([k, c]) => [k, { ...c, top: "everything" }])),
    };
    for (const key of Object.keys(REG.cats)) {
      // The derivation — what actually reaches a product record.
      expect(legacyFor(scrambled, key)).toEqual(legacyFor(REG, key));
      // Sizes and the one-size branch.
      expect(sizesOf(catByKey(scrambled, key))).toEqual(sizesOf(catByKey(REG, key)));
      expect(isOneSize(catByKey(scrambled, key))).toBe(isOneSize(catByKey(REG, key)));
    }
    // Same 31 categories reachable, only the headings differ.
    expect(allCategories(scrambled).map((c) => c.key).sort())
      .toEqual(allCategories(REG).map((c) => c.key).sort());
    expect(groupedCategories(scrambled).map((g) => g.label)).toEqual(["Everything"]);
  });

  it("queue predicates read legacy fields and categoryKey, never `top`", () => {
    // isLegacySneaker keys off the LEGACY category/subcategory pair, so moving
    // Sneakers between dropdown groups cannot change who enters the queue.
    const sneaker = { id: "p1", category: "Footwear", subcategory: "Sneakers" };
    expect(isLegacySneaker(sneaker)).toBe(true);
    expect(needsAssignment(sneaker)).toBe(false);
    expect(effectiveCategoryKey(sneaker)).toBe("sneakers");
  });

  it("a category added by pure DATA appears with no code change", () => {
    const reg = {
      ...REG,
      cats: { ...REG.cats, scarves: { key: "scarves", label: "Scarves", top: "clothing", order: 99,
        sizeMode: "one", sizes: ["_"], legacy: { category: "Accessories", subcategory: null, productType: "clothing" },
        flags: {}, active: true } },
    };
    expect(allCategories(reg).map((c) => c.key)).toContain("scarves");
    expect(legacyFor(reg, "scarves")).toEqual({ category: "Accessories", subcategory: null, productType: "clothing" });
    expect(isOneSize(catByKey(reg, "scarves"))).toBe(true);
  });

  it("labelForKey falls back to the raw key", () => {
    expect(labelForKey(REG, "t-shirts")).toBe("T-Shirts");
    expect(labelForKey(REG, "gone")).toBe("gone");
  });
});

describe("assignment-queue predicates", () => {
  const sneaker = { id: "p1", category: "Footwear", subcategory: "Sneakers" };
  const boot = { id: "p2", category: "Footwear", subcategory: "Boots" };
  const tee = { id: "p3", category: "Clothing", subcategory: "T-Shirts" };
  const done = { id: "p4", category: "Clothing", subcategory: "T-Shirts", categoryKey: "t-shirts" };

  it("legacy sneakers are auto-assigned and never queue", () => {
    expect(isLegacySneaker(sneaker)).toBe(true);
    expect(needsAssignment(sneaker)).toBe(false);
    expect(effectiveCategoryKey(sneaker)).toBe("sneakers");
  });

  it("boots and soccer boots DO queue — they are their own categories now", () => {
    expect(isLegacySneaker(boot)).toBe(false);
    expect(needsAssignment(boot)).toBe(true);
  });

  it("unassigned non-sneakers queue", () => expect(needsAssignment(tee)).toBe(true));

  it("an assigned product leaves the queue immediately", () => {
    expect(isAssigned(done)).toBe(true);
    expect(needsAssignment(done)).toBe(false);
    expect(effectiveCategoryKey(done)).toBe("t-shirts");
  });

  it("an explicit assignment overrides the legacy-sneaker default", () => {
    expect(effectiveCategoryKey({ ...sneaker, categoryKey: "running-shoes" })).toBe("running-shoes");
  });

  it("blank / whitespace categoryKey does not count as assigned", () => {
    expect(isAssigned({ id: "p5", categoryKey: "  " })).toBe(false);
    expect(needsAssignment({ id: "p5", categoryKey: "  " })).toBe(true);
  });

  it("a product with no id never queues (it cannot be written to)", () => {
    expect(needsAssignment({ category: "Clothing" })).toBe(false);
    expect(needsAssignment(null)).toBe(false);
  });
});
