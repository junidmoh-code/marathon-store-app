// ─── THE REPRO, END TO END AT THE PURE LAYER ─────────────────────────────────
// "Gucci watch gold with white inside" — Watches (non-enforced), one photo, one
// one-size stock line of 4 into Central, Hub 2 selected — failed on live with
// the generic alert. This file walks the exact data path addProduct walks with
// the exact sentinel intake the non-enforced flow seeds, and asserts every
// derived shape the live rules and /stock contract require. A real RTDB
// round-trip is deliberately NOT attempted here: end-to-end verification
// against live data is owner-nominated only.

import { describe, it, expect } from "vitest";
import { buildNewProduct, stampStyleCodeProvenance, isSetSafe } from "./newProductRecord.js";
import { TAXONOMY_SEED } from "./productTaxonomy.js";
import { receiveEntries } from "../components/admin/SizeQtyBoxes.jsx";
import { stockCellPath, stockSizeKey } from "./sizeKey.js";

// The exact sentinel the non-enforced Add Product path seeds (App.jsx).
const NON_ENFORCED_INTAKE = {
  styleCode: "", styleCodeNormalised: "", exempt: null,
  suggestedName: "", suggestedBrand: null, suggestedImageUrl: null, model: null,
};

const FORM = {
  name: "Gucci watch gold with white inside",
  categoryKey: "watches",
  photo: "",
  hubs: ["hub2"],
  stockPrice: "",
  retailPrice: "",
  hasShoeBoxOption: true,
};

function buildLikeAddProduct() {
  const id = "p1754000000000";
  const p = buildNewProduct(TAXONOMY_SEED, FORM, {
    id,
    photoUrl: "https://example.invalid/photo.jpg",
    brand: null,
    styleCode: NON_ENFORCED_INTAKE.styleCode ? NON_ENFORCED_INTAKE.styleCode : null,
    exempt: NON_ENFORCED_INTAKE.exempt,
    photoUploaded: true,
    photoUpdatedAt: 1754000000000,
  });
  if (!p) return null;
  p.createdBy = { uid: "uid-mike", deviceId: "dev-1", at: 1754000000001 };
  stampStyleCodeProvenance(p, NON_ENFORCED_INTAKE, "uid-mike");
  p.sku = "0042";
  p.barcode = "00000042";
  return p;
}

describe("a Watches save — the exact failing repro", () => {
  it("builds a record set() will accept (no undefined anywhere)", () => {
    const p = buildLikeAddProduct();
    expect(p).not.toBeNull();
    expect(isSetSafe(p)).toBe(true);
  });

  it("carries NO style-code field of any kind — watches never touch that path", () => {
    const p = buildLikeAddProduct();
    expect(Object.keys(p).filter((k) => k.startsWith("styleCode"))).toEqual([]);
  });

  it("keeps the required hub selection (Hub 2) and the one-size sentinel", () => {
    const p = buildLikeAddProduct();
    expect(p.hubs).toEqual(["hub2"]);
    expect(p.sizes).toEqual(["_"]);
    expect(p.name).toBe("Gucci watch gold with white inside");
    expect(p.category).toBe("Accessories");
    expect(p.subcategory).toBe("Watches");
  });

  it("the 4-unit line becomes one received movement on the one true '_' cell", () => {
    const p = buildLikeAddProduct();
    // The quantity box keys one-size input by the "_" sentinel.
    expect(receiveEntries(p.sizes, { _: "4" })).toEqual([["_", 4]]);
    // …and the cell path applyMovement will read AND write:
    expect(stockCellPath("central", p.id, "_")).toBe(`stock/central/${p.id}/_`);
    // A display label must never mint its own cell — the Free_Size phantom.
    expect(stockSizeKey("Free Size")).toBe("_");
    expect(stockSizeKey(null)).toBe("_");
    expect(stockSizeKey("")).toBe("_");
  });
});
