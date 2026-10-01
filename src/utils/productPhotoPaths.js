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
// Both sides now READ and WRITE:
//   • marathon-pos-app  READS  products/{id}/thumb_300.webp  (src/offline/photoCache.js)
//     and WRITES it in bulk    (scripts/thumbs/generate.mjs, run by hand)
//   • marathon-store-app WRITES it at upload time (src/utils/productThumb.js,
//     called from the two photo-upload call sites in src/App.jsx)
//     and READS it into its own photo mirror (src/offline/photoCache.js)
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
// photoContentMarker() USED to be deliberately absent here, on the grounds that
// cache invalidation belonged to the read side and only the POS app read. That
// stopped being true when this app grew a photo mirror of its own, so it is
// copied now — and it is a THIRD thing to keep in sync, which is why
// productPhotoPaths.test.js pins its answers literally on both sides.
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

/**
 * A string that changes whenever a product's PHOTO changes, and not otherwise.
 *
 * A cached thumbnail is only stale when the photo behind it moved, so this is
 * what a photo mirror compares against to decide whether to re-fetch. Getting
 * it wrong in one direction re-downloads the catalogue for nothing; in the
 * other, a re-shot product keeps showing the picture it had last month.
 *
 * `photoUpdatedAt` alone is not enough — older records do not carry it — so the
 * url is included too. `photo` is the legacy field some older records still
 * use; the precedence picks exactly ONE url, and the stamp never shadows it.
 *
 * A product with no photo at all gets a stable marker rather than an empty
 * string, so "no photo yet" is a state the index can hold rather than a value
 * that compares equal to everything.
 */
export function photoContentMarker(product) {
  const parts = [];
  const stamp = product?.photoUpdatedAt;
  if (typeof stamp === "number" && stamp > 0) parts.push(String(stamp));
  else if (typeof stamp === "string" && stamp) parts.push(stamp);

  if (typeof product?.photoUrl === "string" && product.photoUrl) parts.push(product.photoUrl);
  else if (typeof product?.photo === "string" && product.photo) parts.push(product.photo);

  return parts.length ? parts.join("|") : "no-photo";
}
