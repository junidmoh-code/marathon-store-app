// ─── generateProductPhotos — WHICH PRODUCTS, AND WHICH PHOTO ─────────────────
// The scoping decisions, pulled out of the callable so they can be proved
// without a Cloud Functions runtime, a secret or a paid image call. Same shape
// as the rest of functions/lib: pure logic here, auth and I/O in the caller.
//
// Two decisions live here and both are new, so both are worth pinning:
//
//   1. NAMED IDS vs THE SWEEP. A call that names product ids is asking for
//      exactly those. A call that names none is the unattended catalogue
//      sweep, which has to SCAN to find the next N products missing a photo —
//      and only that branch may pay for reading /products and
//      /aiAssistant/photoProposals whole. Getting this wrong is not a
//      correctness bug, it is a bandwidth bill: 4,275 records and ~3,500
//      proposal nodes off the wire to re-shoot one photograph.
//
//   2. THE SOURCE PHOTO. Normally the product record's hero. Shopify
//      Publishing overrides it because its photo set is NOT the record's — the
//      reviewer taps a slot in the publishing strip and expects THAT image
//      re-shot, and a custom publishing set may not contain the hero at all.
//      A source photo is meaningless spread across a batch, so it is accepted
//      for a single named product and refused everywhere else, including on
//      the sweep path where a stray one would silently re-shoot the same
//      picture for every product in the run.
"use strict";

/** Hard ceiling on any one run, mirrored from the callable. */
const PHOTO_MAX_BATCH = 200;

/** Longest sourceUrl accepted. A Storage download URL is ~250 chars; 2000 is
 *  generous headroom and still bounds an untrusted string. */
const SOURCE_URL_MAX = 2000;

// THE APP'S OWN BUCKET, and nothing else. fetchImageBuffer's SSRF guard admits
// any *.googleapis.com host, which is every Firebase project on earth — the
// browser already enforces the tighter rule (APP_STORAGE_PREFIX in
// shopifyPublishStore.js, with a test rejecting "strangers-app.appspot.com")
// and the server must not be the looser of the two. It matters because the
// url is persisted, shown to a human as "Original", and re-fetched later: a
// foreign URL would become a permanent third-party dependency inside our data.
const APP_STORAGE_PREFIX =
  "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";

// A real product id. REJECT, never repair — the same discipline as the
// browser's uploadPublishPhoto. This is not cosmetic: the id is interpolated
// into RTDB and Storage paths, and Firebase's path parser DROPS empty
// segments. `productIds: [""]` would make `db.ref("products/" + id)` a read of
// the WHOLE /products node, and `photoProposals/` + .set() a REPLACE of every
// pending proposal in the database. An id containing "/" walks into another
// product's Storage folder; one containing "." "#" "$" "[" or "]" makes
// db.ref() THROW outside the per-product try/catch, failing a whole batch
// instead of skipping one bad entry.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const isSafeProductId = (id) => typeof id === "string" && id !== "" && SAFE_ID.test(id);

/**
 * The de-duplicated, capped list of product ids this call named, or null when
 * it named none (→ the sweep).
 */
function resolveNamedIds(data, max = PHOTO_MAX_BATCH) {
  const raw = data && data.productIds;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = [...new Set(raw)].filter(isSafeProductId);
  if (ids.length === 0) return null;
  return ids.slice(0, max);
}

/**
 * The photo to re-shoot, or null to use each product's own hero.
 * ONLY honoured for exactly one named product — see the note above.
 */
function resolveSourceUrl(data, namedIds) {
  const raw = data && data.sourceUrl;
  if (typeof raw !== "string") return null;
  if (!namedIds || namedIds.length !== 1) return null;
  const trimmed = raw.trim().slice(0, SOURCE_URL_MAX);
  if (!trimmed || !trimmed.startsWith(APP_STORAGE_PREFIX)) return null;
  return trimmed;
}

/**
 * True when this call must read /products and the proposals map whole. Only
 * the sweep does; a caller that already knows its ids fetches those records
 * directly.
 */
function needsCatalogueScan(namedIds) {
  return namedIds === null;
}

/**
 * The work list.
 *
 * Named ids keep the caller's order and drop anything with no record. A
 * product with no photoUrl is dropped too — UNLESS a sourceUrl was given,
 * which is the whole picture to work from and makes the record's own hero
 * irrelevant.
 *
 * The sweep keeps its original behaviour byte for byte: photoUrl required,
 * optional category filter matching either the new `category` or the legacy
 * `productType`, already-proposed products skipped unless `reprocess`, sorted
 * for a stable walk, then capped.
 */
function pickIds({ namedIds, products = {}, existing = {}, sourceUrl = null, data = {}, limit = 12 }) {
  if (namedIds) {
    return namedIds.filter((id) => products[id] && (sourceUrl || products[id].photoUrl));
  }
  const ids = Object.keys(products).filter((id) => {
    const p = products[id];
    if (!p || !p.photoUrl) return false;
    if (data.category && p.category !== data.category && (p.productType || "") !== data.category) return false;
    if (!data.reprocess && existing[id]) return false;
    return true;
  });
  ids.sort();
  return ids.slice(0, limit);
}

/**
 * Whether this generation may be recorded in /aiAssistant/photoProposals.
 *
 * It may not, when a sourceUrl was named. That node is keyed by product id and
 * written with .set() — a whole-node REPLACE — and it belongs to the AI Studio
 * review lane. A Shopify-page re-shoot writing into it would destroy an
 * unreviewed candidate for the same product, and worse: `originalUrl` on that
 * node is what AI Studio's approve copies into products/{id}/photoUrlOriginal.
 * A publishing photo can itself be a generated image, so approving such a
 * proposal in the other surface would overwrite the record's only pointer to
 * the true original with a generated one.
 */
function mayRecordProposal(sourceUrl) {
  return !sourceUrl;
}

module.exports = {
  PHOTO_MAX_BATCH, SOURCE_URL_MAX, APP_STORAGE_PREFIX, isSafeProductId,
  resolveNamedIds, resolveSourceUrl, needsCatalogueScan, pickIds, mayRecordProposal,
};
