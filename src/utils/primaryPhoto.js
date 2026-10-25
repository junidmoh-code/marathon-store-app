// ─── ONE PRIMARY PHOTO PER PRODUCT (Junid, 25 Oct 2026) ──────────────────────
// "One primary photo per product … Make them all read one field, the primary
// photo, with resized thumbnails for list screens … Old photos go to history."
//
// THE FIELD IS /products/{pid}/photoUrl. It already was the app photo almost
// everywhere (store app, POS readPhotoUrl, Jimmy's swap lines), and since #760
// the Shopify publisher's primary follows it — so it stays the one field, and
// this module is the one reading of it:
//
//   primaryPhotoUrl(p)      the full-size primary (photoUrl, else the legacy
//                           `photo` when it is a real image URL)
//   primaryThumbUrl(p, id)  the 300px till thumbnail of THAT photo, for list
//                           and grid screens — or null when there is none that
//                           is provably of this photo (see below)
//
// THE THUMBNAIL IS PROVABLY THIS PHOTO ONLY IN THE PRODUCT'S OWN FOLDER.
// products/{pid}/thumb_300.webp is rebuilt by every writer that moves photoUrl
// (setPrimaryPhoto below, primaryPhotoCore, the AI Studio approve, the New
// Arrivals chain). A photoUrl that lives under ANOTHER product's folder (a
// twin that copied it) is not this product's to vouch for — the owner of that
// folder may have re-shot since — so such a product gets no thumbnail URL and
// its list screens show the full photo, never a stranger's thumbnail.
//
// HISTORY. Every change of the primary records the photo it replaced at
// /products/{pid}/photoHistory/{epoch ms} = { url, at, by, source, replacedWith }.
// Keys are epoch milliseconds (never ISO text — see #269). Nothing here, or in
// any writer, deletes a photo object: a history entry is a pointer to a file
// that stays in Storage, so any swap can be undone (undoPhotoPatch).
//
// Pure: no Firebase import — the browser, the functions and the Mac mini
// scripts all run this exact code.
import { productPhotoThumbPath, photoContentMarker } from "./productPhotoPaths.js";

export const STORAGE_BUCKET = "marathon-club.firebasestorage.app";
export const PHOTO_HISTORY_KEY = "photoHistory";
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isImageUrl = (v) => typeof v === "string" && /^(https?:|data:image\/)/.test(v);

/** The full-size primary photo URL, or null. */
export function primaryPhotoUrl(p) {
  if (!p || typeof p !== "object") return null;
  if (typeof p.photoUrl === "string" && p.photoUrl) return p.photoUrl;
  return isImageUrl(p.photo) ? p.photo : null;
}

/** The Storage object path inside a Firebase download URL (any bucket), or null. */
export function storagePathOfUrl(url) {
  try {
    const m = /\/o\/([^?]+)/.exec(new URL(String(url)).pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/** A public object URL in the product bucket (products/** is public-read). */
export function storageObjectUrl(path) {
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}

// A short, stable tag of the photo marker, so a re-shot product's thumbnail
// URL changes and no CDN or browser cache can answer with the old picture.
function tag(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** The thumbnail URL for list screens, or null (see the header). */
export function primaryThumbUrl(p, productId = p?.id) {
  const url = primaryPhotoUrl(p);
  if (!url || !PID_RE.test(String(productId ?? ""))) return null;
  const path = storagePathOfUrl(url);
  if (!path || !path.startsWith(`products/${productId}/`)) return null;
  return `${storageObjectUrl(productPhotoThumbPath(productId))}&v=${tag(photoContentMarker(p))}`;
}

/** History entries, newest first: [{ key, url, at, by, source, replacedWith, undoneAt }]. */
export function photoHistoryEntries(p) {
  const h = p?.[PHOTO_HISTORY_KEY];
  if (!h || typeof h !== "object") return [];
  return Object.entries(h)
    .filter(([k, v]) => /^\d+$/.test(k) && v && typeof v === "object")
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => Number(b.key) - Number(a.key));
}

/**
 * The /products/{pid} child-key patch that makes `newUrl` the primary photo
 * (null = remove it), recording the replaced photo in history. null when
 * nothing would change.
 *   at        serverNowMs — the history key and photoSource stamp (required)
 *   by        who: a uid, an email, or "script:<name>"
 *   source    "edit" | "ai_studio" | "shopify_publish" | "shopify_backfill" | "new_arrivals" | "undo" | …
 *   archived  the URL the replaced photo can be found at from now on, when
 *             the caller moved it before overwriting its object (a re-shoot
 *             over photo.jpg); defaults to the current URL
 *   extra     more child keys written in the same update (photoUpdatedAt …)
 */
export function primaryPhotoPatch(pid, product, newUrl, { at, by = null, source, archived = null, extra = {} } = {}) {
  if (!PID_RE.test(String(pid ?? ""))) return null;
  if (!(Number.isFinite(at) && at > 0)) return null;
  const next = typeof newUrl === "string" && newUrl ? newUrl : null;
  const current = primaryPhotoUrl(product);
  if (next === current && !archived) return null;
  const patch = { photoUrl: next, photoSource: { from: String(source || "edit"), at }, ...extra };
  const was = archived || current;
  if (was) {
    patch[`${PHOTO_HISTORY_KEY}/${at}`] = {
      url: was, at, by: by ?? null, source: String(source || "edit"), replacedWith: next,
    };
  }
  return patch;
}

/** The entry an undo restores: the newest not-yet-undone photo that differs from the current one. */
export function undoTarget(product) {
  const current = primaryPhotoUrl(product);
  return photoHistoryEntries(product).find((e) => !e.undoneAt && isImageUrl(e.url) && e.url !== current) || null;
}

/**
 * Undo: the previous photo is the primary again; the photo it replaces goes
 * to history like any other swap (so an undo can itself be undone), and the
 * entry restored is marked undoneAt. null when there is nothing to undo.
 */
export function undoPhotoPatch(pid, product, { at, by = null } = {}) {
  const target = undoTarget(product);
  if (!target) return null;
  const patch = primaryPhotoPatch(pid, product, target.url, { at, by, source: "undo" });
  if (!patch) return null;
  // Same millisecond as the entry restored is impossible in practice; never
  // let the new history key overwrite the entry being marked.
  if (String(at) === target.key) return null;
  patch[`${PHOTO_HISTORY_KEY}/${target.key}/undoneAt`] = at;
  return { patch, restored: target };
}
