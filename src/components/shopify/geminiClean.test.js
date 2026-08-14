// ─── The subject-preservation gate, pinned ───────────────────────────────────
// The truthfulness rule's enforcement point: a generated image whose product
// region differs from the original — moved, redrawn, recoloured, or with a
// mark cleaned off — must be DISCARDED before anyone sees it. These tests
// drive assessSubjectPreservation with synthetic frames where ground truth is
// exact: same subject over a new background must pass; any change to the
// subject must fail.
import { describe, it, expect } from "vitest";
import { assessSubjectPreservation, isCleanBackgroundAvailable } from "./geminiClean";

const W = 100, H = 100;

function frame(fill) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}
function drawRect(img, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
    }
  }
}
// A "product": red body with a dark "logo mark" patch — the mark is what a
// cleanup model loves to erase, so the tests treat it specially.
function productOn(bg, { shift = 0, bodyColor = [200, 30, 30], markColor = [40, 20, 20], mark = true } = {}) {
  const img = frame(bg);
  drawRect(img, 30 + shift, 30, 70 + shift, 70, bodyColor);
  if (mark) drawRect(img, 45 + shift, 45, 55 + shift, 55, markColor);
  return img;
}

const CLUTTER = [90, 85, 80];  // the original's messy backdrop
const STUDIO = [235, 235, 235]; // the candidate's plain field

describe("assessSubjectPreservation", () => {
  it("passes a pure background replacement — subject pixels identical", () => {
    const v = assessSubjectPreservation(productOn(CLUTTER), productOn(STUDIO));
    expect(v.pass).toBe(true);
    expect(v.metrics.mean).toBe(0);
  });
  it("fails when the subject moved", () => {
    const v = assessSubjectPreservation(productOn(CLUTTER), productOn(STUDIO, { shift: 8 }));
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/did not survive/);
  });
  it("fails when the subject was recoloured/retouched", () => {
    const v = assessSubjectPreservation(
      productOn(CLUTTER),
      productOn(STUDIO, { bodyColor: [230, 60, 60], markColor: [70, 50, 50] })
    );
    expect(v.pass).toBe(false);
  });
  it("fails when a mark on the product was cleaned off — misrepresentation, the core case", () => {
    const v = assessSubjectPreservation(productOn(CLUTTER), productOn(STUDIO, { mark: false }));
    expect(v.pass).toBe(false);
  });
  it("fails when a mark was painted out WITH the background colour — the interior-hole gate", () => {
    // The sneakiest erasure: the mark region becomes background-coloured, so
    // it drops OUT of the candidate's subject mask and the pixel-diff never
    // sees it (reviewer finding 2026-08-14). Flood fill from the border finds
    // the background-coloured island trapped inside the product.
    const orig = productOn(CLUTTER); // has the dark 10×10 mark
    const cand = productOn(STUDIO);
    drawRect(cand, 45, 45, 55, 55, STUDIO); // mark painted out with the studio backdrop
    const v = assessSubjectPreservation(orig, cand);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/inside the product/);
  });
  it("fails when even a TINY mark was cleaned off — the changed-area gate closes the p95 tail hole", () => {
    // A 4×4 scuff on the body (~1% of the subject): erasing it barely moves
    // the mean and hides entirely inside p95's 5% allowance — only the
    // changed-pixel-area gate catches it (reviewer finding 2026-08-14).
    const scuff = (img) => drawRect(img, 60, 34, 64, 38, [40, 20, 20]);
    const orig = productOn(CLUTTER);
    scuff(orig);
    const cand = productOn(STUDIO);
    scuff(cand);
    expect(assessSubjectPreservation(orig, cand).pass).toBe(true); // sanity: scuff kept ⇒ passes
    const erased = productOn(STUDIO); // same candidate WITHOUT the scuff
    const v = assessSubjectPreservation(orig, erased);
    expect(v.pass).toBe(false);
    expect(v.metrics.mean).toBeLessThanOrEqual(10);   // mean alone would have passed it
    expect(v.metrics.changedFrac).toBeGreaterThan(0.005);
  });
  it("fails when no subject stands out of the new background", () => {
    const v = assessSubjectPreservation(productOn(CLUTTER), frame(STUDIO));
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no clear subject/);
  });
  it("fails on a dimension mismatch", () => {
    const small = { data: new Uint8ClampedArray(50 * 50 * 4), width: 50, height: 50 };
    expect(assessSubjectPreservation(productOn(CLUTTER), small).pass).toBe(false);
  });
  it("tolerates re-encode noise — small uniform jitter still passes", () => {
    const cand = productOn(STUDIO);
    for (let p = 0; p < W * H; p++) { // ±3 per channel, the scale of JPEG round-tripping
      const i = p * 4;
      cand.data[i] = Math.min(255, cand.data[i] + 3);
      cand.data[i + 2] = Math.max(0, cand.data[i + 2] - 3);
    }
    expect(assessSubjectPreservation(productOn(CLUTTER), cand).pass).toBe(true);
  });
});

describe("availability", () => {
  it("no GEMINI_API_KEY at build ⇒ the action reports unavailable (disabled, no stub)", () => {
    expect(isCleanBackgroundAvailable()).toBe(false);
  });
});
