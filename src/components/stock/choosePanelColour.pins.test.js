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
  it("an AUTO pick is never stored as a human answer (CodeRabbit), and a human answer stores the deciding palette, never stale state (Kimi)", () => {
    // CodeRabbit: a margin-cleared guess stored as an answer could later
    // bypass the margin through the memory path — only human taps remember.
    expect(src).toMatch(/pick\(decided\.product, \{ remember: false \}\)/);
    // Kimi: pick() must take the palette explicitly (defaulting to committed
    // state for the human-tap path), never read mid-update state on its own.
    expect(src).toMatch(/const pick = \(p, \{ remember = true, palette = photoColours \} = \{\}\) =>/);
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

describe("layout auto-pick visibility (Sonnet review PR #334)", () => {
  const reader = readFileSync(join(here, "TongueLabelReader.jsx"), "utf8");
  it("a learned-layout pick is ANNOUNCED with override chips — never invisible", () => {
    // A wrong rule (one mistaken first tap) can only self-correct if the
    // surfaces that USE it can generate the disagreeing answer. The reader
    // proceeds but shows the pick + the other token(s) as chips.
    expect(reader).toMatch(/if \(out\.auto && Array\.isArray\(out\.allCandidates\) && out\.allCandidates\.length > 1\)/);
    expect(reader).toMatch(/Wrong\? Tap the right one:/);
  });
  it("the override chips run through the SAME tap handler that teaches the rule", () => {
    expect(reader).toMatch(/learnLabelLayout\(\{ codes: readNote\.candidates, chosenCode: c \}\)/);
  });
});

describe("alias-lookup failure handling (CodeRabbit PR #334)", () => {
  it("count flow: a FAILED codeLookup errors-and-returns — never a false never-registered note", () => {
    const branch = src.slice(src.indexOf("aliasOwner = await lookupCodeAlias(normalised)"), src.indexOf("recordUnresolvedScan({ hub, code: display"));
    expect(src).toMatch(/try \{\s*\n\s*aliasOwner = await lookupCodeAlias\(normalised\);\s*\n\s*\} catch \(err\) \{/);
    expect(branch).toMatch(/return;/);
  });
  it("assistant finder: a FAILED codeLookup says so — never \"nothing owns it\"", () => {
    const app = readFileSync(join(here, "..", "..", "App.jsx"), "utf8");
    expect(app).toMatch(/aliasOwner = await lookupCodeAlias\(normaliseStyleCode\(display\)\);\s*\n\s*\} catch \{/);
    expect(app).toMatch(/Couldn't check \$\{display\} against the label-code index/);
  });
});
