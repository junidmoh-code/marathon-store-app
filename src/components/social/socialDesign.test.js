// ── EVERY NUMBER ON THE POST CAME FROM THE RECORD ────────────────────────────
// The owner's rule: "A model-drawn price is a number I have to honour and it
// has already garbled text once." So the design layer is pure and testable, and
// what is tested is the PROPERTY — that a price on the artwork can only ever be
// a price from /products, and the total can only ever be the sum of the ones
// actually shown.
//
// vitest excludes functions/**, so this reaches the CJS module the way
// socialStockParity.diff.test.js does.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../../../functions/lib/social-design.cjs");

const P = (name, retailPrice) => ({ displayName: name, retailPrice });
const OUTFIT = [
  P("EA7 Train Track Jacket", 1899),
  P("Lacoste T-Clip Sneakers", 2499),
  P("Diesel Black Denim Jeans", 1350),
];

const numbersIn = (svg) => (svg.match(/R[\d,]+/g) || []);
// Only the words the viewer actually sees. Asserting against raw SVG matched
// markup instead of content — /OFF/i hit the `<stop offset=...>` attribute and
// failed a test about promotional language.
const textOf = (svg) => (svg.match(/>([^<]+)</g) || []).map((m) => m.slice(1, -1)).join(" | ");

describe("prices come from the record and nowhere else", () => {
  it("renders exactly the prices it was given", () => {
    const svg = D.buildOverlay({ products: OUTFIT, kind: "outfit" });
    expect(svg).toContain("R1,899");
    expect(svg).toContain("R2,499");
    expect(svg).toContain("R1,350");
  });

  it("shows no number that is not a listed price or their sum", () => {
    const svg = D.buildOverlay({ products: OUTFIT, kind: "outfit" });
    const allowed = new Set(["R1,899", "R2,499", "R1,350", "R5,748"]);
    for (const n of numbersIn(svg)) expect(allowed, `unexpected number ${n}`).toContain(n);
  });

  it("totals the outfit in code — 1899 + 2499 + 1350 = 5748", () => {
    expect(D.outfitTotal(D.sellableRows(OUTFIT))).toBe(5748);
    expect(D.buildOverlay({ products: OUTFIT, kind: "outfit" })).toContain("R5,748");
  });

  it("never rounds, discounts or embellishes a price", () => {
    const svg = D.buildOverlay({ products: [P("Odd Priced Thing", 1234)], kind: "single" });
    expect(svg).toContain("R1,234");
    expect(textOf(svg)).not.toMatch(/\bSAVE\b|\bWAS\b|\bOFF\b|%|\bRRP\b/i);
  });
});

describe("a product with no usable price is omitted, never invented", () => {
  for (const [label, bad] of [
    ["null", null], ["undefined", undefined], ["zero", 0],
    ["negative", -50], ["NaN", NaN], ["a string", "1 200"], ["Infinity", Infinity],
  ]) {
    it(`drops a product priced ${label}`, () => {
      const rows = D.sellableRows([P("Priceless Thing", bad), P("Real Thing", 500)]);
      expect(rows.map((r) => r.name)).toEqual(["Real Thing"]);
      const svg = D.buildOverlay({ products: [P("Priceless Thing", bad), P("Real Thing", 500)], kind: "outfit" });
      expect(svg).not.toContain("PRICELESS");
      expect(svg).not.toMatch(/R0\b|RNaN|Rnull|Rundefined|RInfinity/);
    });
  }

  it("the total counts only what is actually named", () => {
    // An unpriced item in the picture must not silently join the total, and
    // must not silently be counted as zero either — it is simply not named.
    const rows = D.sellableRows([P("Named", 700), P("Unpriced", null), P("Also named", 300)]);
    expect(D.outfitTotal(rows)).toBe(1000);
  });

  it("renders no callouts at all rather than empty ones when nothing has a price", () => {
    const svg = D.buildOverlay({ products: [P("A", 0), P("B", null)], kind: "outfit" });
    expect(numbersIn(svg)).toEqual([]);
  });
});

describe("the layout answers to the photograph", () => {
  const flatLeft = { left: { mean: 200, stdev: 4 }, right: { mean: 90, stdev: 40 } };
  const flatRight = { left: { mean: 90, stdev: 40 }, right: { mean: 200, stdev: 4 } };

  it("puts the rail where the negative space is", () => {
    expect(D.chooseLayout(flatLeft).side).toBe("left");
    expect(D.chooseLayout(flatRight).side).toBe("right");
  });

  it("uses dark ink on a bright side and light ink on a dark one", () => {
    expect(D.chooseLayout({ left: { mean: 230, stdev: 3 }, right: { mean: 100, stdev: 40 } }).ink).toBe("#141414");
    expect(D.chooseLayout({ left: { mean: 20, stdev: 3 }, right: { mean: 100, stdev: 40 } }).ink).toBe("#F4F1EA");
  });

  it("falls back to a usable layout when the measurement is missing", () => {
    // measureEdges returns {} on failure; a paid image must still get a design.
    const l = D.chooseLayout({});
    expect(["left", "right"]).toContain(l.side);
    expect(l.ink).toBeTruthy();
    expect(D.buildOverlay({ products: OUTFIT, edges: {}, kind: "outfit" })).toContain("R5,748");
  });

  it("does not always choose the same side regardless of input", () => {
    // The direction forbids a fixed layout. If this ever passes trivially the
    // measurement has stopped being consulted.
    expect(D.chooseLayout(flatLeft).side).not.toBe(D.chooseLayout(flatRight).side);
  });
});

describe("the whole-outfit total", () => {
  it("appears for an outfit of several pieces", () => {
    expect(D.buildOverlay({ products: OUTFIT, kind: "outfit" })).toContain("WHOLE OUTFIT");
  });
  it("does not appear for a single product", () => {
    const svg = D.buildOverlay({ products: [P("One Thing", 900)], kind: "single" });
    expect(textOf(svg)).not.toContain("WHOLE OUTFIT");
    expect(textOf(svg)).toContain("SHOP IT ONLINE");   // and the CTA says so too
  });
  it("does not appear when only one piece could be priced", () => {
    const svg = D.buildOverlay({ products: [P("One", 900), P("No price", null)], kind: "outfit" });
    expect(textOf(svg)).not.toContain("WHOLE OUTFIT");
  });
  it("the CTA never promises a whole outfit that is not shown", () => {
    for (const [kind, prods, want] of [
      ["outfit", OUTFIT, "SHOP THE WHOLE OUTFIT"],
      ["single", [P("One Thing", 900)], "SHOP IT ONLINE"],
      ["flatlay", [P("A", 100), P("B", 200)], "SHOP THESE"],
    ]) {
      expect(textOf(D.buildOverlay({ products: prods, kind })), kind).toContain(want);
    }
  });
});

describe("names and escaping", () => {
  it("uses the true product name, brand first", () => {
    const svg = D.buildOverlay({ products: [P("Lacoste T-Clip Sneakers", 2499)], kind: "single" });
    expect(svg).toContain("LACOSTE");
    expect(svg).toContain("T-CLIP SNEAKERS");
  });

  it("escapes XML so a product name cannot break the SVG", () => {
    const svg = D.buildOverlay({ products: [P('Nasty <tag> & "quote"', 100)], kind: "single" });
    expect(svg).toContain("&amp;");
    expect(svg).not.toMatch(/<tag>/);
  });

  it("carries no promotional furniture the direction forbids", () => {
    const svg = D.buildOverlay({ products: OUTFIT, kind: "outfit" });
    expect(svg).not.toMatch(/SALE|DISCOUNT|LIMITED|BUY NOW|CLICK/i);
  });
});

// ── THE MEASUREMENT MUST ACTUALLY MEASURE ────────────────────────────────────
// chooseLayout() is only as good as the numbers handed to it, and the first
// implementation handed it the same numbers every time: sharp's stats() reads
// the SOURCE image and ignores an extract() earlier in the pipeline, so every
// region of every photograph reported identical mean and stdev. The layout
// would have been fixed for all images while appearing to be measured — the
// exact thing the art direction forbids, failing silently.
//
// The unit tests above did not catch it because they feed chooseLayout
// synthetic numbers. This one exercises the real sharp behaviour, which is the
// only way the bug is visible.
describe("region measurement is real, not the whole image", () => {
  const sharp = require("sharp");

  const halfBlackHalfWhite = async (w = 600, h = 400) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: w / 2, top: 0 }])
      .png().toBuffer();

  // The shape measureEdges() uses: materialise the cut BEFORE asking for stats.
  const regionMean = async (img, left, top, width, height) => {
    const cut = await sharp(img).extract({ left, top, width, height }).toBuffer();
    const st = await sharp(cut).greyscale().stats();
    return st.channels[0].mean;
  };

  it("reports different values for genuinely different regions", async () => {
    const img = await halfBlackHalfWhite();
    const left = await regionMean(img, 0, 0, 200, 400);
    const right = await regionMean(img, 400, 0, 200, 400);
    expect(left).toBeLessThan(20);
    expect(right).toBeGreaterThan(235);
    expect(left).not.toBeCloseTo(right, 0);
  });

  it("the naive form — extract().stats() — is the trap, and is why this exists", async () => {
    // Documented rather than merely avoided: if a future sharp makes stats()
    // honour extract(), this assertion fails and the comment can be deleted.
    const img = await halfBlackHalfWhite();
    const naiveLeft = (await sharp(img).extract({ left: 0, top: 0, width: 200, height: 400 }).greyscale().stats()).channels[0].mean;
    const naiveRight = (await sharp(img).extract({ left: 400, top: 0, width: 200, height: 400 }).greyscale().stats()).channels[0].mean;
    expect(naiveLeft).toBeCloseTo(naiveRight, 1);
  });

  it("feeds chooseLayout numbers that actually move the layout", async () => {
    const img = await halfBlackHalfWhite();
    const mk = async (l) => ({ mean: await regionMean(img, l, 0, 200, 400), stdev: 0 });
    // Flat on both sides here, so the tie-break applies — what matters is that
    // the INK follows the measured brightness rather than a constant.
    expect(D.chooseLayout({ left: await mk(0), right: await mk(400) }).ink).toBe("#141414");
    expect(D.chooseLayout({ left: await mk(400), right: await mk(0) }).ink).toBe("#F4F1EA");
  });
});

// ── THE OVERLAY MUST FIT THE PHOTOGRAPH IT GOES ON ───────────────────────────
// normalizeSocialImage resizes with fit:"inside" and withoutEnlargement, so the
// finished photograph is routinely SMALLER than 1080x1350 — 1080x1341 is
// typical. sharp refuses to composite an overlay larger than its base, so a
// fixed-size overlay failed on EVERY real generation ("Image to composite must
// have same dimensions or smaller") while passing every test here, because the
// tests rendered at exactly 1080x1350.
//
// The failure was invisible in the worst way: compositeSocialDesign catches it
// and keeps the bare photograph, so posts came out looking finished and simply
// had no design on them.
describe("the overlay is sized to the photograph, not to a constant", () => {
  const sharp = require("sharp");
  const products = [P("Air Force 1 Black", 750), P("Lacoste Sweatshirt Beige", 600)];

  const flat = async (w, h) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();

  // The real shapes seen in production, plus the exact authored size.
  for (const [w, h] of [[1080, 1341], [1080, 1350], [1024, 1280], [900, 1125]]) {
    it(`composites onto a ${w}x${h} photograph`, async () => {
      const base = await flat(w, h);
      const svg = D.buildOverlay({ products, kind: "outfit", width: w, height: h });
      const out = await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg().toBuffer();
      const meta = await sharp(out).metadata();
      expect(meta.width).toBe(w);
      expect(meta.height).toBe(h);
    });
  }

  it("declares the given size on the svg while keeping the authored viewBox", () => {
    const svg = D.buildOverlay({ products, kind: "outfit", width: 1080, height: 1341 });
    expect(svg).toContain('width="1080"');
    expect(svg).toContain('height="1341"');
    expect(svg).toContain(`viewBox="0 0 ${D.W} ${D.H}"`);
  });

  it("still renders the real prices after scaling", async () => {
    const svg = D.buildOverlay({ products, kind: "outfit", width: 1080, height: 1341 });
    expect(svg).toContain("R750");
    expect(svg).toContain("R600");
    expect(svg).toContain("R1,350");   // summed in code, not drawn
  });
});
