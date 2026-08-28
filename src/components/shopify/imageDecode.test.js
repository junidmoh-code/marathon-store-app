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

  it("refuses an SVG — a document with script semantics, not a photograph", () => {
    expect(ACCEPTED_TYPES).not.toContain("image/svg+xml");
    expect(isAcceptedImageFile(fileOf("image/svg+xml", "logo.svg"))).toBe(false);
    expect(isAcceptedImageFile(fileOf("", "logo.svg"))).toBe(false);
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
