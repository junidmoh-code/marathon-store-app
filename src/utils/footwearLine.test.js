import { describe, it, expect } from "vitest";
import {
  isFootwearLine, productIsFootwear, sizeLooksLikeShoe,
  FOOTWEAR_CATEGORY_KEYS, FOOTWEAR_LEGACY_CATEGORY,
} from "./footwearLine.js";

// Every fixture below is a REAL shape from the live catalogue on 2026-07-29.
const shoe = { category: "Footwear", productType: "sneaker", name: "Air Jordan 4 Retro Black Cat" };
const kids = { category: "Footwear", productType: "sneaker", name: "Kids soccerboot" };
const tee = { category: "Clothing", productType: "clothing", name: "Boss Black T-Shirt" };
const bag = { category: "Accessories", productType: "clothing", name: "Jordan Backpack Black" };
const perfume = { category: "Perfume", name: "Lacoste perfume 100ML" };

describe("sizeLooksLikeShoe", () => {
  it("numeric sizes are shoe sizes", () => {
    for (const s of ["3", "6", "9", "11"]) expect(sizeLooksLikeShoe(s)).toBe(true);
  });
  it("half sizes, raw and RTDB-encoded", () => {
    expect(sizeLooksLikeShoe("5.5")).toBe(true);
    expect(sizeLooksLikeShoe("5_5")).toBe(true);
  });
  it("kids sizes 26-33 are shoe sizes — the waist cutoff must NOT apply here", () => {
    for (const s of ["26", "28", "30", "33"]) expect(sizeLooksLikeShoe(s)).toBe(true);
  });
  it("letter sizes are never shoe sizes", () => {
    for (const s of ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "2XL"]) {
      expect(sizeLooksLikeShoe(s)).toBe(false);
    }
  });
  it("the one-size sentinel is not a shoe size", () => expect(sizeLooksLikeShoe("_")).toBe(false));
  it("junk, empty and null are not shoe sizes", () => {
    for (const s of ["", "  ", "Free Size", null, undefined, {}, []]) expect(sizeLooksLikeShoe(s)).toBe(false);
  });
  it("accepts a number as well as a string", () => expect(sizeLooksLikeShoe(9)).toBe(true));
});

describe("productIsFootwear", () => {
  it("legacy category Footwear counts", () => expect(productIsFootwear(shoe)).toBe(true));
  it("clothing, accessories and perfume do not", () => {
    for (const p of [tee, bag, perfume]) expect(productIsFootwear(p)).toBe(false);
  });
  it("categoryKey WINS over the legacy category when present", () => {
    // A product reassigned to a footwear key but whose legacy category still says
    // Clothing is footwear; and the reverse.
    expect(productIsFootwear({ category: "Clothing", categoryKey: "boots" })).toBe(true);
    expect(productIsFootwear({ category: "Footwear", categoryKey: "t-shirts" })).toBe(false);
  });
  it("every footwear registry key is recognised", () => {
    for (const k of FOOTWEAR_CATEGORY_KEYS) expect(productIsFootwear({ categoryKey: k })).toBe(true);
  });
  it("a blank categoryKey falls through to the legacy category", () => {
    expect(productIsFootwear({ categoryKey: "  ", category: "Footwear" })).toBe(true);
  });
  it("null / unknown product is not footwear", () => {
    expect(productIsFootwear(null)).toBe(false);
    expect(productIsFootwear({})).toBe(false);
  });
});

// ═══ THE GATE ════════════════════════════════════════════════════════════════
describe("isFootwearLine — both keys must agree", () => {
  it("a real sneaker sale routes to the hub", () => expect(isFootwearLine(shoe, "9")).toBe(true));
  it("a kids shoe at size 30 routes to the hub", () => expect(isFootwearLine(kids, "30")).toBe(true));
  it("a half size routes to the hub", () => expect(isFootwearLine(shoe, "5.5")).toBe(true));

  it("a t-shirt NEVER routes to the hub", () => {
    for (const s of ["S", "M", "L", "XL"]) expect(isFootwearLine(tee, s)).toBe(false);
  });
  it("a one-size bag NEVER routes to the hub", () => expect(isFootwearLine(bag, "_")).toBe(false));
  it("perfume NEVER routes to the hub", () => expect(isFootwearLine(perfume, "_")).toBe(false));
});

// ── The live conflicts this gate exists to survive ───────────────────────────
describe("real catalogue conflicts (measured 2026-07-29)", () => {
  // 12 live products are clothing carrying productType "sneaker". Gating on
  // productType would deduct these from a hub.
  const misTyped = [
    { category: "Clothing", productType: "sneaker", name: "Nike Puffer Jacket Black" },
    { category: "Clothing", productType: "sneaker", name: "Diesel Cargo Jeans Grey" },
    { category: "Clothing", productType: "sneaker", name: "FC Barcelona Away Jersey Mint" },
    { category: "Clothing", productType: "sneaker", name: "Portugal tracksuit white" },
  ];
  it('clothing mis-typed productType:"sneaker" still stays at the shop', () => {
    for (const p of misTyped) {
      expect(productIsFootwear(p)).toBe(false);
      for (const s of ["S", "M", "L", "XL", "XXL"]) expect(isFootwearLine(p, s)).toBe(false);
    }
  });

  // "Designer Light Brown 9551" — category Clothing, sizes XXL,XL,L,M,S AND a
  // stray "5.5". The size key alone would send that one line to a hub.
  it("a stray shoe size on a clothing product does not reach the hub", () => {
    const strayed = { category: "Clothing", productType: "sneaker", name: "Designer Light Brown 9551" };
    expect(isFootwearLine(strayed, "5.5")).toBe(false);
  });

  // "Lacoste navy with white" — category Footwear but productType clothing.
  it("footwear mis-typed productType:\"clothing\" still routes to the hub", () => {
    const p = { category: "Footwear", productType: "clothing", name: "Lacoste navy with white" };
    expect(isFootwearLine(p, "8")).toBe(true);
  });

  // "Karl paper bag" — category Accessories, size "3".
  it("an accessory sized 3 does not reach the hub", () => {
    expect(isFootwearLine({ category: "Accessories", name: "Karl paper bag" }, "3")).toBe(false);
  });
});

// ── The safety property, stated as a test ────────────────────────────────────
describe("fails safe", () => {
  it("an unknown product NEVER routes to the hub", () => {
    expect(isFootwearLine(null, "9")).toBe(false);
    expect(isFootwearLine(undefined, "9")).toBe(false);
    expect(isFootwearLine({}, "9")).toBe(false);
  });

  it("a product with NO productType and NO category never routes to the hub", () => {
    // The exact case a negative test (`productType !== "clothing"`) gets wrong.
    expect(isFootwearLine({ name: "mystery item" }, "9")).toBe(false);
  });

  it("productType is not consulted at all", () => {
    const a = { category: "Footwear", productType: "clothing" };
    const b = { category: "Footwear", productType: "sneaker" };
    const c = { category: "Footwear" };
    expect(isFootwearLine(a, "9")).toBe(isFootwearLine(b, "9"));
    expect(isFootwearLine(b, "9")).toBe(isFootwearLine(c, "9"));
  });

  it("footwear with a missing size stays at the shop rather than guessing", () => {
    expect(isFootwearLine(shoe, null)).toBe(false);
    expect(isFootwearLine(shoe, "")).toBe(false);
  });

  it("the legacy category constant is exactly the live tree's value", () => {
    expect(FOOTWEAR_LEGACY_CATEGORY).toBe("Footwear");
  });
});

// ── CROSS-APP DRIFT GUARD ────────────────────────────────────────────────────
// MIRRORED in marathon-pos-app/src/shared/__tests__/footwearLine.test.js. Both
// apps write the same /stock: if the store-app skips a transfer because it calls
// a line footwear, and the POS deducts at the shop because it does not, the units
// are never deducted anywhere. A one-sided edit must fail here, not at a till.
describe("cross-app contract (mirror of the POS copy)", () => {
  it("the footwear key set is exactly these seven, in this order", () => {
    expect([...FOOTWEAR_CATEGORY_KEYS]).toEqual([
      "sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes",
    ]);
  });

  it("the legacy category is exactly 'Footwear'", () => {
    expect(FOOTWEAR_LEGACY_CATEGORY).toBe("Footwear");
  });

  it("the decision table both apps rely on", () => {
    const cases = [
      [{ category: "Footwear" }, "9", true],
      [{ category: "Footwear" }, "5.5", true],
      [{ category: "Footwear" }, "5_5", true],
      [{ category: "Footwear" }, "30", true],
      [{ category: "Footwear" }, "M", false],
      [{ category: "Footwear" }, "_", false],
      [{ category: "Footwear" }, null, false],
      [{ category: "Clothing" }, "9", false],
      [{ category: "Accessories" }, "3", false],
      [{ category: "Perfume" }, "_", false],
      [{ categoryKey: "boots", category: "Clothing" }, "8", true],
      [{ categoryKey: "t-shirts", category: "Footwear" }, "8", false],
      [null, "9", false],
      [{}, "9", false],
    ];
    for (const [product, size, expected] of cases) {
      expect(isFootwearLine(product, size), `${JSON.stringify(product)} @ ${size}`).toBe(expected);
    }
  });
});
