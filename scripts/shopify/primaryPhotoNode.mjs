// ─── The Firebase Admin legs for the primary-photo backfill and its rollback ─
// Application-default credentials (this MacBook's gcloud ADC), the shared
// functions/ firebase-admin. Nothing here decides anything: the decisions are
// primaryPhotoSync.mjs and the write is primaryPhotoCore.setShopifyPrimaryPhoto.
import { createRequire } from "module";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { writeApprovedThumbFromUrl, writeProductThumb } from "../../src/utils/productThumb.js";
import { PHOTO_THUMB_MAX_EDGE } from "../../src/utils/productPhotoPaths.js";
import { objectPathOf } from "../../src/components/shopify/primaryPhotoCore.js";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

export const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
export const BUCKET = "marathon-club.firebasestorage.app";
const OUR_BUCKET = `/v0/b/${BUCKET}/o/`;

export function initAdmin() {
  const app = admin.initializeApp({ databaseURL: DB_URL, storageBucket: BUCKET });
  return { app, db: admin.database(), bucket: admin.storage().bucket() };
}

/** The keys of /shopify_publish — REST ?shallow=true, so no node body is read. */
export async function shallowKeys(app, path) {
  const { access_token } = await app.options.credential.getAccessToken();
  const r = await fetch(`${DB_URL}/${path}.json?shallow=true&access_token=${access_token}`);
  if (!r.ok) throw new Error(`shallow read of /${path} failed: HTTP ${r.status}`);
  return Object.keys((await r.json()) || {}).sort();
}

/** The server's clock: Date.now() corrected by /.info/serverTimeOffset (serverNowMs). */
export async function serverClock(db) {
  const offset = Number((await db.ref(".info/serverTimeOffset").once("value")).val()) || 0;
  return () => Date.now() + offset;
}

const ourPath = (url) => (typeof url === "string" && url.includes(OUR_BUCKET) ? objectPathOf(url) : null);

export function md5Reader(bucket) {
  const cache = new Map();
  return async (url) => {
    const path = ourPath(url);
    if (!path) return null;
    if (!cache.has(path)) {
      cache.set(path, bucket.file(path).getMetadata().then(([m]) => m?.md5Hash || null, (e) => {
        if (e?.code === 404) return null;
        cache.delete(path);
        throw e;
      }));
    }
    return cache.get(path);
  };
}

/** md5 → owners, from ONE listing of products/ (names and hashes only). */
export async function listProductObjects(bucket) {
  const out = [];
  let q = { prefix: "products/", maxResults: 1000, autoPaginate: false, fields: "items(name,md5Hash),nextPageToken" };
  while (q) {
    const [files, next] = await bucket.getFiles(q);
    for (const f of files) out.push({ name: f.name, md5Hash: f.metadata?.md5Hash || null });
    q = next;
  }
  return out;
}

export const readers = (db) => ({
  readNode: async (pid) => {
    const [media, photos] = await Promise.all(["media", "photos"].map((k) => db.ref(`shopify_publish/${pid}/${k}`).once("value").then((s) => s.val())));
    return { media, photos };
  },
  readProduct: async (pid) => {
    const [photoUrl, photoUrlOriginal, photoSource] = await Promise.all(["photoUrl", "photoUrlOriginal", "photoSource"]
      .map((k) => db.ref(`products/${pid}/${k}`).once("value").then((s) => s.val())));
    // No photo: one-child probe, so a node whose product is gone is never given a record.
    const exists = photoUrl != null || (await db.ref(`products/${pid}`).orderByKey().limitToFirst(1).once("value")).exists();
    return { exists, photoUrl, photoUrlOriginal, photoSource };
  },
});

/** sharp's WebP thumbnail: the browser's rule (≤ PHOTO_THUMB_MAX_EDGE wide, q80). */
export const encodeThumbNode = (buf) =>
  sharp(Buffer.from(buf)).rotate().resize({ width: PHOTO_THUMB_MAX_EDGE, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

/** The till thumbnail from `url`, by the AI Studio approve's helper. */
export function thumbRebuilder(bucket, from = "shopify_publish") {
  return (pid, url) => writeApprovedThumbFromUrl(pid, url, {
    download: async (u) => {
      const path = ourPath(u);
      if (!path) throw new Error("not in this bucket");
      return (await bucket.file(path).download())[0];
    },
    upload: (path, buf, md) => bucket.file(path).save(buf, {
      resumable: false, contentType: md.contentType,
      // thumbSource marks the object so a thumbnail regeneration from photo.jpg does not undo it.
      metadata: { cacheControl: md.cacheControl, metadata: { thumbSource: from, thumbSourceObject: ourPath(url) || "" } },
    }),
    remove: (path) => bucket.file(path).delete(),
    warn: (...a) => console.warn(`  ${pid}: thumbnail —`, ...a.map(String)),
    write: (id, blob, d) => writeProductThumb(id, blob, { ...d, encode: encodeThumbNode }),
  });
}

export const productWriter = (db) => (pid, patch) => db.ref(`products/${pid}`).update(patch);

// ── the rollback ledger ─────────────────────────────────────────────────────
export const ROLLBACK_DIR = join(homedir(), "marathon-rollbacks");
export const ledgerPath = (date) => join(ROLLBACK_DIR, `shopify-photo-sync-${date}.json`);

/** A ledger that survives an interrupted run: rewritten atomically after every entry. */
export function openLedger(path) {
  mkdirSync(ROLLBACK_DIR, { recursive: true });
  const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { kind: "shopify-photo-sync", createdAt: new Date().toISOString(), entries: [] };
  const save = () => { writeFileSync(`${path}.tmp`, JSON.stringify(doc, null, 2)); renameSync(`${path}.tmp`, path); };
  return {
    doc,
    // The FIRST entry for a product is its true before-state; a later one is never allowed to replace it.
    add: async (entry) => { if (!doc.entries.some((e) => e.pid === entry.pid)) { doc.entries.push({ ...entry, at: new Date().toISOString() }); save(); } },
    save,
  };
}
