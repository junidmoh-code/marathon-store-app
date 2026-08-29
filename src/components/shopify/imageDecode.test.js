// The upload path staff actually use: a phone picker, an Apple camera format,
// and a handset that will kill the tab if a 12-megapixel photo is decoded at
// full size. Every case here is one an iPhone or a cheap Android produces.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isAcceptedImageFile, ACCEPTED_TYPES, decodeImageFile } from "./imageDecode";

const fileOf = (type, name, size = 100) => ({ type, name, size });

describe("isAcceptedImageFile", () => {
  it("accepts what an iPhone camera actually produces", () => {
    expect(isAcceptedImageFile(fileOf("image/heic", "IMG_0042.HEIC"))).toBe(true);
    expect(isAcceptedImageFile(fileOf("image/heif", "IMG_0042.heif"))).toBe(true);
  });

  it("accepts a file the picker gave NO type for, on its extension", () => {
    // iOS does this routinely — a shared album, Files, another app. Rejecting
    // a blank type rejects exactly the phones this exists for.
    expect(isAcceptedImageFile(fileOf("", "IMG_0042.HEIC"))).toBe(true);
    expect(isAcceptedImageFile(fileOf("", "photo.jpg"))).toBe(true);
    expect(isAcceptedImageFile(fileOf("", "clip.mov"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("", "notes"))).toBe(false);
  });

  it("still accepts everything it used to", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp"]) {
      expect(isAcceptedImageFile(fileOf(t, "x"))).toBe(true);
    }
  });

  it("accepts a HEIC the picker mislabelled — application/octet-stream", () => {
    // Pickers do this. Refusing on the type alone turned the photo away with a
    // different cause but the same result as the bug this work removes.
    expect(isAcceptedImageFile(fileOf("application/octet-stream", "IMG_0042.HEIC"))).toBe(true);
    expect(isAcceptedImageFile(fileOf("application/octet-stream", "scan.pdf"))).toBe(false);
  });

  it("refuses an SVG — a document with script semantics, not a photograph", () => {
    expect(ACCEPTED_TYPES).not.toContain("image/svg+xml");
    // Refused on BOTH counts now that either may vouch for a file: it is in
    // neither the type list nor the extension list.
    expect(isAcceptedImageFile(fileOf("image/svg+xml", "logo.svg"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("", "logo.svg"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("image/svg+xml", "logo.png"))).toBe(true); // an image by name
  });

  it("refuses a video and no file at all", () => {
    expect(isAcceptedImageFile(fileOf("video/quicktime", "IMG_1.MOV"))).toBe(false);
    expect(isAcceptedImageFile(null)).toBe(false);
  });
});

describe("decodeImageFile", () => {
  const BIG = 4 * 1024 * 1024;
  const bitmap = (w, h) => ({ width: w, height: h, close: vi.fn() });
  let calls;

  beforeEach(() => { calls = []; });
  afterEach(() => {
    delete globalThis.createImageBitmap;
    vi.restoreAllMocks();
  });

  it("asks the DECODER to shrink a phone photo, rather than decoding it whole", () => {
    // The allocation that kills a cheap handset is the full-size bitmap, so it
    // must never exist. The hint carries a width only — height is derived, so
    // the aspect ratio survives and the caller's canvas clamps the long side.
    globalThis.createImageBitmap = (file, opts) => {
      calls.push(opts);
      return Promise.resolve(bitmap(1600, 2133));
    };
    return decodeImageFile(fileOf("image/jpeg", "IMG.jpg", BIG), 1600).then((d) => {
      expect(calls[0]).toEqual({ resizeWidth: 1600, resizeQuality: "high" });
      expect(d.width).toBe(1600);
    });
  });

  it("does NOT ask for a resize on a small file — the hint is a width, not a maximum", () => {
    // resizeWidth on a 400px graphic would UPSCALE it to 1600 and then the
    // canvas would have nothing to shrink: a blurred logo instead of a sharp one.
    globalThis.createImageBitmap = (file, opts) => {
      calls.push(opts);
      return Promise.resolve(bitmap(400, 400));
    };
    return decodeImageFile(fileOf("image/png", "logo.png", 20 * 1024), 1600).then(() => {
      expect(calls[0]).toBeUndefined();
    });
  });

  it("falls back to a plain decode when the browser rejects the resize options", () => {
    // Older Safari. A refusal of the OPTIONS is not a refusal of the FILE.
    globalThis.createImageBitmap = (file, opts) => {
      calls.push(opts);
      if (opts) return Promise.reject(new Error("unsupported"));
      return Promise.resolve(bitmap(3024, 4032));
    };
    return decodeImageFile(fileOf("image/heic", "IMG.HEIC", BIG), 1600).then((d) => {
      expect(calls.length).toBe(2);
      expect(d.width).toBe(3024);
    });
  });

  it("release() closes the bitmap — its pixels are off the JS heap", async () => {
    const b = bitmap(100, 100);
    globalThis.createImageBitmap = () => Promise.resolve(b);
    const d = await decodeImageFile(fileOf("image/jpeg", "x.jpg", 10), 1600);
    d.release();
    expect(b.close).toHaveBeenCalled();
  });

  it("release() on an <img> fallback does not throw — an image has no close()", async () => {
    globalThis.createImageBitmap = () => Promise.reject(new Error("no"));
    const img = { naturalWidth: 10, naturalHeight: 10 };
    const spy = vi.spyOn(globalThis, "URL", "get");
    spy.mockReturnValue({ createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    globalThis.Image = class { set src(_) { setTimeout(() => this.onload(), 0); }
                               get width() { return img.naturalWidth; }
                               get height() { return img.naturalHeight; } };
    const d = await decodeImageFile(fileOf("image/jpeg", "x.jpg", 10), 1600);
    expect(() => d.release()).not.toThrow();
    delete globalThis.Image;
  });

  it("gives a sentence a person can act on when nothing can read the file", async () => {
    // No stack trace, no MIME type, no library name.
    globalThis.createImageBitmap = () => Promise.reject(new Error("decode failed"));
    globalThis.Image = class { set src(_) { setTimeout(() => this.onerror(), 0); } };
    const spy = vi.spyOn(globalThis, "URL", "get");
    spy.mockReturnValue({ createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    await expect(decodeImageFile(fileOf("image/heic", "IMG.HEIC", 10), 1600)).rejects.toThrow(
      /couldn't be opened|couldn't open/i
    );
    delete globalThis.Image;
  });
});

// ─── THE GATE NO LONGER ENUMERATES (owner report 2026-08-28) ─────────────────
// A camera-roll photo was refused with "That doesn't look like a photo" —
// the third time a named format list met a format it did not name (HEIC was
// the first two). Any image/* type is now attempted; SVG alone stays out.
describe("isAcceptedImageFile — any image/* is attempted", () => {
  const fileOf = (type, name, size = 100) => ({ type, name, size });
  it("accepts the formats Apple added after the list was written", () => {
    expect(isAcceptedImageFile(fileOf("image/jxl", "IMG_8001.JXL"))).toBe(true);   // iPhone 16 Pro JPEG-XL
    expect(isAcceptedImageFile(fileOf("image/x-adobe-dng", "IMG_8001.DNG"))).toBe(true); // ProRAW
    expect(isAcceptedImageFile(fileOf("image/whatever-comes-next", "x"))).toBe(true);
  });
  it("accepts them by extension too when the type is blank (Files-app picks)", () => {
    expect(isAcceptedImageFile(fileOf("", "IMG_8001.DNG"))).toBe(true);
    expect(isAcceptedImageFile(fileOf("", "IMG_8001.jxl"))).toBe(true);
  });
  it("SVG stays refused under every spelling — it is a scriptable document, not a photo", () => {
    expect(isAcceptedImageFile(fileOf("image/svg+xml", "logo.svg"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("image/svg", "logo.svg"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("", "logo.svg"))).toBe(false);
  });
  it("still refuses what genuinely is not an image on both counts", () => {
    expect(isAcceptedImageFile(fileOf("video/quicktime", "IMG_1.MOV"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("application/pdf", "scan.pdf"))).toBe(false);
  });
});

describe("the refusal carries its own diagnosis", () => {
  it("names the reported type and file name, so the next phone report answers itself", async () => {
    const { uploadFileProblem } = await import("./photoTools.js");
    const msg = uploadFileProblem({ type: "video/quicktime", name: "IMG_1234.MOV", size: 100 });
    expect(msg).toContain("video/quicktime");
    expect(msg).toContain("IMG_1234.MOV");
    const blank = uploadFileProblem({ type: "", name: "", size: 100 });
    expect(blank).toContain("no type");
  });
});

describe("the size ceiling admits real camera output (owner report 2026-08-28, same evening)", () => {
  it("a 60 MB ProRAW DNG passes the gate; 200 MB is refused with its size named", async () => {
    const { uploadFileProblem } = await import("./photoTools.js");
    expect(uploadFileProblem({ type: "image/x-adobe-dng", name: "IMG_8001.DNG", size: 60 * 1024 * 1024 })).toBe(null);
    expect(uploadFileProblem({ type: "image/heic", name: "IMG_8002.HEIC", size: 3 * 1024 * 1024 })).toBe(null);
    const msg = uploadFileProblem({ type: "image/jpeg", name: "x.jpg", size: 200 * 1024 * 1024 });
    expect(msg).toContain("200 MB");
    expect(msg).toContain("150 MB");
  });
});

// ─── THE RESIZE HINT IS ABOUT PIXELS, NOT BYTES ──────────────────────────────
// Both callers of this decoder hand it a picked file and trust the hint not to
// invent pixels: src/components/shopify/photoTools.js (compressImageFile, the
// publishing upload, maxDim 1600) and
// src/components/cardrecon/CardReconScreen.jsx (downscalePhoto, the batch slip,
// maxDim 2000). The card-recon one is where an upscale SHOWS: its canvas step
// clamps the longer side only, so a bitmap that came back upscaled is uploaded
// upscaled — a blurrier picture of thermal print, which is the one thing that
// path cannot afford.
describe("decodeImageFile — the resize hint gates on the picture, not the file size", () => {
  const be16 = (n) => [(n >> 8) & 0xFF, n & 0xFF];
  const be32 = (n) => [(n >>> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
  const chars = (s) => [...s].map((c) => c.charCodeAt(0));
  const u8 = (...parts) => new Uint8Array(parts.flat());
  const pngBytes = (w, h) => u8([0x89], chars("PNG"), [0x0D, 0x0A, 0x1A, 0x0A],
    be32(13), chars("IHDR"), be32(w), be32(h), new Array(8).fill(0));
  // A file that carries real header bytes, as a picker's File does.
  const realFile = (u8bytes, size) => ({
    type: "image/png", name: "shot.png", size,
    slice: () => ({ arrayBuffer: async () => u8bytes.buffer.slice(0) }),
  });

  let seen;
  beforeEach(() => { seen = []; });
  afterEach(() => { delete globalThis.createImageBitmap; });

  it("does NOT hint on a heavy file that is already SMALLER than the ceiling", async () => {
    // THE BUG. A 4 MB losslessly-compressed screenshot 1,200 pixels wide passed
    // the old 900 KB byte gate, so the decoder was asked for resizeWidth 1600 —
    // and createImageBitmap's resizeWidth is a width, not a maximum. It
    // upscaled, and the canvas then had nothing to shrink.
    globalThis.createImageBitmap = (f, o) => { seen.push(o); return Promise.resolve({ width: 1200, height: 800, close() {} }); };
    await decodeImageFile(realFile(pngBytes(1200, 800), 4 * 1024 * 1024), 1600);
    expect(seen[0]).toBeUndefined();
  });

  it("hints on the LONG side of a portrait photo, so the ceiling holds either way", async () => {
    // resizeWidth on a portrait 12 MP photo leaves the height at maxDim × 4/3 —
    // the memory ceiling the hint exists for, missed by a third.
    globalThis.createImageBitmap = (f, o) => { seen.push(o); return Promise.resolve({ width: 1500, height: 2000, close() {} }); };
    await decodeImageFile(realFile(pngBytes(3024, 4032), 3 * 1024 * 1024), 2000);
    expect(seen[0]).toEqual({ resizeHeight: 2000, resizeQuality: "high" });
  });

  it("hints on the width of a landscape photo above the ceiling", async () => {
    globalThis.createImageBitmap = (f, o) => { seen.push(o); return Promise.resolve({ width: 1600, height: 1200, close() {} }); };
    await decodeImageFile(realFile(pngBytes(4032, 3024), 3 * 1024 * 1024), 1600);
    expect(seen[0]).toEqual({ resizeWidth: 1600, resizeQuality: "high" });
  });

  it("keeps the byte fallback for a container whose header says nothing", async () => {
    // An exotic format (JPEG-XL, a ProRAW variant) still must not be decoded at
    // full size on a handset — "unknown and large" stays a phone photo.
    globalThis.createImageBitmap = (f, o) => { seen.push(o); return Promise.resolve({ width: 1600, height: 1200, close() {} }); };
    const unknown = { type: "image/jxl", name: "IMG.jxl", size: 5 * 1024 * 1024,
                      slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) };
    await decodeImageFile(unknown, 1600);
    expect(seen[0]).toEqual({ resizeWidth: 1600, resizeQuality: "high" });
  });
});
