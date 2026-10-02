// The extracted compression loop must produce what the two inline copies did.
import { describe, it, expect } from "vitest";
import { scaledSize, stepDownJpegDataUrl, APP_PHOTO_MAX_DIM, SOURCE_PHOTO_MAX_DIM } from "./productPhotoEncode.js";

describe("scaledSize", () => {
  it("caps the long side and never upscales", () => {
    expect(scaledSize(4032, 3024, APP_PHOTO_MAX_DIM)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(3024, 4032, SOURCE_PHOTO_MAX_DIM)).toEqual({ width: 1800, height: 2400 });
    expect(scaledSize(640, 480, SOURCE_PHOTO_MAX_DIM)).toEqual({ width: 640, height: 480 });
  });
});

describe("stepDownJpegDataUrl", () => {
  // A fake canvas whose output size grows with quality.
  const canvasOf = (bytesAt) => ({ toDataURL: (_t, q) => "x".repeat(Math.round(bytesAt(q) / 0.75)) });
  it("takes the first quality from 0.85 down that fits", () => {
    const tried = [];
    const c = { toDataURL: (t, q) => { tried.push(q); return "x".repeat(Math.round((q * 1000) / 0.75)); } };
    const out = stepDownJpegDataUrl(c, 700);
    expect(out.length * 0.75).toBeLessThanOrEqual(700);
    expect(tried.slice(0, 5)).toEqual([0.05, 0.85, 0.8, 0.75, 0.7]);
  });
  it("falls back to q 0.05 when nothing fits", () => {
    const out = stepDownJpegDataUrl(canvasOf((q) => (q === 0.05 ? 10 : 1000)), 100);
    expect(out.length).toBe(Math.round(10 / 0.75));
  });
});
