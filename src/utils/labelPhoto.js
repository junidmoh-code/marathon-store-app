// ─── LABEL PHOTO — CLIENT-SIDE DOWNSCALE BEFORE UPLOAD ───────────────────────
// Every tongue-label photo is resized in the browser before it goes anywhere.
// This is a cost control, not a nicety: outgoing bandwidth is a live, measured
// expense on this project, and a modern phone camera produces 4–12 MB frames.
// Sending those to a Cloud Function, and then on to an OCR API, would multiply
// that by every shoe received in every shop.
//
// ── WHY 1024px AND NOT THE 800px THE PRODUCT-PHOTO PATH USES ─────────────────
// A product photo only has to look right. A LABEL photo has to stay READABLE by
// OCR: the style code is small print, often at an angle, sometimes on a curved
// tongue. 800px with the existing aggressive quality ladder (which steps down to
// 0.05 to hit 200 KB) reliably destroys it — and an unreadable photo costs a
// Vision call, a Gemini call, and a retake. So this path is deliberately
// separate from handleImageUpload: 1024px, and a quality floor that never goes
// below legibility. The result still lands around 200–400 KB.

const MAX_DIM = 1024;         // longest edge — the addendum's ceiling
const TARGET_BYTES = 400 * 1024;
const MIN_QUALITY = 0.55;     // hard floor: below this the small print smears

/** base64 payload of a data URL, without the "data:image/jpeg;base64," prefix. */
export function base64FromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return "";
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

/** dataURL → Blob, for the Storage upload. */
export function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(",");
  const mime = (head.match(/:(.*?);/) || [])[1] || "image/jpeg";
  const bin = atob(body || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Draw an already-loaded image onto a canvas at ≤ MAX_DIM and encode it,
 * stepping quality down only as far as MIN_QUALITY.
 *
 * Split out from the File/FileReader plumbing so the sizing maths is testable
 * without a DOM file input.
 *
 * @returns {{ dataUrl: string, width: number, height: number, quality: number }}
 */
export function encodeForOcr(img, { makeCanvas } = {}) {
  const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / img.height);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = makeCanvas ? makeCanvas(width, height) : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);

  // Step down from 0.92, stopping at the first size that fits — or at the
  // legibility floor, whichever comes first. Unlike the product-photo ladder we
  // do NOT keep going to 0.05: a small unreadable file is worse than a large
  // readable one here, because it costs two API calls and a retake.
  let quality = MIN_QUALITY;
  let dataUrl = canvas.toDataURL("image/jpeg", MIN_QUALITY);
  for (let q = 0.92; q >= MIN_QUALITY; q = Math.round((q - 0.06) * 100) / 100) {
    const candidate = canvas.toDataURL("image/jpeg", q);
    if (candidate.length * 0.75 <= TARGET_BYTES) { dataUrl = candidate; quality = q; break; }
  }
  return { dataUrl, width, height, quality };
}

/**
 * File (camera capture or gallery pick) → everything the intake flow needs:
 * a preview/upload dataURL and the base64 the OCR callable takes.
 *
 * @returns {Promise<{dataUrl:string, base64:string, blob:Blob, width:number, height:number}>}
 */
export function prepareLabelPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error("no file")); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read that photo"));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("that file is not an image"));
      img.onload = () => {
        try {
          const { dataUrl, width, height } = encodeForOcr(img);
          resolve({
            dataUrl,
            base64: base64FromDataUrl(dataUrl),
            blob: dataUrlToBlob(dataUrl),
            width,
            height,
          });
        } catch (err) {
          reject(err);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

export const LABEL_PHOTO_LIMITS = { MAX_DIM, TARGET_BYTES, MIN_QUALITY };
