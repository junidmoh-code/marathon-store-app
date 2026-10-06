// ─── SHOPIFY PUBLISHING — SHARED LIMITS ──────────────────────────────────────
// Constants shared VERBATIM between the browser page and the owner-run Node
// scripts. This file must stay dependency-free: reconcile.mjs imports it under
// plain Node ESM (no bundler), so an import chain here would need explicit
// file extensions and could drag browser-only code into the scripts.

// How many intents one reconciler run applies — and therefore the page's batch
// selection cap (one selection = at most one run; the two cannot disagree
// because both read THIS constant).
//
// 25 is sized against the Shopify rate limiter, MEASURED 2026-08-14 against
// the live shop with read-only queries: cost-based leaky bucket with
// maximumAvailable = 2000 points and restoreRate = 100 points/s; the
// reconciler's read queries cost 1–32 requested points each and a worst-case
// CREATE+PUBLISH (including up to 15 media-status polls) stays under ~320
// requested points. 25 products ⇒ ≤ ~8,000 points ⇒ roughly a minute of
// accumulated THROTTLED waits spread across the run, which client.mjs absorbs
// by design (THROTTLED rejects BEFORE execution, so its wait-and-retry is
// mutation-safe). The binding constraint on run size is operator attention,
// not the API.
export const RECONCILE_MAX_APPLY = 25;

// The most media (photos AND videos) one product may hold — Shopify's OWN
// per-product cap ("You can add a maximum of 250 images, 3D models, or videos
// to a product", help.shopify.com product-media/add-media, checked 6 Oct
// 2026). There is deliberately no lower, invented cap (Junid, 6 Oct 2026: as
// many photos as he wants). The reconciler reads media back 250 at a time,
// which is also Shopify's largest connection page, so one page always holds
// the whole set.
export const MAX_PUBLISH_MEDIA = 250;
// Kept under its old name for the callers that only speak photos (the New
// Arrivals chain, AI Studio's "Add as another photo").
export const MAX_PUBLISH_PHOTOS = MAX_PUBLISH_MEDIA;

// Every publishing photo and video lives in THIS app's bucket — the client
// refuses anything else and so does the reconciler (media.mjs), so neither the
// browser nor the privileged push can be pointed at an arbitrary host.
export const APP_STORAGE_PREFIX = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";

// ─── SHOPIFY'S VIDEO LIMITS ──────────────────────────────────────────────────
// From Shopify's help center, "Product media types" (checked 6 Oct 2026):
// video "Up to 10 minutes", "Up to 1 GB", "Up to 4K (4096 x 2160 px)",
// ".mp4, .mov, or .webm". 1 GB is taken as 10^9 bytes, the smaller reading,
// so a file Shopify might count as "under 1 GB" in binary units is never sent
// to be refused there. A video outside these is KEPT (Storage + the list) and
// simply never pushed — nothing here ever re-encodes, trims or shrinks it.
export const SHOPIFY_VIDEO_MAX_BYTES = 1_000_000_000;
export const SHOPIFY_VIDEO_MAX_DURATION_MS = 10 * 60 * 1000;
export const SHOPIFY_VIDEO_MAX_LONG_EDGE = 4096;
export const SHOPIFY_VIDEO_MAX_SHORT_EDGE = 2160;
export const SHOPIFY_VIDEO_MIME = ["video/mp4", "video/quicktime", "video/webm"];

// ─── THE DESCRIPTION TEMPLATE — ONE SOURCE ───────────────────────────────────
// The product page previews the description "exactly as it will appear on
// Shopify", so the template must live where BOTH the browser and the
// reconciler read it — a copied template would let the preview drift from the
// push. compliance.mjs re-exports these for the scripts; shopifyPublishCore
// re-exports CONDITIONS for the page. (Until 2026-08-14 the two sides held
// deliberate twins pinned equal by tests; the pins remain and now hold
// trivially.)

// Condition values, exactly these three (owner spec 2026-08-13). NO default:
// a product with condition unset is state=blocked and cannot be pushed —
// buildDescriptionHtml throws rather than invents one.
export const CONDITIONS = [
  "Excellent — no visible wear",
  "Very good — light cosmetic marks",
  "Good — visible wear, priced accordingly",
];

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The one description template. {condition} is the only substitution.
export function buildDescriptionHtml(condition) {
  if (!CONDITIONS.includes(condition)) {
    throw new Error(
      `condition must be one of the three fixed values, got: ${JSON.stringify(condition)}. ` +
        `There is NO default — an unset condition blocks the push.`
    );
  }
  return (
    `<p>Curated by Marathon Club. Sourced from clearance, factory surplus and pre-loved stock — each piece is limited and rarely restocked.</p>\n` +
    `<p><strong>Condition:</strong> ${escapeHtml(condition)}</p>\n` +
    `<p>Every item is checked by hand before listing. Original packaging isn't always included.</p>\n` +
    `<p>14-day exchange on anything faulty. Full detail on our <a href="/pages/returns-and-condition">Returns &amp; Condition</a> page.</p>`
  );
}

// /shopify_publish/{pid}/photos → a clean ordered URL list, or null when the
// node has no usable custom set (callers then fall back to the record's
// photoUrl + gallery). RTDB stores arrays as 0..n children and hands them
// back as arrays only when contiguous — a set that lost an index mid-edit
// arrives as an object, so both shapes are accepted, keyed numerically,
// de-duplicated, blanks dropped.
export function normalizePhotoList(val) {
  if (val == null) return null;
  const arr = Array.isArray(val)
    ? val
    : typeof val === "object"
      ? Object.keys(val).sort((a, b) => Number(a) - Number(b)).map((k) => val[k])
      : [];
  const out = [];
  for (const u of arr) {
    if (typeof u !== "string") continue;
    const t = u.trim(); // trim BEFORE dedupe — " url" and "url" are one photo
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out.length ? out : null;
}

// ═══ ONE ORDERED MEDIA LIST PER PRODUCT ══════════════════════════════════════
// /shopify_publish/{pid}/media is an ordered array of items:
//
//   { id, type: "photo"|"video", url, path,
//     posterUrl?, posterPath?,               — videos: a small JPEG frame
//     sha256?, bytes?, mime?, width?, height?, durationMs?,
//     addedAt?, addedBy?, source?, derivedFrom? }
//
// It EXTENDS the `photos` list rather than standing beside it: every write
// of `media` also writes `photos` = the photo URLs in list order, in the same
// transaction (publishMutators.mediaMutator), so every reader that only knows
// `photos` — the New Arrivals chain, the social engine, an old bundle still
// open on a phone — keeps seeing exactly the photos Junid arranged.
//
// THE LAZY READ. A product nobody has touched since this shipped has no
// `media` at all; resolveMediaList shows it as its `photos` list, or as its
// record photo(s), as a one-photo list — and writes nothing. The first edit
// is what writes `media`.
//
// THE OTHER DIRECTION. A writer that only knows `photos` (the New Arrivals
// chain's photosMutator, an old bundle) can change `photos` after `media`
// was written. resolveMediaList notices that the photo projection no longer
// matches and merges: the `photos` order wins for photos, videos keep their
// places, and position 0 is still a photo. So the two can never show
// different photo sets, whichever side wrote last.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// FNV-1a, 32-bit — a stable id for an item derived from a bare URL (the lazy
// read), so the browser and the reconciler name the SAME item the same way
// without either of them needing a crypto library.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The Storage object path inside one of this bucket's download URLs, or null. */
export function storagePathOf(url) {
  if (typeof url !== "string" || !url.startsWith(APP_STORAGE_PREFIX)) return null;
  const rest = url.slice(APP_STORAGE_PREFIX.length).split("?")[0];
  try { return decodeURIComponent(rest); } catch { return null; }
}

/** The item a bare photo URL becomes when read lazily. Deterministic. */
export function lazyPhotoItem(url, source = "publish") {
  const u = String(url).trim();
  const item = { id: `u${fnv1a(u)}${u.length.toString(36)}`, type: "photo", url: u, source };
  const path = storagePathOf(u);
  if (path) item.path = path;
  return item;
}

// One stored item → a clean item, or null when it is not a usable one.
// Unknown keys are dropped (they could never be validated); numbers must be
// finite and positive.
const NUM_KEYS = ["bytes", "width", "height", "durationMs", "addedAt"];
const STR_KEYS = ["path", "posterUrl", "posterPath", "mime", "addedBy", "source", "derivedFrom", "name"];
export function cleanMediaItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type === "video" ? "video" : raw.type === "photo" ? "photo" : null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!type || !url || !ID_RE.test(id)) return null;
  const out = { id, type, url };
  for (const k of STR_KEYS) if (typeof raw[k] === "string" && raw[k] !== "") out[k] = raw[k];
  for (const k of NUM_KEYS) if (Number.isFinite(raw[k]) && raw[k] > 0) out[k] = raw[k];
  if (typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256)) out.sha256 = raw.sha256;
  return out;
}

/**
 * /shopify_publish/{pid}/media → a clean ordered item list, or null. Same
 * tolerance as normalizePhotoList: RTDB hands back a list that lost an index
 * as an OBJECT, so both shapes are read, keyed numerically; a duplicate id or
 * URL keeps its first occurrence.
 */
export function normalizeMediaItems(val) {
  if (val == null) return null;
  const arr = Array.isArray(val)
    ? val
    : typeof val === "object"
      ? Object.keys(val).sort((a, b) => Number(a) - Number(b)).map((k) => val[k])
      : [];
  const out = [];
  const ids = new Set();
  const urls = new Set();
  for (const raw of arr) {
    const item = cleanMediaItem(raw);
    if (!item || ids.has(item.id) || urls.has(item.url)) continue;
    ids.add(item.id); urls.add(item.url);
    out.push(item);
  }
  return out.length ? out : null;
}

/** The photo URLs of a media list, in list order — the `photos` projection. */
export function photoUrlsOf(items) {
  return (items || []).filter((m) => m.type === "photo").map((m) => m.url);
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Position 0 must be a photo: the first photo moves to the front if a video got there. */
export function photoFirst(items) {
  if (!items.length || items[0].type === "photo") return items;
  const i = items.findIndex((m) => m.type === "photo");
  if (i < 0) return items;
  return [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
}

/**
 * A `photos` list written by a photos-only writer, folded back into the media
 * list: photos take the new order (an existing item is reused by URL so its
 * hash and metadata survive), videos keep their slots, new URLs become lazy
 * items, removed photos leave, position 0 stays a photo.
 */
export function mergePhotosIntoMedia(items, photos) {
  const byUrl = new Map(items.filter((m) => m.type === "photo").map((m) => [m.url, m]));
  const queue = photos.map((u) => byUrl.get(u) || lazyPhotoItem(u));
  const out = [];
  for (const m of items) {
    if (m.type === "video") out.push(m);
    else if (queue.length) out.push(queue.shift());
  }
  out.push(...queue);
  return photoFirst(out);
}

/**
 * THE ONE READ of a product's publishing media. → { items, source } where
 * source is "media" (the list as saved), "merged" (a photos-only writer
 * changed the photos since), "photos" (only the old photo list exists) or
 * "record" (nothing saved yet: the app photo + its gallery). Never writes.
 */
export function resolveMediaList(node, product) {
  const media = normalizeMediaItems(node?.media);
  const photos = normalizePhotoList(node?.photos);
  if (media) {
    if (!photos || sameList(photoUrlsOf(media), photos)) return { items: photoFirst(media), source: "media" };
    return { items: mergePhotosIntoMedia(media, photos), source: "merged" };
  }
  if (photos) return { items: photos.map((u) => lazyPhotoItem(u)), source: "photos" };
  const urls = [];
  const push = (u) => {
    if (typeof u === "string" && u.trim() !== "" && !urls.includes(u.trim())) urls.push(u.trim());
  };
  push(product?.photoUrl);
  for (const u of Array.isArray(product?.gallery) ? product.gallery : []) push(u);
  return { items: urls.map((u) => lazyPhotoItem(u, "record")), source: "record" };
}

/** Why a media list cannot be saved, or null when it can. */
export function mediaListProblem(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "The media list can't be empty — a product never ships without a photo.";
  }
  if (items.length > MAX_PUBLISH_MEDIA) {
    return `Shopify takes at most ${MAX_PUBLISH_MEDIA} photos and videos per product.`;
  }
  if (items[0]?.type !== "photo") return "The first item must be a photo — a video can never be the primary.";
  const ids = new Set();
  const urls = new Set();
  for (const raw of items) {
    const m = cleanMediaItem(raw);
    if (!m) return "The media list has an item that isn't a photo or a video.";
    if (ids.has(m.id)) return "The media list has the same item twice.";
    if (urls.has(m.url)) return "The media list has the same file twice.";
    ids.add(m.id); urls.add(m.url);
    if (!m.url.startsWith(APP_STORAGE_PREFIX)) return "Photos and videos must be this app's own Firebase Storage files.";
    if (m.posterUrl && !m.posterUrl.startsWith(APP_STORAGE_PREFIX)) return "A video poster must be this app's own Firebase Storage file.";
  }
  return null;
}

/**
 * Can Shopify take this video? → null when it can, else the plain reason it is
 * kept but never pushed. Unknown metadata (a phone that could not read the
 * file's header) is not a refusal — Shopify itself then decides, and a
 * refusal there shows as FAILED on the item.
 */
export function shopifyVideoProblem(item) {
  if (!item || item.type !== "video") return null;
  const mb = (n) => `${Math.ceil(n / 1_000_000).toLocaleString("en-ZA")} MB`;
  if (Number(item.bytes) > SHOPIFY_VIDEO_MAX_BYTES) {
    return `kept, too large for Shopify — ${mb(item.bytes)}; Shopify takes videos up to 1 GB`;
  }
  if (Number(item.durationMs) > SHOPIFY_VIDEO_MAX_DURATION_MS) {
    return `kept, too long for Shopify — ${Math.ceil(item.durationMs / 60000)} min; Shopify takes videos up to 10 minutes`;
  }
  const w = Number(item.width) || 0;
  const h = Number(item.height) || 0;
  if (w && h && (Math.max(w, h) > SHOPIFY_VIDEO_MAX_LONG_EDGE || Math.min(w, h) > SHOPIFY_VIDEO_MAX_SHORT_EDGE)) {
    return `kept, too large a picture for Shopify — ${w}×${h}; Shopify takes videos up to 4K (4096×2160)`;
  }
  if (item.mime && !SHOPIFY_VIDEO_MIME.includes(String(item.mime).toLowerCase())) {
    return `kept, a format Shopify does not take (${item.mime}); Shopify takes .mp4, .mov and .webm`;
  }
  return null;
}

/**
 * The comparable shape of what is SAVED on a node (not what it resolves to):
 * the concurrency basis for a media edit. Two sessions editing from the same
 * saved state agree; anything written in between — media or photos — differs.
 */
export function storedMediaKey(node) {
  const media = normalizeMediaItems(node?.media);
  return JSON.stringify([media ? media.map((m) => [m.id, m.url]) : null, normalizePhotoList(node?.photos)]);
}

/**
 * The order the reconciler must reproduce on Shopify, as one string: the
 * items it pushes (photos, and videos Shopify can take) by id+url. A change
 * to anything that matters to Shopify changes this; a change only to app-side
 * metadata does not.
 */
export function mediaPushSig(items) {
  return JSON.stringify((items || [])
    .filter((m) => m.type === "photo" || !shopifyVideoProblem(m))
    .map((m) => [m.id, m.type, m.url]));
}
