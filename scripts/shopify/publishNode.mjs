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
// The never-overwrite guarantee is a TRANSACTION on the cleanName child — a
// read-then-update here would let an AI run and a card save both observe
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

export async function setPublishState(db, productId, state, updatedBy) {
  assertSafeSegment(productId, "productId");
  if (!PUBLISH_STATES.includes(state)) throw new Error(`invalid publish state: ${state}`);
  await db.ref(`shopify_publish/${productId}`).update({
    state,
    updatedAt: Date.now(),
    updatedBy,
  });
}
