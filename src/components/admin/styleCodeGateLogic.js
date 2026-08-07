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
// 1b. ORDERING CANDIDATES BY THE LABEL'S OWN COLOURWAY LINE
// ─────────────────────────────────────────────────────────────────────────────
// Some labels (RTFKT-style Nike) print a colourway line — "WOLF GREY/PHOTO
// BLUE". When a code resolves to several products, that line can put the
// likely match FIRST. Ordering is this function's ENTIRE effect (owner spec
// 2026-08-07): it never selects, never filters, never breaks resolveAddStock-
// Target's fail-closed rules — the operator still taps the shoe they hold.
// Matching is bag-of-words overlap against the candidate's name and its own
// stored labelColorway; zero-overlap candidates keep their original order.

export function orderCandidatesByColourway(candidates, colourway) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  const words = String(colourway || "").toUpperCase().split(/[^A-Z]+/).filter((w) => w.length >= 3);
  if (!words.length) return list;
  const score = (p) => {
    const hay = `${p && p.name ? p.name : ""} ${p && p.labelColorway ? p.labelColorway : ""}`.toUpperCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  return list
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((x, y) => (y.s - x.s) || (x.i - y.i)) // stable — ties keep their order
    .map((x) => x.c);
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


// ─────────────────────────────────────────────────────────────────────────────
// 4. IS THIS CATEGORY ASKED FOR A STYLE CODE AT ALL?
// ─────────────────────────────────────────────────────────────────────────────
// The gate used to run BEFORE the operator said what they were adding, which
// made every non-sneaker product impossible to create. Category comes first now,
// and only an ENFORCED category sees the gate.
//
// FAILS OPEN, on purpose. This list decides whether someone is allowed to do
// their job, so every unreadable, malformed or missing input resolves to "not
// enforced" — the failure mode must be "people can add products", never the
// reverse. That is the opposite of how the duplicate guards fail, and
// deliberately so: a wrong product is recoverable, a blocked shop floor is not.

/**
 * @param {string} categoryKey  the chosen registry key, e.g. "sneakers"
 * @param {unknown} enforced    the live list from /config/styleCode
 */
export function isCategoryEnforced(categoryKey, enforced) {
  if (typeof categoryKey !== "string" || !categoryKey) return false;
  if (!Array.isArray(enforced)) return false;
  return enforced.some((k) => typeof k === "string" && k === categoryKey);
}

/**
 * Normalise whatever /config/styleCode/enforcedCategories holds into a usable
 * list. Absent, wrong-typed or empty → the default. A list containing junk keeps
 * only the strings, so one bad entry cannot disable the whole gate.
 */
export function readEnforcedCategories(configValue, fallback) {
  const def = Array.isArray(fallback) ? fallback : [];
  if (!configValue || typeof configValue !== "object") return def;
  const raw = configValue.enforcedCategories;
  if (!Array.isArray(raw)) return def;
  const clean = raw.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim());
  return clean.length ? clean : def;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. MAY THIS BYPASS BE COMPLETED?
// ─────────────────────────────────────────────────────────────────────────────
// Two preconditions, and both exist for the same reason: an exempt product gets
// NO /style_code_index claim, so the name-based duplicate check is the ONLY
// duplicate protection it will EVER have. Skipping it does not defer the
// problem, it removes it permanently.
//
//   • a REASON from the fixed list — so the bypass rate is countable, and
//     "no code exists" stays distinguishable from "I can't read the code"
//   • the operator must have SEEN the duplicate search results for the name
//     they are adding — not merely triggered a search, but had it come back

export const BYPASS_NEEDS_NAME = "needs-name";
export const BYPASS_NEEDS_DUPLICATE_CHECK = "needs-duplicate-check";
export const BYPASS_NEEDS_REASON = "needs-reason";
export const BYPASS_READY = "ready";

/**
 * @param {object} args
 *   name              what the operator typed as the product name
 *   duplicatesShown   true only once the search has RETURNED for that exact name
 *   searchedName      the name the results belong to — guards against typing on
 *                     after the search, which would show results for a different
 *                     product than the one being created
 *   reason            selected reason key
 *   validReasons      the allowed set
 */
export function bypassReadiness({ name, duplicatesShown, searchedName, reason, validReasons } = {}) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 3) return BYPASS_NEEDS_NAME;
  // The results must belong to the name being submitted. Otherwise an operator
  // can search "Nike", read "no matches", retype "Gucci Ace" and bypass on the
  // strength of a search that never looked at Gucci.
  if (!duplicatesShown || String(searchedName || "").trim() !== trimmed) return BYPASS_NEEDS_DUPLICATE_CHECK;
  const allowed = Array.isArray(validReasons) ? validReasons : [];
  if (typeof reason !== "string" || !allowed.includes(reason)) return BYPASS_NEEDS_REASON;
  return BYPASS_READY;
}
