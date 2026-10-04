// ─── NEW ARRIVALS — THE PRODUCT'S CURRENT SOURCE PHOTO (one rule, one copy) ──
// The "original" a New Arrivals item shows, and the photo Gemini is given, is
// the product's photo AS IT IS NOW — read from the product every time, never a
// copy kept on the queue item. (Until 4 Oct the item pinned products/{pid}/
// photoUrl at the moment it entered New; a photo replaced in admin afterwards
// was never seen by the card, the generator or the approval chain.)
//
// A staff photo always lives at products/{pid}/photo.jpg (productPhotoPaths:
// a re-shoot overwrites that object and gets a new download token, so the URL
// changes). An APPROVED generated photo replaces products/{pid}/photoUrl and
// sets photoUrlOriginal to the staff photo it replaced. So:
//   photoUrl is the staff photo        → that is the source (a re-shoot after
//                                        an approval lands here too);
//   photoUrl is an approved generated  → the source is photoUrlOriginal;
//   neither (an older record)          → photoUrl, else the item's old pin.
//
// Dependency-free CommonJS: required by core.cjs (the callables) and imported
// by studio/studio.mjs (the generator) and scripts/newArrivals/chainCore.mjs
// (the approval chain on the Mac mini).
"use strict";

const CLOCK_SLACK_MS = 60_000;

/** The Storage object path inside a Firebase download URL, or null. Pure. */
function objectPath(url) {
  try {
    const m = /\/o\/([^?]+)/.exec(new URL(String(url)).pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/** Is this URL the product's own staff photo (products/{pid}/photo.jpg)? Pure. */
function isStaffPhoto(pid, url) {
  return !!pid && !!url && objectPath(url) === `products/${pid}/photo.jpg`;
}

/**
 * The product's CURRENT source photo — what the card shows as "Original" and
 * what a generation starts from. `item` is only the last resort (an older
 * record with no photo on the product). Pure.
 */
function currentSourceUrl(pid, product, item = null) {
  const p = product || {};
  if (isStaffPhoto(pid, p.photoUrl)) return String(p.photoUrl);
  if (p.photoUrlOriginal && !isGeneratedPhoto(p.photoUrlOriginal)) return String(p.photoUrlOriginal);
  // An older record's photo, stored elsewhere — but NEVER a generated photo: that is not a source.
  if (p.photoUrl && !isGeneratedPhoto(p.photoUrl)) return String(p.photoUrl);
  return item && item.originalUrl && !isGeneratedPhoto(item.originalUrl) ? String(item.originalUrl) : null;
}

/** Is this URL one of the New Arrivals GENERATED photos (products/{pid}/new_arrivals/…)? Pure. */
function isGeneratedPhoto(url) {
  const p = objectPath(url);
  return !!p && /^products\/[^/]+\/new_arrivals\//.test(p);
}

/**
 * Was this generation made from a photo the product no longer shows?
 * By the source it recorded (a different address now), or by time — the
 * product's photo was replaced (photoUpdatedAt, stamped by human uploads
 * only) after the generation was made. Pure.
 */
function generationIsStale(gen, { sourceUrl = null, photoUpdatedAt = null } = {}) {
  if (!gen || typeof gen !== "object") return false;
  // EITHER sign is enough: a different source address, or a replacement stamped
  // after it was made (an overwrite can keep the same address).
  if (gen.sourceUrl && sourceUrl && String(gen.sourceUrl) !== String(sourceUrl)) return true;
  // A minute's slack: the two stamps come from different clocks (the function's
  // and the uploading device's estimate of server time) — the same slack the
  // generator's own freshness rule uses. A real replacement comes minutes later.
  const at = Number(gen.at) || 0, changed = Number(photoUpdatedAt) || 0;
  return at > 0 && changed > at + CLOCK_SLACK_MS;
}

module.exports = { CLOCK_SLACK_MS, objectPath, isStaffPhoto, isGeneratedPhoto, currentSourceUrl, generationIsStale };
