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

// The most photos one publishing set may hold. Shopify's media read-back in
// reconcile.mjs pages at 50 and refuses an unpaginated set — 20 keeps every
// product far inside that while being more angles than any listing needs.
export const MAX_PUBLISH_PHOTOS = 20;

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
    if (typeof u === "string" && u.trim() !== "" && !out.includes(u)) out.push(u);
  }
  return out.length ? out : null;
}
