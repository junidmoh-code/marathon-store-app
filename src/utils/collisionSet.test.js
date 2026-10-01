import { describe, it, expect } from "vitest";
import { distinctNamesFor, nameFromAttributes, handleFromName } from "./productAttributes.js";
import { validateVisionName } from "./visionNaming.js";

// ─── THE COLLISION SET, PINNED ───────────────────────────────────────────────
// The six products the owner brief named as the proof this build has to pass:
// four that the lexicon namer resolved to "Sneaker Black", and two on
// "Low-top sneaker Navy Blue".
//
// The PR reported them passing. A reviewer pointed out that a number in a PR
// body is not a test, and that three of the six were still carrying v1
// extractions when that run happened — so the proof was made against a mix.
// These are the LIVE v2 attributes, captured 2026-09-06 after the full
// backfill, so the assertion is against exactly the data that shipped.
//
// If a future change to the vocabulary or the tiers makes any two of these
// collide again, this fails — which is the whole point. It is the one
// regression that would put the build back where it started.
const LIVE = [
  // Nike Air Force 1 Louis Vuitton Black
  ["p1777895684767", {"brand": "Nike", "category": "Footwear", "silhouette": "low-top", "upperMaterial": "denim", "primaryColour": "black", "secondaryColour": "grey", "colourFamily": "black", "pattern": "print", "toeShape": "round", "soleColour": "black", "soleType": "cup", "closure": "laced", "finish": "textured", "priceBand": "core", "styleTags": ["luxury", "basketball", "casual"]}],
  // Nike Air Force 1 Supreme Black
  ["p1777896503209", {"brand": "Nike", "category": "Footwear", "silhouette": "low-top", "upperMaterial": "nubuck", "primaryColour": "black", "secondaryColour": "", "colourFamily": "black", "pattern": "solid", "toeShape": "round", "soleColour": "black", "soleType": "cup", "closure": "laced", "finish": "matte", "priceBand": "core", "styleTags": ["skate", "basketball", "casual"]}],
  // Nike Zoomx Invincible Run Flyknit Black
  ["p1777903744143", {"brand": "Nike", "category": "Footwear", "silhouette": "runner", "upperMaterial": "mesh", "primaryColour": "black", "secondaryColour": "", "colourFamily": "black", "pattern": "solid", "toeShape": "round", "soleColour": "black", "soleType": "chunky", "closure": "laced", "finish": "textured", "priceBand": "core", "styleTags": ["running", "chunky", "technical"]}],
  // Adidas sambarose cloud black 
  ["p1785156678328", {"brand": "Adidas", "category": "Footwear", "silhouette": "low-top", "upperMaterial": "leather", "primaryColour": "black", "secondaryColour": "white", "colourFamily": "black", "pattern": "two-tone", "toeShape": "round", "soleColour": "brown", "soleType": "platform", "closure": "laced", "finish": "textured", "priceBand": "core", "styleTags": ["retro", "chunky", "casual"]}],
  // Nike Air Force 1 Low Supreme Navy Blue
  ["p1777896558219", {"brand": "Nike", "category": "Footwear", "silhouette": "low-top", "upperMaterial": "nubuck", "primaryColour": "navy", "secondaryColour": "", "colourFamily": "blue", "pattern": "solid", "toeShape": "round", "soleColour": "navy", "soleType": "cup", "closure": "laced", "finish": "textured", "priceBand": "core", "styleTags": ["retro", "basketball", "skate"]}],
  // Boss Low Navy Blue
  ["p1778243387406", {"brand": "Boss", "category": "Footwear", "silhouette": "low-top", "upperMaterial": "knit", "primaryColour": "blue", "secondaryColour": "navy", "colourFamily": "blue", "pattern": "two-tone", "toeShape": "round", "soleColour": "white", "soleType": "chunky", "closure": "laced", "finish": "textured", "priceBand": "premium", "styleTags": ["casual", "luxury", "chunky"]}],
];

describe("the six products the brief named", () => {
  it("every one of them gets a name", () => {
    for (const [pid, attrs] of LIVE) {
      expect(nameFromAttributes(attrs), pid).not.toBe("");
    }
  });

  it("SIX DISTINCT NAMES AND SIX DISTINCT HANDLES", () => {
    const out = distinctNamesFor(LIVE);
    expect(out.size).toBe(LIVE.length);
    const names = [...out.values()].map((v) => v.name);
    const handles = [...out.values()].map((v) => v.handle);
    expect(new Set(names).size, `names: ${JSON.stringify(names)}`).toBe(LIVE.length);
    expect(new Set(handles).size, `handles: ${JSON.stringify(handles)}`).toBe(LIVE.length);
  });

  it("and every one of those names is publishable", () => {
    for (const [pid, { name }] of distinctNamesFor(LIVE)) {
      expect(validateVisionName(name).ok, `${pid}: ${name}`).toBe(true);
      expect(handleFromName(name), pid).toBeTruthy();
    }
  });

  // The two that were STILL on lexicon names and live on the storefront when
  // this was built. "sneaker-black" is the handle 11 products were blocked on.
  it("neither of the two lexicon names survives", () => {
    const out = distinctNamesFor(LIVE);
    expect(out.get("p1785156678328").handle).not.toBe("sneaker-black");
    expect(out.get("p1778243387406").handle).not.toBe("low-top-sneaker-navy-blue");
  });

  // Escalation is REACHED here, not merely implemented: these six sit in a
  // catalogue of 1,407 where several genuinely share a base name.
  it("is stable — the same six give the same six names every time", () => {
    const a = distinctNamesFor(LIVE);
    const b = distinctNamesFor([...LIVE].reverse());
    for (const [pid, v] of a) expect(b.get(pid).name, pid).toBe(v.name);
  });
});
