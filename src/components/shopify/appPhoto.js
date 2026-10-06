// ─── THE PRIMARY PHOTO IS THE APP PHOTO (Junid, 26 Sep 2026) ─────────────────
// "A photo changed in Shopify Publishing must also become the product's photo
// in the normal app." So when an edit in Shopify Publishing CHANGES the
// primary (position 0) — Make primary, a new first photo, AI Studio's "Use
// instead of this one" on the primary — /products/{pid}/photoUrl follows, and
// the till thumbnail is rebuilt from it. Extra photos and every video are
// Shopify-only and never touch the app photo.
//
// The write is exactly the one the two existing "a new photo becomes the
// product's photo" paths make (AI Studio approve in App.jsx, the New Arrivals
// chain): photoUrl ← the new photo; photoUrlOriginal ← the staff photo it
// replaces, kept once and never overwritten by a later swap unless the
// product is showing a staff photo again. Child keys only (update, never set),
// so nothing else on the record — styleCodeNormalised above all, which the
// rules make immutable — is ever rewritten.
import { ref, update } from "firebase/database";
import { ref as storageRef, getBlob, uploadBytes, deleteObject } from "firebase/storage";
import { database, storage } from "../../firebase";
import { writeApprovedThumbFromUrl } from "../../utils/productThumb";
import { storagePathOf } from "./publishShared";

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Is this URL the product's own staff photo (products/{pid}/photo.jpg)? */
export function isStaffPhoto(pid, url) {
  return !!pid && storagePathOf(url) === `products/${pid}/photo.jpg`;
}

/**
 * The /products/{pid} child patch for a primary that changed from
 * `oldPrimary` to `newPrimary`, or null when the app photo must not move:
 * the primary did not change, or the app already shows the new one.
 */
export function appPhotoPatch(pid, product, oldPrimary, newPrimary) {
  if (!PID_RE.test(String(pid ?? ""))) return null;
  if (!newPrimary || newPrimary === oldPrimary) return null;
  if (product?.photoUrl === newPrimary) return null;
  const patch = { photoUrl: newPrimary };
  const current = product?.photoUrl || null;
  // Keep the STAFF photo being replaced (photo.jpg) — the AI Studio approve
  // rule. A publishing or generated photo is never recorded as the original.
  if (current && isStaffPhoto(pid, current) && current !== newPrimary) patch.photoUrlOriginal = current;
  return patch;
}

const uploadThumbObject = (path, blob, metadata) => uploadBytes(storageRef(storage, path), blob, metadata);
const removeThumbObject = (path) => deleteObject(storageRef(storage, path));

/**
 * Make the app photo follow a changed primary. → { ok, changed, thumb? }.
 * Never throws: the media list is already saved, and a failure here is shown
 * as a sentence, never as a lost edit.
 */
export async function syncAppPhoto(pid, product, oldPrimary, newPrimary) {
  const patch = appPhotoPatch(pid, product, oldPrimary, newPrimary);
  if (!patch) return { ok: true, changed: false };
  try {
    await update(ref(database, `products/${pid}`), patch);
  } catch (e) {
    return { ok: false, changed: false, message: `The Shopify photos are saved, but the app photo could not be changed (${String(e?.message || e)}).` };
  }
  // The till thumbnail, by the same helper the AI Studio approve uses —
  // best-effort by its own contract.
  const thumb = await writeApprovedThumbFromUrl(pid, newPrimary, {
    download: (url) => getBlob(storageRef(storage, url)),
    upload: uploadThumbObject,
    remove: removeThumbObject,
  });
  return { ok: true, changed: true, thumb: !!thumb?.ok };
}
