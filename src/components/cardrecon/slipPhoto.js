// ─── A PICKED FILE → A SENDABLE SLIP PHOTO ───────────────────────────────────
// Shared by the manager's capture screen (CardReconScreen) and the one-till
// slip screen (CardSlipScreen), so a slip photo is decoded, downscaled and
// size-checked exactly one way whichever screen took it.

import { decodeImageFile, isAcceptedImageFile, describePickedFile } from "../shopify/imageDecode";
import { planPhotoIntake, payloadRefusal } from "./photoIntake";
import { describeDecodeError } from "./captureFailure";

// Slip photos need legible 8pt thermal print, so the downscale budget is wider
// than the label reader's 1024px. ~2000px keeps a full receipt column sharp and
// a JPEG comfortably under the callable's per-photo ceiling.
const MAX_PHOTO_DIM = 2000;

/**
 * A picked file → a ~2000px JPEG, whatever the phone handed over.
 *
 * DECODING GOES THROUGH THE SHARED DECODER, not FileReader + `new Image()`: an
 * iPhone's library stores HEIC and `new Image()` cannot decode it outside
 * Safari, so the naive path fails on exactly the phones this exists for.
 * decodeImageFile falls back to a lazily-imported wasm decoder and resizes
 * DURING decode where the browser supports it — on a phone, the difference
 * between one upload and three. The resize is gated on the picture's own
 * PIXELS, so a heavy but modest-resolution file is never upscaled on the way in.
 */
export async function downscalePhoto(file) {
  const decoded = await decodeImageFile(file, MAX_PHOTO_DIM);
  try {
    const { source, width, height } = decoded;
    // decodeImageFile may already have resized during decode; scale from what
    // it actually returned rather than assuming it did or did not.
    const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.88);
    return { base64: jpeg.split(",")[1] || "" };
  } finally {
    // An ImageBitmap holds its pixels outside the JS heap; the collector is in
    // no hurry, and this runs on cheap handsets.
    decoded.release();
  }
}

/**
 * A picked file list → `{ photo }` ready to send, or `{ refusal }`: a sentence
 * saying why not. The decision about what is usable stays in the tested pure
 * module, cap 1: a non-photo is refused BY NAME rather than as "that doesn't
 * look like a photo" about a photo.
 */
export async function preparePhoto(files) {
  const { take, refusal } = planPhotoIntake({
    current: [], files, cap: 1, replace: true,
    isImage: isAcceptedImageFile, describe: describePickedFile,
  });
  if (refusal) return { refusal };
  let photo;
  try {
    photo = await downscalePhoto(take[0]);
  } catch (err) {
    // The decoder writes its own sentences for a person — an unsupported or
    // Apple-format photo is named as such rather than parenthesised into a
    // raw message. See captureFailure.js.
    const failure = describeDecodeError(err);
    console.error(failure.logLine, err);
    return { refusal: failure.message };
  }
  // Refused HERE rather than as a transport error nobody can read.
  const tooBig = payloadRefusal([photo]);
  return tooBig ? { refusal: tooBig } : { photo };
}
