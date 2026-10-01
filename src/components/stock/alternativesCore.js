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
// And an empty result is a real answer. Since 2026-10-01 the sheet says so in
// words — "No similar styles in size 8" — rather than padding the row with
// shoes that do not come in an 8.
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
import { shoeSizeKey } from "../../utils/shoeSize";

/** How many alternatives the sheet shows. Owner spec: up to 8. */
export const MAX_ALTERNATIVES_SHOWN = 8;

/**
 * The sellable alternatives to (product, size), best first, plus what the size
 * gate did — `{ rows, candidates, sizeGateRemoved }`.
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
 * @param sizeAvailable    (product, size) -> is a unit sellable right now. The
 *                         SAME predicate that drew the size chip, so the chip
 *                         and this sheet cannot disagree about a size.
 * @param isSellable       product -> not deactivated, has a photo, has a price
 * @param limit            default MAX_ALTERNATIVES_SHOWN
 *
 * rows: [{ product, sizes, why, code, hasRequestedSize, matchedSize }] — every
 *   row is sellable in the requested size (hasRequestedSize is always true);
 *   `matchedSize` is THAT SHOE'S OWN label for it, which is what its cells and
 *   its grid are keyed by. `sizes` is every size it can sell right now.
 * candidates: how many stored neighbours were looked at.
 * sizeGateRemoved: how many passed every other gate and had stock in SOME size,
 *   but could not sell the requested one — the rows this gate used to let
 *   through as padding (telemetry, log only).
 */
export function alternativesForSize({
  neighbours, requestedSize, resolveProduct, sizesOf, availabilityKnown,
  sizeAvailable, isSellable, limit = MAX_ALTERNATIVES_SHOWN,
}) {
  const rows = [];
  const seen = new Set();
  const parsed = parseNeighbours(neighbours);
  let sizeGateRemoved = 0;
  // ── THE SIZE GATE (2026-10-01) ─────────────────────────────────────────────
  // Every row must be sellable in the size that was tapped. Before this, a
  // shoe with stock in ANY size was a row, and the size-holders were merely
  // sorted to the front — so an Air Force running 3–6 was offered to a
  // customer who asked for an 8 (Junid's report). A row that cannot be sold in
  // the asked-for size is the refusal again, one tap later.
  //
  // Compared through shoeSize.js, never by raw label: the candidate's "8.5"
  // and the tapped "8_5" are one size, a "6Y" and a "6" are not. A requested
  // size that cannot be classified matches NOTHING — the sheet says so rather
  // than guessing.
  const wantKey = shoeSizeKey(requestedSize);
  for (const n of parsed) {
    // A merged-away neighbour resolves to its SURVIVOR, which may already be in
    // the list under its own pid — and the same shoe twice is a worse list than
    // a shorter one.
    const product = resolveProduct(n.pid);
    if (!product || seen.has(product.id)) continue;
    if (!isSellable(product)) continue;
    if (!availabilityKnown(product)) continue;
    const grid = sizesOf(product) || [];
    const sizes = grid.filter((s) => sizeAvailable(product, s));
    if (!sizes.length) continue;
    seen.add(product.id);
    const matchedSize = wantKey ? sizes.find((s) => shoeSizeKey(s) === wantKey) : undefined;
    if (matchedSize === undefined) { sizeGateRemoved += 1; continue; }
    rows.push({ product, sizes, why: n.why, code: n.code, hasRequestedSize: true, matchedSize });
  }
  // The stored order IS the ranking and is not second-guessed here: the
  // survivors keep exactly the order the neighbour build wrote.
  return { rows: rows.slice(0, limit), candidates: parsed.length, sizeGateRemoved };
}

/** The rows alone — see alternativesForSize. */
export function sellableAlternatives(args) {
  return alternativesForSize(args).rows;
}

/**
 * What tapping an alternative should open on. Owner spec: the customer's
 * original size preselected when that shoe has it, otherwise the shoe's own
 * size grid with nothing chosen — and never a trip back to the catalogue.
 *
 * The preselected label is the CHOSEN SHOE'S OWN (`matchedSize`), not the one
 * tapped on the other shoe: the two can be spelled differently and still be
 * the same size, and the cart line must address the chosen shoe's cell.
 *
 * Returns { product, size } where size is "" for "open the grid".
 */
export function alternativeSelection(row, requestedSize) {
  if (!row?.product) return null;
  if (!row.hasRequestedSize) return { product: row.product, size: "" };
  return { product: row.product, size: row.matchedSize ?? requestedSize };
}
