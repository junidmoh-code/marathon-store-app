// ─── SHOPIFY PUBLISHING — DEVICE PHOTO UPLOAD ────────────────────────────────
// Turns a picked file into a publishing photo: validate → compress → upload
// to the product's DEDICATED publishing folder in Storage → hand back the
// public download URL for /shopify_publish/{pid}/photos.
//
// Storage path: products/{pid}/shopify/{id}.jpg — keyed by product id, inside
// the existing `products/**` Storage rule (public read — Shopify fetches the
// URL — and authed-staff write), so NO console Storage rule change is needed,
// and the host passes the media.mjs allowlist at push time. Filenames are
// generated ids, never user text — a brand word in a filename would trip the
// compliance validator's URL-path check.
//
// Nothing here ever deletes or overwrites: every upload is a new timestamped
// object, and generated images record the URL they derived from in
// customMetadata (the original always survives beside them).
//
// The compress pipeline is the app's existing scale-then-step-quality-down
// one (compressImageFile in App.jsx, Style Kit sizing: 1600px / 800 KB —
// listing photos carry more detail than in-app thumbs). Duplicated here
// because App.jsx doesn't export it and importing the monolith would pull the
// whole app into this module.
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // pre-compression ceiling — phone originals fit, junk doesn't

// Why a picked file can't become a publishing photo, or null when it can.
export function uploadFileProblem(file) {
  if (!file) return "No file picked.";
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return "That file isn't a JPEG, PNG or WebP image.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "That image is over 12 MB — export a smaller copy and try again.";
  }
  return null;
}

function dataURLToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/data:(.*?);/)[1];
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function compressImageFile(file, maxDim = 1600, maxBytes = 800 * 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't an image."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / img.width, maxDim / img.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        let dataUrl = canvas.toDataURL("image/jpeg", 0.05); // worst-case fallback
        for (let q = 0.85; q > 0.05; q = Math.round((q - 0.05) * 100) / 100) {
          const candidate = canvas.toDataURL("image/jpeg", q);
          if (candidate.length * 0.75 <= maxBytes) { dataUrl = candidate; break; }
        }
        resolve(dataURLToBlob(dataUrl));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Upload a JPEG blob as a publishing photo for this product and return its
 * public URL. `kind` prefixes the object name ("upload" | "gen");
 * `derivedFrom` records the source URL of a generated image in metadata.
 * Immutable cache headers — every object is write-once by construction.
 */
export async function uploadPublishPhoto(productId, blob, { kind = "upload", derivedFrom = null } = {}) {
  const id = `${kind}_${serverNowMs()}_${Math.random().toString(36).slice(2, 7)}`;
  const sRef = storageRef(storage, `products/${productId}/shopify/${id}.jpg`);
  await uploadBytes(sRef, blob, {
    contentType: "image/jpeg",
    cacheControl: "public, max-age=31536000, immutable",
    ...(derivedFrom ? { customMetadata: { derivedFrom } } : {}),
  });
  return getDownloadURL(sRef);
}
