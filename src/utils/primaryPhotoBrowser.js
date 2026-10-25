// ─── setPrimaryPhoto's browser legs ──────────────────────────────────────────
// The rule is setPrimaryPhoto.js (pure, shared with the Mac mini scripts).
// This binds it to the app's Firebase SDK. The /products write is child keys
// only (update, never set), so styleCodeNormalised — immutable under the rules
// — is never rewritten. The live rules let any signed-in staff account write
// /products children and products/** in Storage, so no callable is needed.
import { ref, update, get } from "firebase/database";
import { ref as storageRef, getBlob, getMetadata, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage } from "../firebase";
import { writeApprovedThumbFromUrl } from "./productThumb";
import { productPhotoThumbPath } from "./productPhotoPaths";
import { serverNowMs } from "./serverTime";
import { storagePathOfUrl, PHOTO_HISTORY_KEY } from "./primaryPhoto";
import { setPrimaryPhoto, undoPrimaryPhoto } from "./setPrimaryPhoto";

const uploadThumbObject = (path, blob, metadata) => uploadBytes(storageRef(storage, path), blob, metadata);
const removeThumbObject = (path) => deleteObject(storageRef(storage, path));

export const browserSetPrimaryDeps = {
  now: serverNowMs,
  // Three child reads — never the whole record.
  readProduct: async (pid) => {
    const [photoUrl, photo, photoHistory] = await Promise.all(["photoUrl", "photo", PHOTO_HISTORY_KEY]
      .map((k) => get(ref(database, `products/${pid}/${k}`)).then((s) => s.val())));
    return { photoUrl, photo, photoHistory };
  },
  md5Of: async (url) => {
    const path = storagePathOfUrl(url);
    return path ? (await getMetadata(storageRef(storage, path)))?.md5Hash || null : null;
  },
  // Copy the object about to be overwritten into the product's history
  // folder. Missing object → nothing to keep (null). Immutable: a history
  // copy is never rewritten, so it may be cached for a year.
  archiveObject: async (pid, path, at) => {
    let blob;
    try { blob = await getBlob(storageRef(storage, path)); }
    catch (e) { if (String(e?.code || "").includes("object-not-found")) return null; throw e; }
    const dest = storageRef(storage, `products/${pid}/history/${at}.jpg`);
    await uploadBytes(dest, blob, { contentType: blob.type || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
    return getDownloadURL(dest);
  },
  rebuildThumb: (pid, url) => writeApprovedThumbFromUrl(pid, url, {
    download: (u) => getBlob(storageRef(storage, u)),
    upload: uploadThumbObject,
    remove: removeThumbObject,
  }),
  removeThumb: (pid) => removeThumbObject(productPhotoThumbPath(pid)),
  writeProduct: (pid, patch) => update(ref(database, `products/${pid}`), patch),
};

/** Set the primary photo from the browser (see setPrimaryPhoto). */
export const setPrimaryPhotoInApp = (pid, args, deps = {}) =>
  setPrimaryPhoto(pid, args, { ...browserSetPrimaryDeps, ...deps });

/** The "Undo photo" button. */
export const undoPrimaryPhotoInApp = (pid, args, deps = {}) =>
  undoPrimaryPhoto(pid, args, { ...browserSetPrimaryDeps, ...deps });
