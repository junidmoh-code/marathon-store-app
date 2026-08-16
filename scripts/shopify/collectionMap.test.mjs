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
  it("is exactly the agreed taxonomy: 9 top level, 6 under Clothing, 3 cross-cutting", () => {
    // Boots / Soccer Boots / Sandals & Slides joined the top level on
    // 2026-08-16 when the single footwear lane was split (see the header
    // census in collectionMap.mjs).
    const tops = COLLECTIONS.filter((c) => c.parent === null && c.kind === "manual").map((c) => c.title);
    expect(tops).toEqual([
      "Sneakers", "Boots", "Soccer Boots", "Sandals & Slides",
      "Clothing", "Caps & Hats", "Bags", "Fragrance", "Accessories",
    ]);
    const kids = COLLECTIONS.filter((c) => c.parent === "clothing").map((c) => c.title);
    expect(kids).toEqual(["T-shirts", "Hoodies & Sweats", "Tracksuits", "Jackets", "Shorts", "Pants"]);
    expect(SMART_KEYS).toEqual(["new-in", "sale", "under-r500"]);
    expect(MANUAL_KEYS).toHaveLength(15);
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

  it("every live pair EXCEPT the price records resolves to a real collection", () => {
    for (const [category, subcategory] of LIVE_PAIRS) {
      const r = resolveCollection({ category, subcategory });
      const expected = category === "Price Products" ? "excluded" : "mapped";
      expect({ category, subcategory, status: r.status }).toEqual({ category, subcategory, status: expected });
    }
  });

  it("maps the pairs that carry the live storefront today", () => {
    // The 2026-08-16 live set: 23 Footwear|Boots, 15 Footwear|Sandals & Slides,
    // 4 Clothing|Caps & Hats, 3 Footwear|Sneakers.
    expect(resolveCollection({ category: "Footwear", subcategory: "Boots" }))
      .toMatchObject({ collectionKey: "boots", status: "mapped" });
    expect(resolveCollection({ category: "Footwear", subcategory: "Sandals & Slides" }))
      .toMatchObject({ collectionKey: "sandals-slides", status: "mapped" });
    expect(resolveCollection({ category: "Clothing", subcategory: "Caps & Hats" }))
      .toMatchObject({ collectionKey: "caps-hats", status: "mapped" });
  });

  it("footwear has FOUR lanes, and a boot is never a sneaker", () => {
    const lane = (subcategory) => resolveCollection({ category: "Footwear", subcategory }).collectionKey;
    expect(lane("Sneakers")).toBe("sneakers");
    expect(lane("Boots")).toBe("boots");
    expect(lane("Soccer Boots")).toBe("soccer-boots");
    expect(lane("Sandals & Slides")).toBe("sandals-slides");
    // The regression this split exists to prevent.
    expect(["Boots", "Soccer Boots", "Sandals & Slides"].map(lane)).not.toContain("sneakers");
  });

  it("the Sneakers copy no longer promises boots and slides it does not hold", () => {
    const sneakers = COLLECTION_BY_KEY.get("sneakers");
    // It may still NAME them — to point the shopper at the new lanes — but it
    // must not read as though this collection contains them.
    expect(sneakers.description).not.toMatch(/Shoes — sneakers, boots/i);
    expect(sneakers.description).toMatch(/sections of their own/i);
    expect(sneakers.seoDescription).toMatch(/^Sneakers in stock/);
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

  it("Price Products is EXCLUDED, not merely unmapped", () => {
    const r = resolveCollection({ category: "Price Products", subcategory: "Price Products" });
    expect(r.status).toBe("excluded");
    expect(r.collectionKey).toBeNull();
    expect(r.reason).toMatch(/not merchandise/);
    // The old answer let it go live and surface in New In. It must not read
    // that way any more.
    expect(r.reason).not.toMatch(/New In/);
  });

  it("exclusion survives losing any ONE of its three identifying signals", () => {
    // Fail-safe check: the rule is an OR, so an edit to any single field
    // cannot make a price record publishable.
    const full = { priceProduct: true, category: "Price Products", subcategory: "Price Products" };
    for (const drop of ["priceProduct", "category", "subcategory"]) {
      const rec = { ...full };
      delete rec[drop];
      expect({ drop, status: resolveCollection(rec).status }).toEqual({ drop, status: "excluded" });
    }
    // Re-categorised to a real category but still flagged: still excluded.
    expect(resolveCollection({ priceProduct: true, category: "Clothing", subcategory: "T-Shirts" }).status)
      .toBe("excluded");
    // And a real product is unaffected.
    expect(resolveCollection({ category: "Clothing", subcategory: "T-Shirts" }).status).toBe("mapped");
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

// The sweep distinguishes three "no collection" outcomes and they must stay
// distinguishable from the map's answer alone: a deliberate null, a category
// nobody mapped, and a mapped collection that was never created on the shop.
describe("the no-collection outcomes are distinguishable", () => {
  it("not-merchandise is 'excluded' — the only status that blocks publication", () => {
    expect(resolveCollection({ category: "Price Products", subcategory: "Price Products" }).status).toBe("excluded");
  });
  it("'unmapped' is currently UNREACHABLE, because exclusion wins over the null rows", () => {
    // The only null rows left in CATEGORY_MAP are the two Price Products ones,
    // and isPriceRecord() short-circuits resolveCollection before the table is
    // read — so those rows answer "excluded", not "unmapped". The rows stay as
    // documentation of the decision. This states that plainly rather than
    // pretending "unmapped" is still a live outcome, and it is the test that
    // notices if a future null row is added for something that IS merchandise.
    const nullRows = Object.entries(CATEGORY_MAP).filter(([, v]) => v === null).map(([k]) => k);
    expect(nullRows).toEqual(["Price Products|Price Products", "Price Products|*"]);
    for (const row of nullRows) {
      const [category, sub] = row.split("|");
      const subcategory = sub === "*" ? "Anything At All" : sub;
      expect({ row, status: resolveCollection({ category, subcategory }).status })
        .toEqual({ row, status: "excluded" });
    }
  });
  it("a category nobody mapped is 'unknown'", () => {
    expect(resolveCollection({ category: "Homeware", subcategory: "Mugs" }).status).toBe("unknown");
  });
  it("a MAPPED category still names a collection key — 'no recorded id' is a shop fact, not a map fact", () => {
    // sync-collections reports this as `no-id` (fix it with ensure-collections
    // --commit), never as the documented-normal `no-collection`.
    const r = resolveCollection({ category: "Footwear", subcategory: "Boots" });
    expect(r).toMatchObject({ status: "mapped", collectionKey: "boots" });
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
