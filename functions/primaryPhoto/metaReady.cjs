// ─── primaryPhotoMetaReady — a Meta-ready copy of every new primary photo ────
// (Junid, 25 Oct 2026, COMMIT 6.) Fires on /products/{pid}/photoUrl, so EVERY
// writer of the primary photo — the edit screen, AI Studio, the publisher,
// New Arrivals, the backfill, Undo photo — gets one without remembering to.
//
// STORED ALONGSIDE, NEVER REPLACING: products/{pid}/meta/{at}.jpg (a new
// object per version; nothing is overwritten or deleted) and the pointer
// /products/{pid}/photoMeta = { url, sourceUrl, at, width, height, fill, … }.
// `sourceUrl` is the primary it was made from, so a reader can tell a current
// version from a stale one (photoMetaFor below).
//
// WHO USES IT: only the reconciler, and only when it CREATES a new Shopify
// product on or after the switch date (reconcile.mjs, META_READY_FROM). The
// Meta catalogue is fed from Shopify, so a new listing's first image reaches
// it the same way. Existing listings' images are never touched.
//
// Re-reads photoUrl before and after the work (an RTDB trigger's payload can
// be stale), and does nothing when the pointer already matches. retry: false —
// a missed version is made again by the reconciler at create time if needed.
"use strict";

const { randomUUID } = require("node:crypto");
const { makeMetaReady } = require("../lib/meta-ready.cjs");

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET = "marathon-club.firebasestorage.app";
const META_VERSION = 1;

function objectPath(url) {
  try {
    const u = new URL(String(url));
    if (!u.pathname.includes(`/b/${BUCKET}/o/`)) return null;
    const m = /\/o\/([^?]+)/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/** The current Meta-ready URL for a product, or null when there is none for THIS primary. Pure. */
function photoMetaFor(product) {
  const m = product && product.photoMeta;
  if (!m || typeof m.url !== "string" || !product.photoUrl) return null;
  return m.sourceUrl === product.photoUrl && Number(m.version) >= 1 ? m.url : null;
}

/**
 * Make (or confirm) the Meta-ready version of pid's current primary.
 *   deps: { db, bucket, sharp, fetchImpl?, now? }
 * → { made } | { skipped }. Throws only on a real failure (logged by the caller).
 */
async function ensureMetaReady(deps, pid) {
  const { db, bucket, sharp, fetchImpl = fetch, now = Date.now } = deps;
  if (!PID_RE.test(String(pid || ""))) return { skipped: "bad pid" };
  const url = (await db.ref(`products/${pid}/photoUrl`).get()).val();
  if (typeof url !== "string" || !url) return { skipped: "no photo" };
  const meta = (await db.ref(`products/${pid}/photoMeta`).get()).val();
  if (meta && meta.sourceUrl === url && Number(meta.version) >= META_VERSION) return { skipped: "already made", url: meta.url };

  const path = objectPath(url);
  let input;
  if (path) input = (await bucket.file(path).download())[0];
  else {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    input = Buffer.from(await r.arrayBuffer());
  }
  const { buffer, info } = await makeMetaReady(sharp, input);
  const at = now();
  const dest = `products/${pid}/meta/${at}.jpg`;
  const token = randomUUID();
  await bucket.file(dest).save(buffer, {
    resumable: false, contentType: "image/jpeg",
    metadata: { cacheControl: "public, max-age=31536000, immutable",
                metadata: { firebaseStorageDownloadTokens: token, metaReadyFrom: path || url } },
  });
  // The primary may have moved while this ran; that change has its own run.
  const still = (await db.ref(`products/${pid}/photoUrl`).get()).val();
  if (still !== url) return { skipped: "photo moved while making it" };
  const out = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(dest)}?alt=media&token=${token}`;
  await db.ref(`products/${pid}/photoMeta`).set({
    url: out, sourceUrl: url, at, version: META_VERSION,
    width: info.width, height: info.height, fill: info.fill, productFound: info.productFound,
    frameCut: info.frameCut, sourceWidth: info.sourceWidth, sourceHeight: info.sourceHeight,
  });
  return { made: out, info };
}

module.exports = { ensureMetaReady, photoMetaFor, META_VERSION };
