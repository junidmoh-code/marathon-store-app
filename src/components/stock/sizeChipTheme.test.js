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
  it("nothing is faded to the point of illegibility", () => {
    const out = phoneSizeChipStyle({ out: true });
    expect(out.opacity).toBeUndefined();               // no blanket opacity
    // rgba(r,g,b,a) — the alpha is the last comma-separated component.
    const alpha = Number(String(out.color).replace(/^.*\(|\).*$/g, "").split(",").pop());
    expect(alpha).toBeGreaterThanOrEqual(0.35);        // .38, not the old .28
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
