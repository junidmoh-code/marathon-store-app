// ─── STYLE CODE GATE — THE THREE DECISIONS, IN PURE FORM ─────────────────────
// Extracted from StyleCodeGate.jsx so each one can be proven rather than
// eyeballed. All three exist to stop the gate from GUESSING.
//
//   resolveAddStockTarget   which product does stock go to?
//   classifyLookupOutcome   did the lookup fail, or did it answer "nothing"?
//   labelPhotoEvidence      is this photo still evidence for this code?
//
// Every one of them fails CLOSED: when the answer is not certain, they say so
// and the UI refuses the action, rather than picking something plausible.

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHERE DOES THE STOCK GO?
// ─────────────────────────────────────────────────────────────────────────────
// ── WHY THIS IS THE MOST DANGEROUS DECISION IN THE FLOW ──────────────────────
// Routing stock to the wrong product is SILENT COUNT CORRUPTION. It is a worse
// outcome than the duplicate product this whole feature exists to prevent: a
// duplicate is visible in the catalogue and can be merged, whereas units added
// to the wrong twin look exactly like a normal receipt and surface weeks later
// as a shoe that is somehow always short. This shop has already been bitten
// twice by a twin-identity bug deducting the wrong product.
//
// So there is no default and no first-match fallback. Either the target is
// CERTAIN, or the operator picks explicitly, or the action is refused.
//
// Certainty, in order:
//   • THE CLAIM. /style_code_index is the authority on who owns a code, so a
//     loaded claim settles it outright — even when the legacy scan also
//     returned rows, because those are stamped records, not ownership.
//   • A SOLE loaded scan match, when there is no claim.
//   • The operator's explicit choice, validated against the real options.
// Anything else is blocked.

export const TARGET_READY = "ready";
export const TARGET_CHOOSE = "choose";
export const TARGET_BLOCKED = "blocked";

export const BLOCK_NO_TARGET = "no-target";
export const BLOCK_CLAIM_UNAVAILABLE = "claim-product-unavailable";
export const BLOCK_PRODUCT_UNAVAILABLE = "product-unavailable";

/**
 * @param {object} args
 *   claim            { productId } from /style_code_index, or null
 *   existingProducts rows the /products scan returned
 *   products         the catalogue actually loaded on this device
 *   selectedId       what the operator tapped, if anything
 *
 * @returns {{kind:"ready", productId:string, basis:string}
 *          |{kind:"choose", options:string[]}
 *          |{kind:"blocked", reason:string}}
 */
export function resolveAddStockTarget({ claim, existingProducts, products, selectedId } = {}) {
  const loaded = Array.isArray(products) ? products.filter(Boolean) : [];
  const isLoaded = (id) => !!id && loaded.some((p) => p && p.id === id);
  const scan = (Array.isArray(existingProducts) ? existingProducts : []).filter((p) => p && p.id);
  const claimId = claim && typeof claim.productId === "string" && claim.productId ? claim.productId : null;

  // ── The claim is the authority ──
  // A loaded claim settles the target even if the scan found other rows: those
  // are products STAMPED with the code, which is a different fact from owning
  // it. If the claim names a product this device cannot see, we cannot verify
  // anything about it — refuse rather than fall back to a scan row.
  if (claimId) {
    if (isLoaded(claimId)) return { kind: TARGET_READY, productId: claimId, basis: "claim" };
    return { kind: TARGET_BLOCKED, reason: BLOCK_CLAIM_UNAVAILABLE, productId: claimId };
  }

  if (!scan.length) return { kind: TARGET_BLOCKED, reason: BLOCK_NO_TARGET };

  // ── Exactly one match: certain, provided we can actually see it ──
  if (scan.length === 1) {
    if (isLoaded(scan[0].id)) return { kind: TARGET_READY, productId: scan[0].id, basis: "sole-match" };
    return { kind: TARGET_BLOCKED, reason: BLOCK_PRODUCT_UNAVAILABLE, productId: scan[0].id };
  }

  // ── Two or more: the operator MUST choose. No default, ever. ──
  // This is the duplicate case, and it is precisely where picking the first
  // match silently corrupts a count.
  const options = scan.map((p) => p.id);
  if (selectedId && options.includes(selectedId) && isLoaded(selectedId)) {
    return { kind: TARGET_READY, productId: selectedId, basis: "operator-selected" };
  }
  return { kind: TARGET_CHOOSE, options };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DID THE LOOKUP FAIL, OR DID IT ANSWER "NOTHING"?
// ─────────────────────────────────────────────────────────────────────────────
// These two must be distinguishable EVERYWHERE they surface. "Not in the
// catalogue" is a claim we may only make when the lookup actually succeeded and
// came back empty. Saying it after a failure tells the operator something we do
// not know, and the create-new path they are then offered produces exactly the
// duplicate product this feature exists to prevent.
//
// So a degraded lookup reads as UNKNOWN and is offered no create path — only
// retry. This mirrors the rule the resolver already enforces server-side: a
// dead vendor is never reported as "no such shoe".

export const STEP_ORPHAN = "orphan";
export const STEP_EXISTING = "existing";
export const STEP_FOUND = "found";
export const STEP_UNAVAILABLE = "unavailable";
export const STEP_UNKNOWN = "unknown";

/**
 * @param {object} args
 *   data   the resolveStyleCode payload (ignored when `threw`)
 *   threw  true when the callable itself rejected
 */
export function classifyLookupOutcome({ data, threw } = {}) {
  // The callable never answered. We know nothing at all.
  if (threw) return STEP_UNAVAILABLE;

  const d = data || {};
  const existing = Array.isArray(d.existingProducts) ? d.existingProducts : [];

  // A local answer outranks a degraded remote one: if we already hold this
  // product, a broken vendor tier changes nothing about what to do next.
  if (d.claimOrphaned) return STEP_ORPHAN;
  if (d.claim || existing.length) return STEP_EXISTING;
  if (d.found) return STEP_FOUND;

  // Nothing local, nothing found — now the distinction matters. A tier that was
  // BROKEN means we did not really look, so we must not say "not in the
  // catalogue" and must not offer to create a new product.
  if ((Array.isArray(d.errors) ? d.errors : []).length) return STEP_UNAVAILABLE;

  return STEP_UNKNOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. IS THIS PHOTO STILL EVIDENCE FOR THIS CODE?
// ─────────────────────────────────────────────────────────────────────────────
// A label photo is evidence for ONE code — the one it was read from. If it
// travels onto a different code it stops being evidence and becomes a lie about
// which shoe was inspected, which defeats the entire purpose of storing it.
//
// The binding is only valid when BOTH halves are present AND the code still
// matches. The component clears `photoForCode` at the START of a retake, so a
// retake that FAILS cannot leave a new photo paired with the previous code —
// that was the gap the first version of this guard left open.

export function labelPhotoEvidence({ labelPhoto, photoForCode, normalised } = {}) {
  if (!labelPhoto || !photoForCode || !normalised) return null;
  return photoForCode === normalised ? labelPhoto : null;
}
