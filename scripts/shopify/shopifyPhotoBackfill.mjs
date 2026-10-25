// ─── BRING THE GOOD SHOPIFY PHOTOS BACK INTO THE APP — the pure half ─────────
// (Junid, 25 Oct 2026, COMMIT 4.) "Where Shopify's image differs from the
// app's photo (the studio replacements), copy the Shopify image into our own
// Storage (never hotlink Shopify's CDN) and make it the primary photo; old app
// photo goes to history. Match on Shopify product ID, never by name (twin
// products exist). Dry run, then batches of 100 with a check after each."
//
// backfill-shopify-photos.mjs reads and writes; this file only decides.
//
// "DIFFERS" IS A PICTURE QUESTION, NOT A BYTES QUESTION. Shopify re-hosts and
// re-encodes every upload, so its file never has our md5 even when it IS our
// photo (every product the #760 sync already aligned). Both pictures are
// reduced to a 64-bit difference hash (dHash: 9×8 grey, one bit per
// left/right step) and compared by Hamming distance:
//   ≤ SAME_MAX         the same photograph → nothing to do
//   ≥ DIFFERENT_MIN    a different photograph → replace
//   in between         uncertain → left alone and listed, never guessed
//
// WRONG-PHOTO GUARDS (Junid's stop condition is "a batch matches a product to
// the wrong photo"):
//   • the link is the claim index AND the record's own map, both naming the
//     same Shopify product id (the reconciler's two halves of one mapping);
//   • the Shopify title must equal the listing name the reconciler pushed
//     (cleanName) — a mapped product whose title differs is not certainly ours;
//   • one Shopify picture headed to two app products (twins sharing a photo)
//     is excluded for both;
//   • after a batch, every written product is re-read and its new photo
//     re-hashed against Shopify's; a mismatch is a STOP.

import { cleanTitleFor } from "../../src/utils/shopifyTriggers.js";

export const SAME_MAX = 8;
export const DIFFERENT_MIN = 14;

/** Bulk query: every product's id, title, status and featured image. */
export const BACKFILL_BULK_QUERY = `{
  products {
    edges { node { id title status
      featuredMedia { ... on MediaImage { id image { url width height } } }
    } }
  }
}`;

/** PURE: bulk JSONL → Map(gid → { id, title, status, image: { url, width, height } | null }). */
export function parseBackfillSnapshot(jsonl) {
  const out = new Map();
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (!String(o.id).includes("/Product/") || o.__parentId) continue;
    const img = o.featuredMedia?.image;
    out.set(o.id, { id: o.id, title: o.title ?? null, status: o.status ?? null,
                    image: img?.url ? { url: img.url, width: img.width ?? null, height: img.height ?? null } : null });
  }
  return out;
}

/** Hamming distance between two 16-hex-digit hashes, or null. */
export function hamming(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== 16 || b.length !== 16) return null;
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** PURE: 9×8 greyscale bytes (row-major) → the 16-hex-digit dHash. */
export function dhashFromGrey(px) {
  if (!px || px.length < 72) throw new Error("dhash needs 9×8 grey pixels");
  let hex = "", nib = 0, n = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nib = (nib << 1) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0);
      if (++n % 4 === 0) { hex += nib.toString(16); nib = 0; }
    }
  }
  return hex;
}

/** A Shopify CDN URL asked for at `width` px (for hashing — never stored). */
export function shopifySized(url, width) {
  try { const u = new URL(url); u.searchParams.set("width", String(width)); return u.toString(); } catch { return url; }
}

/**
 * One product's verdict, before any picture is read.
 * → { go: true } | { go: false, code, why }
 */
export function linkVerdict({ pid, gid, mappedGid, product, node, shop }) {
  const no = (code, why) => ({ go: false, code, why });
  if (!shop?.image?.url) return no("no-shopify-image", "the Shopify listing has no image");
  if (mappedGid !== gid) return no("map-mismatch", `the claim says ${gid} but the record maps to ${mappedGid || "nothing"}`);
  if (!product) return no("no-product", "no app product");
  if (product.mergedInto) return no("merged", `merged into ${product.mergedInto}`);
  // The name the reconciler pushed as the title: the reviewed cleanName, else the lexicon's.
  let listing = typeof node?.cleanName === "string" && node.cleanName.trim() ? node.cleanName.trim() : null;
  if (!listing) { const t = cleanTitleFor(product); listing = t?.needsAI ? null : String(t?.title || "").trim() || null; }
  if (!listing || listing !== String(shop.title || "").trim()) {
    return no("title-mismatch", `the Shopify title ${JSON.stringify(shop.title)} is not the app's listing name ${JSON.stringify(listing)} — not certainly the same product`);
  }
  return { go: true };
}

/** The picture verdict from the two hashes. `appHash` null = the app has no photo. */
export function pictureVerdict(shopHash, appHash) {
  if (!shopHash) return { action: "skip", code: "unreadable", why: "the Shopify image could not be read" };
  if (appHash == null) return { action: "replace", code: "app-has-none", distance: null };
  const d = hamming(shopHash, appHash);
  if (d == null) return { action: "skip", code: "unreadable", why: "a hash could not be compared" };
  if (d <= SAME_MAX) return { action: "same", code: "same", distance: d };
  if (d >= DIFFERENT_MIN) return { action: "replace", code: "differs", distance: d };
  return { action: "skip", code: "uncertain", distance: d, why: `the pictures are neither clearly the same nor clearly different (distance ${d})` };
}

/** Twins: one Shopify picture headed to two app products → none of them. Returns the pids to drop. */
export function sharedPictureConflicts(rows) {
  const byHash = new Map();
  for (const r of rows) {
    const k = r.shopHash;
    if (!k) continue;
    const near = [...byHash.keys()].find((h) => hamming(h, k) <= SAME_MAX);
    const key = near ?? k;
    byHash.set(key, [...(byHash.get(key) || []), r.pid]);
  }
  return new Set([...byHash.values()].filter((pids) => pids.length > 1).flat());
}

/** Our Storage path for the copy (never the Shopify CDN). */
export const copyPathFor = (pid, at, ext = "jpg") => `products/${pid}/shopify_backfill/${at}.${ext}`;

/** The after-batch check for one product. → [] clean, else what is wrong. */
export function batchCheck({ entry, now }) {
  const out = [];
  if (now.photoUrl !== entry.newUrl) out.push(`photoUrl is ${now.photoUrl}, not the copy`);
  if (entry.oldUrl && now.history?.url !== entry.oldUrl) out.push("the old photo is not in its history");
  const d = hamming(now.copyHash, entry.shopHash);
  if (d == null || d > SAME_MAX) out.push(`the stored copy does not look like the Shopify photo (distance ${d})`);
  if (now.mappedGid !== entry.gid || now.claimPid !== entry.pid) out.push("the Shopify link changed");
  return out;
}
