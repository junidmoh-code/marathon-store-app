// ─── PRODUCT PHOTO ENCODE — the ONE scale-then-step-quality-down pipeline ────
// Extracted from App.jsx (guided product photos, 2026-10-02). The Add Product
// form's handleImageUpload and the promisified compressImageFile each carried
// their own copy of the same loop; the guided-photo work needed it a THIRD
// time (the high-resolution source copy for the AI pipeline), which is the
// point at which a copy stops being a convenience and starts being a drift
// risk. The loop itself is unchanged, byte for byte in what it produces:
//
//   • scale so the LONG side is ≤ maxDim (never upscale)
//   • step JPEG quality down from 0.85 in 0.05 steps until the base64 length
//     × 0.75 (≈ the real byte count) fits maxBytes; 0.05 as the worst case
//
// TWO OUTPUTS for a new product's photo, from ONE decode:
//   • the APP copy  — 800px / 200 KB, exactly as before. photo.jpg, the
//     offline thumbnail, dominant colours, every screen: nothing downstream
//     sees a different picture than it did yesterday.
//   • the SOURCE copy — long edge ≤ 2400px, fixed q 0.9, no byte budget. This
//     is for the AI Studio pipeline only (products/{id}/source_photo.jpg): an
//     800px phone shot is too small to re-light and re-place a shoe without
//     the model inventing the stitching. It never replaces the app copy.
//
// Browser-only (canvas, FileReader, Image) but Firebase-free, so the pure parts
// (scaledSize, stepDownJpegDataUrl, dataURLToBlob) are unit-tested with fakes.

export const APP_PHOTO_MAX_DIM = 800;
export const APP_PHOTO_MAX_BYTES = 200 * 1024; // 200 KB target
export const SOURCE_PHOTO_MAX_DIM = 2400;
export const SOURCE_PHOTO_QUALITY = 0.9;

export function dataURLToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** Target pixel size for a source of w×h with its long side capped at maxDim. Never upscales. */
export function scaledSize(width, height, maxDim) {
  const scale = Math.min(1, maxDim / width, maxDim / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Draw any drawable (img, video, canvas) into a fresh canvas capped at maxDim. */
export function drawScaled(source, width, height, maxDim) {
  const size = scaledSize(width, height, maxDim);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Step quality from 0.85 down to 0.05 in 0.05 increments.
 * dataUrl length * 0.75 ≈ actual byte count (base64 overhead is 4/3).
 * Stop as soon as the image fits in maxBytes.
 */
export function stepDownJpegDataUrl(canvas, maxBytes) {
  let dataUrl = canvas.toDataURL("image/jpeg", 0.05); // worst-case fallback
  for (let q = 0.85; q > 0.05; q = Math.round((q - 0.05) * 100) / 100) {
    const candidate = canvas.toDataURL("image/jpeg", q);
    if (candidate.length * 0.75 <= maxBytes) { dataUrl = candidate; break; }
  }
  return dataUrl;
}

/** Read a File/Blob into a decoded <img> — the FileReader → data: URL → Image path the form always used. */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't an image."));
      img.onload = () => resolve(img);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/** maxDim / maxBytes JPEG from an already-decoded drawable → { dataUrl, blob }. */
export function encodeCompressed(source, width, height, maxDim, maxBytes) {
  const dataUrl = stepDownJpegDataUrl(drawScaled(source, width, height, maxDim), maxBytes);
  return { dataUrl, blob: dataURLToBlob(dataUrl) };
}

/** The high-resolution AI-pipeline copy: long edge ≤ 2400px, JPEG q 0.9. */
export function encodeSource(source, width, height) {
  const canvas = drawScaled(source, width, height, SOURCE_PHOTO_MAX_DIM);
  return dataURLToBlob(canvas.toDataURL("image/jpeg", SOURCE_PHOTO_QUALITY));
}

/**
 * A new product's photo, from a File/Blob (picked from photos OR shot by the
 * guided camera — both arrive here as a Blob, so there is one path):
 *   { photoUrl, photoBlob }  — the app copy, 800px / 200 KB, as before
 *   photoSourceBlob          — the ≤2400px q0.9 copy for the AI pipeline
 */
export async function prepareProductPhoto(file) {
  const img = await loadImageFile(file);
  const app = encodeCompressed(img, img.width, img.height, APP_PHOTO_MAX_DIM, APP_PHOTO_MAX_BYTES);
  return { photoUrl: app.dataUrl, photoBlob: app.blob, photoSourceBlob: encodeSource(img, img.width, img.height) };
}

/**
 * A shoe box photo for the new-product form: the ≤2400px q0.9 copy that is
 * uploaded (boxBlob) plus a small preview data URL for the form's thumbnail —
 * a 2400px data URL in React state just to draw a 72px square would be waste.
 */
export async function prepareBoxPhoto(file) {
  const img = await loadImageFile(file);
  const preview = encodeCompressed(img, img.width, img.height, 240, 40 * 1024);
  return { boxBlob: encodeSource(img, img.width, img.height), boxPreviewUrl: preview.dataUrl };
}
