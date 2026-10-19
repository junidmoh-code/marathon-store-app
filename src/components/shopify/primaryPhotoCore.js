// ─── THE SHOPIFY PRIMARY PHOTO IS THE APP PHOTO — the ONE write ─────────────
// Decision (Junid, 26 Sep 2026, confirmed 19 Oct): the PRIMARY photo of a
// product's Shopify Publishing list (position 0) is the product's photo
// everywhere in the app. Extra photos, videos, names and captions stay
// Shopify-only.
//
// Every path that sets or replaces that primary ends here, in
// setShopifyPrimaryPhoto: the photo strip (Make primary, a new first photo,
// AI Studio's "Use instead of this one" on the primary, removing the primary),
// the New Arrivals chain, and the backfill script
// (scripts/shopify/sync-primary-photos-to-app.mjs). The browser, the chain and
// the script inject their own Storage/RTDB legs; the rule is written once.
// primaryPhotoGuard.test.js fails if a publishing-list writer skips it.
//
// THE APP PHOTO MOVES BY POINTER, NOT BY OVERWRITE. photoUrl ← the primary's
// own download URL; the staff photo it replaces stays where it is
// (products/{pid}/photo.jpg, never touched, never deleted) and is recorded in
// photoUrlOriginal. That is the model the AI Studio approve and the New
// Arrivals chain already use, and two readers depend on it: sourcePhoto.cjs
// treats "photoUrl is photo.jpg" as "the product shows a staff photo", and
// the generator starts from photoUrlOriginal. Copying the primary over
// photo.jpg would make both read a Shopify photo as a staff photo. The URL
// changes on every swap, and photoUrl is part of the offline mirror's content
// marker (photoContentMarker), so every device re-fetches without a cache-bust.
//
// SAME CONTENT IS NO CHANGE. The app photo and the primary are compared by
// Storage md5, not by URL: the same JPEG uploaded twice has two URLs and is
// still the same photo — nothing is written for it.
//
// Pure: no Firebase import, so the browser bundle, the Mac mini chain and the
// MacBook script all run this exact code.
import { resolveMediaList } from "./publishShared.js";

export const PHOTO_SOURCE_FROM = "shopify_publish";
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The Storage object path inside a Firebase download URL (any bucket), or null. */
export function objectPathOf(url) {
  try {
    const m = /\/o\/([^?]+)/.exec(new URL(String(url)).pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/** Is this URL the product's own staff photo (products/{pid}/photo.jpg)? */
export function isStaffPhoto(pid, url) {
  return !!pid && !!url && objectPathOf(url) === `products/${pid}/photo.jpg`;
}

// A photo that is never an "original": a publishing upload / AI Studio result
// (products/{pid}/shopify/…) or a New Arrivals generation.
const isDerivedPhoto = (url) => /^products\/[^/]+\/(shopify|new_arrivals)\//.test(objectPathOf(url) || "");

/**
 * The /products/{pid} child patch that makes `newPrimary` the app photo, or
 * null when the app photo must not move (bad pid, no primary, the primary did
 * not change, or the app already shows that URL). `at` stamps photoSource.
 *
 * photoUrlOriginal keeps the photo being replaced when it is the STAFF photo
 * (re-shoots included), or — once, when none is kept yet — an older record's
 * photo stored elsewhere. A publishing or generated photo is never kept as
 * the original. `fallbackOriginal` is the chain's last resort for a product
 * with no usable photo of its own.
 */
export function appPhotoPatch(pid, product, oldPrimary, newPrimary, { at = null, fallbackOriginal = null } = {}) {
  if (!PID_RE.test(String(pid ?? ""))) return null;
  if (typeof newPrimary !== "string" || !newPrimary || newPrimary === oldPrimary) return null;
  if (product?.photoUrl === newPrimary) return null;
  const patch = { photoUrl: newPrimary };
  const current = product?.photoUrl || null;
  if (current && isStaffPhoto(pid, current)) patch.photoUrlOriginal = current;
  else if (!product?.photoUrlOriginal) {
    const keep = current && !isDerivedPhoto(current) ? current : fallbackOriginal && !isDerivedPhoto(fallbackOriginal) ? fallbackOriginal : null;
    if (keep && keep !== newPrimary) patch.photoUrlOriginal = keep;
  }
  if (Number.isFinite(at) && at > 0) patch.photoSource = { from: PHOTO_SOURCE_FROM, at };
  return patch;
}

/**
 * THE ONE WRITE. Make the app photo follow the Shopify primary.
 *   pid, { product, oldPrimary, newPrimary, fallbackOriginal? }
 *   deps: {
 *     now()                 → serverNowMs, or a promise of it (the photoSource stamp)
 *     md5Of(url)            → the object's Storage md5, or null when unknown
 *     rebuildThumb(pid,url) → the till thumbnail from the new photo (best-effort)
 *     writeProduct(pid, patch) → an update() of /products/{pid} child keys
 *   }
 * → { ok, changed, reason?, patch?, thumb?, message? }. Never throws.
 *
 * The thumbnail is rebuilt BEFORE photoUrl moves: photoUrl is the mirror's
 * content marker, and a device that sees the new marker while the old
 * thumbnail is still in the bucket would cache the old picture as current
 * for ever.
 */
export async function setShopifyPrimaryPhoto(pid, { product, oldPrimary = null, newPrimary, fallbackOriginal = null }, deps) {
  let at = null;
  try { at = Math.round(Number(await deps.now())); } catch { at = null; }
  const patch = appPhotoPatch(pid, product, oldPrimary, newPrimary, { at, fallbackOriginal });
  if (!patch) return { ok: true, changed: false, reason: newPrimary && product?.photoUrl === newPrimary ? "same-url" : "no-change" };
  const current = product?.photoUrl || null;
  if (current && typeof deps.md5Of === "function") {
    const [a, b] = await Promise.all([current, newPrimary].map(async (u) => { try { return (await deps.md5Of(u)) || null; } catch { return null; } }));
    if (a && b && a === b) return { ok: true, changed: false, reason: "same-content" };
  }
  let thumb = null;
  if (typeof deps.rebuildThumb === "function") {
    try { thumb = await deps.rebuildThumb(pid, newPrimary); } catch (e) { thumb = { ok: false, reason: String(e?.message || e) }; }
  }
  try {
    await deps.writeProduct(pid, patch);
  } catch (e) {
    return { ok: false, changed: false, patch, thumb: !!thumb?.ok,
             message: `The Shopify photos are saved, but the app photo could not be changed (${String(e?.message || e)}).` };
  }
  return { ok: true, changed: true, patch, thumb: !!thumb?.ok };
}

/**
 * The primary photo a /shopify_publish/{pid} node holds IN ITS OWN LIST, or
 * null when it has none (a node never edited shows the app photo, so it has
 * no primary of its own to sync). Same reading as resolveMediaList: `media`
 * first, with `photos` winning the photo order when a photos-only writer
 * changed it since.
 */
export function storedPrimaryOf(node) {
  if (!node || (node.media == null && node.photos == null)) return null;
  const { items, source } = resolveMediaList(node, null);
  if (source === "record") return null;
  const first = (items || []).find((m) => m.type === "photo");
  return first ? first.url : null;
}
