// ─── LINK SUGGESTIONS — the scoring, pinned to the live evidence ─────────────
// Every fixture below is a live catalogue shape from the 2026-08-13 evidence
// pull (713 code rows) or a real scan off the 2026-08-12 hub-count floor. The
// claims:
//
//   1. 742CFA0011-2G4 — the sixth Gripshot — surfaces ALL FIVE registered
//      742CFA00••-2G4 products at the top, family tier, mask in the reason.
//   2. A code whose only difference is the COLOUR segment is never family or
//      misread — it is the warned colourway tier, scored under everything.
//   3. The equal-length rule: 745SMA00042A9 (13) vs 745SMA0042A9 (12) parse
//      their article blocks at different offsets — misread tier, NOT family
//      (the live pair is navy vs light green; "same family" would lie).
//   4. The printed model name matches product names; a token broader than
//      NAME_DF_CAP names (a brand word) carries no signal.
//   5. Alias candidates map through, respect excludeIds, skip merged-away.
//   6. A code with no plausible relative returns EMPTY — the panel says so
//      honestly instead of dressing up a weak match.
//   7. Truncated reads: 742CFA0007 (a real 2026-08-12 floor scan) finds
//      742CFA00072G4; a 6-char Nike body prefix is refused (the floor is 8).
//   8. Confusable folding is COMPARISON-ONLY: 742CFA0011264 (the real G→6
//      floor misread) reaches the Gripshot family as a misread suggestion.
//   9. A pendingStyleCode equal to the scan is the top suggestion.
import { describe, it, expect } from "vitest";
import {
  buildLinkSuggestions, codeSuggestions, modelNameSuggestions, aliasSuggestions,
  splitStyleCode, isOneEditApart, isTruncatedPair, foldConfusables,
  TIER_SCORES, NAME_DF_CAP,
} from "./linkSuggestions.js";

const GRIPSHOTS = [
  { id: "g5", name: "Lacoste Gripshot Mid White", styleCodeNormalised: "742CFA00052G4", photoUrl: "p5.jpg" },
  { id: "g6", name: "Lacoster gripshot mid white and brown", styleCodeNormalised: "742CFA00062G4", photoUrl: "p6.jpg" },
  { id: "g7", name: "Lacoste Gripshot Mid Green", styleCodeNormalised: "742CFA00072G4", photoUrl: "p7.jpg" },
  { id: "g12", name: "Lacoste Gripshot White Green Orange", styleCodeNormalised: "742CFA00122G4", photoUrl: "p12.jpg" },
  { id: "g16", name: "Lacoster gripshot green", styleCodeNormalised: "742CFA00162G4", photoUrl: "p16.jpg" },
];
const NOISE = [
  { id: "nk", name: "Nike P-6000 White", styleCodeNormalised: "HF5509002" },
  { id: "ad", name: "Adidas Samba White", styleCodeNormalised: "B75806" },
];

describe("the Gripshot evidence case (claim 1)", () => {
  it("742CFA0011-2G4 surfaces all five family members on top, one-digit members first", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "742CFA00112G4", products: [...NOISE, ...GRIPSHOTS] });
    const top5 = out.slice(0, 5);
    expect(top5.map((s) => s.product.id).sort()).toEqual(["g12", "g16", "g5", "g6", "g7"]);
    expect(top5.every((s) => s.tier === "family")).toBe(true);
    // one article digit apart (0012, 0016) outrank two apart (0005/6/7)
    expect(out[0].score).toBe(93);
    expect(["g12", "g16"]).toContain(out[0].product.id);
    expect(["g12", "g16"]).toContain(out[1].product.id);
  });

  it("the reason names the family mask, per the owner spec wording", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "742CFA00112G4", products: GRIPSHOTS });
    expect(out[0].reasons.join(" ")).toContain("same code family — 742CFA00••-2G4");
  });

  it("suggestions carry the product, its registered code and a reason — the row's three facts", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "742CFA00112G4", products: GRIPSHOTS });
    for (const s of out) {
      expect(s.product.photoUrl).toBeTruthy();
      expect(s.code).toMatch(/^742CFA00\d\d2G4$/);
      expect(s.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("colourway discipline (claim 2) — measured: all 54 live colour-edit pairs are different shoes", () => {
  const MISSOURI = [
    { id: "m1", name: "Lacoste Missouri Mid Green Grey", styleCodeNormalised: "743SMA01691M3" },
    { id: "m4", name: "Lacoste Missouri Mid Green", styleCodeNormalised: "743SMA01694M3" },
  ];
  it("a colour-segment edit is the colourway tier with the warning wording — never family, never misread", () => {
    const out = codeSuggestions("743SMA01696M3", MISSOURI);
    // …96M3 vs …91M3/…94M3: colour 6M3 vs 1M3/4M3 — one char, IN the colour code
    expect(out.length).toBe(2);
    for (const s of out) {
      expect(s.tier).toBe("colourway");
      expect(s.reason).toContain("DIFFERENT colour");
    }
  });
  it("the colourway tier scores below misread, name and truncated tiers", () => {
    expect(TIER_SCORES.colourway).toBeLessThan(TIER_SCORES.misread);
    expect(TIER_SCORES.colourway).toBeLessThan(TIER_SCORES.name);
    expect(TIER_SCORES.colourway).toBeLessThan(TIER_SCORES.truncated);
  });
});

describe("the equal-length rule (claim 3) — the live navy/light-green false pairing", () => {
  it("745SMA00042A9 vs registered 745SMA0042A9 is a misread suggestion, NOT `same family`", () => {
    const out = codeSuggestions("745SMA00042A9", [
      { id: "aud", name: "Lacoste Audyssey Light Green", styleCodeNormalised: "745SMA0042A9" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("misread");
    expect(out[0].reason).toContain("Check the shoe against the photo");
  });
});

describe("the printed model name (claim 4)", () => {
  it("a label printing GRIPSHOT MID surfaces products named Gripshot", () => {
    const out = buildLinkSuggestions({
      kind: "code", normalised: "999ZZZ9999XX9", modelName: "GRIPSHOT MID 2233SP2",
      products: [...NOISE, ...GRIPSHOTS],
    });
    expect(out.length).toBe(5);
    for (const s of out) {
      expect(s.tier).toBe("name");
      expect(s.product.name.toUpperCase()).toContain("GRIPSHOT");
      expect(s.reasons.join(" ")).toContain("GRIPSHOT");
    }
  });

  it("a brand-wide token identifies nothing — dropped by document frequency, not a hand list", () => {
    const wall = Array.from({ length: NAME_DF_CAP + 1 }, (_, i) => ({ id: `w${i}`, name: `Lacoste Runner ${i}` }));
    const out = modelNameSuggestions("LACOSTE", wall);
    expect(out).toEqual([]);
  });

  it("a token reading matches names the same way (the tokens ARE the label's words)", () => {
    const out = buildLinkSuggestions({
      kind: "tokens", tokens: ["GRIPSHOT", "RUBBER", "OUTSOLE", "MENS"],
      products: [...NOISE, ...GRIPSHOTS],
    });
    expect(out.length).toBe(5);
    expect(out.every((s) => s.tier === "name")).toBe(true);
  });
});

describe("alias candidates (claim 5)", () => {
  const cands = [
    { productId: "g5", score: 0.6, shared: 4 },
    { productId: "gone", score: 0.5, shared: 3 },
    { productId: "g7", score: 0.4, shared: 3 },
  ];
  it("maps the match call's candidates onto local products and says what was shared", () => {
    const out = aliasSuggestions(cands, GRIPSHOTS);
    expect(out.map((s) => s.product.id)).toEqual(["g5", "g7"]); // "gone" not in catalogue → skipped
    expect(out[0].tier).toBe("alias");
    expect(out[0].reason).toContain("4 words");
  });
  it("candidates the operator already rejected never resurface", () => {
    const out = buildLinkSuggestions({
      kind: "tokens", tokens: ["GRIPSHOT", "RUBBER"], aliasCandidates: cands,
      excludeIds: ["g5", "g7", "g12", "g16", "g6"], products: GRIPSHOTS,
    });
    expect(out).toEqual([]);
  });
  it("merged-away products never answer", () => {
    const merged = GRIPSHOTS.map((p) => ({ ...p, mergedInto: "elsewhere" }));
    expect(aliasSuggestions(cands, merged)).toEqual([]);
    expect(codeSuggestions("742CFA00112G4", merged)).toEqual([]);
  });
});

describe("threshold honesty (claim 6)", () => {
  it("a code with no plausible relative returns EMPTY — never a padded list", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "ZZ9QQ7XW1", products: [...NOISE, ...GRIPSHOTS] });
    expect(out).toEqual([]);
  });
});

describe("truncated reads (claim 7) — real floor scan 742CFA0007", () => {
  it("742CFA0007 finds 742CFA00072G4 — the label lost its colour block to glare", () => {
    const out = codeSuggestions("742CFA0007", GRIPSHOTS);
    expect(out.length).toBe(1);
    expect(out[0].product.id).toBe("g7");
    expect(out[0].tier).toBe("truncated");
  });
  it("a 6-char Nike body prefix is refused — below the 8-char floor it fans out across colourways", () => {
    expect(isTruncatedPair("CT8527", "CT8527016")).toBe(false);
    expect(codeSuggestions("CT8527", [{ id: "n", name: "Nike", styleCodeNormalised: "CT8527016" }])).toEqual([]);
  });
});

describe("confusable folding (claim 8) — real floor scan 742CFA0011264", () => {
  it("G→6 misreads reach the family as misread suggestions, comparison-only", () => {
    const out = codeSuggestions("742CFA0011264", GRIPSHOTS);
    const ids = out.map((s) => s.product.id).sort();
    expect(ids).toEqual(["g12", "g16"]); // one edit after folding 2G4→264
    expect(out.every((s) => s.tier === "misread")).toBe(true);
  });
  it("folding never touches identity — an exact-after-fold code is NOT an exact match", () => {
    expect(foldConfusables("742CFA00122G4")).toBe("742CFA0012264");
    const out = codeSuggestions("742CFA0012264", [GRIPSHOTS[3]]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("misread"); // suggested for a human — never pendingExact/resolved
  });
});

describe("pending codes (claim 9)", () => {
  it("a pendingStyleCode equal to the scan is the strongest suggestion", () => {
    const out = buildLinkSuggestions({
      kind: "code", normalised: "742CFA00112G4",
      products: [...GRIPSHOTS, { id: "pend", name: "Lacoste Gripshot Navy", pendingStyleCode: "742CFA00112G4" }],
    });
    expect(out[0].product.id).toBe("pend");
    expect(out[0].tier).toBe("pendingExact");
    expect(out[0].score).toBe(TIER_SCORES.pendingExact);
  });
});

describe("the splitters", () => {
  it("splits every catalogued shape at its printed colour boundary", () => {
    expect(splitStyleCode("CT8527016")).toMatchObject({ body: "CT8527", colour: "016" });
    expect(splitStyleCode("315122111")).toMatchObject({ body: "315122", colour: "111" });
    expect(splitStyleCode("38019001")).toMatchObject({ body: "380190", colour: "01" });
    expect(splitStyleCode("742CFA00052G4")).toMatchObject({ colour: "2G4" });
    expect(splitStyleCode("742CFA0005").colour).toBe(""); // suffix-less: boundary unknowable
    expect(splitStyleCode("B75806").colour).toBe("");     // adidas: no colour block at all
  });
  it("one-edit is a substitution or a single dropped character, nothing wider", () => {
    expect(isOneEditApart("742CFA00112G4", "742CFA00122G4")).toBe(true);
    expect(isOneEditApart("45SMA0042A9", "745SMA0042A9")).toBe(true);
    expect(isOneEditApart("742CFA00112G4", "742CFA00052G4")).toBe(false); // two digits apart
    expect(isOneEditApart("ABC", "ABC")).toBe(false);
  });
});
