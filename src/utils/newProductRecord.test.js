import { describe, it, expect } from "vitest";
import { buildNewProduct, cleanHubs } from "./newProductRecord.js";
import { TAXONOMY_SEED } from "./productTaxonomy.js";

const REG = TAXONOMY_SEED;
const base = {
  name: "  Nike Air Force 1 Triple White  ",
  categoryKey: "sneakers",
  photo: "👟",
  hubs: ["hub1"],
  stockPrice: "",
  retailPrice: "",
  hasShoeBoxOption: true,
};
const build = (over = {}, extras = {}) =>
  buildNewProduct(REG, { ...base, ...over }, { id: "p123", brand: "Nike", ...extras });

// ── The gate classifiers, mirrored EXACTLY as the deployed code applies them ──
// If a change to the derivation would break one of these, it breaks here first.

// functions/lib/refill-engine.cjs:170
const engineIsClothing = (p) => {
  if (!p) return false;
  if (p.productType) return p.productType === "clothing";
  return (p.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
};
// functions/displayChecks/lib.cjs:58
const displayCheckFires = (p, rawSize) => {
  if (p && p.category === "Perfume") return true;
  const pt = p && p.productType;
  if (pt) return pt === "clothing";
  return typeof rawSize === "string" && /^(S|M|L|XL|XXL|XXXL)$/i.test(rawSize);
};
// marathon-pos-app/src/shared/sizeClass.js — size string only, never the category
const posShowsShoebox = (size) => {
  if (typeof size !== "string") return true;
  const s = size.trim().toUpperCase();
  if (/^(XS|S|M|L|X+L|[2-9]X+L)$/.test(s)) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) < 28;
  return true;
};

describe("cleanHubs", () => {
  it("strips hub1 for clothing", () => expect(cleanHubs(["hub1", "hub2"], true)).toEqual(["hub2"]));
  it("keeps hub1 for footwear", () => expect(cleanHubs(["hub1", "hub3"], false)).toEqual(["hub1", "hub3"]));
  it("falls back to hub2 when clothing empties the list", () => expect(cleanHubs(["hub1"], true)).toEqual(["hub2"]));
  it("falls back to hub1 when footwear has nothing", () => expect(cleanHubs([], false)).toEqual(["hub1"]));
  it("drops junk hub ids", () => expect(cleanHubs(["hub1", "hub9", "central"], false)).toEqual(["hub1"]));
  it("de-duplicates", () => expect(cleanHubs(["hub2", "hub2"], true)).toEqual(["hub2"]));
  it("survives a non-array", () => expect(cleanHubs(null, false)).toEqual(["hub1"]));
});

describe("buildNewProduct — core shape", () => {
  it("writes the new categoryKey", () => expect(build().categoryKey).toBe("sneakers"));
  it("trims the name", () => expect(build().name).toBe("Nike Air Force 1 Triple White"));
  it("takes sizes from the registry, not the form", () => {
    expect(build().sizes).toEqual(["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"]);
    expect(build({ categoryKey: "t-shirts" }).sizes).toEqual(["S", "M", "L", "XL", "XXL", "XXXL"]);
  });
  it("refuses an unknown category rather than half-typing a product", () => {
    expect(build({ categoryKey: "not-real" })).toBeNull();
    expect(build({ categoryKey: "" })).toBeNull();
  });

  it("refuses a category with no sizes — the shape a console edit can produce", () => {
    const reg = { ...REG, cats: { ...REG.cats, empty: {
      key: "empty", label: "Empty", top: "footwear", order: 99, sizeMode: "list", sizes: [],
      legacy: { category: "Footwear", subcategory: "Sneakers", productType: "sneaker" }, active: true,
    } } };
    // No sizes means no stock cells and no barcodes — a product that can never
    // hold inventory. Refuse rather than create it.
    expect(buildNewProduct(reg, { ...base, categoryKey: "empty" }, { id: "p1" })).toBeNull();
  });
});

describe("buildNewProduct — prices", () => {
  it("omits empty prices entirely", () => {
    const p = build();
    expect("stockPrice" in p).toBe(false);
    expect("retailPrice" in p).toBe(false);
  });
  it("never writes 0 (POS would treat the product as free)", () => {
    const p = build({ stockPrice: "0", retailPrice: "0" });
    expect("stockPrice" in p).toBe(false);
    expect("retailPrice" in p).toBe(false);
  });
  it("parses valid prices to numbers", () => {
    const p = build({ stockPrice: "450", retailPrice: "1299.99" });
    expect(p.stockPrice).toBe(450);
    expect(p.retailPrice).toBe(1299.99);
  });
  it("omits non-numeric junk", () => expect("stockPrice" in build({ stockPrice: "abc" })).toBe(false));
});

describe("buildNewProduct — shoebox", () => {
  it("footwear keeps the operator's choice", () => {
    expect(build({ categoryKey: "sneakers", hasShoeBoxOption: true }).hasShoeBoxOption).toBe(true);
    expect(build({ categoryKey: "sneakers", hasShoeBoxOption: false }).hasShoeBoxOption).toBe(false);
  });
  it("clothing is forced false even if the form says true", () => {
    expect(build({ categoryKey: "t-shirts", hasShoeBoxOption: true }).hasShoeBoxOption).toBe(false);
    expect(build({ categoryKey: "bags", hasShoeBoxOption: true }).hasShoeBoxOption).toBe(false);
  });
  it("is always explicitly present so POS never infers it", () => {
    expect("hasShoeBoxOption" in build()).toBe(true);
  });
});

describe("buildNewProduct — omission vs null", () => {
  it("omits subcategory where no legacy leaf exists (Loafers, Dresses)", () => {
    for (const k of ["loafers", "dresses"]) {
      const p = build({ categoryKey: k });
      expect("subcategory" in p).toBe(false);
    }
  });
  it("omits productType for Perfume — matching the 53 live perfume records", () => {
    const p = build({ categoryKey: "perfumes" });
    expect("productType" in p).toBe(false);
    expect(p.category).toBe("Perfume");
  });
  it("writes subcategory and productType wherever they exist", () => {
    const p = build({ categoryKey: "t-shirts" });
    expect(p.subcategory).toBe("T-Shirts");
    expect(p.productType).toBe("clothing");
  });
  it("never writes a literal null into subcategory/productType", () => {
    for (const key of Object.keys(REG.cats)) {
      const p = build({ categoryKey: key });
      if ("subcategory" in p) expect(p.subcategory).not.toBeNull();
      if ("productType" in p) expect(p.productType).not.toBeNull();
    }
  });
});

// ═══ THE GUARANTEE ═══════════════════════════════════════════════════════════
// For every one of the 31 categories, assert what each live automation will do
// with the record this form produces.
describe("every category lands correctly in every live automation", () => {
  const REFILL_MANAGED = new Set([
    "t-shirts", "golf-t-shirts", "hoodies", "sweaters", "jackets", "tracksuits", "pants", "jeans",
    "shorts", "cargo-pants", "basketball-vests", "baseball-shirts", "soccer-jerseys", "dresses",
    "underwear", "fitted-caps", "gloves",
    // one-size accessories: the engine SEES them (productType clothing) but can
    // never resolve a target for "_", so they only surface in the No-Target queue.
    "bags", "belts", "watches", "chains-bracelets", "sunglasses", "caps-beanies",
  ]);
  const FOOTWEAR = ["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes"];

  for (const key of Object.keys(REG.cats)) {
    it(`${key}`, () => {
      const p = build({ categoryKey: key, hubs: ["hub1", "hub2", "hub3"] });
      expect(p).not.toBeNull();

      // Refill engine
      expect(engineIsClothing(p)).toBe(REFILL_MANAGED.has(key));

      // Display Checks — fires for everything clothing-typed, plus Perfume by category
      const expectedCheck = REFILL_MANAGED.has(key) || key === "perfumes";
      expect(displayCheckFires(p, p.sizes[0])).toBe(expectedCheck);

      // Hub rule: clothing-typed products can never carry hub1
      if (REFILL_MANAGED.has(key)) expect(p.hubs).not.toContain("hub1");
      else expect(p.hubs).toContain("hub1");

      // POS browse needs a real top-level category on every record
      expect(["Footwear", "Clothing", "Accessories", "Perfume"]).toContain(p.category);

      // Footwear categories are all productType sneaker and shoebox-eligible
      if (FOOTWEAR.includes(key)) {
        expect(p.productType).toBe("sneaker");
        expect(p.category).toBe("Footwear");
      }
    });
  }

  it("perfume is the ONLY category that fires a display check without being refill-managed", () => {
    const odd = Object.keys(REG.cats).filter((k) => {
      const p = build({ categoryKey: k });
      return displayCheckFires(p, p.sizes[0]) && !engineIsClothing(p);
    });
    expect(odd).toEqual(["perfumes"]);
  });
});

describe("one-size categories", () => {
  const ONE = ["bags", "belts", "watches", "chains-bracelets", "sunglasses", "caps-beanies", "perfumes"];

  it('carry exactly the "_" sentinel, which is the cell key POS already writes', () => {
    for (const k of ONE) expect(build({ categoryKey: k }).sizes).toEqual(["_"]);
  });

  it('the "_" size never resolves a standard refill target', () => {
    // functions/lib/refill-engine.cjs STANDARD_SIZE_RE
    const STANDARD = /^(S|M|L|XL|XXL|XXXL)$/i;
    for (const k of ONE) expect(build({ categoryKey: k }).sizes.some((s) => STANDARD.test(s))).toBe(false);
  });
});

describe("POS shoebox stays size-driven (unchanged by this build)", () => {
  it("shows on footwear sizes, hides on apparel sizes", () => {
    expect(build({ categoryKey: "sneakers" }).sizes.every(posShowsShoebox)).toBe(true);
    expect(build({ categoryKey: "t-shirts" }).sizes.some(posShowsShoebox)).toBe(false);
  });

  // PRE-EXISTING POS QUIRK, documented not fixed — the POS reads the size STRING
  // only and this build does not touch the POS repo. The waist threshold is 28,
  // so a kids shoe SPLITS: sizes 26–27 offer the +box charge, 28–33 do not, on
  // the same product. Flagged as a POS follow-up; asserted here so the split is
  // recorded rather than discovered later at a till.
  it("kids shoes split at the waist threshold: 26–27 show the box, 28–33 hide it", () => {
    const sizes = build({ categoryKey: "kids-shoes" }).sizes;
    expect(sizes.filter(posShowsShoebox)).toEqual(["26", "27"]);
    expect(sizes.filter((s) => !posShowsShoebox(s))).toEqual(["28", "29", "30", "31", "32", "33"]);
  });

  it("fitted caps 55–63 also read as waists — same pre-existing size-string rule", () => {
    expect(build({ categoryKey: "fitted-caps" }).sizes.some(posShowsShoebox)).toBe(false);
  });
});

describe("photo stamp", () => {
  it("stamps photoUpdatedAt only when a real photo was uploaded", () => {
    expect("photoUpdatedAt" in build({}, { photoUploaded: false, photoUpdatedAt: null })).toBe(false);
    expect(build({}, { photoUploaded: true, photoUpdatedAt: 1700000000000 }).photoUpdatedAt).toBe(1700000000000);
  });
});

// ─── STYLE CODE ──────────────────────────────────────────────────────────────
// The manufacturer code off the inside-tongue label. It is the intake identity
// key for sneakers, so the pair must be written together and normalised the ONE
// way — a product stamped with a key nothing else computes is a product no
// future scan will ever find.
describe("style code", () => {
  it("writes the pair — readable form plus the normalised identity key", () => {
    const p = build({}, { styleCode: "CT8527-016" });
    expect(p.styleCode).toBe("CT8527-016");
    expect(p.styleCodeNormalised).toBe("CT8527016");
  });

  it("keeps the operator's spelling but always normalises the key", () => {
    const p = build({}, { styleCode: "  ct8527 016 " });
    expect(p.styleCode).toBe("ct8527 016");
    expect(p.styleCodeNormalised).toBe("CT8527016");
  });

  it("renders a canonical display form when only a bare code is supplied", () => {
    expect(build({}, { styleCode: "CT8527016" }).styleCode).toBe("CT8527016");
    expect(build({}, { styleCode: "CT8527016" }).styleCodeNormalised).toBe("CT8527016");
  });

  it("OMITS both fields when there is no code — absent means 'no code'", () => {
    for (const none of [undefined, null, "", "   ", "---"]) {
      const p = build({}, { styleCode: none });
      expect("styleCode" in p).toBe(false);
      expect("styleCodeNormalised" in p).toBe(false);
    }
  });

  it("never writes one field without the other", () => {
    for (const code of ["CT8527-016", "IE3437", "ML574EVG", "380190-01", "", null]) {
      const p = build({}, { styleCode: code });
      expect("styleCode" in p).toBe("styleCodeNormalised" in p);
    }
  });

  it("THE GATE: sibling colorways get different keys on the product record", () => {
    const a = build({}, { styleCode: "CT8527-016" });
    const b = build({}, { styleCode: "CT8527-700" });
    expect(a.styleCodeNormalised).not.toBe(b.styleCodeNormalised);
  });

  it("is additive — adding a code changes nothing else on the record", () => {
    const without = build({});
    const { styleCode, styleCodeNormalised, ...rest } = build({}, { styleCode: "CT8527-016" });
    expect(rest).toEqual(without);
  });

  it("clothing can carry a code too — the field is not footwear-gated here", () => {
    // Nike apparel prints the same 6+3 format. Category comes from the intake
    // entry point, never from the code, so the record must not refuse one.
    const p = build({ categoryKey: "t-shirts", hubs: ["hub2"] }, { styleCode: "DD1391-100" });
    expect(p.styleCodeNormalised).toBe("DD1391100");
    expect(p.productType).toBe("clothing");
  });
});
