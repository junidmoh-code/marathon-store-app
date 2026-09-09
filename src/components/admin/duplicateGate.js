// ─── THE DUPLICATE GATE — THE TWO DECISIONS, IN PURE FORM ────────────────────
// Extracted from the panel and from AdminView so each one can be proven rather
// than eyeballed, exactly as styleCodeGateLogic.js does for the sneaker gate.
//
//   resolveDuplicateChoice   one code, one product — or the operator chooses
//   createAnywayPrompt       what the operator must read before making a twin
//   splitPrefillSizes        what survives the handoff into an existing product
//
// ─────────────────────────────────────────────────────────────────────────────
// 1. ONE CODE MUST NOT MEAN TWO PRODUCTS
// ─────────────────────────────────────────────────────────────────────────────
// This is the CONSISTENCY RULE, and it is the same rule resolveAddStockTarget
// enforces one screen over: a SOLE exact match is CERTAIN, so it is resolved
// automatically and shown as a banner, not offered as a choice.
//
// The reason is not convenience. Three shops receive the same delivery. If
// "44712" is presented to each of them as a list to pick from, three people make
// three independent judgement calls, and the same printed code ends up routed to
// two different products — which is silent count corruption, the failure the
// style-code work calls worse than the duplicate itself (see the header of
// styleCodeGateLogic.js). A choice offered where there is only one right answer
// is a choice that can be got wrong.
//
// A GENUINE TIE — two or more products already answering to the same code — is
// the one case where a human must decide, because the catalogue is already
// inconsistent and no rule here can fix that. Then, and only then, a picker.
//
// The override link is NOT a choice: it is an escape, it takes an extra tap, and
// it exists because a rule that cannot be overridden is a rule that blocks the
// shop floor. Fails toward "people can do their job" — deliberately the opposite
// of how the count-corruption guards fail.

import { TIER_EXACT_CODE } from "../../utils/productDupMatch.js";

export const DUP_NONE = "none";        // nothing certain — show the panel as a panel
export const DUP_RESOLVED = "resolved"; // exactly one; the banner names it
export const DUP_CHOOSE = "choose";     // a genuine tie; the operator must pick

/**
 * @param {Array} rows  rankCandidates output
 * @returns {{kind:"none"}
 *          |{kind:"resolved", row:object}
 *          |{kind:"choose", rows:Array}}
 */
export function resolveDuplicateChoice(rows) {
  const exact = (Array.isArray(rows) ? rows : []).filter((r) => r && r.tier === TIER_EXACT_CODE);
  if (exact.length === 1) return { kind: DUP_RESOLVED, row: exact[0] };
  if (exact.length > 1) return { kind: DUP_CHOOSE, rows: exact };
  return { kind: DUP_NONE };
}

/** Just the exact-code rows. Used at save time, where the panel's debounced view
 *  is not authoritative — the gate re-derives from the name being saved. */
export function exactRowsOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.tier === TIER_EXACT_CODE);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. A SECOND RECORD FOR THE SAME CODE IS A DELIBERATE ACT
// ─────────────────────────────────────────────────────────────────────────────
// Only against an EXACT code match. A fuzzy name overlap is a suggestion and
// gets no confirm at all — putting a dialog in front of a guess trains the
// operator to dismiss dialogs, which is how the one that mattered gets dismissed
// too.
//
// The sentence NAMES THE PRODUCT and its unit count, because "this may be a
// duplicate" is a sentence nobody can act on. "44712 already exists as Mens
// Fleece Tracksuit with 14 units" is one they can check against the rail in
// front of them.
//
// A unit count we could not read is reported as UNKNOWN, never as 0 — the same
// rule the panel and networkTotalsStore hold: "0 units" reads as "dead record,
// safe to replace", which is the exact wrong conclusion to invite here.

/**
 * Can a unit total be READ at all right now?
 *
 * The location registry is a live subscription. Before it answers — or if it
 * fails — the set of locations to sum over is EMPTY, and summing over no
 * locations returns a confident `{ total: 0 }` (networkTotalsCore.sumProduct of
 * an empty map). That number would then be printed as "with 0 units", which is
 * the single most dangerous sentence this confirm could show: 0 units reads as
 * "dead record, safe to replace", and pushes the operator toward creating
 * exactly the duplicate the dialog exists to prevent.
 *
 * So an empty location set is UNKNOWN, never zero. Same rule the panel and
 * networkTotalsStore already hold for a failed read; this is the third way the
 * same wrong number could have been produced.
 */
export function totalsKnowable(locationIds) {
  return Array.isArray(locationIds) && locationIds.length > 0;
}

/**
 * @param {string} typed        the name about to be saved
 * @param {Array}  exactRows    rankCandidates rows, exact tier only
 * @param {object} totalsById   { [productId]: {total} | null } — null = unknown
 * @returns {string|null}       null when there is nothing to confirm
 */
export function createAnywayPrompt(typed, exactRows, totalsById = {}) {
  const rows = exactRowsOf(exactRows);
  if (!rows.length) return null;
  const name = String(typed || "").trim();
  const describe = (r) => {
    const t = totalsById[r.product.id];
    const units = t && Number.isFinite(t.total)
      ? `${t.total} unit${t.total === 1 ? "" : "s"}`
      : "an unknown number of units";
    return `${r.product.name || "an unnamed product"} with ${units}`;
  };
  const which = rows.length === 1
    ? describe(rows[0])
    : rows.map(describe).join(", and as ");
  return `${name} already exists as ${which}.\n\nCreate a second product anyway?`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE HANDOFF LOSES NOTHING SILENTLY
// ─────────────────────────────────────────────────────────────────────────────
// Picking a suggestion carries the operator into the EXISTING receive-stock path
// for that product, with the location and quantities they had already typed.
// But the sizes they typed came from the CATEGORY they chose on the add form,
// and the product they picked has its own size list. Those two can differ — an
// apparel category offering XXXL against a product stocked S–XL, say.
//
// The receive path drops a quantity for a size the product does not have. That
// is correct (it must not invent a stock cell), but if it happens silently the
// operator receives eleven units believing they received fourteen, and the
// difference surfaces weeks later as a shortfall nobody can explain.
//
// So the split is explicit and the caller is expected to SHOW what was dropped.

/**
 * @param {object} qtys          { size: "n" } as typed on the add form
 * @param {Array}  productSizes  the sizes the target product actually has
 * @returns {{carried: object, dropped: string[]}}
 *   carried — entries whose size the product has AND whose quantity is a real
 *             positive number (a blank or a 0 carries nothing and is not a loss)
 *   dropped — sizes with a real positive quantity that the product cannot hold
 */
export function splitPrefillSizes(qtys, productSizes) {
  const have = new Set((Array.isArray(productSizes) ? productSizes : []).map(String));
  const carried = {};
  const dropped = [];
  for (const [size, raw] of Object.entries(qtys || {})) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (have.has(String(size))) carried[size] = String(n);
    else dropped.push(String(size));
  }
  dropped.sort();
  return { carried, dropped };
}
