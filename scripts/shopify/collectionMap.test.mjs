// ── Collection-map tests ─────────────────────────────────────────────────────
// The category rows below are the COMPLETE set of `category|subcategory` pairs
// present in the live catalogue, lifted verbatim from the read-only census of
// 2026-08-15 (4,167 visible records — id && name, not merged). If the app grows
// a category, this list stops being complete and the coverage test below is the
// thing that notices.
import { describe, it, expect } from "vitest";
import {
  COLLECTIONS, COLLECTION_BY_KEY, CATEGORY_MAP, MANUAL_KEYS, SMART_KEYS,
  resolveCollection, validateCollectionPayload, validateAllCollections,
} from "./collectionMap.mjs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

// [category, subcategory, live count] — the census, verbatim.
const LIVE_PAIRS = [
  ["Footwear", "Sneakers", 1224],
  ["Clothing", "Clothing — Uncategorized", 472],
  ["Clothing", "T-Shirts", 451],
  ["Clothing", "Caps & Hats", 339],
  ["Accessories", "Bags", 336],
  ["Clothing", "Tracksuits & Sets", 291],
  ["Clothing", "Jerseys", 228],
  ["Clothing", "Jeans & Denim", 157],
  ["Footwear", "Soccer Boots", 81],
  ["Clothing", "Hoodies & Sweatshirts", 72],
  ["Clothing", "Jackets & Coats", 69],
  ["Perfume", "Perfume", 63],
  ["Clothing", "Polos", 61],
  ["Footwear", "Sandals & Slides", 49],
  ["Accessories", "Watches", 47],
  ["Footwear", "Boots", 45],
  ["Clothing", "Cargos & Pants", 40],
  ["Price Products", "Price Products", 35],
  ["Clothing", "Shorts & Vests", 32],
  ["Clothing", "Underwear & Socks", 27],
  ["Accessories", "Belts", 25],
  ["Accessories", "Eyewear", 14],
  ["Footwear", null, 3],
  ["Accessories", "Balaclavas & Masks", 2],
  ["Accessories", "Jewellery", 2],
  ["Accessories", "Gloves", 1],
  ["Clothing", null, 1],
];

describe("COLLECTIONS — the shape of the storefront", () => {
  it("is exactly the agreed taxonomy: 6 top level, 6 under Clothing, 3 cross-cutting", () => {
    const tops = COLLECTIONS.filter((c) => c.parent === null && c.kind === "manual").map((c) => c.title);
    expect(tops).toEqual(["Sneakers", "Clothing", "Caps & Hats", "Bags", "Fragrance", "Accessories"]);
    const kids = COLLECTIONS.filter((c) => c.parent === "clothing").map((c) => c.title);
    expect(kids).toEqual(["T-shirts", "Hoodies & Sweats", "Tracksuits", "Jackets", "Shorts", "Pants"]);
    expect(SMART_KEYS).toEqual(["new-in", "sale", "under-r500"]);
    expect(MANUAL_KEYS).toHaveLength(12);
  });

  it("every key and every handle is unique", () => {
    expect(new Set(COLLECTIONS.map((c) => c.key)).size).toBe(COLLECTIONS.length);
    expect(new Set(COLLECTIONS.map((c) => c.handle)).size).toBe(COLLECTIONS.length);
  });

  it("every parent reference names a real collection", () => {
    for (const c of COLLECTIONS) {
      if (c.parent !== null) expect(COLLECTION_BY_KEY.has(c.parent)).toBe(true);
    }
  });

  it("smart collections carry conditions and manual ones do not", () => {
    for (const c of COLLECTIONS) {
      if (c.kind === "smart") expect(c.conditions?.all?.length).toBeGreaterThan(0);
      else expect(c.conditions).toBeUndefined();
    }
  });
});

// THE COMPLIANCE PIN. Every string a collection pushes is a catalogue field.
describe("compliance — no brand trigger reaches Shopify through a collection", () => {
  it("validateAllCollections() finds nothing", () => {
    expect(validateAllCollections()).toEqual([]);
  });

  it("every pushed string is trigger-free, field by field", () => {
    for (const c of COLLECTIONS) {
      for (const field of ["title", "handle", "description", "seoTitle", "seoDescription"]) {
        expect({ key: c.key, field, hits: triggersInText(c[field]) })
          .toEqual({ key: c.key, field, hits: [] });
      }
    }
  });

  it("menu labels are the collection titles, so the same pin covers them", () => {
    for (const c of COLLECTIONS) expect(triggersInText(c.title)).toEqual([]);
  });

  it("refuses a title carrying a brand", () => {
    const v = validateCollectionPayload({
      title: "Nike Sneakers", handle: "nike-sneakers", description: "x",
    });
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.field === "title")).toBe(true);
    expect(v.violations.some((x) => x.field === "handle")).toBe(true);
  });

  it("refuses a brand hidden in a smart-collection condition value", () => {
    const v = validateCollectionPayload({
      title: "Clean", handle: "clean", description: "clean",
      conditions: { matchType: "ALL", all: [{ productTag: { relation: "TAGGED_WITH", values: ["yeezy"] } }] },
    });
    expect(v.ok).toBe(false);
    expect(v.violations[0].field).toBe("conditions[0].productTag.values");
  });

  it("refuses a dirty handle and an empty description", () => {
    expect(validateCollectionPayload({ title: "A B", handle: "A B", description: "d" }).ok).toBe(false);
    expect(validateCollectionPayload({ title: "A B", handle: "a-b", description: "" }).ok).toBe(false);
  });
});

describe("resolveCollection — the join, against the real catalogue", () => {
  it("covers EVERY live category pair: nothing resolves to 'unknown'", () => {
    const unknown = LIVE_PAIRS
      .map(([category, subcategory, n]) => ({ pair: `${category}|${subcategory}`, n, ...resolveCollection({ category, subcategory }) }))
      .filter((r) => r.status === "unknown");
    expect(unknown).toEqual([]);
  });

  it("maps the pairs that carry the live storefront today", () => {
    // 7 of the 11 currently-live products are Footwear|Boots, 4 are Clothing|Caps & Hats.
    expect(resolveCollection({ category: "Footwear", subcategory: "Boots" }))
      .toMatchObject({ collectionKey: "sneakers", status: "mapped" });
    expect(resolveCollection({ category: "Clothing", subcategory: "Caps & Hats" }))
      .toMatchObject({ collectionKey: "caps-hats", status: "mapped" });
  });

  it("one internal category lands in exactly ONE collection — never a list", () => {
    for (const [category, subcategory] of LIVE_PAIRS) {
      const r = resolveCollection({ category, subcategory });
      expect(typeof r.collectionKey === "string" || r.collectionKey === null).toBe(true);
    }
  });

  it("a jersey and a polo are NOT filed under T-shirts", () => {
    expect(resolveCollection({ category: "Clothing", subcategory: "Jerseys" }).collectionKey).toBe("clothing");
    expect(resolveCollection({ category: "Clothing", subcategory: "Polos" }).collectionKey).toBe("clothing");
  });

  it("denim is pants", () => {
    expect(resolveCollection({ category: "Clothing", subcategory: "Jeans & Denim" }).collectionKey).toBe("pants");
  });

  it("a record with no subcategory falls back to its category's wildcard row", () => {
    expect(resolveCollection({ category: "Footwear" })).toMatchObject({ collectionKey: "sneakers", key: "Footwear|*" });
    expect(resolveCollection({ category: "Clothing", subcategory: "" })).toMatchObject({ collectionKey: "clothing", key: "Clothing|*" });
  });

  it("an unrecognised subcategory under a known category falls back, it does not go unknown", () => {
    const r = resolveCollection({ category: "Clothing", subcategory: "Something New" });
    expect(r).toMatchObject({ collectionKey: "clothing", status: "mapped", key: "Clothing|*" });
  });

  it("Price Products is unmapped ON PURPOSE, and says so", () => {
    const r = resolveCollection({ category: "Price Products", subcategory: "Price Products" });
    expect(r.status).toBe("unmapped");
    expect(r.collectionKey).toBeNull();
    expect(r.reason).toMatch(/on purpose/);
    expect(r.reason).toMatch(/New In/);
  });

  it("an entirely new top-level category is 'unknown' — the loud case", () => {
    const r = resolveCollection({ category: "Homeware", subcategory: "Mugs" });
    expect(r.status).toBe("unknown");
    expect(r.collectionKey).toBeNull();
    expect(r.reason).toMatch(/collectionMap\.mjs/);
  });

  it("a record with no category at all is unknown, not a crash", () => {
    expect(resolveCollection({}).status).toBe("unknown");
    expect(resolveCollection(null).status).toBe("unknown");
    expect(resolveCollection(undefined).collectionKey).toBeNull();
  });

  it("never invents a collection that does not exist", () => {
    for (const [category, subcategory] of LIVE_PAIRS) {
      const { collectionKey } = resolveCollection({ category, subcategory });
      if (collectionKey !== null) expect(COLLECTION_BY_KEY.has(collectionKey)).toBe(true);
    }
  });
});

describe("CATEGORY_MAP integrity", () => {
  it("every non-null target names a MANUAL collection (smart ones are Shopify's to fill)", () => {
    for (const [key, target] of Object.entries(CATEGORY_MAP)) {
      if (target === null) continue;
      expect({ key, target, manual: MANUAL_KEYS.includes(target) }).toEqual({ key, target, manual: true });
    }
  });

  it("every category that appears in an exact row also has a wildcard row", () => {
    const cats = new Set(Object.keys(CATEGORY_MAP).map((k) => k.split("|")[0]));
    for (const c of cats) expect(`${c}|*` in CATEGORY_MAP).toBe(true);
  });

  it("every manual collection is reachable from at least one category row", () => {
    const used = new Set(Object.values(CATEGORY_MAP).filter(Boolean));
    for (const key of MANUAL_KEYS) expect({ key, used: used.has(key) }).toEqual({ key, used: true });
  });
});
