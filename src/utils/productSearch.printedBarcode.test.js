// ─── A CODE THE POS RESOLVES MUST NOT BE INVISIBLE TO THIS APP ───────────────
// Once a perfume's printed EAN is in /barcodes, a cashier scanning the box
// finds the product. If the app's own search does not know that number, an
// admin holding the same box and typing the same digits finds nothing — and
// concludes the product was never created. So every code a product answers to
// is searchable, not just the ones we minted.

import { describe, it, expect } from "vitest";
import { searchProducts } from "./productSearch";

const OUD_MOOD = "6291106065114";

const perfume = {
  id: "pPerfume", name: "Oud Mood 100ml",
  barcode: "00000042", sku: "0042",
  printedBarcode: OUD_MOOD,
  barcodes: { _: "00000042" },
};
const sneaker = { id: "pShoe", name: "Nike Air Force 1", barcode: "00000043", sku: "0043" };
const catalogue = [perfume, sneaker];

const ids = (q) => searchProducts(catalogue, q).map((p) => p.id);

describe("searching by the manufacturer's printed code", () => {
  it("finds the perfume by the EAN printed on its box", () => {
    expect(ids(OUD_MOOD)).toEqual(["pPerfume"]);
  });

  it("still finds it by its auto-generated shop code — both codes work", () => {
    expect(ids("00000042")).toEqual(["pPerfume"]);
  });

  it("still finds it by name and SKU", () => {
    expect(ids("oud mood")).toEqual(["pPerfume"]);
    expect(ids("0042")).toEqual(["pPerfume"]);
  });

  it("finds it by EITHER spelling of a UPC-A, whichever one is stored", () => {
    // A UPC-A and its zero-padded EAN-13 are the same number, and which one a
    // colleague reads off the box is not necessarily the one we persisted.
    // Both are registered in /barcodes, so both must be searchable here.
    const asUpc = [{ id: "pU", name: "Boxed Thing", printedBarcode: "036000291452" }];
    expect(searchProducts(asUpc, "036000291452").map((p) => p.id)).toEqual(["pU"]);
    expect(searchProducts(asUpc, "0036000291452").map((p) => p.id)).toEqual(["pU"]);

    const asEan = [{ id: "pE", name: "Boxed Thing", printedBarcode: "0036000291452" }];
    expect(searchProducts(asEan, "0036000291452").map((p) => p.id)).toEqual(["pE"]);
    expect(searchProducts(asEan, "036000291452").map((p) => p.id)).toEqual(["pE"]);
  });

  it("does not match a DIFFERENT product's code", () => {
    expect(ids(OUD_MOOD)).not.toContain("pShoe");
  });

  it("tolerates a product with no printed code (every other category)", () => {
    expect(ids("00000043")).toEqual(["pShoe"]);
    expect(ids("air force")).toEqual(["pShoe"]);
  });
});
