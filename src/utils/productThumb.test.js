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

  it("retries the WRITE once — a re-shoot's dropped upload leaves a stale thumbnail marked current", async () => {
    // The asymmetry that earns the retry: both call sites stamp photoUpdatedAt
    // right after this returns, and that stamp is the mirror's content marker.
    // A never-written thumbnail is recorded missing and retried every 6h; a
    // FAILED re-shoot write leaves the previous picture in place under a marker
    // that now says "current", and nothing revisits it.
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("network dropped"))
      .mockResolvedValueOnce(undefined);
    const res = await writeProductThumb("p1", { size: 1 }, {
      upload, encode: async () => webpBlob(), warn: () => {}, pause: async () => {},
    });
    expect(res.ok).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0]).toBe("products/p1/thumb_300.webp");
  });

  it("gives up after the second write failure — it never throws and never loops", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("storage/unauthorized"));
    const res = await writeProductThumb("p1", { size: 1 }, {
      upload, encode: async () => webpBlob(), warn: () => {}, pause: async () => {},
    });
    expect(res.ok).toBe(false);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry the encode — it fails deterministically, so a second go only wastes time", async () => {
    const encode = vi.fn(async () => { throw new Error("browser encoded image/png, not WebP"); });
    const upload = vi.fn();
    const res = await writeProductThumb("p1", { size: 1 }, { upload, encode, warn: () => {}, pause: async () => {} });
    expect(res.ok).toBe(false);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
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

// ── PROPERTY FUZZ: the geometry, over 2,000 random source shapes ─────────────
// The dimension maths is three lines and looks obviously right, which is
// exactly the kind of code that is wrong at one edge (a 1px-tall panorama, a
// 4:1 banner, a source 1px under the cap) and never noticed, because a
// slightly wrong thumbnail still renders. So it is fuzzed rather than
// spot-checked: same properties, thousands of inputs. Seeded, so a failure is
// reproducible rather than a flake.
describe("encodeThumbnail geometry — property fuzz", () => {
  const seeded = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // WHAT THIS FUZZ CANNOT SEE: drawImage is a mock, so it proves the three
  // lines of dimension arithmetic and nothing about the pixels. A crop bug (a
  // drawImage with the wrong source rectangle), a makeCanvas that never sets
  // canvas.width/height, and the naturalWidth-vs-width fallback all pass it.
  // The real canvas path is exercised only by
  // scripts/thumbs/measure-browser-vs-cwebp.mjs, which runs this module in a
  // real browser against cwebp — and which is not part of `npm test`, because
  // it needs a network, a bucket and a browser.
  it("holds the invariants for every source shape", async () => {
    const rand = seeded(20260904);
    // Uniform random shapes alone were NOT enough: removing the Math.max(1, …)
    // floor survived a 2,000-case uniform fuzz, because the case that catches
    // it (a source so wide and so short that its scaled height rounds to ZERO)
    // is roughly one draw in a thousand. So the extreme aspect ratios that
    // actually break things are drawn deliberately, and the exact boundaries
    // are listed outright. A fuzz that only samples the middle is a slower
    // spot-check. (Mutation-tested: each invariant below kills a mutant.)
    const edges = [
      [6000, 1], [4096, 3], [1200, 2], [301, 1], [300, 1], [299, 1],
      [1, 6000], [1, 1], [300, 300], [301, 300], [8000, 12],
      // PORTRAIT extremes. The height is deliberately NOT bounded by 300 —
      // `cwebp -resize 300 0` sets the width only, so the catalogue's 600x800
      // photos are 300x400 objects and every one of the 5,016 already in the
      // bucket has that shape. These cases exist to pin that on purpose, so
      // nobody "fixes" the MAX_EDGE misnomer by scaling to the longest edge and
      // silently disagrees with the bulk writer about what a thumbnail is.
      [600, 800], [301, 6000], [400, 4000], [302, 9000],
    ];
    for (let i = 0; i < 2000 + edges.length; i++) {
      let srcW, srcH;
      if (i < edges.length) {
        [srcW, srcH] = edges[i];
      } else if (i % 3 === 0) {
        // A deliberately extreme ratio: very wide, only a few pixels tall.
        srcW = 600 + Math.floor(rand() * 5400);
        srcH = 1 + Math.floor(rand() * 12);
      } else {
        srcW = 1 + Math.floor(rand() * 6000);
        srcH = 1 + Math.floor(rand() * 6000);
      }
      let made = null;
      await encodeThumbnail({ size: 1 }, {
        loadImage: async () => ({ naturalWidth: srcW, naturalHeight: srcH }),
        makeCanvas: (w, h) => { made = { w, h }; return { width: w, height: h, getContext: () => ({ drawImage: () => {} }) }; },
        toBlob: async () => webpBlob(),
      });
      const ctx = `source ${srcW}x${srcH} -> ${made.w}x${made.h}`;
      // 1. Never wider than the convention's 300px.
      expect(made.w, ctx).toBeLessThanOrEqual(300);
      // 2. Never upscaled — cwebp would, and it only wastes bytes.
      expect(made.w, ctx).toBeLessThanOrEqual(srcW);
      expect(made.h, ctx).toBeLessThanOrEqual(srcH);
      // 3. Never a zero-dimension canvas: toBlob on a 0-wide canvas throws in
      //    some browsers and yields a 1x1 in others, and both write junk to a
      //    path the till will happily display.
      expect(made.w, ctx).toBeGreaterThanOrEqual(1);
      expect(made.h, ctx).toBeGreaterThanOrEqual(1);
      // 4. Integers — a fractional canvas dimension is silently truncated.
      expect(Number.isInteger(made.w), ctx).toBe(true);
      expect(Number.isInteger(made.h), ctx).toBe(true);
      // 5. Aspect ratio kept. Rounding to whole pixels moves the ratio by at
      //    most half a pixel on each axis; anything beyond that is a bug, not
      //    rounding. (Sources narrower than 300px are copied 1:1.)
      if (srcW > 300) {
        const expectedH = (srcH * 300) / srcW;
        // HALF a pixel, which is what Math.round actually guarantees — not 1.
        // At <= 1 this invariant survived swapping round for floor, ceil and
        // trunc, i.e. it was not testing the rounding at all. (Fable, PR #553.)
        expect(Math.abs(made.h - Math.max(1, expectedH)), ctx).toBeLessThanOrEqual(0.5);
        expect(made.w, ctx).toBe(300);
      } else {
        expect(made, ctx).toEqual({ w: srcW, h: srcH });
      }
    }
  });
});
