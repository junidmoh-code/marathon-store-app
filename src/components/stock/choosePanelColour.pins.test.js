// ─── CHOOSE PANEL colour-decision wiring pins (owner spec 2026-08-08) ────────
// The decision logic (margins, answer matching) is unit-tested in
// utils/dominantColours.test.js; these pins hold the PANEL's wiring to it —
// the part a refactor can silently detach. Source pins, same technique as
// displayRegisterRemoved.test.js: cheap, and they fail loudly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "HubCleanup.jsx"), "utf8");

describe("ChoosePanel colour wiring (Kimi review PR #334 + owner spec pins)", () => {
  it("the auto-pick records the palette that DROVE the decision, never stale state", () => {
    // The med-severity Kimi finding: pick() reading photoColours state on the
    // auto path records the PREVIOUS photo's palette. The palette must be
    // passed explicitly from the handler's local `colours`.
    expect(src).toMatch(/pick\(decided\.product, \{ palette: colours \}\)/);
    expect(src).toMatch(/const pick = \(p, \{ remember = true, palette = photoColours \} = \}?\{?\) =>|const pick = \(p, \{ remember = true, palette = photoColours \} = \{\}\) =>/);
    expect(src).toMatch(/recordColourwayAnswer\(\{\s*code: normaliseStyleCode\(panel\.code\), productId: p\.id, palette,\s*\}\)/);
  });
  it("a remembered answer resolves WITHOUT re-remembering (already human-vouched)", () => {
    expect(src).toMatch(/pick\(rememberedProduct, \{ remember: false \}\)/);
  });
  it("the decision order is memory → margin → ask, and only for sibling sets", () => {
    const photoHandler = src.slice(src.indexOf("async function handleShoePhoto"), src.indexOf("return (", src.indexOf("async function handleShoePhoto")));
    const iMemory = photoHandler.indexOf("matchColourwayAnswers");
    const iMargin = photoHandler.indexOf("selectByColourAffinity");
    expect(iMemory).toBeGreaterThan(-1);
    expect(iMargin).toBeGreaterThan(iMemory);
    expect(photoHandler).toMatch(/if \(siblings\) \{/);
  });
  it("the margin decision runs against ENRICHED candidates (on-the-fly palettes)", () => {
    expect(src).toMatch(/const withPalettes = await enrichCandidates\(\);\s*\n\s*const decided = selectByColourAffinity\(withPalettes, colours\)/);
  });
});
