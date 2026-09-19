// Pins the ONE thumbnail path convention against its other half in
// marathon-pos-app/src/shared/productPhotoPaths.js.
//
// These are LITERAL strings on purpose. Deriving them from the constants would
// pass happily after somebody renamed the format or changed the size, which is
// the one drift this file exists to catch: the POS app READS
// products/{id}/thumb_300.webp, this app WRITES it, and a mismatch is silent —
// every till shows a blank square while both apps report success.
//
// The identical assertions live in the POS repo at
// src/shared/__tests__/productPhotoPaths.test.js. Change both, or neither.
import { describe, it, expect } from "vitest";
import {
  productPhotoObjectPath,
  productPhotoThumbPath,
  PHOTO_THUMB_MAX_EDGE,
  PHOTO_THUMB_FORMAT,
  photoContentMarker,
} from "./productPhotoPaths.js";

describe("productPhotoPaths (matched pair with marathon-pos-app)", () => {
  it("derives the original path deterministically from productId", () => {
    expect(productPhotoObjectPath("p1777895684767")).toBe("products/p1777895684767/photo.jpg");
  });

  it("derives the thumbnail path deterministically from productId", () => {
    expect(productPhotoThumbPath("p1777895684767")).toBe("products/p1777895684767/thumb_300.webp");
  });

  it("pins the size and format the POS app reads", () => {
    expect(PHOTO_THUMB_MAX_EDGE).toBe(300);
    expect(PHOTO_THUMB_FORMAT).toBe("webp");
  });

  it("is deterministic — the same product always resolves to the same object", () => {
    // No timestamp, no token, no URL parsing: a re-shoot must REPLACE the
    // thumbnail in place, not add a second one the reader will never find.
    expect(productPhotoThumbPath("p1")).toBe(productPhotoThumbPath("p1"));
    expect(productPhotoThumbPath("p1")).not.toBe(productPhotoThumbPath("p2"));
  });

  it("throws rather than guessing a path for a missing id", () => {
    expect(() => productPhotoObjectPath(null)).toThrow();
    expect(() => productPhotoThumbPath(undefined)).toThrow();
    expect(() => productPhotoThumbPath("")).toThrow();
  });
});

describe("photoContentMarker (matched pair with marathon-pos-app)", () => {
  // LITERAL expectations, for the same reason the paths above are literal: a
  // marker that drifts between the two apps means one of them re-downloads a
  // catalogue it already has, or keeps showing a photo that was replaced.
  it("a stamp and a url both contribute, joined by a pipe", () => {
    expect(photoContentMarker({ photoUpdatedAt: 1757000000000, photoUrl: "https://x/y.jpg" }))
      .toBe("1757000000000|https://x/y.jpg");
  });

  it("a string stamp is kept verbatim", () => {
    expect(photoContentMarker({ photoUpdatedAt: "2026-09-19T00:00:00.000Z" }))
      .toBe("2026-09-19T00:00:00.000Z");
  });

  it("the legacy `photo` field is used only when photoUrl is absent", () => {
    expect(photoContentMarker({ photoUrl: "https://new", photo: "https://old" })).toBe("https://new");
    expect(photoContentMarker({ photo: "https://old" })).toBe("https://old");
  });

  it("no photo at all is a STABLE marker, not an empty string", () => {
    // An empty string would compare equal to a missing index entry, so a
    // product that later gains a photo could read as already current.
    expect(photoContentMarker({})).toBe("no-photo");
    expect(photoContentMarker(null)).toBe("no-photo");
  });

  it("a zero or empty stamp does not contribute", () => {
    expect(photoContentMarker({ photoUpdatedAt: 0, photoUrl: "https://x" })).toBe("https://x");
    expect(photoContentMarker({ photoUpdatedAt: "", photoUrl: "https://x" })).toBe("https://x");
  });
});
