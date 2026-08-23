// ─── MULTI-TOKEN LABEL IDENTITY — client-side proofs (owner spec 2026-08-13) ─
// The root cause, proven from physical labels: OCR captured ONE line and WHICH
// line varied between registrations. The client half of the fix: every token
// pools into ONE ranked suggestion list, the reader's server pick (`preferred`)
// resolves without erasing the set, and the intake gate's duplicate question is
// asked with every token. Server-half proofs live in
// functions/test/multi-token-label.test.cjs.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { buildLinkSuggestions, codeSuggestions } from "./linkSuggestions.js";
import { normaliseStyleCode, styleCodeFormat } from "./styleCode.js";
import { chooseFromLabelRead } from "../components/stock/hubCleanupCore.js";

// The server extractor — imported directly so this proof runs the REAL
// extraction over the REAL label text, not a hand-typed candidate list.
const require = createRequire(import.meta.url);
const { extractStyleCodeCandidates } = require("../../functions/lib/style-code-ocr.cjs");

const LACOSTE_LABEL = [
  "LGUARD BRKR CTT 225 2 SFA",
  "45SMA0018",
  "35289 0625",
  "TTJJ21FB00001",
  "UK 8 US 9 EUR 42.5",
  "MADE IN VIETNAM",
].join("\n");

const TIMBERLAND_LABEL = [
  "TIMBERLAND",
  "MOTION 6 MID GTX",
  "A6CWNEN3",
  "A8425",
  "US 9 UK 8.5 EU 43",
  "MADE IN VIETNAM",
].join("\n");

describe("the format twins carry label-serial identically", () => {
  it("both twins recognise the Timberland serial and refuse the size line", () => {
    const { styleCodeFormat: serverFormat } = require("../../functions/lib/style-code.cjs");
    for (const fn of [styleCodeFormat, serverFormat]) {
      expect(fn("A6CWNEN3")).toBe("label-serial");
      expect(fn("TTJJ21FB00001")).toBe("label-serial");
      expect(fn("US10UK9")).toBe(null);
      expect(fn("EUR42CM27")).toBe(null);
      // Gender-qualified size markers and a trailing width word are still
      // size lines, never serials (CodeRabbit, PR #354).
      expect(fn("USM8UK8")).toBe(null);
      expect(fn("USW8UK8")).toBe(null);
      expect(fn("US10UK9WIDE")).toBe(null);
    }
  });
});

describe("POOLED suggestions — every token feeds ONE merged ranked list", () => {
  const products = [
    { id: "pKhaki", name: "Timberland Motion 6 Mid Hiking Boots Khaki", styleCodeNormalised: "A8425", photoUrl: "x" },
    { id: "pBlack", name: "Timberland Motion 6 Mid Black", pendingStyleCode: "A6CWNEN3", photoUrl: "y" },
    { id: "pNoise", name: "Nike Court Vision", styleCodeNormalised: "DD1391100", photoUrl: "z" },
  ];

  it("the Timberland's two tokens both contribute candidates to the same list", () => {
    // The operator's scan led with A6CWNEN3 (which nothing owns outright);
    // A8425 rides in allCodes. BOTH must surface their products, each row's
    // reason naming the token that found it.
    const list = buildLinkSuggestions({
      kind: "code", normalised: "A6CWNEN3", allCodes: ["A6CWNEN3", "A8425"],
      includeExact: true, products,
    });
    const ids = list.map((s) => s.product.id);
    expect(ids).toContain("pBlack"); // pendingExact on the primary token
    expect(ids).toContain("pKhaki"); // exact via the OTHER token
    const khaki = list.find((s) => s.product.id === "pKhaki");
    expect(khaki.tier).toBe("exact");
    expect(khaki.reasons.join(" ")).toMatch(/other token A8425/);
  });

  it("without allCodes the list is exactly what the primary code alone produces (additive only)", () => {
    const before = buildLinkSuggestions({ kind: "code", normalised: "A6CWNEN3", includeExact: true, products });
    const withEmpty = buildLinkSuggestions({ kind: "code", normalised: "A6CWNEN3", allCodes: [], includeExact: true, products });
    expect(withEmpty).toEqual(before);
  });

  it("the pooled panel is never empty when fillToMin asks for rows", () => {
    const list = buildLinkSuggestions({
      kind: "code", normalised: "ZZ9999999", allCodes: ["ZZ9999999", "YY8888888"],
      products, fillToMin: 3,
    });
    expect(list.length).toBeGreaterThan(0);
  });

  it("the label's word set feeds the name tier on a code-ful read", () => {
    const list = buildLinkSuggestions({
      kind: "code", normalised: "ZZ9999999",
      tokens: ["MOTION", "GTX", "A6CWNEN3"],
      products,
    });
    const hit = list.find((s) => s.product.id === "pKhaki" || s.product.id === "pBlack");
    expect(hit, "a MOTION token must reach the name tier").toBeTruthy();
    expect(hit.tier).toBe("name");
  });
});

describe("THE RECOVERY PROOF — the stored line is still printed on the label", () => {
  it("a full read of the Lacoste label surfaces 'Lacoster white' by its production token", () => {
    // "Lacoster white" exactly as registered today: it holds the production
    // line 352890-625, captured as its style code. No migration, no typing —
    // the full-token read alone must surface it as an EXACT match.
    const products = [
      { id: "pLW", name: "Lacoster white", styleCodeNormalised: "352890625", photoUrl: "p" },
    ];
    const scanned = extractStyleCodeCandidates(LACOSTE_LABEL).map((c) => c.normalised);
    expect(scanned).toContain("45SMA0018");
    expect(scanned).toContain("352890625");
    // The operator's tap is the article code; the production token pools.
    const list = buildLinkSuggestions({
      kind: "code", normalised: "45SMA0018", allCodes: scanned,
      includeExact: true, products,
    });
    expect(list[0].product.id).toBe("pLW");
    expect(list[0].tier).toBe("exact");
    expect(list[0].reasons.join(" ")).toMatch(/352890-625/);
  });

  it("the Timberland label's extraction feeds both tokens into codeSuggestions equally", () => {
    const scanned = extractStyleCodeCandidates(TIMBERLAND_LABEL).map((c) => c.normalised);
    expect(scanned.sort()).toEqual(["A6CWNEN3", "A8425"]);
    const products = [{ id: "pK", name: "Khaki", styleCodeNormalised: "A8425", photoUrl: "x" }];
    // Either token as the primary finds the product (directly or via pooling).
    for (const primary of scanned) {
      const list = buildLinkSuggestions({
        kind: "code", normalised: primary, allCodes: scanned, includeExact: true, products,
      });
      expect(list.some((s) => s.product.id === "pK" && s.tier === "exact")).toBe(true);
    }
  });
});

describe("chooseFromLabelRead — the server pick resolves without erasing", () => {
  it("a layout-rule autoPick still wins, labelled as learned", () => {
    const out = chooseFromLabelRead({
      candidates: ["45SMA0018", "352890625"], displayCandidates: ["45SMA0018", "352890-625"],
      autoPick: "45SMA0018", preferred: "352890625",
    });
    expect(out.kind).toBe("chosen");
    expect(out.code).toBe("45SMA0018");
    expect(out.autoSource).toBe("layout");
    expect(out.allCandidates).toEqual(["45SMA0018", "352890625"]);
  });

  it("tier 2's preferred resolves when no rule exists, labelled as read", () => {
    const out = chooseFromLabelRead({
      candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"],
      preferred: "A6CWNEN3",
    });
    expect(out.kind).toBe("chosen");
    expect(out.code).toBe("A6CWNEN3");
    expect(out.auto).toBe(true);
    expect(out.autoSource).toBe("read");
    expect(out.allCandidates).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("a preferred that names none of the candidates is ignored — the RULE heads the set, nobody is asked", () => {
    const out = chooseFromLabelRead({
      candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"],
      preferred: "ZZ9999999",
    });
    expect(out.kind).toBe("chosen");
    expect(out.autoSource).toBe("rule");
    // Timberland: A8425 (adidas-block shape, rank 0) heads A6CWNEN3 (label-serial, rank 2).
    expect(out.code).toBe("A8425");
    expect(out.allCandidates).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("EXISTING contracts unchanged: one candidate chooses, zero candidates fall to tokens", () => {
    expect(chooseFromLabelRead({ candidates: ["IE3437"], displayCandidates: ["IE3437"] }).kind).toBe("chosen");
    expect(chooseFromLabelRead({ candidates: [], tokens: ["CLOUDNOVA", "MONO"] }).kind).toBe("tokens");
  });
});

describe("normalisation parity — the three printed spellings compare equal", () => {
  it("35289 0625 ≡ 352890625 ≡ 352890-625", () => {
    expect(normaliseStyleCode("35289 0625")).toBe("352890625");
    expect(normaliseStyleCode("352890-625")).toBe("352890625");
  });
});
