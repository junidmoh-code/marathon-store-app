// ─── "NOT THAT ONE — BUT THESE, RIGHT NOW" ───────────────────────────────────
//
// The join between the PRECOMPUTED neighbour list (productNeighbours.js, built
// offline) and LIVE availability (availabilityCore.js, the resolver merged in
// #562). The list says what is ALIKE; this says what can actually be sold to
// the customer standing at the counter, and only the intersection is shown.
//
// ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
// NEVER SHOW A SUGGESTION THAT CANNOT BE SOLD. A row an assistant reads out
// that turns out to be unavailable is worse than the bare refusal it replaced:
// it costs the customer's patience twice and it teaches the assistant not to
// trust the screen. So every gate here fails CLOSED — if availability is not
// known for a candidate, the candidate is dropped, not shown with a caveat.
//
// And an empty result is a real answer. The sheet shows the reason alone; it
// never renders an empty section and never renders a "nothing found" row.
//
// ── THE READ PATH ────────────────────────────────────────────────────────────
// The stored list (already on the product record the app holds in memory) plus
// availability checks on THOSE products only. No catalogue scan, no similarity
// arithmetic, no new subscription — at most twelve candidates are looked up in
// maps the screen is already streaming for its own grid.
//
// PURE. Every live fact arrives as a callback from the screen that already
// holds it, so the whole thing is testable without mounting anything or
// touching firebase.

import { parseNeighbours } from "../../utils/productNeighbours";

/** How many alternatives the sheet shows. Owner spec: up to 8. */
export const MAX_ALTERNATIVES_SHOWN = 8;

/**
 * The sellable alternatives to (product, size), best first.
 *
 * @param neighbours       the raw stored value from product[NEIGHBOURS_FIELD]
 * @param requestedSize    the size the customer actually asked for
 * @param resolveProduct   pid -> product record (or null). MUST follow merges —
 *                         a merged-away pid still sits in an older stored list.
 * @param sizesOf          product -> the sizes on its record
 * @param availabilityKnown product -> can this screen actually answer for it?
 *                         FALSE for a Pine/hub3 shoe (never gated) and for a
 *                         hub whose cells have not settled. A candidate we
 *                         cannot answer for is dropped, never assumed available.
 * @param sizeAvailable    (product, size) -> is a unit sellable right now
 * @param isSellable       product -> not deactivated, has a photo, has a price
 * @param limit            default MAX_ALTERNATIVES_SHOWN
 *
 * @returns [{ product, sizes, why, code, hasRequestedSize }] — `sizes` is never
 *          empty (a product with no sellable size is not an alternative).
 */
export function sellableAlternatives({
  neighbours, requestedSize, resolveProduct, sizesOf, availabilityKnown,
  sizeAvailable, isSellable, limit = MAX_ALTERNATIVES_SHOWN,
}) {
  const out = [];
  const seen = new Set();
  for (const n of parseNeighbours(neighbours)) {
    // A merged-away neighbour resolves to its SURVIVOR, which may already be in
    // the list under its own pid — and the same shoe twice is a worse list than
    // a shorter one.
    const product = resolveProduct(n.pid);
    if (!product || seen.has(product.id)) continue;
    if (!isSellable(product)) continue;
    if (!availabilityKnown(product)) continue;
    const sizes = (sizesOf(product) || []).filter((s) => sizeAvailable(product, s));
    if (!sizes.length) continue;
    seen.add(product.id);
    out.push({
      product, sizes, why: n.why, code: n.code,
      hasRequestedSize: !!requestedSize && sizes.includes(requestedSize),
    });
  }

  // ── A STABLE PARTITION, NOT A RE-RANK ──────────────────────────────────────
  // The stored order IS the ranking and is not second-guessed here. But a
  // customer who asked for an 8 is better served by a slightly-less-similar
  // shoe that HAS an 8 than by a closer one that does not — that is the whole
  // transaction. So the list is partitioned, and rank is preserved inside each
  // half. A shoe never moves relative to another shoe in the same half.
  const withSize = out.filter((r) => r.hasRequestedSize);
  const without = out.filter((r) => !r.hasRequestedSize);
  return [...withSize, ...without].slice(0, limit);
}

/**
 * What tapping an alternative should open on. Owner spec: the customer's
 * original size preselected when that shoe has it, otherwise the shoe's own
 * size grid with nothing chosen — and never a trip back to the catalogue.
 *
 * Returns { product, size } where size is "" for "open the grid".
 */
export function alternativeSelection(row, requestedSize) {
  if (!row?.product) return null;
  return { product: row.product, size: row.hasRequestedSize ? requestedSize : "" };
}
