// ─── LABEL PHOTO — THE DOWNSCALE THAT KEEPS THE CODE READABLE ────────────────
// Two competing requirements meet here, and the tests pin both:
//   • BANDWIDTH — outgoing bytes are a measured cost on this project. A phone
//     camera frame is 4–12 MB and there is one per shoe received per shop.
//   • LEGIBILITY — this photo exists to be OCR'd. The style code is small print,
//     often angled, sometimes on a curved tongue. Compress it the way the
//     product-photo path does (800px, quality stepping down to 0.05 chasing
//     200 KB) and the code smears — which costs a Vision call, a Gemini call
//     and a retake, i.e. more than the bytes saved.
// So: 1024px ceiling, and a hard quality floor.

import { describe, it, expect } from "vitest";
import { encodeForOcr, base64FromDataUrl, LABEL_PHOTO_LIMITS } from "./labelPhoto";

// A fake canvas that reports a size proportional to quality, so the quality
// ladder's behaviour is observable without a real encoder.
function makeFakeCanvas(bytesAtQ1 = 2_000_000) {
  const calls = [];
  return {
    canvas: (w, h) => ({
      width: w, height: h,
      getContext: () => ({ drawImage() {} }),
      toDataURL: (_type, q) => {
        calls.push(q);
        // dataUrl length ≈ bytes / 0.75, and bytes scale with quality × area.
        const bytes = Math.round(bytesAtQ1 * q * ((w * h) / (1024 * 1024)));
        return "data:image/jpeg;base64," + "x".repeat(Math.max(1, Math.round(bytes / 0.75)));
      },
    }),
    calls,
  };
}

const img = (width, height) => ({ width, height });

describe("sizing", () => {
  it("caps the longest edge at 1024px", () => {
    const { canvas } = makeFakeCanvas();
    const out = encodeForOcr(img(4032, 3024), { makeCanvas: canvas });
    expect(Math.max(out.width, out.height)).toBe(1024);
    expect(out.width).toBe(1024);
    expect(out.height).toBe(768); // aspect ratio preserved
  });

  it("caps a portrait photo on its long edge too", () => {
    const { canvas } = makeFakeCanvas();
    const out = encodeForOcr(img(3024, 4032), { makeCanvas: canvas });
    expect(out.height).toBe(1024);
    expect(out.width).toBe(768);
  });

  it("never UPSCALES a photo that is already small", () => {
    const { canvas } = makeFakeCanvas();
    const out = encodeForOcr(img(640, 480), { makeCanvas: canvas });
    expect([out.width, out.height]).toEqual([640, 480]);
  });

  it("the ceiling is 1024, not the product path's 800", () => {
    expect(LABEL_PHOTO_LIMITS.MAX_DIM).toBe(1024);
  });

  it("a degenerate image still produces at least one pixel", () => {
    const { canvas } = makeFakeCanvas();
    const out = encodeForOcr(img(1, 0), { makeCanvas: canvas });
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

describe("the quality ladder", () => {
  it("starts high and stops at the first size that fits", () => {
    // 400 KB at q=1 → 368 KB at 0.92, inside the 400 KB target on the first try.
    const { canvas, calls } = makeFakeCanvas(400_000);
    const out = encodeForOcr(img(1024, 1024), { makeCanvas: canvas });
    expect(out.quality).toBe(0.92);
    expect(calls[calls.length - 1]).toBe(0.92);
  });

  it("steps down only as far as it must", () => {
    // 600 KB at q=1 → 552 KB at 0.92, too big; the first fitting step is 0.68.
    const { canvas } = makeFakeCanvas(600_000);
    const out = encodeForOcr(img(1024, 1024), { makeCanvas: canvas });
    expect(out.quality).toBeCloseTo(0.68, 5);
    expect(out.quality).toBeGreaterThan(LABEL_PHOTO_LIMITS.MIN_QUALITY);
  });

  it("steps down for a heavy photo, but NEVER below the legibility floor", () => {
    // Huge source: no quality in the ladder can hit the byte target.
    const { canvas, calls } = makeFakeCanvas(40_000_000);
    const out = encodeForOcr(img(1024, 1024), { makeCanvas: canvas });
    expect(out.quality).toBe(LABEL_PHOTO_LIMITS.MIN_QUALITY);
    // The product-photo path would have kept going to 0.05 and smeared the
    // small print. This one must not.
    expect(Math.min(...calls)).toBeGreaterThanOrEqual(LABEL_PHOTO_LIMITS.MIN_QUALITY);
    expect(LABEL_PHOTO_LIMITS.MIN_QUALITY).toBe(0.55);
  });

  it("the byte target is generous enough for small print", () => {
    expect(LABEL_PHOTO_LIMITS.TARGET_BYTES).toBe(400 * 1024);
  });
});

describe("base64FromDataUrl", () => {
  it("strips the data-URL prefix", () => {
    expect(base64FromDataUrl("data:image/jpeg;base64,QUJD")).toBe("QUJD");
  });

  it("returns '' for anything that is not a data URL", () => {
    for (const bad of ["", "nope", null, undefined, 42, {}]) {
      expect(base64FromDataUrl(bad)).toBe("");
    }
  });

  it("round-trips with what encodeForOcr produces", () => {
    const { canvas } = makeFakeCanvas(600_000);
    const { dataUrl } = encodeForOcr(img(100, 100), { makeCanvas: canvas });
    expect(base64FromDataUrl(dataUrl).length).toBeGreaterThan(0);
    expect(base64FromDataUrl(dataUrl)).not.toContain("data:");
  });
});
