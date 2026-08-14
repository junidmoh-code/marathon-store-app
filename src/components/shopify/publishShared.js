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
