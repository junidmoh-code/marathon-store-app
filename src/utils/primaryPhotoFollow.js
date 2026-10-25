// ─── THE SHOPIFY LISTING FOLLOWS THE APP'S PRIMARY PHOTO (from 28 Oct 2026) ──
// "Replacing a photo anywhere (publisher card, studio, any edit screen) sets
// the primary photo, so it changes everywhere at once." (Junid, 25 Oct 2026.)
//
// The publisher card already moves the app photo (primaryPhotoCore, #760).
// This is the other direction: a photo set in the APP — the edit screen's
// re-shoot, the AI Studio approve, Undo photo, the Shopify backfill — becomes
// the first photo of the product's publishing list, so the website's card
// follows (the reconciler pushes the list: the live media phase for a listed
// product, the next publish for one that is off).
//
// ONLY A PRODUCT WITH ITS OWN LIST is touched. One with none already shows
// the app photo when it is next published (resolveMediaList reads the record).
// A removed photo is never followed: the website is never left imageless.
//
// SWITCH: catalogue freeze until 28 Oct — "Shopify/Meta image changes are built
// and tested now but switch on 28 Oct". On from SHOPIFY_IMAGES_FROM_MS (or
// /config/primaryPhoto/shopifyImagesFrom), off whenever
// /config/primaryPhoto/shopifyImagesOff === true.
import { resolveMediaList, lazyPhotoItem } from "../components/shopify/publishShared.js";
import { makePrimary, replaceItem } from "../components/shopify/mediaEdits.js";

export const SHOPIFY_IMAGES_FROM_MS = Date.parse("2026-10-28T00:00:00+02:00");

/** Is the Shopify side of a photo change switched on now? PURE. */
export function shopifyImagesOn(nowMs, config) {
  if (config?.shopifyImagesOff === true) return false;
  const from = Number(config?.shopifyImagesFrom) > 0 ? Number(config.shopifyImagesFrom) : SHOPIFY_IMAGES_FROM_MS;
  return Number(nowMs) >= from;
}

/**
 * The publishing list with `newUrl` as its first photo, or null when there is
 * nothing to do (no own list, already first, no photo). PURE.
 * Already in the list → moved to the front; otherwise it takes the old
 * primary's place (the old one stays in the app's photo history).
 */
export function followItems(node, newUrl) {
  if (!newUrl || !node || (node.media == null && node.photos == null)) return null;
  const { items, source } = resolveMediaList(node, null);
  if (source === "record" || !Array.isArray(items) || !items.length) return null;
  const first = items.findIndex((m) => m.type === "photo");
  if (first < 0 || items[first].url === newUrl) return null;
  const at = items.findIndex((m) => m.type === "photo" && m.url === newUrl);
  if (at > 0) return makePrimary(items, at);
  return replaceItem(items, items[first].url, lazyPhotoItem(newUrl, "app"));
}

/**
 * Is the Meta-ready version used as the FIRST image of a NEW Shopify product
 * now? Same date, its own switch (/config/primaryPhoto/metaReadyOff,
 * metaReadyFrom). Existing listings' images are never touched by it. PURE.
 */
export function metaReadyOn(nowMs, config) {
  if (config?.metaReadyOff === true) return false;
  const from = Number(config?.metaReadyFrom) > 0 ? Number(config.metaReadyFrom) : SHOPIFY_IMAGES_FROM_MS;
  return Number(nowMs) >= from;
}
