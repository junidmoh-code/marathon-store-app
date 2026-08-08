// ─── DOMINANT COLOURS — ordering, margin auto-select, answer memory ──────────
// Owner-spec proofs pinned here. 2026-08-07: colour ORDERS the candidate list
// so the likely match sits first. 2026-08-08: colour also AUTO-SELECTS, but
// ONLY behind the margin (clear winner over the runner-up) and fails closed
// on every ambiguity — a missing palette, a washed-out photo, a near tie all
// fall through to the picker; and an ANSWERED question (matchColourwayAnswers)
// resolves the same physical shoe silently, disagreements resolving nothing.
// The pure half is tested without a canvas; the extraction half is
// browser-only and deliberately untested here (it fails soft to [] by
// contract).

import { describe, it, expect } from "vitest";
import {
  quantiseColours, paletteDistance, orderByColourAffinity,
  selectByColourAffinity, matchColourwayAnswers,
  AUTO_SELECT_MARGIN, AUTO_SELECT_CLOSE_MAX, ANSWER_MATCH_MAX,
} from "./dominantColours.js";

const BLACKISH = [{ r: 20, g: 20, b: 22, w: 0.8 }];
const WHITISH = [{ r: 240, g: 240, b: 238, w: 0.8 }];

const pBlack = { id: "pBlack", name: "Black", dominantColours: BLACKISH };
const pWhite = { id: "pWhite", name: "White", dominantColours: WHITISH };
const pNoPalette = { id: "pNone", name: "Unknown" };

describe("quantiseColours", () => {
  it("finds the dominant swatch of a mostly-one-colour pixel set", () => {
    const pixels = [...Array(90).fill([10, 10, 10]), ...Array(10).fill([250, 250, 250])];
    const swatches = quantiseColours(pixels);
    expect(swatches[0].r).toBeLessThan(40);
    expect(swatches[0].w).toBeGreaterThan(0.8);
  });
  it("empty input yields an empty palette, never a throw", () => {
    expect(quantiseColours([])).toEqual([]);
    expect(quantiseColours(null)).toEqual([]);
  });
});

describe("paletteDistance", () => {
  it("like palettes sit closer than unlike ones", () => {
    expect(paletteDistance(BLACKISH, BLACKISH)).toBeLessThan(paletteDistance(BLACKISH, WHITISH));
  });
  it("an absent palette is Infinity — unknown sorts last, never first by accident", () => {
    expect(paletteDistance(BLACKISH, [])).toBe(Infinity);
    expect(paletteDistance([], WHITISH)).toBe(Infinity);
  });
});

describe("orderByColourAffinity — the owner-spec contract", () => {
  it("PROOF: a black shoe photo puts the black candidate first…", () => {
    const out = orderByColourAffinity([pWhite, pBlack], BLACKISH);
    expect(out.map((p) => p.id)).toEqual(["pBlack", "pWhite"]);
  });
  it("…and a white photo reverses the order — the photo drives it", () => {
    const out = orderByColourAffinity([pBlack, pWhite], WHITISH);
    expect(out.map((p) => p.id)).toEqual(["pWhite", "pBlack"]);
  });
  it("PROOF: ordering NEVER selects, drops or mutates — same members, order aside", () => {
    const input = [pWhite, pBlack, pNoPalette];
    const before = JSON.stringify(input);
    const out = orderByColourAffinity(input, BLACKISH);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(["pWhite", "pBlack", "pNone"]));
    // No candidate gained a "selected"/"chosen" marker of any kind.
    for (const p of out) expect(Object.keys(p).some((k) => /select|chosen|picked/i.test(k))).toBe(false);
    // The input array and its members are untouched.
    expect(JSON.stringify(input)).toBe(before);
  });
  it("candidates without a palette keep their relative order, after those with one", () => {
    const pAlso = { id: "pAlso", name: "Also unknown" };
    const out = orderByColourAffinity([pNoPalette, pAlso, pBlack], BLACKISH);
    expect(out.map((p) => p.id)).toEqual(["pBlack", "pNone", "pAlso"]);
  });
  it("no photo colours → the list comes back untouched", () => {
    const input = [pWhite, pBlack];
    expect(orderByColourAffinity(input, null).map((p) => p.id)).toEqual(["pWhite", "pBlack"]);
    expect(orderByColourAffinity(input, []).map((p) => p.id)).toEqual(["pWhite", "pBlack"]);
  });
});

// The owner's evidence pair: two colourways of HF0438-001 that share a white
// upper and differ only on the accent — visually SIMILAR by construction.
const WHITE_BLUE = [{ r: 240, g: 240, b: 245, w: 0.6 }, { r: 60, g: 120, b: 230, w: 0.4 }];
const WHITE_GRAY = [{ r: 238, g: 238, b: 240, w: 0.6 }, { r: 150, g: 150, b: 155, w: 0.4 }];
const pBlue = { id: "pBlue", name: "White Photo Blue", dominantColours: WHITE_BLUE };
const pGray = { id: "pGray", name: "White Gray", dominantColours: WHITE_GRAY };

describe("selectByColourAffinity — the 2026-08-08 margin contract", () => {
  it("PROOF: two clearly different colourways auto-select from the shoe photo", () => {
    const photo = [{ r: 25, g: 24, b: 26, w: 0.75 }, { r: 200, g: 40, b: 40, w: 0.25 }]; // a black shoe
    const out = selectByColourAffinity([pWhite, pBlack], photo);
    expect(out.kind).toBe("auto");
    expect(out.product.id).toBe("pBlack");
    expect(out.secondD - out.bestD).toBeGreaterThanOrEqual(AUTO_SELECT_MARGIN);
  });
  it("PROOF: two visually similar colourways fall through to the picker, never a guess", () => {
    // A photo of the white/blue shoe — but the white/gray sibling shares the
    // dominant white upper, so the runner-up trails inside the margin.
    const photo = [{ r: 236, g: 237, b: 242, w: 0.7 }, { r: 90, g: 130, b: 210, w: 0.3 }];
    const out = selectByColourAffinity([pBlue, pGray], photo);
    expect(out.kind).toBe("ask");
    // …and the ordering still helps: the likelier match sits first.
    expect(out.ordered[0].id).toBe("pBlue");
  });
  it("fails closed when ANY candidate has no stored palette — it could be the true match", () => {
    const photo = [{ r: 25, g: 24, b: 26, w: 1 }];
    expect(selectByColourAffinity([pBlack, pNoPalette], photo).kind).toBe("ask");
  });
  it("fails closed when the winner does not actually resemble the photo", () => {
    const neonGreen = [{ r: 40, g: 250, b: 40, w: 1 }]; // nothing like either candidate
    const out = selectByColourAffinity([pBlue, pGray], neonGreen);
    expect(out.kind).toBe("ask");
    expect(AUTO_SELECT_CLOSE_MAX).toBeLessThan(255); // the ceiling is real, not decorative
  });
  it("fails closed with no photo or a single candidate", () => {
    expect(selectByColourAffinity([pBlack, pWhite], null).kind).toBe("ask");
    expect(selectByColourAffinity([pBlack], [{ r: 0, g: 0, b: 0, w: 1 }]).kind).toBe("ask");
  });
});

describe("matchColourwayAnswers — never ask twice for the same physical shoe", () => {
  const answered = [{ productId: "pBlue", p: WHITE_BLUE }];
  it("PROOF: a photo matching a stored answer resolves silently", () => {
    const nearIdentical = [{ r: 239, g: 241, b: 244, w: 0.6 }, { r: 62, g: 118, b: 228, w: 0.4 }];
    expect(matchColourwayAnswers(answered, nearIdentical)).toBe("pBlue");
  });
  it("a different shoe's photo matches nothing", () => {
    expect(matchColourwayAnswers(answered, [{ r: 20, g: 20, b: 20, w: 1 }])).toBe(null);
  });
  it("fails closed when stored answers DISAGREE inside the match radius", () => {
    const rows = [
      { productId: "pBlue", p: WHITE_BLUE },
      { productId: "pGray", p: WHITE_BLUE }, // conflicting answer, same signature
    ];
    expect(matchColourwayAnswers(rows, WHITE_BLUE)).toBe(null);
  });
  it("no photo → no match, and the radius is genuinely tight", () => {
    expect(matchColourwayAnswers(answered, null)).toBe(null);
    expect(ANSWER_MATCH_MAX).toBeLessThanOrEqual(AUTO_SELECT_MARGIN);
  });
});
