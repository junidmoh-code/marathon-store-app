// ─── DOMINANT COLOURS — ordering is the ENTIRE effect, mutation-proved ───────
// Owner-spec proof pinned here (2026-08-07): colour ORDERS the candidate list
// so the likely match sits first, and NEVER selects. The pure half is tested
// without a canvas; the extraction half is browser-only and deliberately
// untested here (it fails soft to [] by contract).

import { describe, it, expect } from "vitest";
import { quantiseColours, paletteDistance, orderByColourAffinity } from "./dominantColours.js";

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
