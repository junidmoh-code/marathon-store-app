// ── /shopify_publish/{productId} — the publishing-state node ─────────────────
// One node per product (owner decision 2026-08-13), SEPARATE from the
// /shopify_sync ID map: sync records WHAT exists on Shopify, publish records
// WHERE a product is in the human pipeline:
//
//   /shopify_publish/{productId} = {
//     state:            "none" | "nominated" | "draft" | "live" | "blocked",
//     cleanName:        string,                  // the compliant listing title
//     cleanNameSource:  "lexicon" | "ai" | "manual",
//     condition:        one of CONDITIONS (compliance.mjs) — NO default,
//     updatedAt:        epoch ms,
//     updatedBy:        uid or "script:<name>",
//   }
//
// Console rules (already pasted by the owner, NOT in database.rules.json):
// read = any non-anonymous user; write = Junid or stockRole admin. Admin SDK
// scripts bypass rules but keep to the same field set so the card and the
// scripts always agree on shape.
//
// WRITE DISCIPLINE: every write here is a MERGE (update()), never set() — a
// script caching a cleanName must not clobber a condition Junid just set from
// the card, and vice versa. cachePublishName never overwrites an existing
// cleanName: a name is generated once and never regenerated (AI is
// non-deterministic; a re-run must not silently change a reviewed title).
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const PUBLISH_STATES = ["none", "nominated", "draft", "live", "blocked"];

export async function readPublishNode(db, productId) {
  assertSafeSegment(productId, "productId");
  return (await db.ref(`shopify_publish/${productId}`).get()).val();
}

export async function readAllPublishNodes(db) {
  return (await db.ref("shopify_publish").get()).val() || {};
}

// Cache a generated/typed clean name. Returns "cached" | "kept-existing".
export async function cachePublishName(db, productId, { cleanName, source, updatedBy }) {
  assertSafeSegment(productId, "productId");
  const ref = db.ref(`shopify_publish/${productId}`);
  const existing = (await ref.get()).val();
  if (existing?.cleanName) return "kept-existing";
  await ref.update({
    cleanName: String(cleanName),
    cleanNameSource: source,
    updatedAt: Date.now(),
    updatedBy,
  });
  return "cached";
}

export async function setPublishState(db, productId, state, updatedBy) {
  assertSafeSegment(productId, "productId");
  if (!PUBLISH_STATES.includes(state)) throw new Error(`invalid publish state: ${state}`);
  await db.ref(`shopify_publish/${productId}`).update({
    state,
    updatedAt: Date.now(),
    updatedBy,
  });
}
