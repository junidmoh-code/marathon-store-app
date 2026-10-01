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
// cache in BYTES: a systematically fatter browser encode would eat the
// mirror's budget silently.
//
// MEASURED 2026-09-04, 12 real catalogue photos, headless Chromium running THIS
// module against cwebp on the same sources: browser 19.1 KB mean vs cwebp
// 18.4 KB mean — a RATIO of 1.04x, every output image/webp and exactly 300px
// wide. The ratio is the finding; this sample's own mean is NOT, and must not
// be projected as one. The whole set is already measured on the other side:
// 5,016 objects, 106.6 MB (POS photoCache.js), i.e. 21.3 KB mean — 14% above
// this sample. A catalogue of browser-written thumbnails therefore projects to
// 1.04 x 106.6 = ~111 MB, against PHOTO_CACHE_BYTE_BUDGET = 160 MB.
// Comfortably inside the BUDGET, and deliberately not described as inside
// 106.6 MB, which is a measurement of the existing set and not a ceiling —
// reading it as one is how a catalogue ends up permanently over budget,
// self-evicting.
//
// Measured in Chromium, which is what the script can drive. The uploading
// fleet is iPad Safari and its ratio is UNMEASURED. Both are libwebp
// underneath, so the difference is the resampler and the encoder settings
// rather than a different codec: comparable, not identical, and the Safari
// number is a gap in the evidence rather than a claim.
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
// content marker actually changed, the response is ~15-30 KB, and an unchanged
// object revalidates as a 304 — and it is the only value under which the HTTP
// cache cannot WITHHOLD a re-shoot. Not "guaranteed to reach the till": that
// also needs the write itself to have landed, which is what the single retry
// below is for, and a write that fails twice still leaves the previous
// thumbnail standing under an advanced marker.
//
// Verified live 2026-09-04: Firebase honours cacheControl on the ?alt=media
// path (photo.jpg serves max-age=604800), the bulk-written thumbnails carry
// Firebase's own default of private, max-age=0, and a conditional GET on one
// returns 304. The 7-day value was the outlier here, not this one.
export const PHOTO_THUMB_CACHE_CONTROL = "public, max-age=0, must-revalidate";

// Long enough for a flapping connection to come back, short enough that nobody
// watching a product save notices it.
export const RETRY_DELAY_MS = 800;
const defaultPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * PHOTO_THUMB_MAX_EDGE IS A MISNOMER, AND IT IS THE POS REPO'S NAME.
 * The HEIGHT IS NOT BOUNDED by 300. `cwebp -resize 300 0` sets the width and
 * lets the height fall out of the aspect ratio, so every one of the 5,016
 * thumbnails already in the bucket is 300 wide and whatever tall — the
 * catalogue's portrait 600x800 photos are 300x400 objects, not 225x300. This
 * copies that exactly, on purpose. "Fixing" the name by scaling to the longest
 * edge would make this writer disagree with the bulk writer about what a
 * thumbnail IS, silently, for every product photographed in portrait — the
 * same class of drift the path convention exists to prevent — and it would
 * invalidate the mirror's measured byte budget, which came from real cwebp
 * output that already has this shape. The constant keeps its name so both
 * repos keep saying the same word for the same thing. (Adversarial review.)
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
  const { upload, remove, encode = encodeThumbnail, warn = (...a) => console.warn(...a), pause = defaultPause } = deps;
  let path = null;
  try {
    if (!productId) return { ok: false, reason: "no product id" };
    if (!sourceBlob) return { ok: false, reason: "no source blob" };
    if (typeof upload !== "function") return { ok: false, reason: "no upload function" };

    path = productPhotoThumbPath(productId);
    const blob = await encode(sourceBlob);
    const metadata = {
      contentType: PHOTO_THUMB_CONTENT_TYPE,
      cacheControl: PHOTO_THUMB_CACHE_CONTROL,
    };
    // ── ONE RETRY, ON THE WRITE AND ONLY ON THE WRITE ───────────────────────
    // A dropped write is not symmetrical with a missing one. Both call sites
    // stamp photoUpdatedAt straight after this returns, and that stamp IS the
    // mirror's content marker: once it advances, every till records "I have the
    // current thumbnail for this product". So a RE-SHOOT whose thumbnail write
    // failed leaves the PREVIOUS picture in the bucket, marked current, and
    // nothing ever revisits it — where a never-written thumbnail is kinder,
    // because the till records it missing and retries every 6 hours. The write
    // is also the leg that fails TRANSIENTLY (a phone that lost signal for a
    // second mid-save), so it gets one more go. The ENCODE is not retried: it
    // fails deterministically — no WebP encoder, an image that will not decode
    // — and a second attempt would only spend the operator's time failing
    // identically. (Adversarial review, PR #553.)
    try {
      await upload(path, blob, metadata);
    } catch (firstErr) {
      warn("product thumbnail write failed, retrying once:", firstErr);
      await pause(RETRY_DELAY_MS);
      await upload(path, blob, metadata);
    }
    return { ok: true, path, bytes: blob.size ?? null };
  } catch (err) {
    // Deliberately swallowed. The photo has already uploaded (or is about to);
    // a missing thumbnail costs one blank square on an offline till until the
    // next re-shoot or the next generate.mjs run, and that is strictly better
    // than a product that would not save.
    warn("product thumbnail not written (upload continues):", err);

    // ── A STALE THUMBNAIL IS WORSE THAN NO THUMBNAIL ────────────────────────
    // Both call sites stamp photoUpdatedAt after this returns, whatever
    // happened here — and they must: photoUpdatedAt is the upload time, and a
    // photo WAS uploaded. But that stamp is also the mirror's content marker,
    // so on a re-shoot whose thumbnail write failed for good, the PREVIOUS
    // photo's thumbnail sits at the deterministic path recorded as current.
    // Every till then shows a picture of the product's OLD photo — silently,
    // and for ever, because a marker the till believes is current is never
    // revisited. A MISSING thumbnail has recovery: the till records it missing
    // and retries every 6 hours, and generate.mjs regenerates it (it keys on
    // photo.jpg's generation, which has changed).
    //
    // So a terminal failure DELETES the object it could not replace, turning
    // "silently wrong for ever" into "blank until repaired". There is no case
    // where the standing thumbnail is still right: reaching here means the
    // photo itself was replaced. Best-effort in its own right — a delete that
    // fails changes nothing and must not throw either. (CodeRabbit, PR #553,
    // and the same hole two other reviewers raised.)
    let staleRemoved = false;
    if (path && typeof remove === "function") {
      try {
        await remove(path);
        staleRemoved = true;
      } catch (removeErr) {
        // Includes the ordinary case of there never having been one (a brand
        // new product): storage/object-not-found, nothing to repair.
        warn("stale thumbnail could not be removed:", removeErr);
      }
    }
    return { ok: false, reason: err?.message || String(err), staleRemoved };
  }
}

/**
 * Write the thumbnail for an APPROVED AI photo proposal.
 *
 * WHY THIS IS NOT JUST writeProductThumb WITH A FETCH IN FRONT OF IT
 * Approving a proposal points products/{id}/photoUrl at
 * products/{id}/photo_proposal_{token}.jpg and leaves products/{id}/photo.jpg
 * standing — the original is kept, not overwritten. But the offline thumbnail
 * has exactly ONE path per product, and every one in the bucket was generated
 * from photo.jpg. So an approval used to leave the shop showing the clean
 * white-background photo online and every till showing the ORIGINAL, with
 * nothing to ever correct it: a thumbnail is only revisited when photo.jpg
 * changes, and an approval does not change photo.jpg. Measured 2026-09-04:
 * 522 live products in exactly that state.
 *
 * THE DOWNLOAD FAILING IS NOT THE SAME AS THE WRITE FAILING, and this is the
 * whole reason the download is not just injected into writeProductThumb.
 * writeProductThumb's terminal-failure leg DELETES the thumbnail it could not
 * replace — right when a photo has genuinely been replaced, because the
 * standing file is then provably wrong and blank-and-repairable beats
 * wrong-and-silent. But if we could not even READ the new photo, nothing about
 * the bucket has changed: the product still has a thumbnail of its original
 * photo, which is no more wrong than it was a second ago. Destroying it would
 * turn a failed download into a blank square on every till. So a download
 * failure returns early and touches nothing.
 *
 * Best-effort by contract, like every other thumbnail write: it never throws.
 * An approval is the operator's decision about which photo the shop shows, and
 * a derived ~15 KB file must never be able to refuse it.
 */
export async function writeApprovedThumbFromUrl(productId, proposedUrl, deps = {}) {
  const { download, upload, remove, warn = (...a) => console.warn(...a), write = writeProductThumb } = deps;
  if (!productId) return { ok: false, reason: "no product id" };
  if (!proposedUrl) return { ok: false, reason: "no proposal url" };
  if (typeof download !== "function") return { ok: false, reason: "no download function" };

  let blob;
  try {
    blob = await download(proposedUrl);
  } catch (err) {
    warn("approved proposal thumbnail: could not download the proposal:", err);
    return { ok: false, reason: err?.message || String(err), downloadFailed: true };
  }
  if (!blob) return { ok: false, reason: "proposal download produced no blob", downloadFailed: true };
  return write(productId, blob, { upload, remove });
}
