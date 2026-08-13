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
//  10. THE SFA/SMA FLOOR CASE (owner spec 2026-08-13): the label 745SMA004-21G
//      in hand, the product registered 745SFA000521G — gender letters AND
//      length differ, only the trailing colour code survives. The colourCode
//      tier surfaces it near the top with "same colour code 21G" as the
//      reason, while the AUTO-LINK rule (perSizeStyleCode.js) still refuses
//      the same pair: the two thresholds are separate and must stay so.
//  11. NEVER EMPTY: fillToMin pads the panel with honest "closest" rows from
//      any non-empty catalogue; fillers never outrank a real tier; the
//      default (no fillToMin) keeps the old empty-means-nothing contract.
//  12. weak rows (brandSegment / substring / closest) are browsing evidence:
//      flagged so the intake gate's BLOCKING step can ignore them, while
//      colourCode is NOT weak — it is exactly the duplicate-minting label.
import { describe, it, expect } from "vitest";
import {
  buildLinkSuggestions, codeSuggestions, modelNameSuggestions, aliasSuggestions,
  closestCandidates, splitStyleCode, isOneEditApart, isTruncatedPair, foldConfusables,
  longestCommonSubstring, TIER_SCORES, NAME_DF_CAP,
} from "./linkSuggestions.js";
import { perSizeAutoCandidate, perSizeSiblingCodes } from "./perSizeStyleCode.js";

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
  it("a code with no plausible relative returns EMPTY by default — the padded list is opt-in", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "ZZ9QQ7XW1", products: [...NOISE, ...GRIPSHOTS] });
    expect(out).toEqual([]);
  });
});

describe("the SFA/SMA floor case (claim 10) — 2026-08-13, staff blocked mid-count", () => {
  const AUDYSOL = { id: "aud", name: "Lacoste Audysol White", styleCodeNormalised: "745SFA000521G", photoUrl: "aud.jpg" };
  it("scanning 745SMA004-21G suggests the product registered as 745SFA000521G at the top — same colour code 21G", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "745SMA00421G", products: [...NOISE, AUDYSOL, ...GRIPSHOTS] });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].product.id).toBe("aud");
    expect(out[0].tier).toBe("colourCode");
    expect(out[0].reasons.join(" ")).toContain("same colour code 21G");
  });
  it("the SAME pair still refuses to auto-link — the tight threshold is a different rule in a different file", () => {
    // perSizeStyleCode.js demands identical gender letters and an article
    // block exactly one digit apart; SFA vs SMA fails clause 2 outright.
    expect(perSizeSiblingCodes("745SMA00421G", "745SFA000521G")).toBe(false);
    expect(perSizeAutoCandidate("745SMA00421G", [AUDYSOL])).toBe(null);
  });
  it("colourCode needs a shared lead — the same colour code on an unrelated brand family is not a suggestion", () => {
    // Two nike-format codes sharing only the trailing 002: no shared prefix,
    // no tier (colour codes like -100 repeat across half the catalogue).
    const out = codeSuggestions("ZQ1111002", [{ id: "nk", name: "Nike P-6000 White", styleCodeNormalised: "HF5509002" }]);
    expect(out.filter((s) => s.tier === "colourCode")).toEqual([]);
  });
  it("colourCode sits below misread but above the name tier's base — one char off is still stronger evidence", () => {
    expect(TIER_SCORES.colourCode).toBeLessThan(TIER_SCORES.misread);
    expect(TIER_SCORES.colourCode).toBeGreaterThan(TIER_SCORES.name);
  });
});

describe("the loose browsing tiers (claim 12) — shared lead, shared fragment", () => {
  it("a shared 4+ char lead in the same format is a weak brandSegment suggestion", () => {
    // 745SMA00421G vs 745SMA0042A9 — the live navy/light-green pair: two
    // chars apart (not misread), colours differ (not colourCode), lead of 10.
    const out = codeSuggestions("745SMA00421G", [{ id: "nvy", name: "Lacoste Audyssey Navy", styleCodeNormalised: "745SMA0042A9" }]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("brandSegment");
    expect(out[0].weak).toBe(true);
    expect(out[0].reason).toContain("745SMA0042");
  });
  it("a long shared fragment ANYWHERE is a weak substring suggestion; short fragments are refused", () => {
    expect(longestCommonSubstring("742CFA00112G4", "888742CFA1111")).toBe("742CFA");
    const out = codeSuggestions("742CFA00112G4", [{ id: "x", name: "Odd import", styleCodeNormalised: "888742CFA1111" }]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("substring");
    expect(out[0].weak).toBe(true);
    expect(out[0].reason).toContain("742CFA");
    expect(codeSuggestions("742CF999999", [{ id: "x", name: "Odd", styleCodeNormalised: "888742CF11111" }])
      .filter((s) => s.tier === "substring")).toEqual([]); // 5 shared < the floor of 6
  });
  it("every real tier outranks every weak tier's cap — weak rows can never displace evidence", () => {
    // 29 is brandSegment's cap — measured on the live 2026-08-13 unresolved
    // list: a cap above the colourway tier let a prefix-cousin outrank a
    // one-edit colour sibling on four real scans.
    for (const strong of ["family", "misread", "colourCode", "truncated", "name", "colourway"]) {
      expect(TIER_SCORES[strong]).toBeGreaterThan(29);
    }
  });
});

describe("the panel is NEVER empty (claim 11) — fillToMin", () => {
  const CATALOGUE = [...NOISE, ...GRIPSHOTS];
  it("a scan with no plausible relative still yields rows from any non-empty catalogue, honestly labelled", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "ZZ9QQ7XW1", products: CATALOGUE, fillToMin: 10 });
    expect(out.length).toBe(CATALOGUE.length); // 7 products — all it can supply
    for (const s of out) {
      expect(s.tier).toBe("closest");
      expect(s.weak).toBe(true);
      expect(s.score).toBeLessThanOrEqual(TIER_SCORES.closest);
      expect(s.reasons.join(" ")).toMatch(/not a close match|never empty/);
    }
  });
  it("fillers only pad the TAIL — real matches keep the top and their scores stay above every filler", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "742CFA00112G4", products: CATALOGUE, fillToMin: 10 });
    expect(out.length).toBe(CATALOGUE.length);
    expect(out.slice(0, 5).every((s) => s.tier === "family")).toBe(true);
    const firstFiller = out.findIndex((s) => s.tier === "closest");
    expect(firstFiller).toBe(5);
    expect(out[4].score).toBeGreaterThan(out[5].score);
  });
  it("an empty catalogue is the ONE case that stays empty — there is nothing to show", () => {
    expect(buildLinkSuggestions({ kind: "code", normalised: "ZZ9QQ7XW1", products: [], fillToMin: 10 })).toEqual([]);
  });
  it("closest rows say WHY they are there when any affinity exists — fragment or shared name words", () => {
    const rows = closestCandidates({ normalised: "745SMA00421G", labelWords: ["GRIPSHOT"], products: GRIPSHOTS, limit: 10 });
    expect(rows.length).toBe(5);
    expect(rows[0].reason).toContain("its name shares");
  });
  it("excludeIds and merged-away products never resurface as fillers", () => {
    const rows = closestCandidates({ normalised: "ZZ9QQ7XW1", products: [
      ...GRIPSHOTS.map((p) => (p.id === "g5" ? { ...p, mergedInto: "elsewhere" } : p)),
    ], excludeIds: ["g6"], limit: 10 });
    expect(rows.map((r) => r.product.id).sort()).toEqual(["g12", "g16", "g7"]);
  });
});

describe("truncated reads (claim 7) — real floor scan 742CFA0007", () => {
  it("742CFA0007 finds 742CFA00072G4 on top — the rest of the family rides along as weak lead-sharers", () => {
    const out = codeSuggestions("742CFA0007", GRIPSHOTS).sort((a, b) => b.score - a.score);
    expect(out[0].product.id).toBe("g7");
    expect(out[0].tier).toBe("truncated");
    // The 2026-08-13 loosening: the other four Gripshots share an 8-9 char
    // lead, so they surface too — weak, below the truncated hit.
    expect(out.length).toBe(5);
    expect(out.slice(1).every((s) => s.tier === "brandSegment" && s.weak === true)).toBe(true);
  });
  it("a 6-char Nike body prefix is never a truncated CLAIM — it fans out across colourways, so it rides as a weak row", () => {
    expect(isTruncatedPair("CT8527", "CT8527016")).toBe(false);
    // The 2026-08-13 loosening: it still SHOWS (the operator gets the body's
    // colourways to browse, photos first) — but weak, never worded as a read.
    const out = codeSuggestions("CT8527", [{ id: "n", name: "Nike", styleCodeNormalised: "CT8527016" }]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("substring");
    expect(out[0].weak).toBe(true);
  });
});

describe("confusable folding (claim 8) — real floor scan 742CFA0011264", () => {
  it("G→6 misreads reach the family as misread suggestions, comparison-only", () => {
    const out = codeSuggestions("742CFA0011264", GRIPSHOTS);
    const misreads = out.filter((s) => s.tier === "misread").map((s) => s.product.id).sort();
    expect(misreads).toEqual(["g12", "g16"]); // one edit after folding 2G4→264
    // The 2026-08-13 loosening: the remaining family shares the 742CFA00 lead
    // and rides along as weak rows underneath — never as misreads.
    expect(out.filter((s) => s.tier !== "misread").every((s) => s.weak === true)).toBe(true);
  });
  it("folding never touches identity — an exact-after-fold code is NOT an exact match", () => {
    expect(foldConfusables("742CFA00122G4")).toBe("742CFA0012264");
    const out = codeSuggestions("742CFA0012264", [GRIPSHOTS[3]]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("misread"); // suggested for a human — never pendingExact/resolved
  });
});

describe("exact confirmed owners (includeExact — the intake gate's pre-form check)", () => {
  it("excluded by default: the count flow resolves exact owners before its panel opens", () => {
    const out = codeSuggestions("742CFA00122G4", GRIPSHOTS);
    expect(out.every((s) => s.tier !== "exact")).toBe(true);
  });
  it("includeExact adds the confirmed owner (capture-only intake never checked this pre-form)", () => {
    const out = codeSuggestions("742CFA00122G4", GRIPSHOTS, { includeExact: true });
    const exact = out.find((s) => s.tier === "exact");
    expect(exact).toBeTruthy();
    expect(exact.product.id).toBe("g12");
    expect(exact.score).toBe(TIER_SCORES.exact);
    expect(exact.reason).toContain("exactly this code");
  });
  it("buildLinkSuggestions passes the flag through and ranks the exact owner FIRST", () => {
    const out = buildLinkSuggestions({ kind: "code", normalised: "742CFA00122G4", products: GRIPSHOTS, includeExact: true });
    expect(out[0].tier).toBe("exact");
    expect(out[0].product.id).toBe("g12");
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
