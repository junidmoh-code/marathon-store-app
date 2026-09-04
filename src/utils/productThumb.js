// ─── OFFLINE-MIRROR THUMBNAIL, WRITTEN AT UPLOAD TIME ────────────────────────
//
// WHY THIS EXISTS
// The POS tills mirror product thumbnails into Cache Storage so till search
// shows pictures with no network (marathon-pos-app/src/offline/photoCache.js).
// Every thumbnail in the bucket today — 5,016 of them — was made by one
// manual run of marathon-pos-app/scripts/thumbs/generate.mjs. Nothing made one
// for a photo uploaded after that run, so every product added since shows a
// blank square on an offline till, and the gap widens with the catalogue.
//
// There is no Storage trigger in either repo and there must not be one: the
// Cloud Functions project is SHARED with marathon-pos-app, so a trigger here
// is a functions deploy that touches the POS app too. The photo is already
// resized and re-encoded in a canvas in the browser at upload time, so the
// thumbnail is a second canvas encode and a second uploadBytes on a path this
// app already has write access to (storage.rules: products/{allPaths=**}).
// The thumbnail therefore exists the instant the photo does.
//
// IT RE-DECODES THE JPEG RATHER THAN REUSING THE UPLOAD'S CANVAS
// Both call sites have a canvas in hand already, and a second toBlob() on it
// would skip a decode. It is not reused deliberately: that canvas lives inside
// two different chunks of App.jsx component code, and threading it out here
// would restructure the very upload path this change is supposed to leave
// alone — and would make this module untestable without a real canvas. So the
// already-compressed JPEG blob is re-decoded into a canvas of its own. That is
// also exactly what generate.mjs does (it starts from the uploaded photo.jpg),
// so both writers carry the same JPEG generation loss and produce comparable
// objects. The cost is one extra decode of an image already capped at 800px /
// 200 KB, once per photo upload.
//
// A REMOVED PHOTO STILL LEAVES BOTH OBJECTS BEHIND
// removePhoto() nulls photoUrl and deletes nothing from Storage — it never
// deleted photo.jpg either, so this is not new. But it is worth naming here:
// after this change, far more products have a thumbnail, so the till showing a
// picture for a product whose photo was "removed" goes from rare to ordinary.
// Fixing it means deleting BOTH objects in removePhoto, which is a change to a
// different path with its own blast radius (an accidental delete is not
// recoverable) — reported, not smuggled in here.
//
// THE PHOTO MATTERS MORE THAN THE THUMBNAIL
// writeProductThumb NEVER throws and never rejects. Every failure — an image
// that will not decode, a canvas that will not encode WebP, a Storage write
// that is refused — returns { ok:false, reason } and is logged. A product must
// never fail to save, and a re-shoot must never fail to replace the photo,
// because a derived 15 KB convenience file could not be written.
//
// SAFARI < 16.4 WRITES A PNG AND CALLS IT A WEBP
// canvas.toBlob() with an unsupported type does not fail: it silently falls
// back to image/png. Uploading that to thumb_300.webp would put a PNG several
// times the size behind a .webp name — the till would still render it, so
// nothing would look wrong while the mirror's measured byte budget quietly
// stopped holding. So the encoded blob's own type is CHECKED, and a non-WebP
// result is refused rather than uploaded. (This repo already bans regex
// lookbehind for the same fleet reason: Safari < 16.4 is still out there.)
import {
  productPhotoThumbPath,
  PHOTO_THUMB_MAX_EDGE,
} from "./productPhotoPaths.js";

// q80 — the same NUMBER scripts/thumbs/generate.mjs passes cwebp (WEBP_QUALITY
// = 80). It is deliberately not claimed to be the same encoder: canvas WebP is
// the browser's own encoder on its own quality scale, not libwebp's, so the
// two are comparable rather than identical. Measured on real catalogue photos
// (scripts/thumbs/measure-browser-vs-cwebp.mjs, headless Chromium vs cwebp on
// the same sources) before this shipped, because the mirror enforces its
// budget in BYTES: a systematically fatter browser encode would eat the
// measured 106.6 MB full-catalogue budget silently.
//
// MEASURED 2026-09-04, 12 real catalogue photos, headless Chromium running
// THIS module against cwebp on the same sources: browser 19.1 KB mean vs cwebp
// 18.4 KB mean — 1.04x, every output image/webp and exactly 300px wide. Full
// catalogue projects to ~94 MB, inside the 106.6 MB the mirror was measured
// against. Comparable, as claimed, and now on evidence rather than on the
// number matching.
export const PHOTO_THUMB_QUALITY = 0.8;
export const PHOTO_THUMB_CONTENT_TYPE = "image/webp";
// ── WHY THIS IS NOT products/{id}/photo.jpg's 7-DAY CAP ──────────────────────
// photo.jpg can afford max-age=604800 because nothing reads it by a stable
// URL: it is read through photoUrl, a TOKENISED download URL, and overwriting
// the object mints a new token, so a re-shoot changes the URL and the HTTP
// cache is bypassed. (The POS repo's photoContentMarker relies on exactly that
// property — "its token changes when the Storage object is replaced".)
//
// The thumbnail has no such escape. The mirror reads it by its DETERMINISTIC,
// token-less path — getBlob(storageRef(storage, productPhotoThumbPath(id))) —
// which is the same URL before and after a re-shoot. A week-long max-age there
// means: photo re-shot, photoUpdatedAt changes, the mirror's marker changes,
// the mirror refetches… and the browser HTTP cache hands back the PREVIOUS
// thumbnail, which then gets stored under the NEW marker as though it were
// current, for up to seven days. "The thumbnail replaces in place" would be
// true at the bucket and false at every till. (Fable, PR #553.)
//
// So: always revalidate. It costs nothing — the mirror only fetches when the
// content marker actually changed, and the response is ~15 KB — and it is the
// only value under which a re-shoot is guaranteed to reach the till.
export const PHOTO_THUMB_CACHE_CONTROL = "public, max-age=0, must-revalidate";

// Decode a Blob to an <img>. The object URL is revoked as soon as the image has
// decoded — the bitmap is already in memory by then.
async function defaultLoadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("thumbnail: source image would not decode"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function defaultMakeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new Error("thumbnail: canvas.toBlob is unavailable"));
      return;
    }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("thumbnail: canvas produced no blob"))),
      type,
      quality,
    );
  });
}

/**
 * Re-encode a product photo blob as the 300px WebP thumbnail.
 *
 * The width is pinned to PHOTO_THUMB_MAX_EDGE and the height follows the
 * source's aspect ratio — the same geometry as `cwebp -resize 300 0` in
 * scripts/thumbs/generate.mjs. It deliberately never UPSCALES: a source
 * already narrower than 300px is re-encoded at its own size rather than
 * inflated, which cwebp would do and which only wastes bytes.
 *
 * Throws on any failure, including a non-WebP encode. The caller
 * (writeProductThumb) is what turns that into a swallowed, logged no-op.
 */
export async function encodeThumbnail(sourceBlob, deps = {}) {
  const { loadImage = defaultLoadImage, makeCanvas = defaultMakeCanvas, toBlob = canvasToBlob } = deps;
  if (!sourceBlob) throw new Error("thumbnail: no source blob");

  const img = await loadImage(sourceBlob);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error("thumbnail: source image has no dimensions");

  const scale = Math.min(1, PHOTO_THUMB_MAX_EDGE / srcW);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("thumbnail: no 2d context");
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await toBlob(canvas, PHOTO_THUMB_CONTENT_TYPE, PHOTO_THUMB_QUALITY);
  // See the Safari note in the header: an unsupported type yields a PNG here,
  // not an error. Refuse it — a PNG behind a .webp name is worse than no
  // thumbnail, because nothing downstream would ever notice.
  if (!blob || blob.type !== PHOTO_THUMB_CONTENT_TYPE) {
    throw new Error(`thumbnail: browser encoded ${blob ? blob.type || "an unnamed type" : "nothing"}, not WebP`);
  }
  return blob;
}

/**
 * Write the offline-mirror thumbnail for a product. Best-effort by contract:
 * resolves { ok:false, reason } instead of throwing, whatever goes wrong.
 *
 * `upload(path, blob, metadata)` is injected so this module stays free of
 * Firebase imports and is testable without a bucket; App.jsx passes the
 * uploadBytes wrapper.
 */
export async function writeProductThumb(productId, sourceBlob, deps = {}) {
  const { upload, encode = encodeThumbnail, warn = (...a) => console.warn(...a) } = deps;
  try {
    if (!productId) return { ok: false, reason: "no product id" };
    if (!sourceBlob) return { ok: false, reason: "no source blob" };
    if (typeof upload !== "function") return { ok: false, reason: "no upload function" };

    const path = productPhotoThumbPath(productId);
    const blob = await encode(sourceBlob);
    await upload(path, blob, {
      contentType: PHOTO_THUMB_CONTENT_TYPE,
      cacheControl: PHOTO_THUMB_CACHE_CONTROL,
    });
    return { ok: true, path, bytes: blob.size ?? null };
  } catch (err) {
    // Deliberately swallowed. The photo has already uploaded (or is about to);
    // a missing thumbnail costs one blank square on an offline till until the
    // next re-shoot or the next generate.mjs run, and that is strictly better
    // than a product that would not save.
    warn("product thumbnail not written (upload continues):", err);
    return { ok: false, reason: err?.message || String(err) };
  }
}
