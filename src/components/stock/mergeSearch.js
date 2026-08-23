// ─── THE MERGE TARGET SEARCH — nothing is unreachable ────────────────────────
// (Owner spec 2026-08-23: "Some products cannot be found by name in the merge
// target search at all, so their duplicate can never be merged.")
//
// WHAT WAS FILTERING THE PICKER, AND WHAT IS LEFT
//
// The picker's pool and its search sat in MergeProducts.jsx. Every constraint
// that was on it, and its fate:
//
//   KEPT  merged-away products are never offered (utils/mergedProducts
//         isMergedAway). A record that is already a redirect cannot be a merge
//         target; offering one would build a chain.
//   KEPT  the loser itself is never offered. A product cannot merge into
//         itself, and the server refuses it anyway.
//   KEPT  FOOTWEAR ONLY, via the existing cross-app classifier
//         (utils/footwearLine.js productIsFootwear) — the owner's explicit
//         instruction. See the note below on what that admits, and on the one
//         case where the pool is deliberately NOT footwear-restricted.
//   GONE  the RESULT CAP. searchProducts was called with { limit: 12 }: a
//         search that matched thirty products showed twelve and said nothing
//         about the other eighteen, so a twin ranked thirteenth was
//         unreachable by scrolling, by typing more, by anything. The search is
//         now uncapped and the SCREEN pages it.
//   GONE  the empty-query dead end. `searchProducts` returns [] for an empty
//         query, so before a label read the screen offered nothing at all.
//         An empty query now lists the whole offerable pool, paged.
//   GONE  name-only matching. A code read off a tongue label, or a word off
//         it, now finds the product (see matchesQuery below).
//
// There was NO stock-holding filter, NO photo filter, NO coded/uncoded filter
// and NO location filter on this picker to remove — those live on OTHER
// surfaces (the register pass's registerSearchPool, the Leftovers list itself)
// and are untouched. What made products unreachable here was the cap, the
// empty-query dead end, and the missing code/alias matching.
//
// ── WHAT THE FOOTWEAR CLASSIFIER ADMITS ──────────────────────────────────────
// productIsFootwear answers YES when the product's categoryKey is one of
//   sneakers · running-shoes · boots · soccer-boots · slides · loafers ·
//   kids-shoes
// or, when it carries no categoryKey at all, when its legacy `category` is
// "Footwear". So the picker covers far more than sneakers — slides, soccer
// boots and kids shoes are all in — and it does NOT cover `designer-shoes`,
// which the live taxonomy files under footwear but the classifier's key list
// (a marathon-pos-app MIRROR, and therefore not editable from here) omits.
//
// ── THE ONE PLACE THE POOL IS NOT FOOTWEAR-ONLY ──────────────────────────────
// The picker is also reachable from a duplicate collision on a NON-footwear
// product. Restricting the pool to footwear there would leave a duplicated
// t-shirt with no target at all — removing a working path to obey an
// instruction that was about shoes. So the rule is stated as "same side of the
// classifier as the LOSER": a footwear loser gets a footwear-only pool (the
// instruction, exactly), a non-footwear loser gets the non-footwear pool. You
// can never merge a t-shirt into a sneaker either way, which is the property
// the footwear filter was protecting.

import { productIsFootwear } from "../../utils/footwearLine.js";
import { isMergedAway } from "../../utils/mergedProducts.js";
import { nameMatchesQuery, codeMatchesQuery } from "../../utils/productSearch.js";
import { searchTermsFor } from "../../utils/labelIdentity.js";

/** The products this picker may offer as the survivor. Uncapped. */
export function mergeTargetPool(products, loser) {
  const loserIsFootwear = productIsFootwear(loser);
  return (products || []).filter((p) => (
    p && p.id && !isMergedAway(p)
    && p.id !== (loser && loser.id)
    && productIsFootwear(p) === loserIsFootwear
  ));
}

/** Normalise a code or token for comparison: letters and digits, upper case. */
function squash(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Does this product answer to the query?
 *
 * NAME  the shared forgiving matcher (typo/acronym/partial tolerant), unchanged.
 * CODE  every code the product answers to — its own field, its /style_code_index
 *       claim, a sibling claim, and every code alias — matched punctuation-
 *       blind, because "745SMA004-21G" and "745SMA00421G" are the same number
 *       and which one gets typed is not our choice. A 3+ character substring
 *       counts, so a partly-remembered code still narrows the list.
 * ALIAS every wording token filed against the product from a label reading, so
 *       a word visible on the label finds the shoe even when no code was ever
 *       captured.
 *
 * `identityMap` may be null/empty — then only the product's own fields answer,
 * which is exactly the pre-change behaviour.
 */
export function matchesQuery(product, rawQuery, identityMap) {
  const q = String(rawQuery ?? "").trim();
  if (!q) return true;
  if (!product) return false;
  if (product.name && nameMatchesQuery(product, q)) return true;
  if (codeMatchesQuery(product, q)) return true;      // barcode / sku / printed EAN
  const needle = squash(q);
  if (!needle) return false;
  for (const term of searchTermsFor(product, identityMap)) {
    const hay = squash(term);
    if (!hay) continue;
    if (hay === needle) return true;
    if (needle.length >= 3 && hay.includes(needle)) return true;
  }
  return false;
}

/**
 * THE RESULT LIST — every match, in a stable order, UNCAPPED.
 * Paging is the screen's job (it renders a window and a "Show more"), so that
 * "there are 214 more" can be stated rather than silently truncated.
 */
export function mergeTargetMatches(pool, query, identityMap) {
  const out = (pool || []).filter((p) => matchesQuery(p, query, identityMap));
  out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return out;
}
