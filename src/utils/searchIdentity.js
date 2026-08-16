// ─── SEARCH IDENTITY — the true name, kept where renaming cannot reach it ────
// What a shopper types is the BRAND: "gripshot", "samba", "air force". None of
// those words may exist on Shopify, so the storefront search matches against
// the app's own record instead. Today that means `/products/{pid}.name`, which
// is brand-first and true for 95% of live stock.
//
// ── WHY THIS FIELD EXISTS ────────────────────────────────────────────────────
// Because `name` is about to be rewritten. The vision namer renames products
// from their photos, and the existing Review-Names flow already writes an
// approved name straight onto the record. If the only copy of the brand lives
// in the field being rewritten, the first big rename run DESTROYS SEARCH for
// everything it touches — silently, and with no way back.
//
// So the searchable identity gets its own node, `/product_identity/{pid}`, and
// the rule is structural rather than a promise: NO RENAMING PATH WRITES HERE.
// A rename writes the public name and nothing else. Identity is seeded once
// from what the record already knew, and after that only ever improves.
//
// ── INTERNAL. NEVER LEAVES THE SYSTEM ────────────────────────────────────────
// This is the brand, in plain text. It never reaches Shopify in any field, and
// the search endpoint never returns it — it is MATCHED AGAINST, not displayed.
// The endpoint's `publicResult` is an allow-list that cannot carry it, and the
// brand-leak test covers every field defined here.
//
// ── PRECEDENCE: A GUESS NEVER BEATS KNOWLEDGE ────────────────────────────────
// Three sources, ranked. A write only lands when it outranks what is already
// there, so a vision guess can fill an empty slot or replace an older guess but
// can never overwrite supplier data or a human's correction.
//
//   manual  — Junid typed or corrected it. Always wins, always final.
//   record  — the name the product was received under: supplier data, entered
//             by staff off the box. This is what the migration seeds.
//   vision  — read off the photo by a model. A GUESS, and marked as one, with
//             the model's own confidence recorded beside it.

export const SEARCH_IDENTITY_PATH = "product_identity";

export const IDENTITY_SOURCES = ["manual", "record", "vision"];

// Rank, not confidence. Confidence only orders two VISION guesses against each
// other; it can never lift a guess above supplier data, however sure the model
// claims to be. A model that is confidently wrong is the failure mode this
// ranking exists to contain.
const SOURCE_RANK = { manual: 3, record: 2, vision: 1 };

export function identityRank(source) {
  return SOURCE_RANK[source] ?? 0;
}

/**
 * May `incoming` replace `existing`? → true / false.
 *
 * Rules, in order:
 *   • nothing there            → yes (anything beats nothing)
 *   • incoming has no text     → no (never blank an identity out)
 *   • higher-ranked source     → yes
 *   • lower-ranked source      → NO. This is the load-bearing one: a vision
 *                                guess must not overwrite supplier data.
 *   • same source, both vision → only if strictly more confident
 *   • same source, otherwise   → yes (a re-run of the same kind of write is a
 *                                correction, not a downgrade)
 */
export function shouldReplaceIdentity(existing, incoming) {
  const text = String(incoming?.text ?? "").trim();
  if (!text) return false;
  if (!existing || !String(existing.text ?? "").trim()) return true;
  const a = identityRank(existing.source);
  const b = identityRank(incoming.source);
  if (b > a) return true;
  if (b < a) return false;
  if (incoming.source === "vision") {
    return Number(incoming.confidence ?? 0) > Number(existing.confidence ?? 0);
  }
  return true;
}

/**
 * The identity a product ALREADY has, from its own record — what the migration
 * seeds and what `updateProductName` preserves before a rename lands.
 * Returns null when there is nothing worth keeping.
 */
export function buildRecordIdentity(product, { at = null, by = "migration" } = {}) {
  const text = String(product?.name ?? "").trim();
  if (!text) return null;
  const brand = String(product?.brand ?? "").trim();
  return {
    text,
    source: "record",
    confidence: null,
    ...(brand ? { brand } : {}),
    capturedAt: at,
    capturedBy: by,
  };
}

/**
 * The text the search index should MATCH on for this product.
 * Falls back to the record's name while the migration is incomplete, so search
 * never gets worse than it is today — but once identity exists it wins, because
 * by then `name` may be a rewritten public name with no brand left in it.
 */
export function identityTextFor(identity, product) {
  const stored = String(identity?.text ?? "").trim();
  if (stored) return stored;
  return String(product?.name ?? "").trim();
}

/**
 * The extra words worth matching that are not already in the identity text —
 * the structured fields a vision pass fills in. Deduped against the text so a
 * brand that is already in the sentence is not weighted twice.
 */
export function identityExtras(identity) {
  const text = String(identity?.text ?? "").toLowerCase();
  const parts = [identity?.brand, identity?.model, identity?.colourway]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .filter((s) => !text.includes(s.toLowerCase()));
  return [...new Set(parts)].join(" ");
}

/** Is this identity a machine guess a human has not confirmed? */
export function isUnreviewedGuess(identity) {
  return !!identity && identity.source === "vision" && identity.reviewedAt == null;
}
