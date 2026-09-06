import { describe, it, expect } from "vitest";
import {
  phoneSizeChipStyle, quickViewSizeChipStyle, chipDistinctionCount, CHIP_DISTINCTION_AXES,
} from "./sizeChipTheme";

// The owner spec, as a test: "the ✕ glyph inside it is REMOVED — the container
// alone carries the unavailability signal, and the size number reads clearly
// inside it. Verify the unavailable and available states remain unmistakably
// different at a glance without the glyph."
describe("the container alone carries the signal", () => {
  it("the phone chip differs on EVERY distinguishing axis, not just one", () => {
    expect(chipDistinctionCount(phoneSizeChipStyle)).toBe(CHIP_DISTINCTION_AXES.length);
  });
  it("the quick-view chip does too", () => {
    expect(chipDistinctionCount((o) => quickViewSizeChipStyle(o))).toBe(CHIP_DISTINCTION_AXES.length);
  });
  it("the unavailable chip carries no accent colour at all", () => {
    const out = phoneSizeChipStyle({ out: true, selected: false });
    for (const v of Object.values(out)) {
      expect(String(v).toLowerCase()).not.toMatch(/60,\s*110,\s*255|#3c6eff|#7aa2ff/);
    }
  });
  it("the outline SHAPE differs, which reads at arm's length", () => {
    expect(phoneSizeChipStyle({ out: true }).borderStyle).toBe("dashed");
    expect(phoneSizeChipStyle({ out: false }).borderStyle).toBe("solid");
  });
  it("and it is filled where an available chip is transparent", () => {
    expect(phoneSizeChipStyle({ out: false, selected: false }).background).toBe("transparent");
    expect(phoneSizeChipStyle({ out: true }).background).not.toBe("transparent");
  });
});

describe("the size number stays readable", () => {
  // The whole reason the glyph could go: the number is the content, and
  // anything that obscures it defeats the change.
  it("nothing is struck through", () => {
    for (const s of [phoneSizeChipStyle({ out: true }), quickViewSizeChipStyle({ out: true })]) {
      expect(s.textDecoration).toBeUndefined();
    }
  });
  // COMPUTED CONTRAST, not an alpha threshold. An alpha reads as "dim enough"
  // and says nothing about whether a 16px size number can actually be read on
  // the chip's own surface — .38 measured at roughly 3:1 there, and WCAG AA
  // wants 4.5:1 for text this size (CodeRabbit).
  const SHEET_BG = [11, 14, 24];        // the phone sheet's ground, #0b0e18

  // rgba(r,g,b,a) over a known ground.
  const composite = (css, bg) => {
    const [r, g, b, a = 1] = String(css).replace(/^.*\(|\).*$/g, "").split(",").map(Number);
    return [r, g, b].map((c, i) => c * a + bg[i] * (1 - a));
  };
  const relLum = ([r, g, b]) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (fg, bg) => {
    const [a, b] = [relLum(fg), relLum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };

  it("the unavailable size number clears 4.5:1 on its own chip surface", () => {
    const out = phoneSizeChipStyle({ out: true });
    const surface = composite(out.background, SHEET_BG);
    expect(contrast(composite(out.color, surface), surface)).toBeGreaterThanOrEqual(4.5);
  });
  it("and so does the AVAILABLE one — it is the label staff read all day", () => {
    const ok = phoneSizeChipStyle({ out: false, selected: false });
    expect(contrast(composite(ok.color, SHEET_BG), SHEET_BG)).toBeGreaterThanOrEqual(4.5);
  });
  // THE ORDERING IS THE POINT, and raising one label alone inverted it: the
  // unavailable number composited BRIGHTER than the sellable one (luminance
  // .338 vs .246), which is backwards on the axis a person reads fastest.
  it("the SELLABLE size is the brighter of the two", () => {
    const out = phoneSizeChipStyle({ out: true });
    const ok = phoneSizeChipStyle({ out: false, selected: false });
    const outLum = relLum(composite(out.color, composite(out.background, SHEET_BG)));
    const okLum = relLum(composite(ok.color, SHEET_BG));
    expect(okLum).toBeGreaterThan(outLum);
  });
  it("nothing is faded with a blanket opacity, which would defeat the above", () => {
    expect(phoneSizeChipStyle({ out: true }).opacity).toBeUndefined();
    expect(quickViewSizeChipStyle({ out: true }).opacity).toBeUndefined();
  });
});

describe("the chip stays tappable — that is what opens the sheet", () => {
  it("never not-allowed", () => {
    expect(phoneSizeChipStyle({ out: true }).cursor).toBe("pointer");
    expect(quickViewSizeChipStyle({ out: true }).cursor).toBe("pointer");
  });
});

describe("the selected state is still obvious", () => {
  it("a selected available chip differs from an unselected one", () => {
    const sel = phoneSizeChipStyle({ out: false, selected: true });
    const un = phoneSizeChipStyle({ out: false, selected: false });
    expect(sel.borderColor).not.toBe(un.borderColor);
    expect(sel.background).not.toBe(un.background);
    expect(sel.color).not.toBe(un.color);
  });
});
