// ─── SLIDES MUST BE ASKED FOR A STYLE CODE — and it is a CONFIG paste ────────
// (Owner spec 2026-08-23: "Slides currently ask for nothing when added. They
// must behave exactly like sneakers and soccer boots.")
//
// THE ANSWER, AND WHY THERE IS NO CODE CHANGE FOR IT. The enforced set is data:
// /config/styleCode/enforcedCategories, read live by useStyleCodeConfig and
// applied by isCategoryEnforced against the CATEGORY KEY the operator chose in
// step 0. The live catalogue's key for slides is exactly
//
//     "slides"                                    (51 live products, 2026-08-23)
//
// — the taxonomy registry's own key (settings/productTaxonomy/cats/slides,
// top: "footwear", label "Slides"), not a display name and not a guess. So the
// whole of Part 1 is this console value:
//
//     /config/styleCode/enforcedCategories = ["sneakers","soccer-boots","slides"]
//
// These tests prove that claim rather than asserting it: with that value set,
// a slide is gated exactly as a sneaker is; with today's live value, it is not.
// If the gate needed code to reach slides, the first test here would fail.

import { describe, it, expect } from "vitest";
import { isCategoryEnforced, readEnforcedCategories } from "./styleCodeGateLogic.js";
import { DEFAULT_ENFORCED_CATEGORIES } from "../../config/styleCode.js";

const LIVE_TODAY = { enforcedCategories: ["sneakers", "soccer-boots"] };
const WITH_SLIDES = { enforcedCategories: ["sneakers", "soccer-boots", "slides"] };

describe("slides under the config-driven gate", () => {
  it("TODAY a slide is asked for nothing — the live value omits it", () => {
    const enforced = readEnforcedCategories(LIVE_TODAY, DEFAULT_ENFORCED_CATEGORIES);
    expect(isCategoryEnforced("slides", enforced)).toBe(false);
  });

  it("with the console value pasted, a slide CANNOT be added without the gate", () => {
    const enforced = readEnforcedCategories(WITH_SLIDES, DEFAULT_ENFORCED_CATEGORIES);
    expect(isCategoryEnforced("slides", enforced)).toBe(true);
  });

  it("a slide is then gated EXACTLY as a sneaker and a soccer boot are", () => {
    const enforced = readEnforcedCategories(WITH_SLIDES, DEFAULT_ENFORCED_CATEGORIES);
    for (const key of ["sneakers", "soccer-boots", "slides"]) {
      expect(isCategoryEnforced(key, enforced)).toBe(true);
    }
  });

  it("nothing else is dragged in — the other footwear keys stay unenforced", () => {
    const enforced = readEnforcedCategories(WITH_SLIDES, DEFAULT_ENFORCED_CATEGORIES);
    for (const key of ["running-shoes", "boots", "loafers", "kids-shoes", "designer-shoes"]) {
      expect(isCategoryEnforced(key, enforced)).toBe(false);
    }
    for (const key of ["t-shirts", "bags", "perfumes", "caps-beanies"]) {
      expect(isCategoryEnforced(key, enforced)).toBe(false);
    }
  });

  it("the key is matched EXACTLY — a display name never enforces anything", () => {
    const enforced = readEnforcedCategories(WITH_SLIDES, DEFAULT_ENFORCED_CATEGORIES);
    expect(isCategoryEnforced("Slides", enforced)).toBe(false);
    expect(isCategoryEnforced("slide", enforced)).toBe(false);
    expect(isCategoryEnforced("Sandals & Slides", enforced)).toBe(false);
  });

  it("a malformed console edit still fails OPEN, never locking Add Product", () => {
    for (const bad of [null, {}, { enforcedCategories: [] }, { enforcedCategories: "slides" }]) {
      const enforced = readEnforcedCategories(bad, DEFAULT_ENFORCED_CATEGORIES);
      expect(enforced).toEqual(DEFAULT_ENFORCED_CATEGORIES);
      expect(isCategoryEnforced("slides", enforced)).toBe(false);
    }
  });
});
