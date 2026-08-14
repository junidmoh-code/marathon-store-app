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
