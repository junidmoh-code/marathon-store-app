// ─── BLACK FRIDAY 2026 — SMALL THUMBNAILS FOR THE CARD'S LIST (21 Nov 2026) ──
// Junid's iPhone reloaded the card every time he came back to it: iOS throws
// away a background tab that holds too much memory, and the list showed every
// product's FULL photo (the AI masters are 4K JPEGs — ~45 MB each once decoded)
// in a 72×96 box. bfThumb serves the list a 360 px WebP of the same photo
// instead; the full photo is loaded only when he opens it.
//
// GET /bfThumb?u=<the photo's Firebase download URL>
//   → 302 to products/{pid}/card_thumbs/{key}_w360.webp (public-read, like
//     every products/** object), made from the photo the first time it is asked
//     for and kept. The key is a hash of the photo's path AND its download token,
//     so a photo re-shot under the same path gets a new thumbnail.
// Only photos of products in the app's own bucket; nothing else is read or
// fetched. Changes no data: it reads one Storage object and writes its thumbnail.
// Deploy BY NAME: firebase deploy --only functions:bfThumb
"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const BUCKET = "marathon-club.firebasestorage.app";
const W = 360;
const H = 480;
const SOURCE_MAX_BYTES = 60 * 1024 * 1024;
const PATH_RE = /^products\/([A-Za-z0-9_-]{1,64})\/(?!card_thumbs\/)[A-Za-z0-9_\-./]{1,300}\.(jpe?g|png|webp)$/i;

/** 32-bit FNV-1a, base 36. Pure. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/** The photo a URL names, if it is a product photo in our bucket: { path, pid, thumbPath } | null. Pure. */
function sourceOf(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "firebasestorage.googleapis.com") return null;
  const m = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
  if (!m || m[1] !== BUCKET) return null;
  let path;
  try { path = decodeURIComponent(m[2]); } catch { return null; }
  if (path.includes("..") || path.includes("//")) return null;
  const pm = PATH_RE.exec(path);
  if (!pm) return null;
  const key = fnv(`${path}|${u.searchParams.get("token") || ""}`);
  return { path, pid: pm[1], thumbPath: `products/${pm[1]}/card_thumbs/${key}_w${W}.webp` };
}
const publicUrl = (path) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`;

/** Make the thumbnail unless it exists. deps: { bucket, sharp }. → thumbPath */
async function ensureThumb(src, { bucket, sharp }) {
  const f = bucket.file(src.thumbPath);
  const [exists] = await f.exists();
  if (exists) return src.thumbPath;
  const [buf] = await bucket.file(src.path).download();
  if (buf.length > SOURCE_MAX_BYTES) throw Object.assign(new Error("too large"), { code: 413 });
  const out = await sharp(buf, { failOn: "none", limitInputPixels: 120_000_000 }).rotate()
    .resize(W, H, { fit: "inside", withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
  await f.save(out, { resumable: false, metadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" } });
  return src.thumbPath;
}

const bfThumb = onRequest(
  { region: "europe-west1", memory: "1GiB", cpu: 1, concurrency: 40, maxInstances: 4, timeoutSeconds: 60, invoker: "public" },
  async (req, res) => {
    const src = sourceOf(req.query && req.query.u);
    if (!src) { res.status(400).send("not a product photo"); return; }
    try {
      const path = await ensureThumb(src, { bucket: admin.storage().bucket(BUCKET), sharp: require("sharp") });
      res.set("Cache-Control", "public, max-age=604800");
      res.redirect(302, publicUrl(path));
    } catch (e) {
      // No thumbnail: the card falls back to the photo itself (its <img> onError).
      console.warn(`bfThumb: ${src.path} — ${e.message}`);
      res.status(e.code === 404 || /No such object/i.test(e.message) ? 404 : e.code === 413 ? 413 : 500).send("no thumbnail");
    }
  },
);

module.exports = { bfThumb, _internals: { sourceOf, ensureThumb, fnv, publicUrl, W, BUCKET } };
