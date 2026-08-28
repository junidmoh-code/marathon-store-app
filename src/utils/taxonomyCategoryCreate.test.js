// ─── CATEGORY CREATION — behaviour answers must mean what they say ──────────
// A category created through the Taxonomy tab is a promise about which live
// automations its products enter. These tests hold the derivation to that
// promise USING THE REAL GATES' LOGIC: the refill engine's isClothing()
// (functions/lib/refill-engine.cjs) and Display Checks' isClothingSale()
// (functions/displayChecks/lib.cjs), replicated below verbatim. If either
// server function changes shape, update the replicas WITH it.

import { describe, it, expect } from "vitest";
import { deriveNewCategory, slugForLabel, checksChoiceForLane } from "./taxonomyCategoryCreate.js";
import { TAXONOMY_SEED, isLegalLegacy, legacyFor, isAssignable, ONE_SIZE_SENTINEL } from "./productTaxonomy.js";
import { SIZE_RUN_SEED } from "./sizeRuns.js";

// ── The REAL gate classifiers, replicated ────────────────────────────────────
// functions/lib/refill-engine.cjs isClothing()
function engineIsClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}
// functions/displayChecks/lib.cjs isClothingSale()
function checksFire(product, rawSize) {
  if (product && product.category === "Perfume") return true;
  const pt = product && product.productType;
  if (pt) return pt === "clothing";
  return typeof rawSize === "string" && /^(S|M|L|XL|XXL|XXXL)$/i.test(rawSize);
}

// What the Add Product form would save for a product of this category — the
// legacy triple plus the category's sizes (legacyFor is the same function the
// real save path calls).
function productOf(registry, key) {
  const legacy = legacyFor(registry, key);
  const cat = registry.cats[key];
  const p = { sizes: cat.sizes };
  if (legacy.category != null) p.category = legacy.category;
  if (legacy.subcategory != null) p.subcategory = legacy.subcategory;
  if (legacy.productType != null) p.productType = legacy.productType;
  return p;
}

const registryWith = (result) => ({
  ...TAXONOMY_SEED,
  sizeRuns: SIZE_RUN_SEED,
  cats: { ...TAXONOMY_SEED.cats, [result.key]: result.record },
});

describe("slugForLabel", () => {
  it("matches the existing key style", () => {
    expect(slugForLabel("Chains & Bracelets")).toBe("chains-bracelets");
    expect(slugForLabel("  Scarves ")).toBe("scarves");
    expect(slugForLabel("Golf T-Shirts")).toBe("golf-t-shirts");
  });
});

describe("clothing lane (sized)", () => {
  const r = deriveNewCategory(
    { label: "Scarves", top: "clothing", oneSize: false, sizeRunKey: "apparel", refillLane: "clothing", displayChecks: false },
    TAXONOMY_SEED,
  );
  it("creates a legal record the form would accept", () => {
    expect(r.ok).toBe(true);
    expect(isLegalLegacy(r.record.legacy)).toBe(true);
    expect(isAssignable(registryWith(r), r.key)).toBe(true);
  });
  it("writes productType clothing under category Clothing, subcategory = label", () => {
    expect(r.record.legacy).toEqual({ category: "Clothing", subcategory: "Scarves", productType: "clothing" });
  });
  it("the REAL engine gate manages it, and Display Checks fire — even though the operator answered checks:no (forced)", () => {
    const p = productOf(registryWith(r), r.key);
    expect(engineIsClothing(p)).toBe(true);
    expect(checksFire(p, "M")).toBe(true);
    expect(r.checks).toBe(true);
    expect(r.forcedChecks).toBe(true);
    expect(checksChoiceForLane("clothing").forced).toBe(true);
  });
  it("takes its sizes from the chosen run (apparel, 4XL included)", () => {
    expect(r.record.sizeRunKey).toBe("apparel");
    expect(r.record.sizes).toEqual(SIZE_RUN_SEED.apparel.sizes);
  });
});

describe("clothing lane (one-size) — the Accessories pattern, productType deliberately kept 'clothing'", () => {
  const r = deriveNewCategory(
    { label: "Wallets", top: "clothing", oneSize: true, refillLane: "clothing", displayChecks: true },
    TAXONOMY_SEED,
  );
  it("derives Accessories + clothing, exactly like the live bags/belts/watches records", () => {
    expect(r.ok).toBe(true);
    expect(r.record.legacy).toEqual({ category: "Accessories", subcategory: "Wallets", productType: "clothing" });
    expect(r.record.sizeMode).toBe("one");
    expect(r.record.sizes).toEqual([ONE_SIZE_SENTINEL]);
  });
  it("Display Checks fire on a sale (the whole point of the live accessories setup)", () => {
    expect(checksFire(productOf(registryWith(r), r.key), "_")).toBe(true);
  });
});

describe("sneaker lane", () => {
  const r = deriveNewCategory(
    { label: "Hiking Boots", top: "footwear", oneSize: false, sizeRunKey: "footwear", refillLane: "sneaker", displayChecks: true },
    TAXONOMY_SEED,
  );
  it("derives Footwear + sneaker; checks are forced OFF even though the operator said yes", () => {
    expect(r.ok).toBe(true);
    expect(r.record.legacy).toEqual({ category: "Footwear", subcategory: "Hiking Boots", productType: "sneaker" });
    expect(r.checks).toBe(false);
    expect(r.forcedChecks).toBe(true);
  });
  it("the REAL gates agree: not engine-clothing, no display check", () => {
    const p = productOf(registryWith(r), r.key);
    expect(engineIsClothing(p)).toBe(false);
    expect(checksFire(p, "8")).toBe(false);
  });
});

describe("no lane + checks yes — the Perfume pattern, productType deliberately OMITTED", () => {
  const r = deriveNewCategory(
    { label: "Colognes", top: "clothing", oneSize: true, refillLane: "none", displayChecks: true },
    TAXONOMY_SEED,
  );
  it("derives category Perfume with NO productType — byte-compatible with the 53 live perfume records", () => {
    expect(r.ok).toBe(true);
    expect(r.record.legacy.category).toBe("Perfume");
    expect(r.record.legacy.productType).toBe(null);
  });
  it("the REAL gates agree: checks fire (by CATEGORY), the engine's heuristic sees only '_' so no lane", () => {
    const p = productOf(registryWith(r), r.key);
    expect(p.productType).toBeUndefined();          // omitted, never the string "null"
    expect(checksFire(p, "_")).toBe(true);
    expect(engineIsClothing(p)).toBe(false);
  });
});

describe("no lane + checks no — Accessories with productType omitted", () => {
  const one = deriveNewCategory(
    { label: "Keyrings", top: "clothing", oneSize: true, refillLane: "none", displayChecks: false },
    TAXONOMY_SEED,
  );
  it("one-size: no lane, no checks — and the real gates agree", () => {
    expect(one.ok).toBe(true);
    expect(one.record.legacy).toEqual({ category: "Accessories", subcategory: "Keyrings", productType: null });
    const p = productOf(registryWith(one), one.key);
    expect(engineIsClothing(p)).toBe(false);
    expect(checksFire(p, "_")).toBe(false);
  });
  it("letter-sized: the preview STATES the engine heuristic caveat, because the real gate does pick it up", () => {
    const sized = deriveNewCategory(
      { label: "Robes", top: "clothing", oneSize: false, sizeRunKey: "apparel", refillLane: "none", displayChecks: false },
      TAXONOMY_SEED,
    );
    expect(sized.ok).toBe(true);
    const p = productOf(registryWith(sized), sized.key);
    expect(engineIsClothing(p)).toBe(true);                       // the heuristic DOES catch it
    expect(sized.preview.join(" ")).toMatch(/heuristic/i);        // …and the preview says so
  });
});

describe("refusals", () => {
  it("refuses a key collision, naming the existing category", () => {
    const r = deriveNewCategory(
      { label: "T-Shirts", top: "clothing", oneSize: false, sizeRunKey: "apparel", refillLane: "clothing", displayChecks: true },
      TAXONOMY_SEED,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("t-shirts");
  });
  it("refuses a missing name, lane, or size run", () => {
    expect(deriveNewCategory({ label: "X", refillLane: "clothing" }, TAXONOMY_SEED).ok).toBe(false);
    expect(deriveNewCategory({ label: "Scarves", refillLane: "apparel" }, TAXONOMY_SEED).ok).toBe(false);
    expect(deriveNewCategory({ label: "Scarves", refillLane: "clothing", oneSize: false, sizeRunKey: "nope" }, TAXONOMY_SEED).ok).toBe(false);
  });
});

describe("the preview tells the truth", () => {
  it("always states the POS-chip limitation", () => {
    const r = deriveNewCategory(
      { label: "Scarves", top: "clothing", oneSize: false, sizeRunKey: "apparel", refillLane: "clothing", displayChecks: true },
      TAXONOMY_SEED,
    );
    expect(r.preview.join(" ")).toMatch(/does NOT create a browse chip/);
    expect(r.preview.join(" ")).toMatch(/marathon-pos-app/);
  });
  it("names every legacy field it will write", () => {
    const r = deriveNewCategory(
      { label: "Colognes", top: "clothing", oneSize: true, refillLane: "none", displayChecks: true },
      TAXONOMY_SEED,
    );
    const text = r.preview.join(" ");
    expect(text).toContain('"Perfume"');
    expect(text).toMatch(/OMITTED/);
  });
});
