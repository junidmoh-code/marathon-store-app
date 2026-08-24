// ── WHAT THE CAPTION MODEL IS AND IS NOT TOLD ────────────────────────────────
// Two owner rules from 2026-08-23 land in this prompt:
//
//   · the physical shops are never mentioned. The prompt used to introduce the
//     business as having "Three physical stores", which is precisely why real
//     captions came back saying "in-store and online". The brief no longer
//     contains a shop for the model to mention.
//
//   · prices never appear in caption prose — they are composited onto the
//     artwork from the product record. The model is not merely asked to leave
//     them out, it is NOT TOLD THEM. A number it never saw is a number it
//     cannot quote, round or mistype.
//
// The gate that actually stops a bad caption is postBlocker/postReadiness in
// src/components/social/socialCore.js (see socialShopRule.test.js). This file
// pins the prompt so the gate is rarely reached.
// vitest excludes functions/** from its include globs, so this test lives here
// and reaches the CJS module the same way socialStockParity.diff.test.js does.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { findShopMentions } from "./socialCore.js";

const require = createRequire(import.meta.url);
const { buildCaptionPrompt, fallbackCaption } = require("../../../functions/lib/social-caption.cjs");

const products = [
  { name: "Nike Air Force 1 Cream Black Grey", retailPrice: 750, slot: "shoe" },
  { name: "Lacoste Polo Red", retailPrice: 350, slot: "top" },
];

describe("the caption prompt withholds prices", () => {
  const prompt = buildCaptionPrompt({ kind: "outfit", products, link: "https://marathonclub.co.za" });

  it("contains no rand amount from the product records", () => {
    expect(prompt).not.toMatch(/R\s?750/);
    expect(prompt).not.toMatch(/R\s?350/);
    // and no bare figure either — the numbers are simply absent
    expect(prompt).not.toMatch(/\b750\b/);
    expect(prompt).not.toMatch(/\b350\b/);
  });

  it("still names the products, because a caption must be able to say what it sells", () => {
    expect(prompt).toContain("Nike Air Force 1 Cream Black Grey");
    expect(prompt).toContain("Lacoste Polo Red");
  });

  it("tells the model prices are not its job", () => {
    expect(prompt).toMatch(/NEVER write a price/i);
  });
});

describe("the caption prompt describes an online-only business", () => {
  const prompt = buildCaptionPrompt({ kind: "single", products: [products[0]], link: "x" });

  it("does not claim the business has physical stores", () => {
    expect(prompt).not.toMatch(/three physical stores/i);
    expect(prompt).not.toMatch(/physical stores and an online/i);
  });

  it("says the business is online", () => {
    expect(prompt).toMatch(/ONLINE/);
  });

  it("forbids shop, branch, address and opening-hours references", () => {
    expect(prompt).toMatch(/NEVER mention a physical shop, branch, address or opening hours/i);
    expect(prompt).toMatch(/in-?store/i);   // named explicitly as a forbidden phrase
    expect(prompt).toMatch(/REFUSED/);      // and says the post cannot go out
  });
});

// ── THE FALLBACK MUST NOT STRAND THE POST IT EXISTS TO RESCUE ────────────────
// fallbackCaption runs when the AI caption call fails or its output is
// refused — i.e. AFTER the image has already been paid for. Three of its four
// lines used to read "in store and online", written before that became a hard
// rule and never re-read when it did. postReadiness() refuses a shop mention,
// so the rescue path produced a post that could never be approved.
//
// Caught by CodeRabbit on PR #426, which spotted the displayName half; the
// shop-rule half was worse and is the reason these assertions exist.
describe("the fallback caption is postable", () => {
  const products = [
    { name: "Fragrance 100ML", displayName: "Lacoste L12 100ML" },
    { name: "Sneaker Cream Black Grey", displayName: "Nike Air Force 1 Cream Black Grey" },
  ];

  for (const kind of ["single", "new_arrivals", "outfit", "flatlay"]) {
    it(`"${kind}" mentions no shop, so it can actually be approved`, () => {
      const text = buildFallback(kind, products);
      expect(findShopMentions(text), text).toEqual([]);
    });

    it(`"${kind}" names products by their REAL name, not the storefront title`, () => {
      const text = buildFallback(kind, products);
      // Every kind names at least one product except those whose line is a
      // bare statement; when it does name one, it must be the real name.
      if (/Fragrance 100ML|Sneaker Cream/.test(text)) {
        throw new Error(`fallback used the brand-stripped storefront name: ${text}`);
      }
      expect(text.length).toBeGreaterThan(0);
    });
  }

  it("falls back to the storefront name only when there is no real one", () => {
    const text = buildFallback("single", [{ name: "Fragrance 100ML" }]);
    expect(text).toContain("Fragrance 100ML");
  });

  function buildFallback(kind, products) {
    return fallbackCaption({ kind, products });
  }
});
