// Junid, 20 Nov 2026: every normal cap, beanie and bucket hat is Caps & Beanies,
// one size — at creation and on rename. Fitted caps and visors are never moved.
import { describe, it, expect } from "vitest";
import { normalHeadwearKind, headwearCategoryKeyFor, headwearRenamePatch, CAPS_BEANIES_KEY } from "./headwearCategory.js";
import { buildNewProduct } from "./newProductRecord.js";
import { TAXONOMY_SEED, legacyFor } from "./productTaxonomy.js";

// The 11 live records the 20 Nov census found filed as Chains & Bracelets.
const LIVE_MISFILED = [
  "The north face beanie green", "The north face beanie black", "Lacoste beanie red 3", "Lacoste beanie green",
  "Karl Lagerfeld beanie black", "Lacoste beanie black small logo", "Lacoste beanie grey",
  "Lacoste beanie green small lago", "Lacoste cap black", "Lacoste bucket hat navy blue", "Nike cap white",
];

describe("normalHeadwearKind", () => {
  it("names beanies, caps and bucket hats", () => {
    expect(normalHeadwearKind("Lacoste beanie grey")).toBe("beanie");
    expect(normalHeadwearKind("Nike cap white")).toBe("cap");
    expect(normalHeadwearKind("NIKE CAPS")).toBe("cap");
    expect(normalHeadwearKind("Lacoste bucket hat navy blue")).toBe("bucket-hat");
    expect(normalHeadwearKind("Nike buckethat")).toBe("bucket-hat"); // run together still counts
  });
  it("never claims a visor, a fitted cap or a cap-sleeve garment", () => {
    expect(normalHeadwearKind("Alo yoga airlift solar visor black")).toBe(null);
    expect(normalHeadwearKind("NY fitted cap black -1")).toBe(null);
    expect(normalHeadwearKind("New Era 59FIFTY Detroit Tigers cap")).toBe(null);
    expect(normalHeadwearKind("Zara cap sleeve top")).toBe(null);
  });
  it("is not fooled by words that merely start with cap", () => {
    expect(normalHeadwearKind("Nike capri pants")).toBe(null);
    expect(normalHeadwearKind("Diesel capsule tee")).toBe(null);
    expect(normalHeadwearKind("")).toBe(null);
    expect(normalHeadwearKind(undefined)).toBe(null);
  });
});

describe("headwearCategoryKeyFor", () => {
  it("re-files every live mis-filed record as caps-beanies", () => {
    for (const n of LIVE_MISFILED) expect(headwearCategoryKeyFor(n, "chains-bracelets")).toBe(CAPS_BEANIES_KEY);
  });
  it("leaves a correct or legitimately different headwear key alone", () => {
    expect(headwearCategoryKeyFor("Nike beanie white", "caps-beanies")).toBe(null);
    expect(headwearCategoryKeyFor("Nike beanie white", " caps-beanies ")).toBe(null);
    expect(headwearCategoryKeyFor("Nike cap", "fitted-caps")).toBe(null);   // fitted caps are never moved
    expect(headwearCategoryKeyFor("Nike cap", "visors")).toBe(null);
  });
  it("answers for a missing key too", () => {
    expect(headwearCategoryKeyFor("Nike bucket hat green", undefined)).toBe(CAPS_BEANIES_KEY);
  });
  it("does nothing for a non-headwear name", () => {
    expect(headwearCategoryKeyFor("Cuban link chain", "chains-bracelets")).toBe(null);
  });
});

describe("buildNewProduct — the creation path that produced the bad records", () => {
  const form = (over) => ({ name: "Nike cap white", categoryKey: "chains-bracelets", photo: "", hubs: ["hub2"], stockPrice: "150", retailPrice: "180", hasShoeBoxOption: false, sizeRun: [], ...over });
  it("a cap picked as Chains & Bracelets is saved as Caps & Beanies, one size", () => {
    const p = buildNewProduct(TAXONOMY_SEED, form(), { id: "p1" });
    expect(p.categoryKey).toBe("caps-beanies");
    expect(p.subcategory).toBe("Caps & Hats");
    expect(p.category).toBe("Clothing");
    expect(p.productType).toBe("clothing");
    expect(p.sizes).toEqual(["_"]);
  });
  it("every live mis-filed name comes out as caps-beanies", () => {
    for (const name of LIVE_MISFILED) expect(buildNewProduct(TAXONOMY_SEED, form({ name }), { id: "p1" }).categoryKey).toBe("caps-beanies");
  });
  it("refuses a headwear name on a SIZED category (the form switches it first)", () => {
    expect(buildNewProduct(TAXONOMY_SEED, form({ name: "Nike beanie", categoryKey: "t-shirts", sizeRun: ["M"] }), { id: "p1" })).toBe(null);
  });
  it("fitted caps keep their own key and sizes", () => {
    const p = buildNewProduct(TAXONOMY_SEED, form({ name: "NY fitted cap black", categoryKey: "fitted-caps", sizeRun: ["57", "58"] }), { id: "p1" });
    expect(p.categoryKey).toBe("fitted-caps");
    expect(p.sizes).toEqual(["57", "58"]);
  });
  it("a cap filed under Fitted Caps by name alone is left there", () => {
    expect(buildNewProduct(TAXONOMY_SEED, form({ name: "Nike cap", categoryKey: "fitted-caps", sizeRun: ["57"] }), { id: "p1" }).categoryKey).toBe("fitted-caps");
  });
  it("a non-headwear product is untouched", () => {
    expect(buildNewProduct(TAXONOMY_SEED, form({ name: "Cuban link chain" }), { id: "p1" }).categoryKey).toBe("chains-bracelets");
  });
});

describe("headwearRenamePatch", () => {
  const legacyOf = (k) => legacyFor(TAXONOMY_SEED, k);
  it("re-files a one-size product renamed to a headwear name", () => {
    expect(headwearRenamePatch({ sizes: ["_"], categoryKey: "chains-bracelets" }, "Nike cap white", legacyOf))
      .toEqual({ categoryKey: "caps-beanies", category: "Clothing", subcategory: "Caps & Hats", productType: "clothing" });
  });
  it("uses the seed triple when no registry is handed in", () => {
    expect(headwearRenamePatch({ sizes: ["_"], categoryKey: "bags" }, "Nike beanie")).toEqual({ categoryKey: "caps-beanies", category: "Clothing", subcategory: "Caps & Hats", productType: "clothing" });
  });
  it("never touches a sized product (that is the collapse's job) or a correct key", () => {
    expect(headwearRenamePatch({ sizes: ["M"], categoryKey: "chains-bracelets" }, "Nike cap white")).toBe(null);
    expect(headwearRenamePatch({ sizes: ["_"], categoryKey: "caps-beanies" }, "Nike cap white")).toBe(null);
    expect(headwearRenamePatch({ sizes: ["_"], categoryKey: "fitted-caps" }, "Nike cap white")).toBe(null);
    expect(headwearRenamePatch(null, "Nike cap white")).toBe(null);
  });
});
