// ─── PRODUCT PHOTO THUMBNAIL — the ONE path convention (store-app copy) ──────
//
// ⚠ SECOND COPY OF A SHARED CONVENTION — READ BEFORE EDITING ⚠
//
// The original lives in the POS repo at:
//     marathon-pos-app/src/shared/productPhotoPaths.js
// and its own header says there must never be a second implementation of
// "where does the thumbnail live". This file is that second implementation,
// and it exists only because the two apps are separate repos with separate
// bundles — marathon-store-app cannot import from marathon-pos-app.
//
// The two sides are a matched pair:
//   • marathon-pos-app  READS  products/{id}/thumb_300.webp  (src/offline/photoCache.js)
//     and WRITES it in bulk    (scripts/thumbs/generate.mjs, run by hand)
//   • marathon-store-app WRITES it at upload time (src/utils/productThumb.js,
//     called from the two photo-upload call sites in src/App.jsx)
//
// If the path here ever drifts from the path there, NOTHING BREAKS LOUDLY:
// the store app cheerfully writes thumbnails to a path the till never reads,
// and every till search shows a blank square while both apps report success.
// That is exactly how the mirror once read /stock/pe and silently returned
// zero rows — healthy-looking, and wrong. So:
//
//   1. productPhotoPaths.test.js pins the exact literal strings on this side;
//      src/shared/__tests__/productPhotoPaths.test.js pins them on the other.
//      Both must be changed together, in two PRs, or not at all.
//   2. A change here that is not mirrored there is a bug even if every test
//      in this repo passes.
//
// photoContentMarker() is deliberately NOT copied: it belongs to the READ
// side (cache invalidation), which only the POS app does. Copying read-side
// logic no writer uses would be a third thing to keep in sync for no benefit.
//
// Pure, no I/O, no Firebase imports.

export const PHOTO_THUMB_MAX_EDGE = 300;
export const PHOTO_THUMB_FORMAT = "webp";

/** The full-size original object path for a product. */
export function productPhotoObjectPath(productId) {
  if (!productId) throw new Error("productPhotoObjectPath: productId is required");
  return `products/${productId}/photo.jpg`;
}

/** The deterministic thumbnail object path for a product. */
export function productPhotoThumbPath(productId) {
  if (!productId) throw new Error("productPhotoThumbPath: productId is required");
  return `products/${productId}/thumb_${PHOTO_THUMB_MAX_EDGE}.${PHOTO_THUMB_FORMAT}`;
}
