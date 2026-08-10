// ─── THE RECORD, AND THE SCOPE ───────────────────────────────────────────────
// Two guarantees the /products write has to keep:
//   1. A captured printed code lands on the record ONLY when it is a real,
//      check-digit-valid manufacturer code — the field is a last line of
//      defence, not a pass-through.
//   2. PERFUME is decided by the CATEGORY CLASSIFIER, never by a category
//      label. Renaming "Perfumes" in the console must not change how any
//      product's barcode is handled.

import { describe, it, expect } from "vitest";
import { buildNewProduct, isSetSafe } from "./newProductRecord";
import { TAXONOMY_SEED } from "./productTaxonomy";
import { isPerfume, PERFUME_CATEGORY } from "./productCategory";

const OUD_MOOD = "6291106065114";
const BAD_CHECK = "6291106065115";

const perfumeForm = { name: "Oud Mood", categoryKey: "perfumes", hubs: ["hub2"], sizeRun: [], photo: "" };
const sneakerForm = { name: "Nike Air Force 1", categoryKey: "sneakers", hubs: ["hub1"], sizeRun: ["9"], photo: "" };

describe("isPerfume — the classifier, not a string match on a label", () => {
  it("recognises the legacy triple the perfume category writes", () => {
    const legacy = TAXONOMY_SEED.cats.perfumes.legacy;
    expect(legacy.category).toBe(PERFUME_CATEGORY);
    expect(isPerfume(legacy)).toBe(true);
  });

  it("recognises a saved perfume product record", () => {
    expect(isPerfume({ category: "Perfume", subcategory: "Perfume" })).toBe(true);
  });

  it("is FALSE for every other category, including the one-size accessories", () => {
    for (const key of ["sneakers", "t-shirts", "watches", "bags", "belts", "sunglasses", "caps-beanies"]) {
      expect(isPerfume(TAXONOMY_SEED.cats[key].legacy), key).toBe(false);
    }
  });

  it("keys off `category`, so the LABEL can be renamed freely", () => {
    // The registry label is console-editable presentation. A perfume category
    // relabelled "Fragrance" is still a perfume; a T-shirt category mislabelled
    // "Perfume" is still not one.
    expect(isPerfume({ label: "Fragrance", category: "Perfume" })).toBe(true);
    expect(isPerfume({ label: "Perfume", category: "Clothing" })).toBe(false);
  });

  it("tolerates null / garbage without throwing", () => {
    expect(isPerfume(null)).toBe(false);
    expect(isPerfume(undefined)).toBe(false);
    expect(isPerfume({})).toBe(false);
  });
});

describe("buildNewProduct — the printed code on the record", () => {
  it("carries a valid captured code on a perfume", () => {
    const p = buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: OUD_MOOD });
    expect(p.printedBarcode).toBe(OUD_MOOD);
    expect(p.sizes).toEqual(["_"]);           // one-size sentinel, unchanged
    expect(p.category).toBe(PERFUME_CATEGORY);
  });

  it("REFUSES a code that fails its check digit — the field is simply absent", () => {
    const p = buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: BAD_CHECK });
    expect("printedBarcode" in p).toBe(false);
  });

  it("refuses a shop-format 8-digit code in the printed slot", () => {
    const p = buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: "00000042" });
    expect("printedBarcode" in p).toBe(false);
  });

  it("OMITS the field rather than nulling it when nothing was captured", () => {
    // An `undefined` anywhere aborts the whole set() client-side (the
    // 2026-08-06 outage); a null is 5,000 pointless bytes catalogue-wide.
    const p = buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: null });
    expect("printedBarcode" in p).toBe(false);
    expect(isSetSafe(p)).toBe(true);
  });

  it("stays set-safe with a code present", () => {
    expect(isSetSafe(buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: OUD_MOOD }))).toBe(true);
  });
});

describe("every other category is untouched", () => {
  it("a sneaker record is byte-identical with and without the new extra", () => {
    const withExtra = buildNewProduct(TAXONOMY_SEED, sneakerForm, { id: "p1", printedBarcode: null });
    const without = buildNewProduct(TAXONOMY_SEED, sneakerForm, { id: "p1" });
    expect(withExtra).toEqual(without);
    expect("printedBarcode" in withExtra).toBe(false);
  });

  it("keeps the legacy fields every automation reads", () => {
    const p = buildNewProduct(TAXONOMY_SEED, sneakerForm, { id: "p1" });
    expect(p.category).toBe("Footwear");
    expect(p.productType).toBe("sneaker");
    expect(p.sizes).toEqual(["9"]);
  });

  it("perfume still omits productType, so it stays out of the refill lane", () => {
    const p = buildNewProduct(TAXONOMY_SEED, perfumeForm, { id: "p1", printedBarcode: OUD_MOOD });
    expect("productType" in p).toBe(false);
  });
});
