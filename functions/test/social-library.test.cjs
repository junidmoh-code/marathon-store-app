// ─── THE PERMANENT ALBUM ─────────────────────────────────────────────────────
// Three properties carry this feature, and each fails silently rather than
// loudly if it breaks:
//   1. a picture is archived exactly ONCE, even though a story and its feed
//      twin are two records sharing one image;
//   2. the archive records WHAT IS IN the frame, because that is what makes an
//      outfit shoppable later;
//   3. the archive never carries a price or a status, because both go stale
//      and a stale price shown as current is worse than no album at all.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  LIBRARY_PATH, buildLibraryEntry, libraryWriteUpdates,
  libraryProducts, libraryMedia, libraryVideoPath, isOutfitEntry,
} = require("../lib/social-library.cjs");

const IMG = { type: "image", url: "https://storage/aiStudio/social/posts/P1/0.jpg" };
const rec = (over = {}) => ({
  media: [IMG], kind: "outfit", createdAt: 1787900000000, engine: "nbpro",
  style: "house", costUSD: 0.1556, link: "https://shop/x",
  products: [{ pid: "p1", slot: "shoe" }, { pid: "p2", slot: "top" }],
  ...over,
});

describe("one picture, one entry", () => {
  test("the primary record is archived", () => {
    assert.equal(buildLibraryEntry("P1", rec()).postId, "P1");
  });

  test("the feed twin is NOT — it shares the story's picture", () => {
    // If this ever returns an entry, the album shows every story twice.
    assert.equal(buildLibraryEntry("T1", rec(), { isTwin: true }), null);
  });

  test("the entry is keyed by post id, so a re-run overwrites instead of duplicating", () => {
    const a = libraryWriteUpdates("P1", rec(), {});
    const b = libraryWriteUpdates("P1", rec({ costUSD: 0.2 }), {});
    assert.deepEqual(Object.keys(a), [`${LIBRARY_PATH}/P1`]);
    assert.deepEqual(Object.keys(b), Object.keys(a));
  });

  test("a twin contributes nothing to the update map", () => {
    assert.deepEqual(libraryWriteUpdates("T1", rec(), { isTwin: true }), {});
  });
});

describe("only real pictures get in", () => {
  test("a video with NO poster is not archived", () => {
    assert.equal(buildLibraryEntry("P1", rec({ media: [{ type: "video", url: "v" }] })), null);
  });

  test("media with no url is not archived", () => {
    assert.equal(buildLibraryEntry("P1", rec({ media: [{ type: "image" }] })), null);
  });

  test("an empty or missing media list is not archived", () => {
    assert.equal(buildLibraryEntry("P1", rec({ media: [] })), null);
    assert.equal(buildLibraryEntry("P1", rec({ media: undefined })), null);
  });

  test("videos are dropped but a picture beside them survives", () => {
    const m = libraryMedia([{ type: "video", url: "v" }, IMG]);
    assert.deepEqual(m, [{ type: "image", url: IMG.url }]);
  });

  test("a missing post id is refused", () => {
    assert.equal(buildLibraryEntry("", rec()), null);
    assert.equal(buildLibraryEntry(undefined, rec()), null);
  });
});

describe("what is in the frame", () => {
  test("pid and slot are kept", () => {
    assert.deepEqual(buildLibraryEntry("P1", rec()).products,
      [{ pid: "p1", slot: "shoe" }, { pid: "p2", slot: "top" }]);
  });

  test("the same product twice in one frame is counted once", () => {
    const e = buildLibraryEntry("P1", rec({
      products: [{ pid: "p1", slot: "shoe" }, { pid: "p1", slot: "shoe" }, { pid: "p2" }],
    }));
    assert.deepEqual(e.products.map((p) => p.pid), ["p1", "p2"]);
  });

  test("a product with no pid is dropped, not archived as a blank", () => {
    assert.deepEqual(libraryProducts([{ slot: "shoe" }, { pid: "  " }, { pid: "p9" }]),
      [{ pid: "p9" }]);
  });

  test("a missing slot is omitted, not written as null", () => {
    // RTDB stores an explicit null by deleting the key, so writing one is at
    // best pointless and at worst reads as a failed lookup.
    assert.deepEqual(libraryProducts([{ pid: "p9" }]), [{ pid: "p9" }]);
    assert.equal("slot" in libraryProducts([{ pid: "p9" }])[0], false);
  });

  test("products missing entirely gives an empty list, never undefined", () => {
    assert.deepEqual(buildLibraryEntry("P1", rec({ products: undefined })).products, []);
  });
});

describe("an outfit is defined by the frame, not the label", () => {
  test("two or more products is a fit", () => {
    assert.equal(isOutfitEntry(buildLibraryEntry("P1", rec())), true);
  });

  test("a post the generator CALLED an outfit but that holds one product is not", () => {
    // A pick can fail; the kind stays 'outfit' while the frame holds one shoe.
    const e = buildLibraryEntry("P1", rec({ kind: "outfit", products: [{ pid: "p1" }] }));
    assert.equal(e.kind, "outfit");
    assert.equal(isOutfitEntry(e), false);
  });

  test("a 'single' that happens to hold two products IS a fit", () => {
    const e = buildLibraryEntry("P1", rec({ kind: "single" }));
    assert.equal(isOutfitEntry(e), true);
  });

  test("nothing is not a fit", () => {
    assert.equal(isOutfitEntry(null), false);
    assert.equal(isOutfitEntry({}), false);
  });
});

describe("what the album refuses to remember", () => {
  const e = buildLibraryEntry("P1", rec({
    status: "discarded", scheduledAt: 1, caption: "words", price: 850,
    results: { instagram: { ok: true } }, platforms: { instagram: true },
  }));

  for (const field of ["status", "scheduledAt", "caption", "price", "results", "platforms"]) {
    test(`${field} is not archived — it belongs to the queue, not the picture`, () => {
      assert.equal(field in e, false);
    });
  }

  test("a discarded post still yields a full entry", () => {
    // The whole point: throwing a post out of the queue must not burn the
    // picture that was paid for.
    assert.equal(e.postId, "P1");
    assert.equal(e.media.length, 1);
  });
});

describe("provenance is carried when present and omitted when not", () => {
  test("format, engine, style, link and cost travel", () => {
    const e = buildLibraryEntry("P1", rec({ format: "story" }));
    assert.equal(e.format, "story");
    assert.equal(e.engine, "nbpro");
    assert.equal(e.style, "house");
    assert.equal(e.link, "https://shop/x");
    assert.equal(e.costUSD, 0.1556);
  });

  test("absent provenance is omitted rather than nulled", () => {
    const e = buildLibraryEntry("P1", {
      media: [IMG], kind: "single", createdAt: 1, products: [],
    });
    for (const f of ["format", "engine", "style", "link", "costUSD"]) {
      assert.equal(f in e, false, `${f} should be omitted`);
    }
  });

  test("a non-numeric cost is omitted, not coerced to 0", () => {
    // costUSD: 0 is a real claim ("this was free"); NaN is not.
    assert.equal("costUSD" in buildLibraryEntry("P1", rec({ costUSD: NaN })), false);
    assert.equal(buildLibraryEntry("P1", rec({ costUSD: 0 })).costUSD, 0);
  });

  test("a non-numeric createdAt becomes null, not a broken sort key", () => {
    assert.equal(buildLibraryEntry("P1", rec({ createdAt: "yesterday" })).createdAt, null);
  });

  test("kind falls back to single rather than undefined", () => {
    assert.equal(buildLibraryEntry("P1", rec({ kind: undefined })).kind, "single");
  });
});

describe("a reel's poster is a photograph and belongs in the album", () => {
  // Regression: the first version kept only type:"image" and silently dropped
  // every reel — 7 of the first 53 posts, each a still that had been paid for.
  const reel = (over = {}) => rec({
    kind: "single", format: "reel",
    media: [{ path: "aiStudio/social/posts/R1/reel_x.mp4", posterUrl: "https://poster/x.jpg" }],
    ...over,
  });

  test("the poster is archived as the picture", () => {
    assert.deepEqual(buildLibraryEntry("R1", reel()).media,
      [{ type: "image", url: "https://poster/x.jpg" }]);
  });

  test("the mp4 is remembered, but not as album media", () => {
    const e = buildLibraryEntry("R1", reel());
    assert.equal(e.videoPath, "aiStudio/social/posts/R1/reel_x.mp4");
    assert.equal(e.media.every((m) => m.type === "image"), true);
  });

  test("a reel is archived like any other picture, products and all", () => {
    const e = buildLibraryEntry("R1", reel({ products: [{ pid: "p1", slot: "shoe" }, { pid: "p2" }] }));
    assert.equal(isOutfitEntry(e), true);
  });

  test("no videoPath key when there is no video", () => {
    assert.equal("videoPath" in buildLibraryEntry("P1", rec()), false);
  });

  test("a poster-less video contributes no media", () => {
    assert.deepEqual(libraryMedia([{ path: "a/b.mp4" }]), []);
  });

  test("only an .mp4 path counts as the video", () => {
    assert.equal(libraryVideoPath([{ path: "a/b.jpg" }]), null);
    assert.equal(libraryVideoPath([{ path: "a/b.MP4" }]), "a/b.MP4");
    assert.equal(libraryVideoPath(undefined), null);
  });

  test("a real image still wins over a poster when both are present", () => {
    const m = libraryMedia([{ type: "image", url: "real.jpg" }, { path: "v.mp4", posterUrl: "poster.jpg" }]);
    assert.deepEqual(m.map((x) => x.url), ["real.jpg", "poster.jpg"]);
  });
});
