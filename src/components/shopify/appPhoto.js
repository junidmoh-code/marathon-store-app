// ─── THE PRIMARY PHOTO IS THE APP PHOTO — the browser's legs ────────────────
// The rule itself is primaryPhotoCore.setShopifyPrimaryPhoto (one copy, shared
// with the New Arrivals chain and the backfill script). This file binds it to
// the browser's Firebase SDK; publishMediaCommit.commitPublishMedia (the ONLY
// way the app writes a publishing media list) runs it with these legs.
//
// The /products write is child keys only (update, never set), so nothing else
// on the record — styleCodeNormalised above all, which the rules make
// immutable — is ever rewritten. The live rules let any signed-in staff
// account write /products children, so this needs no callable.
import { ref, update } from "firebase/database";
import { ref as storageRef, getBlob, getMetadata, uploadBytes, deleteObject } from "firebase/storage";
import { database, storage } from "../../firebase";
import { writeApprovedThumbFromUrl } from "../../utils/productThumb";
import { serverNowMs } from "../../utils/serverTime";
import { storagePathOf } from "./publishShared";

const uploadThumbObject = (path, blob, metadata) => uploadBytes(storageRef(storage, path), blob, metadata);
const removeThumbObject = (path) => deleteObject(storageRef(storage, path));

export const browserPrimaryPhotoDeps = {
  now: serverNowMs,
  md5Of: async (url) => {
    const path = storagePathOf(url);
    return path ? (await getMetadata(storageRef(storage, path)))?.md5Hash || null : null;
  },
  // The till thumbnail, by the same helper the AI Studio approve uses —
  // best-effort by its own contract.
  rebuildThumb: (pid, url) => writeApprovedThumbFromUrl(pid, url, {
    download: (u) => getBlob(storageRef(storage, u)),
    upload: uploadThumbObject,
    remove: removeThumbObject,
  }),
  writeProduct: (pid, patch) => update(ref(database, `products/${pid}`), patch),
};

