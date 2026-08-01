import { describe, it, expect } from "vitest";
import {
  TAXONOMY_SEED, SIZES_APPAREL, SIZES_FOOTWEAR, SIZES_KIDS, SIZES_GLOVES, ONE_SIZE_SENTINEL,
  catByKey, isOneSize, sizesOf, legacyFor, groupedCategories, allCategories, labelForKey,
  isAssigned, isLegacySneaker, needsAssignment, effectiveCategoryKey, isAssignable,
  RETIRED_CATEGORY_KEYS, MERGED_INTO,
} from "./productTaxonomy.js";
import { CATEGORY_TREE } from "./productCategory.js";

const REG = TAXONOMY_SEED;

describe("registry shape", () => {
  // 32 entries: 26 assignable + 6 RETIRED by the 2026-08-01 merge. Retired rows
  // stay in the registry so a product still carrying the key resolves to
  // something the picker can flag, instead of reading as uncategorised.
  it("has 32 categories — 26 active, 6 retired", () => {
    const all = Object.values(REG.cats);
    expect(all).toHaveLength(32);
    expect(all.filter((c) => c.active)).toHaveLength(26);
    expect(all.filter((c) => !c.active).map((c) => c.key).sort())
      .toEqual(["boots", "cargo-pants", "jeans", "loafers", "running-shoes", "sweaters"]);
  });

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

  it("ships the behaviour flags as EMPTY, unused slots that SURVIVE an RTDB write", () => {
    for (const c of Object.values(REG.cats)) {
      expect(c.flags).toEqual({ refillManaged: "unset", displayChecks: "unset", oneSize: "unset" });
      // RTDB deletes null children, so a null-valued slot would vanish on write
      // and the console would show no flags node at all — the opposite of an
      // "empty slot you can fill in later".
      for (const v of Object.values(c.flags)) expect(v).not.toBeNull();
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

  // REGRESSION GUARD. The one-size quantity box has no size to key on, so it
  // always writes to "_". If sizesOf returned something else for a one-size
  // category, the save would look the entered quantity up under a key nobody
  // wrote, find nothing, and receive ZERO stock — silently, with the number the
  // operator typed still on screen. Console-added categories are the advertised
  // workflow, so this typo is reachable. Normalisation makes it unrepresentable.
  it('forces the "_" sentinel for any one-size category, whatever its record says', () => {
    const typo = { key: "scarves", label: "Scarves", top: "clothing", sizeMode: "one",
                   sizes: ["one-size"], legacy: { category: "Accessories", productType: "clothing" } };
    expect(isOneSize(typo)).toBe(true);
    expect(sizesOf(typo)).toEqual([ONE_SIZE_SENTINEL]);

    // Also when sizeMode is missing entirely but the sizes say one-size.
    expect(sizesOf({ key: "x", sizes: ["_"] })).toEqual([ONE_SIZE_SENTINEL]);

    // And the built product agrees with the grid.
    const reg = { ...REG, cats: { ...REG.cats, scarves: { ...typo, active: true, order: 99 } } };
    expect(sizesOf(catByKey(reg, "scarves"))).toEqual([ONE_SIZE_SENTINEL]);
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
    "designer-shoes":   { category: "Footwear",    subcategory: "Sneakers",              productType: "sneaker" },
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
    // A RETIRED category derives to null on purpose — it must not be assignable
    // — but its stored triple is asserted below to prove the merge did not
    // rewrite any legacy data.
    if (RETIRED_CATEGORY_KEYS.has(key)) {
      it(`${key} is retired → derives null, but keeps its legacy triple`, () => {
        expect(legacyFor(REG, key)).toBeNull();
        expect(REG.cats[key].legacy).toEqual(expected);
      });
      continue;
    }
    it(`${key} → ${expected.category}/${expected.subcategory ?? "(omitted)"}/${expected.productType ?? "(omitted)"}`,
      () => expect(legacyFor(REG, key)).toEqual(expected));
  }

  it("returns null for an unknown key so a save can be refused, not half-written", () => {
    expect(legacyFor(REG, "not-a-category")).toBeNull();
    expect(legacyFor(REG, "")).toBeNull();
    expect(legacyFor(null, "t-shirts")).toBeNull();
  });
});

// ── REGISTRY IS UNTRUSTED INPUT ──────────────────────────────────────────────
// It is console-editable, and its `legacy` block decides which live automations
// a product lands in. A bad value must REFUSE the save, never produce a product
// that silently sits outside refill and Display Checks.
describe("legacyFor rejects an illegal registry entry", () => {
  const withLegacy = (legacy) => ({ ...REG, cats: { ...REG.cats, "t-shirts": { ...REG.cats["t-shirts"], legacy } } });

  it('rejects a typo\'d productType — "apparel" would SUPPRESS the letter-size fallback', () => {
    // refill-engine: `if (product.productType) return product.productType === "clothing"`.
    // "apparel" is not ignored — it is an explicit NON-clothing answer.
    expect(legacyFor(withLegacy({ category: "Clothing", subcategory: "T-Shirts", productType: "apparel" }), "t-shirts")).toBeNull();
  });

  it("rejects an unknown top-level category (POS browse filters on it)", () => {
    expect(legacyFor(withLegacy({ category: "Garments", subcategory: "T-Shirts", productType: "clothing" }), "t-shirts")).toBeNull();
  });

  it("rejects a missing category", () => {
    expect(legacyFor(withLegacy({ subcategory: "T-Shirts", productType: "clothing" }), "t-shirts")).toBeNull();
  });

  it("accepts the two legal productTypes and the deliberate perfume omission", () => {
    expect(legacyFor(withLegacy({ category: "Clothing", productType: "clothing" }), "t-shirts").productType).toBe("clothing");
    expect(legacyFor(withLegacy({ category: "Footwear", productType: "sneaker" }), "t-shirts").productType).toBe("sneaker");
    expect(legacyFor(withLegacy({ category: "Perfume", productType: null }), "t-shirts").productType).toBeNull();
  });

  it("allows an UNKNOWN subcategory — it only drives a POS browse chip", () => {
    const r = legacyFor(withLegacy({ category: "Clothing", subcategory: "Ponchos", productType: "clothing" }), "t-shirts");
    expect(r.subcategory).toBe("Ponchos");
  });

  it("refuses a RETIRED category for new use, but keeps it resolvable for history", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: { ...REG.cats.belts, active: false } } };
    expect(legacyFor(reg, "belts")).toBeNull();
    expect(isAssignable(reg, "belts")).toBe(false);
    // Still resolvable, so a product already carrying "belts" is never orphaned.
    expect(catByKey(reg, "belts").label).toBe("Belts");
    expect(labelForKey(reg, "belts")).toBe("Belts");
  });

  it("every ACTIVE category is assignable, and every retired one is not", () => {
    for (const [k, c] of Object.entries(REG.cats)) expect(isAssignable(REG, k)).toBe(!!c.active);
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
  // THE MERGE-SAFETY TEST. Reads the STORED triple, not legacyFor, so it covers
  // retired keys too: the whole promise made to the owner on 2026-08-01 was that
  // merging categories cannot change what the engine sees. Every shoe key —
  // merged away or not — must still carry productType "sneaker", which is what
  // keeps it out of isClothing() and out of the refill clothing lane.
  it("every footwear category stays OUT of the refill clothing lane, retired ones included", () => {
    for (const k of ["sneakers", "running-shoes", "boots", "soccer-boots", "designer-shoes", "slides", "loafers", "kids-shoes"]) {
      expect(REG.cats[k].legacy.productType).toBe("sneaker");
      expect(REG.cats[k].legacy.category).toBe("Footwear");
    }
  });

  // The six merged-away keys must resolve to the SAME legacy category and
  // productType as the key they were merged into, or a re-pointed product would
  // start behaving differently in the engine. (Subcategory may differ — jeans
  // was "Jeans & Denim", pants is "Cargos & Pants" — and the re-point script
  // deliberately leaves each product's own subcategory alone.)
  it("each retired key matches its survivor on the two fields automations read", () => {
    for (const [dead, alive] of Object.entries(MERGED_INTO)) {
      expect(REG.cats[dead].legacy.category).toBe(REG.cats[alive].legacy.category);
      expect(REG.cats[dead].legacy.productType).toBe(REG.cats[alive].legacy.productType);
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
      "sneakers", "soccer-boots", "designer-shoes", "slides", "kids-shoes",
    ]);
    expect(g[1].options).toHaveLength(21);
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
    expect(allCategories(reg)).toHaveLength(26);
    expect(legacyFor(reg, "belts").subcategory).toBe("Belts");
  });

  it("hides inactive categories without breaking the rest", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: { ...REG.cats.belts, active: false } } };
    expect(allCategories(reg).map((c) => c.key)).not.toContain("belts");
    expect(allCategories(reg)).toHaveLength(25);
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

  // ── A KNOWN, ACCEPTED LIMIT OF THE AUTO-ASSIGN RULE ────────────────────────
  // Running Shoes and Kids Shoes derive to the SAME legacy triple as Sneakers
  // (Footwear / Sneakers / sneaker), because the old tree had no leaf for them.
  // So an EXISTING running shoe or kids shoe is indistinguishable from a plain
  // sneaker in the legacy data, gets the "sneakers" default, and never appears
  // in the queue to be corrected. New products are unaffected — the form records
  // the real category at creation. Re-classifying the existing ~1,166 would need
  // a separate pass (by name, or by hand); it is deliberately not attempted here.
  it("an existing running/kids shoe is indistinguishable from a sneaker in legacy data", () => {
    const runningShoe = { id: "p9", category: "Footwear", subcategory: "Sneakers", name: "Nike Pegasus 41" };
    const kidsShoe = { id: "p10", category: "Footwear", subcategory: "Sneakers", name: "Nike Air Max Kids" };
    for (const p of [runningShoe, kidsShoe]) {
      expect(isLegacySneaker(p)).toBe(true);
      expect(needsAssignment(p)).toBe(false);        // never queued
      expect(effectiveCategoryKey(p)).toBe("sneakers"); // defaults to Sneakers
    }
    // An explicit assignment still wins, so any of them CAN be corrected — it
    // just has to be found deliberately rather than surfaced by the queue.
    expect(effectiveCategoryKey({ ...runningShoe, categoryKey: "running-shoes" })).toBe("running-shoes");
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

// ── CodeRabbit findings, PR #280 — pinned so they cannot come back ───────────
describe("a selected category must be ASSIGNABLE, not merely resolvable", () => {
  // catByKey deliberately still resolves a retired/misconfigured entry so that
  // history and labels keep working. The FORM must not treat that as usable, or
  // an operator fills in everything and only fails at save.
  it("a retired category resolves but is not assignable", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: { ...REG.cats.belts, active: false } } };
    expect(catByKey(reg, "belts")).toBeTruthy();       // still resolvable
    expect(isAssignable(reg, "belts")).toBe(false);    // but not usable
  });

  it("a misconfigured category resolves but is not assignable", () => {
    const reg = { ...REG, cats: { ...REG.cats, belts: {
      ...REG.cats.belts, legacy: { category: "Accessories", productType: "apparel" } } } };
    expect(catByKey(reg, "belts")).toBeTruthy();
    expect(isAssignable(reg, "belts")).toBe(false);
  });

  it("every category resolves; only the active ones are assignable", () => {
    for (const [k, c] of Object.entries(REG.cats)) {
      expect(catByKey(REG, k)).toBeTruthy();       // retired keys STILL resolve
      expect(isAssignable(REG, k)).toBe(!!c.active);
    }
  });
});
