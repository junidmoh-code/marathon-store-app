// ─── THE PER-SIZE RULE, PINNED AGAINST THE LIVE CATALOGUE ────────────────────
// (Owner spec 2026-08-12.) Two proofs live here:
//   1. The two PHYSICAL labels — 745SMA004-21G (UK 6.5) and 745SMA006-21G
//      (UK 9.5) of ONE Lacoste runner — are siblings; every colourway family
//      the live catalogue actually contains is NOT.
//   2. Ran over ALL 59 live Lacoste-format codes (evidence pull 2026-08-12),
//      the rule links ZERO existing cross-product pairs — every live pair is
//      either a colourway sibling (Missouri Mid, Powercourt, Audysol, Elite
//      Active families) or unrelated. The rule can therefore only ever fire on
//      a code arriving from a NOT-yet-registered size of a registered shoe.
import { describe, it, expect } from "vitest";
import { perSizeSiblingCodes, findPerSizeSiblings, perSizeAutoCandidate } from "./perSizeStyleCode.js";
import { normaliseStyleCode } from "./styleCode.js";

// Every live styleCodeNormalised matching the Lacoste article shape, from the
// 2026-08-12 read-only evidence pull: 59 products carrying 57 DISTINCT codes
// (737SMA0015082 sits on three records — a shared-code case for the sibling
// flow, not this rule).
const LIVE_LACOSTE = [
  "42SMA00407E9", "42SMA0128", "45SFA0005235", "45SFA0022026", "45SFA005075",
  "45SMA0016", "45SMA0106082", "46SMA0086DA7", "46SMA0121237", "46SMA0121311",
  "46SMA01216B3", "46SMA01216D2", "46SMA01216D5", "47SMA0164", "48SMA004002H",
  "48SMA004077T", "49SMA00666T", "60SMA0166", "60SMA0168", "737SMA0015082",
  "739SMA0062144", "740SMA00111M4", "741SMA00112G3", "741SMA002865T",
  "741SMA002866T", "742SMA004002H", "742SMA00409S", "742SMA0040GB7",
  "743SMA00331R6", "743SMA01596M3", "743SMA01691M3", "743SMA01694M3",
  "743SMA01695M3", "744SMA0033237", "744SMA00337B8", "744SMA0095047",
  "744SMA0096092", "744SMA00962H2", "744SMA0113", "744SMA0115",
  "744SMA0118DG2", "745SFA000521G", "745SFA005235", "745SMA0026042",
  "745SMA0042A9", "745SMA0047Y37", "746SMA0008001", "746SMA0008160",
  "746SMA00081R5", "746SMA0083042", "746SMA0084", "748SFA00652R1",
  "748SMA00701V4", "748SMA0096", "750SFA0130", "760SFA0170", "760SMA016618C",
];

describe("perSizeSiblingCodes — the Lacoste per-size rule", () => {
  it("links the two physical labels: one shoe, one colourway, two sizes", () => {
    const a = normaliseStyleCode("745SMA004-21G");
    const b = normaliseStyleCode("745SMA006-21G");
    expect(a).toBe("745SMA00421G");
    expect(b).toBe("745SMA00621G");
    expect(perSizeSiblingCodes(a, b)).toBe(true);
    expect(perSizeSiblingCodes(b, a)).toBe(true);
  });

  it("NEVER links across a different colourway suffix — the live Missouri Mid family", () => {
    // 743SMA0169 + 1M3 / 4M3 / 5M3 are Green Grey, Green and Brown: three
    // products. They differ by ONE character — inside the colour code.
    expect(perSizeSiblingCodes("743SMA01691M3", "743SMA01694M3")).toBe(false);
    expect(perSizeSiblingCodes("743SMA01694M3", "743SMA01695M3")).toBe(false);
    // Powercourt White vs White Blue — one character apart, both real:
    expect(perSizeSiblingCodes("741SMA002865T", "741SMA002866T")).toBe(false);
    // Elite Active Black vs Black Red:
    expect(perSizeSiblingCodes("746SMA0008001", "746SMA0008160")).toBe(false);
  });

  it("refuses when the printed colour code's first char hides in the article block (2-char parsed suffix)", () => {
    // 745SMA00421G parses article=0042 suffix=1G, but the label printed
    // …004-21G: the "2" belongs to the COLOUR. A diff there is a different
    // colour, and the final-3 guard refuses it.
    expect(perSizeSiblingCodes("745SMA00421G", "745SMA00431G")).toBe(false);
  });

  it("refuses suffix-less codes — the article/colour boundary is unknowable there", () => {
    // 744SMA0113 vs 744SMA0115 are L-Guard Breakers in two REAL colourways
    // that were captured without a colour code. Never automatic.
    expect(perSizeSiblingCodes("744SMA0113", "744SMA0115")).toBe(false);
    expect(perSizeSiblingCodes("744SMA0113", "744SMA0213")).toBe(false);
  });

  it("refuses a season/size-prefix difference — unproven territory", () => {
    // Same article + colour, different leading block (742 vs 48): the live
    // catalogue holds both as separate records; the prefix's meaning is not
    // established, so the rule stays silent.
    expect(perSizeSiblingCodes("742SMA004002H", "48SMA004002H")).toBe(false);
  });

  it("never fires on non-Lacoste shapes — Nike's one-code-many-colourways world", () => {
    expect(perSizeSiblingCodes("HF5509002", "HF5509004")).toBe(false);
    expect(perSizeSiblingCodes("315122001", "315122011")).toBe(false); // numeric-6-3
    expect(perSizeSiblingCodes("38019001", "38019011")).toBe(false);   // puma-6-2
    expect(perSizeSiblingCodes("M990GL6", "M990GL7")).toBe(false);     // new-balance
  });

  it("needs EXACTLY one differing article digit, and never a two-digit drift", () => {
    expect(perSizeSiblingCodes("745SFA000521G", "745SFA000521G")).toBe(false); // identical
    expect(perSizeSiblingCodes("745SFA000521G", "745SFA001621G")).toBe(false); // two digits moved
    expect(perSizeSiblingCodes("745SFA000521G", "745SFA001521G")).toBe(true);  // one digit moved
  });

  it("handles junk without throwing", () => {
    expect(perSizeSiblingCodes(null, "745SMA00421G")).toBe(false);
    expect(perSizeSiblingCodes("745SMA00421G", undefined)).toBe(false);
    expect(perSizeSiblingCodes("", "")).toBe(false);
    expect(perSizeSiblingCodes(42, {})).toBe(false);
  });

  it("fires on ZERO pairs across all 57 distinct live Lacoste codes", () => {
    // The load-bearing evidence claim: every already-registered pair is either
    // a colourway family or unrelated. If a future catalogue change makes two
    // LIVE products auto-linkable, this fails and a human looks first.
    const hits = [];
    for (let i = 0; i < LIVE_LACOSTE.length; i++) {
      for (let j = i + 1; j < LIVE_LACOSTE.length; j++) {
        if (perSizeSiblingCodes(LIVE_LACOSTE[i], LIVE_LACOSTE[j])) {
          hits.push([LIVE_LACOSTE[i], LIVE_LACOSTE[j]]);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("findPerSizeSiblings — the catalogue lookup the count uses", () => {
  const CATALOGUE = [
    { id: "pAud", name: "Lacoste Audysol White", styleCodeNormalised: "745SMA00421G" },
    { id: "pMissouri", name: "Missouri Mid Green Grey", styleCodeNormalised: "743SMA01691M3" },
    { id: "pNike", name: "Nike P-6000", styleCodeNormalised: "HF5509002" },
    { id: "pGone", name: "merged twin", styleCodeNormalised: "745SMA00621G", mergedInto: "pAud" },
  ];

  it("the other size's label finds the ONE registered shoe (raw, hyphenated input)", () => {
    const hits = findPerSizeSiblings("745SMA006-21G", CATALOGUE);
    expect(hits.map((p) => p.id)).toEqual(["pAud"]);
  });

  it("a merged-away record never answers", () => {
    // pGone carries the exact scanned code's sibling but is merged away; only
    // the live pAud may answer — and the scanned code being pGone's own code
    // still lands on pAud through the per-size rule, not on the ghost.
    const hits = findPerSizeSiblings("745SMA00621G", CATALOGUE);
    expect(hits.map((p) => p.id)).toEqual(["pAud"]);
  });

  it("a different colourway finds NOTHING", () => {
    expect(findPerSizeSiblings("743SMA0169-4M3", CATALOGUE)).toEqual([]);
  });

  it("junk and empty catalogues return []", () => {
    expect(findPerSizeSiblings("", CATALOGUE)).toEqual([]);
    expect(findPerSizeSiblings("745SMA006-21G", null)).toEqual([]);
    expect(findPerSizeSiblings("745SMA006-21G", [null, {}, { id: "x" }])).toEqual([]);
  });
});

describe("perSizeAutoCandidate — the only gate the count's auto-link passes", () => {
  // The live Gripshot family the 2026-08-12 sweep surfaced, verbatim: five
  // records whose codes rule-link but whose NAMES claim different colours.
  const GRIPSHOT = [
    { id: "g07", name: "Lacoste Gripshot Mid Green", styleCodeNormalised: "742CFA00072G4" },
    { id: "g12", name: "Lacoste Gripshot White Green Orange", styleCodeNormalised: "742CFA00122G4" },
    { id: "g05", name: "Lacoste Gripshot Mid White", styleCodeNormalised: "742CFA00052G4" },
    { id: "g06", name: "Lacoster gripshot mid white and brown", styleCodeNormalised: "742CFA00062G4" },
    { id: "g16", name: "Lacoster gripshot green", styleCodeNormalised: "742CFA00162G4" },
  ];
  const CLEAN = [
    { id: "pAud", name: "Lacoste Audysol White", styleCodeNormalised: "745SMA00421G" },
    { id: "pMissouri", name: "Missouri Mid Green Grey", styleCodeNormalised: "743SMA01691M3" },
  ];

  it("a lone registered sibling auto-links — the physical-label case", () => {
    expect(perSizeAutoCandidate("745SMA006-21G", CLEAN)?.id).toBe("pAud");
  });

  it("two candidate siblings never auto-link", () => {
    // 742CFA0004-2G4 sits one digit from 0005, 0006 AND 0007 — a question.
    expect(perSizeAutoCandidate("742CFA00042G4", GRIPSHOT)).toBe(null);
  });

  it("never guesses past an exact live owner (callers without the resolve-first guarantee)", () => {
    // The scanned code IS registered: sibling maths must not run at all —
    // pAud sits one digit away, but the exact owner answers, not the rule.
    const withExact = [...CLEAN, { id: "pExact", name: "Audysol Navy", styleCodeNormalised: "745SMA00621G" }];
    expect(perSizeAutoCandidate("745SMA006-21G", withExact)).toBe(null);
  });

  it("REFUSES to auto-link into an already-split cluster, even via exactly one sibling", () => {
    // 742CFA0022-2G4 is one digit from ONLY 0012 — but 0012 itself rule-links
    // to 0016: the cluster's identity is a human question, so no silent pull.
    expect(perSizeAutoCandidate("742CFA00222G4", GRIPSHOT)).toBe(null);
  });
});
