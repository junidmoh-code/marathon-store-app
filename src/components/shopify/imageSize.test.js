// The picture's own header, read as bytes. Every case here is one a phone
// picker or a Shopify upload actually produces — and the awkward ones (a
// truncated header, a marker chain running off the end, a 0x0 claim) are
// exactly why this is pure: they are unphotographable but trivially testable.
import { describe, it, expect } from "vitest";
import { pixelSizeFromHeader, readPixelSize } from "./imageSize";

const bytes = (...parts) => {
  const flat = [];
  for (const p of parts) for (const b of p) flat.push(b);
  return new Uint8Array(flat);
};
const be16 = (n) => [(n >> 8) & 0xFF, n & 0xFF];
const be32 = (n) => [(n >>> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
const le16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];
const le32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n) => new Array(n).fill(0);

const jpeg = (w, h, { app1 = 64, marker = 0xC0 } = {}) => bytes(
  [0xFF, 0xD8],
  [0xFF, 0xE1], be16(app1 + 2), zeros(app1),          // an EXIF block first
  [0xFF, marker], be16(17), [8], be16(h), be16(w), zeros(10),
);
const png = (w, h) => bytes(
  [0x89], chars("PNG"), [0x0D, 0x0A, 0x1A, 0x0A],
  be32(13), chars("IHDR"), be32(w), be32(h), zeros(8),
);
const heic = (...sizes) => bytes(
  be32(24), chars("ftyp"), chars("heic"), zeros(12),
  ...sizes.flatMap(([w, h]) => [be32(20), chars("ispe"), be32(0), be32(w), be32(h)]),
);

describe("pixelSizeFromHeader", () => {
  it("reads a JPEG's frame header, skipping the EXIF block in front of it", () => {
    expect(pixelSizeFromHeader(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("reads a progressive JPEG (SOF2) the same way", () => {
    expect(pixelSizeFromHeader(jpeg(1200, 900, { marker: 0xC2 }))).toEqual({ width: 1200, height: 900 });
  });

  it("does NOT mistake a Huffman table for a frame header", () => {
    // 0xC4 sits inside the SOFn numeric range and is not a frame. Reading it as
    // one yields whatever bytes follow — a plausible-looking wrong size.
    const withDht = bytes(
      [0xFF, 0xD8],
      [0xFF, 0xC4], be16(19), zeros(17),                  // DHT, must be skipped
      [0xFF, 0xC0], be16(17), [8], be16(600), be16(800), zeros(10),
    );
    expect(pixelSizeFromHeader(withDht)).toEqual({ width: 800, height: 600 });
  });

  it("reads PNG, GIF, BMP and WebP", () => {
    expect(pixelSizeFromHeader(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(pixelSizeFromHeader(bytes(chars("GIF89a"), le16(320), le16(240), zeros(8))))
      .toEqual({ width: 320, height: 240 });
    expect(pixelSizeFromHeader(bytes(chars("BM"), zeros(16), le32(1920), le32(-1080 >>> 0), zeros(8))))
      .toEqual({ width: 1920, height: 1080 });   // negative height = top-down, same size
    const vp8x = bytes(
      chars("RIFF"), le32(30), chars("WEBP"), chars("VP8X"), le32(10), zeros(4),
      [(2560 - 1) & 0xFF, ((2560 - 1) >> 8) & 0xFF, 0], [(1440 - 1) & 0xFF, ((1440 - 1) >> 8) & 0xFF, 0],
    );
    expect(pixelSizeFromHeader(vp8x)).toEqual({ width: 2560, height: 1440 });
  });

  it("takes a HEIC's LARGEST ispe — the thumbnail must not be mistaken for the photo", () => {
    // An iPhone HEIC carries a 320x240 thumbnail alongside the 12MP image. Read
    // the first box and the resize would be skipped on exactly the file it is for.
    expect(pixelSizeFromHeader(heic([320, 240], [4032, 3024]))).toEqual({ width: 4032, height: 3024 });
  });

  it("answers null — never a guess — for anything it does not recognise", () => {
    expect(pixelSizeFromHeader(bytes(chars("%PDF-1.7"), zeros(64)))).toBe(null);
    expect(pixelSizeFromHeader(bytes(zeros(4)))).toBe(null);          // too short
    expect(pixelSizeFromHeader(null)).toBe(null);
    expect(pixelSizeFromHeader(png(0, 0))).toBe(null);                // 0x0 is not a size
    // A JPEG whose marker chain runs off the end of the header slice.
    expect(pixelSizeFromHeader(bytes([0xFF, 0xD8], [0xFF, 0xE1], be16(60000), zeros(40)))).toBe(null);
  });

  it("refuses a header claiming an impossible dimension", () => {
    expect(pixelSizeFromHeader(png(9_000_000, 10))).toBe(null);
  });
});

describe("readPixelSize", () => {
  const blobOf = (u8) => ({
    slice: () => ({ arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) }),
  });

  it("reads the front of a real Blob", async () => {
    expect(await readPixelSize(blobOf(jpeg(2000, 1500)))).toEqual({ width: 2000, height: 1500 });
  });

  it("is null, never a throw, when the file cannot be sliced or read", async () => {
    expect(await readPixelSize({ size: 5_000_000 })).toBe(null);           // a plain object
    expect(await readPixelSize({ slice: () => { throw new Error("gone"); } })).toBe(null);
    expect(await readPixelSize(null)).toBe(null);
  });
});
