import { describe, it, expect, vi } from "vitest";
import {
  writeProductThumb,
  encodeThumbnail,
  PHOTO_THUMB_CONTENT_TYPE,
  PHOTO_THUMB_CACHE_CONTROL,
  PHOTO_THUMB_QUALITY,
} from "./productThumb.js";

const webpBlob = (size = 1234) => ({ type: "image/webp", size });

describe("writeProductThumb — where it writes", () => {
  it("writes to the exact path the POS mirror reads", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    const res = await writeProductThumb("p1777895684767", { size: 1 }, {
      upload, encode: async () => webpBlob(),
    });
    expect(res.ok).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe("products/p1777895684767/thumb_300.webp");
  });

  it("uploads as image/webp and ALWAYS REVALIDATES — the mirror reads a token-less URL", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    await writeProductThumb("p1", { size: 1 }, { upload, encode: async () => webpBlob() });
    expect(upload.mock.calls[0][2]).toEqual({
      contentType: PHOTO_THUMB_CONTENT_TYPE,
      cacheControl: PHOTO_THUMB_CACHE_CONTROL,
    });
    expect(PHOTO_THUMB_CONTENT_TYPE).toBe("image/webp");
    // photo.jpg can afford a 7-day cap because its URL carries a token that
    // changes when the object is replaced. The thumbnail is read by its
    // DETERMINISTIC path, so the URL is identical before and after a re-shoot:
    // any freshness lifetime at all lets a till keep serving the previous
    // thumbnail and file it under the NEW content marker as current.
    expect(PHOTO_THUMB_CACHE_CONTROL).toContain("max-age=0");
    expect(PHOTO_THUMB_CACHE_CONTROL).toContain("must-revalidate");
    expect(PHOTO_THUMB_CACHE_CONTROL).not.toContain("immutable");
    expect(PHOTO_THUMB_CACHE_CONTROL).not.toMatch(/max-age=[1-9]/);
  });

  it("a re-shoot REPLACES the thumbnail — same path, second write", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    await writeProductThumb("p9", { size: 1 }, { upload, encode: async () => webpBlob(100) });
    await writeProductThumb("p9", { size: 2 }, { upload, encode: async () => webpBlob(200) });
    expect(upload.mock.calls.map((c) => c[0])).toEqual([
      "products/p9/thumb_300.webp",
      "products/p9/thumb_300.webp",
    ]);
  });
});

describe("writeProductThumb — the photo matters more than the thumbnail", () => {
  it("never throws when the encode fails", async () => {
    const warn = vi.fn();
    const res = await writeProductThumb("p1", { size: 1 }, {
      upload: vi.fn(),
      encode: async () => { throw new Error("canvas exploded"); },
      warn,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("canvas exploded");
    expect(warn).toHaveBeenCalled();
  });

  it("never throws when the Storage write is refused", async () => {
    const res = await writeProductThumb("p1", { size: 1 }, {
      upload: async () => { throw new Error("storage/unauthorized"); },
      encode: async () => webpBlob(),
      warn: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("storage/unauthorized");
  });

  it("never throws on a missing id, a missing blob or a missing uploader", async () => {
    const encode = vi.fn(async () => webpBlob());
    await expect(writeProductThumb(null, { size: 1 }, { upload: vi.fn(), encode })).resolves.toMatchObject({ ok: false });
    await expect(writeProductThumb("p1", null, { upload: vi.fn(), encode })).resolves.toMatchObject({ ok: false });
    await expect(writeProductThumb("p1", { size: 1 }, { encode })).resolves.toMatchObject({ ok: false });
    // None of those should have burned an encode, and none should have thrown.
    expect(encode).not.toHaveBeenCalled();
  });
});

describe("encodeThumbnail", () => {
  const fakeCanvas = (out) => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) };
    canvas.__out = out;
    return canvas;
  };

  it("pins the width to 300 and lets the height follow the aspect ratio", async () => {
    let made = null;
    const blob = await encodeThumbnail({ size: 1 }, {
      loadImage: async () => ({ naturalWidth: 600, naturalHeight: 800 }),
      makeCanvas: (w, h) => { made = { w, h }; return fakeCanvas(); },
      toBlob: async () => webpBlob(),
    });
    // 600x800 portrait (the measured shape of this catalogue's photos) -> 300x400,
    // the same geometry as `cwebp -resize 300 0` in the POS repo's generate.mjs.
    expect(made).toEqual({ w: 300, h: 400 });
    expect(blob.type).toBe("image/webp");
  });

  it("never UPSCALES a source that is already smaller than 300px", async () => {
    let made = null;
    await encodeThumbnail({ size: 1 }, {
      loadImage: async () => ({ naturalWidth: 120, naturalHeight: 160 }),
      makeCanvas: (w, h) => { made = { w, h }; return fakeCanvas(); },
      toBlob: async () => webpBlob(),
    });
    expect(made).toEqual({ w: 120, h: 160 });
  });

  it("asks the canvas for WebP at the same quality as the POS generator's cwebp -q 80", async () => {
    const toBlob = vi.fn(async () => webpBlob());
    await encodeThumbnail({ size: 1 }, {
      loadImage: async () => ({ naturalWidth: 600, naturalHeight: 800 }),
      makeCanvas: () => fakeCanvas(),
      toBlob,
    });
    expect(toBlob.mock.calls[0][1]).toBe("image/webp");
    expect(toBlob.mock.calls[0][2]).toBe(PHOTO_THUMB_QUALITY);
    expect(PHOTO_THUMB_QUALITY).toBe(0.8);
  });

  it("REFUSES the silent PNG fallback older Safari returns for image/webp", async () => {
    // canvas.toBlob does not fail on an unsupported type — it hands back a PNG.
    // Uploading that to a .webp path would look perfectly healthy forever.
    await expect(encodeThumbnail({ size: 1 }, {
      loadImage: async () => ({ naturalWidth: 600, naturalHeight: 800 }),
      makeCanvas: () => fakeCanvas(),
      toBlob: async () => ({ type: "image/png", size: 90000 }),
    })).rejects.toThrow(/not WebP/i);
  });

  it("refuses a source image with no dimensions rather than writing a 0x0 object", async () => {
    await expect(encodeThumbnail({ size: 1 }, {
      loadImage: async () => ({ naturalWidth: 0, naturalHeight: 0 }),
      makeCanvas: () => fakeCanvas(),
      toBlob: async () => webpBlob(),
    })).rejects.toThrow(/dimensions/);
  });
});
