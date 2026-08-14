// ── /shopify_publish/{productId} — the publishing-state node ─────────────────
// One node per product (owner decision 2026-08-13), SEPARATE from the
// /shopify_sync ID map: sync records WHAT exists on Shopify, publish records
// WHERE a product is in the human pipeline. State model of 2026-08-14 — the
// old none/nominated/draft chain is collapsed:
//
//   /shopify_publish/{productId} = {
//     state:            "awaiting" | "live" | "blocked",
//     liveState:        "on" | "off",            // CONFIRMED channel state, live products only
//     desiredState:     "on" | "off",            // INTENT written by the page; reconciler applies
//     blockedReason:    string,                  // reconciler's apply-time refusal, blocked only
//     cleanName:        string,                  // the compliant listing title
//     cleanNameSource:  "lexicon" | "ai" | "manual",
//     nameApprovedAt:   epoch ms,                // name signed off in the review page
//     condition:        one of CONDITIONS (compliance.mjs) — NO default,
//     photos:           [url, …],                // PUBLISHING photo set, ordered, first = primary.
//                                                // Optional — absent means "use the record's
//                                                // photoUrl + gallery". Photos are a publishing
//                                                // concern: NEVER written to /products.
//     liveAt:           epoch ms,                // when the product last went ON (reconciler stamp)
//     adminUrl:         string,                  // Shopify admin link (reconciler stamp)
//     updatedAt:        epoch ms,
//     updatedBy:        uid or "script:<name>",
//   }
//
// The page writes desiredState ONLY (plus name/condition fields); state and
// liveState are written back by scripts/shopify/reconcile.mjs once Shopify
// confirms. desiredState ≠ confirmed ⇒ the row shows pending. The browser
// NEVER calls Shopify — it cannot hold the client secret.
//
// Console rules (pasted by the owner, NOT in database.rules.json): read = any
// non-anonymous user; write = Junid or stockRole admin. Admin SDK scripts
// bypass rules but keep to the same field set so the page and the scripts
// always agree on shape.
//
// WRITE DISCIPLINE: every write here is a MERGE (update()), never set() — a
// script confirming a liveState must not clobber a condition Junid just set
// from the page, and vice versa. cachePublishName never overwrites an existing
// cleanName: a name is generated once and never regenerated (AI is
// non-deterministic; a re-run must not silently change a reviewed title).
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const PUBLISH_STATES = ["awaiting", "live", "blocked"];

export async function readPublishNode(db, productId) {
  assertSafeSegment(productId, "productId");
  return (await db.ref(`shopify_publish/${productId}`).get()).val();
}

export async function readAllPublishNodes(db) {
  return (await db.ref("shopify_publish").get()).val() || {};
}

// Cache a generated/typed clean name. Returns "cached" | "kept-existing".
// The never-overwrite guarantee is a TRANSACTION on the cleanName child — a
// read-then-update here would let an AI run and a page save both observe
// "no name" and the later write clobber the earlier reviewed one.
export async function cachePublishName(db, productId, { cleanName, source, updatedBy }) {
  assertSafeSegment(productId, "productId");
  const nameRef = db.ref(`shopify_publish/${productId}/cleanName`);
  const result = await nameRef.transaction((cur) =>
    cur === null ? String(cleanName) : undefined
  );
  if (!result.committed) return "kept-existing";
  await db.ref(`shopify_publish/${productId}`).update({
    cleanNameSource: source,
    updatedAt: Date.now(),
    updatedBy,
  });
  return "cached";
}

// The reconciler's confirmation write: Shopify now agrees the product is
// on/off, so record it and let the page's pending marker clear. desiredState
// is deliberately NOT touched — it is the page's field; leaving it in place
// keeps the write idempotent (desired == confirmed ⇒ no diff next run).
//
// The optional gid lets the page show the row's Shopify admin link without a
// /shopify_sync read (adminUrl rides the node's $other clause); liveAt stamps
// the moment the product last WENT ON — the fact Junid asked the Live view to
// show. Both are best-effort extras: an older caller without them still
// confirms correctly, the row just shows no link/date yet.
// clearAdminUrl: the caller KNOWS no Shopify product exists (e.g. confirming
// off with no /shopify_sync mapping) — a link stamped in an earlier life
// would now point at nothing, so it is removed rather than preserved.
export async function confirmLiveState(db, productId, liveState, updatedBy, { gid = null, clearAdminUrl = false } = {}) {
  assertSafeSegment(productId, "productId");
  if (liveState !== "on" && liveState !== "off") throw new Error(`invalid liveState: ${liveState}`);
  const numericId = gid ? String(gid).split("/").pop() : null;
  await db.ref(`shopify_publish/${productId}`).update({
    state: "live",
    liveState,
    blockedReason: null,
    ...(numericId ? { adminUrl: `https://admin.shopify.com/store/nu3ei8-0p/products/${numericId}` } : {}),
    ...(!numericId && clearAdminUrl ? { adminUrl: null } : {}),
    ...(liveState === "on" ? { liveAt: Date.now() } : {}),
    updatedAt: Date.now(),
    updatedBy,
  });
}

// The reconciler's refusal write: the apply-time validator said no. The
// intent is cleared back to "off" so the refusal doesn't retry forever —
// after fixing the cause, the page re-expresses it (blocked → awaiting via
// the condition chips, or Publish again).
export async function markBlocked(db, productId, reason, updatedBy) {
  assertSafeSegment(productId, "productId");
  await db.ref(`shopify_publish/${productId}`).update({
    state: "blocked",
    blockedReason: String(reason),
    desiredState: "off",
    updatedAt: Date.now(),
    updatedBy,
  });
}
