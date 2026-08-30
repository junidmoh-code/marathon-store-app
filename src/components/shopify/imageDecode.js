// ─── DECODE WHATEVER THE PICKER GAVE US ──────────────────────────────────────
// Staff photograph stock on their phones and upload from the phone's own
// picker. An iPhone's default camera format is HEIC, and the publishing upload
// answered every one of them with "That file isn't a JPEG, PNG or WebP image."
// — a refusal the person holding the phone can do nothing about, since the
// picker gave them the only file it has.
//
// ── THE ORDER, AND WHY IT IS THAT ORDER ──────────────────────────────────────
//   1. NATIVE DECODE FIRST. Safari and iOS decode HEIC in the browser itself,
//      in C, with no download — which is the majority of the traffic this path
//      sees, because the people uploading HEIC are on Apple devices. Reaching
//      for a decoder library before asking the browser would make the common
//      case the slow one.
//   2. THE WASM DECODER ONLY WHEN THAT FAILS, and loaded only at that moment.
//      It is 2.9 MB. A static import would put it in the bundle every single
//      person downloads, to serve a case that only arises on a non-Apple
//      browser holding an Apple file. The dynamic import() is what makes vite
//      split it into its own chunk, fetched on the first HEIC that needs it
//      and cached after.
//
// ── DOWNSCALING DURING DECODE, NOT AFTER ─────────────────────────────────────
// A 12-megapixel photo is ~48 MB of RGBA once decoded, and the cheap Android
// handsets this runs on will simply kill the tab. Both paths therefore ask the
// decoder for a SMALLER image rather than decoding at full size and shrinking
// afterwards: createImageBitmap's resize options and heicTo's ImageBitmapOptions
// are the same facility, and both do the work below the JS heap.
//
// The old path also read the file through FileReader into a base64 data: URL —
// a second full copy of the file as a JS string, ~33% bigger than the file, on
// top of the decoded bitmap. Nothing here does that; the blob is handed
// straight to the decoder.
//
// NEVER a regex lookbehind in this file (or any file in src/): a parse-time
// SyntaxError blanks the whole app on Safari below 16.4.

import { readPixelSize } from "./imageSize";

// What the picker may hand over. Kept as documentation of the common cases,
// and exported for the tests — but the GATE below no longer enumerates: any
// `image/*` type is attempted (the phone's own picker already filtered to
// images), because every named list eventually meets the format it did not
// name. That is exactly what happened twice: HEIC ("isn't a JPEG, PNG or
// WebP"), then a camera-roll photo outside THIS list too — Apple keeps adding
// formats (JPEG-XL on the 16 Pro, ProRAW DNG) and each one re-created the
// refusal this file exists to remove. The one exception stays absolute: SVG
// is a document with script and fetch semantics, not a photograph.
export const ACCEPTED_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
  "image/avif", "image/gif", "image/bmp", "image/tiff",
];

// iOS hands over an EMPTY type more often than anyone would like — a file
// picked from a shared album, from Files, or from an app that did not set one.
// Rejecting on a blank type would reject exactly the phones this exists for, so
// the extension answers instead. dng (ProRAW) and jxl (JPEG-XL) are here for
// the same reason the type test went wide: they are what a current iPhone's
// camera roll actually contains.
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|heics?|heifs?|avif|gif|bmp|tiff?|dng|jxl)$/i;

/**
 * Is this something we are willing to try to decode?
 *
 * ANY `image/*` type except SVG is attempted — the decode path has its own
 * honest failure message if the browser truly cannot open it, and "we tried
 * and this device can't open it" is actionable where "that doesn't look like
 * a photo" (about a photo) is not. EITHER the type or the file name may vouch
 * for a file, and a rejection needs both to fail: pickers hand over HEICs
 * labelled `application/octet-stream` and files with no type at all
 * (CodeRabbit review, 2026-08-28).
 *
 * SVG is refused on both counts: not an accepted type, not a listed
 * extension. It is a document with script and fetch semantics, not a
 * photograph.
 */
export function isAcceptedImageFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("image/") && !type.includes("svg")) return true;
  return ACCEPTED_EXTENSIONS.test(String(file.name || ""));
}

/**
 * What the file told us about itself — for refusal messages, so the next
 * "it says it doesn't look like a photo" report arrives with the evidence
 * attached instead of needing the phone in hand.
 */
export function describePickedFile(file) {
  const type = String(file?.type || "").trim();
  const name = String(file?.name || "").trim();
  const bits = [type || "no type", name || "no name"].filter(Boolean);
  return bits.join(" — ");
}

// ─── THE RESIZE HINT — GATED ON PIXELS, NOT ON BYTES ─────────────────────────
// createImageBitmap's `resizeWidth` sets a width; it is NOT a maximum. Asking
// for 1600 on a 900-pixel graphic UPSCALES it, and everything after that works
// on invented pixels — a blurrier photo, a bigger upload, and a canvas step
// with nothing left to shrink.
//
// This used to be gated on FILE SIZE ("over 900 KB, therefore a phone photo"),
// which is a proxy that is wrong in exactly the case that matters: a
// screenshot, a scan or a PNG cutout is routinely several megabytes and only
// ~1,200 pixels wide, and every one of those was being upscaled during decode.
//
// So the gate asks the file how big the picture actually is (imageSize.js
// reads it out of the header — one slice, no decode) and hints only when the
// picture is genuinely LARGER than the ceiling.
//
// AND IT CLAMPS THE LONG SIDE. The hint is put on whichever side is longer, so
// a portrait photo comes back with its HEIGHT at maxDim rather than its width —
// the memory ceiling the hint exists for now actually holds in both
// orientations, and the caller's canvas has nothing left to do but agree.
//
// WHEN THE HEADER CANNOT BE READ — an unrecognised container, a file object
// with no slice() — the old byte heuristic is the fallback, because the
// alternative is decoding a 12-megapixel photo at full size on a handset that
// will kill the tab for it. An unknown format over this size is overwhelmingly
// a camera capture; the fallback keeps that case safe and is never reached for
// anything JPEG, PNG, WebP, GIF, BMP, TIFF or HEIC.
const RESIZE_ABOVE_BYTES = 900 * 1024;

async function resizeHint(file, maxDim) {
  const size = await readPixelSize(file);
  if (size) {
    if (Math.max(size.width, size.height) <= maxDim) return undefined;
    return size.width >= size.height
      ? { resizeWidth: maxDim, resizeQuality: "high" }
      : { resizeHeight: maxDim, resizeQuality: "high" };
  }
  if (!(file?.size > RESIZE_ABOVE_BYTES)) return undefined;
  // Unknown container, large file: a width-only hint, which preserves the
  // aspect ratio and is a memory ceiling rather than a final size. The
  // caller's canvas step clamps the longer side afterwards and never upscales.
  return { resizeWidth: maxDim, resizeQuality: "high" };
}

// The <img> path, as a last resort before the wasm decoder. An object URL,
// never a data: URL — a data: URL is the whole file re-encoded as a JS string.
function decodeViaImgElement(file) {
  return new Promise((resolve, reject) => {
    if (typeof URL?.createObjectURL !== "function") { reject(new Error("no object URLs")); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (fn, arg) => { URL.revokeObjectURL(url); fn(arg); };
    img.onload = () => done(resolve, img);
    img.onerror = () => done(reject, new Error("the browser could not decode this image"));
    img.src = url;
  });
}

/**
 * Decode a picked file into something drawable on a canvas.
 *
 * → { source, width, height, release() }
 *   `source` is an ImageBitmap or an HTMLImageElement — both are valid first
 *   arguments to drawImage, which is all the caller needs.
 *   `release()` frees the bitmap. An ImageBitmap holds its pixels OUTSIDE the
 *   JS heap, so the garbage collector will not hurry: on the phones this runs
 *   on, not closing it is the difference between one upload and three.
 *
 * Throws a sentence a person can read. Never a stack trace, never a MIME type.
 */
export async function decodeImageFile(file, maxDim = 1600) {
  const wrap = (source) => ({
    source,
    width: source.width || source.naturalWidth,
    height: source.height || source.naturalHeight,
    release: () => { try { source.close?.(); } catch { /* an <img> has no close */ } },
  });

  if (typeof createImageBitmap === "function") {
    const hint = await resizeHint(file, maxDim);
    if (hint) {
      // Resize DURING decode. Not universally supported (older Safari ignores
      // or rejects the options), so a failure here is not a failure of the
      // file — fall through and try again without the hint.
      try { return wrap(await createImageBitmap(file, hint)); } catch { /* try plain */ }
    }
    try { return wrap(await createImageBitmap(file)); } catch { /* try the <img> */ }
  }

  try { return wrap(await decodeViaImgElement(file)); } catch { /* try the wasm decoder */ }

  // ── Everything native has refused it. HEIC on a non-Apple browser. ─────────
  // The import is HERE, inside the failure branch, and nowhere else: it is
  // 2.9 MB and this is the only moment it earns its download.
  let heic;
  try {
    heic = await import("heic-to");
  } catch (e) {
    throw new Error("This phone couldn't open that photo, and the extra reader for Apple photos didn't load. Check the connection and try again.");
  }
  let looksHeic = false;
  try { looksHeic = await heic.isHeic(file); } catch { looksHeic = false; }
  if (!looksHeic) {
    // isHeic reads the file's own bytes, so this is not a guess about the
    // name or the type — the file genuinely is not one, and the decoder would
    // only fail more slowly.
    throw new Error("That file couldn't be opened as a photo. Try taking or picking it again.");
  }
  // TWO OUTPUT SHAPES, and which one is available depends on the very thing
  // that just failed. heicTo's "bitmap" mode calls createImageBitmap itself, so
  // on a browser that HAS NO createImageBitmap it cannot work — and that is
  // exactly the browser that reached this line by the second route. Asking for
  // a bitmap there would fail for a reason that has nothing to do with the
  // file, on the one path this fallback exists to serve (Codex review,
  // 2026-08-28). So: a bitmap where bitmaps exist, a JPEG blob where they do
  // not, decoded through the <img> element that already works there.
  try {
    if (typeof createImageBitmap === "function") {
      const hint = await resizeHint(file, maxDim);
      return wrap(await heic.heicTo({ blob: file, type: "bitmap", ...(hint ? { options: hint } : {}) }));
    }
    // No resize-during-decode on this branch — the blob API has no such
    // option. The canvas step still clamps; only the peak allocation is worse,
    // and this branch is a browser old enough that correctness beats peak.
    const jpeg = await heic.heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
    return wrap(await decodeViaImgElement(jpeg));
  } catch (e) {
    throw new Error("That Apple photo couldn't be opened on this device. Taking a screenshot of it, or re-saving it, usually works.");
  }
}
