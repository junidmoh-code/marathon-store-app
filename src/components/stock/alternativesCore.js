// ─── "NOT THAT ONE — BUT THESE, RIGHT NOW" ───────────────────────────────────
//
// The join between what the catalogue knows about each shoe and LIVE
// availability (availabilityCore.js, the resolver the size chips use). It says
// what can actually be sold to the customer standing at the counter, best
// match first.
//
// ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
// NEVER SHOW A SUGGESTION THAT CANNOT BE SOLD. A row an assistant reads out
// that turns out to be unavailable is worse than the bare refusal it replaced:
// it costs the customer's patience twice and it teaches the assistant not to
// trust the screen. So every gate here fails CLOSED — if availability is not
// known for a candidate, the candidate is dropped, not shown with a caveat.
//
// ── AND THE SECOND: NEVER "NOTHING" WHILE SOMETHING IS ON THE SHELF ──────────
// (2026-10-09, Junid's Ducks of a Feather report.) The sheet used to join only
// the twelve neighbours the offline build had stored on the product, chosen by
// LOOK, and then drop every one not sellable in the tapped size. A colourful
// shoe's twelve were other colourful shoes; none came in an 8; the sheet said
// "No similar styles in size 8" while thirty Air Force 1s sat at Hub 1 in an 8.
// Measured that morning: 154 sneakers showed that empty sheet for a size that
// other shoes had in stock.
//
// So the POOL is now every shoe sellable in the asked size right now — the
// screen already holds the catalogue and both hubs' cells, so this is a walk
// over memory, not a read — and the stored neighbours only break ties. The
// pool is ranked in tiers, each filling before the next is reached:
//
//   a  SAME MODEL FAMILY (Air Force 1 for an Air Force 1), closest colourway first
//   b  same brand AND same silhouette (other Nike lows)
//   c  same colour family, any brand, same kind of shoe
//   d  anything else sellable in that size, by overall attribute similarity
//
// An empty result therefore means the size is not sellable ANYWHERE this
// screen can order from, and the strip says exactly that.
//
// PURE. Every live fact arrives as a callback from the screen that already
// holds it, so the whole thing is testable without mounting anything or
// touching firebase.

import { parseNeighbours, scorePair, matchReasonCode, matchReasonText } from "../../utils/productNeighbours";
import { shoeSizeKey, productIsKidsGrid } from "../../utils/shoeSize";
import { profileOfProduct } from "../../utils/altProfile";
import { familyLabel } from "../../utils/modelFamily";

/** How many alternatives the sheet shows. Owner spec: up to 8. */
export const MAX_ALTERNATIVES_SHOWN = 8;

/** The tiers, best first. Logged per row (telemetry) — never read back. */
export const ALT_TIERS = Object.freeze(["a", "b", "c", "d"]);

export const TIER_REASON = Object.freeze({
  b: "Same brand, same shape",
  c: "Same colour",
});

// THE ONE SIZE COMPARISON. A label is compared through shoeSize.js, never by
// raw text: "8", "8.0", "UK 8", 8 and the cell-key form "8_5"/"8.5" are each one
// size, and a "6Y" is not a "6". Cached per product object — the walk below
// visits the whole catalogue on every open.
const sizeKeyCache = new WeakMap();
const sameLabels = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function sizeKeysOf(product, labels) {
  // Compared by CONTENT: the screen's sizesOf returns a fresh filtered array on
  // every call, so an identity check would never hit (architect review).
  const hit = sizeKeyCache.get(product);
  if (hit && sameLabels(hit.labels, labels)) return hit.keys;
  const kidsGrid = productIsKidsGrid(product);
  const keys = labels.map((s) => shoeSizeKey(s, { kidsGrid }));
  sizeKeyCache.set(product, { labels: [...labels], keys });
  return keys;
}

/**
 * The label in THIS shoe's own grid that is the requested size, or undefined.
 * The label returned is the candidate's own spelling — the one its cells, its
 * size chip and its cart line are keyed by.
 */
export function matchingSizeLabel(product, labels, wantKey) {
  if (!wantKey || !Array.isArray(labels)) return undefined;
  const keys = sizeKeysOf(product, labels);
  const i = keys.indexOf(wantKey);
  return i === -1 ? undefined : labels[i];
}

/** The requested size's comparison key, read on the SOURCE shoe's scale. */
export function requestedSizeKey(requestedSize, sourceProduct) {
  return shoeSizeKey(requestedSize, { kidsGrid: productIsKidsGrid(sourceProduct) });
}

const eq = (a, b) => (a && b && a === b ? 1 : 0);

// The profile shape scorePair (productNeighbours.js) scores — the same weights
// the offline build ranks by, so "overall similarity" means one thing.
function scoringShape(p) {
  return {
    pid: p.pid, group: p.grp, silhouette: p.sil, categoryKey: p.categoryKey, brand: p.brand,
    colourFamily: p.cf, primaryColour: p.col, priceBand: p.band, upperMaterial: p.mat,
    pattern: p.pat, soleType: p.sole, closure: p.clo, finish: p.fin, soleColour: p.soleCol,
    toeShape: p.toe, styleTags: p.tags || [],
  };
}

// "Closest colourway": same colour, same family, same second colour, same sole
// colour, same cut — in that order of weight.
function colourwayCloseness(src, c) {
  return 4 * eq(src.col, c.col) + 3 * eq(src.cf, c.cf) + 2 * eq(src.col2, c.col2)
    + eq(src.soleCol, c.soleCol) + 2 * eq(src.cut, c.cut);
}

// Same kind of shoe: the silhouette wall when both sides know their group, the
// catalogue's own category line when either does not.
function sameKind(src, c) {
  if (src.grp && c.grp) return src.grp === c.grp;
  return !!src.categoryKey && src.categoryKey === c.categoryKey;
}

// A family read from a rule (name, vision namer, box label, style-code
// sibling) is a MODEL. A fallback family is only "brand + first word" —
// "Nike Air Rift" and "Nike Air Tuned" share one — so it may never claim
// "Same model" (architect review); it only nudges the order inside a tier.
const isModelFamily = (p) => !!p.fam && p.famSrc !== "fallback";

/** Which tier a candidate belongs to for this source. */
export function tierOf(src, c) {
  if (isModelFamily(src) && src.fam === c.fam) return "a";
  if (src.brand && src.brand === c.brand) {
    if (src.sil && c.sil ? src.sil === c.sil : sameKind(src, c)) return "b";
  }
  if (src.cf && src.cf === c.cf && sameKind(src, c)) return "c";
  return "d";
}

// Every line must be TRUE of the pair — the assistant reads it out.
function reasonFor(tier, src, c, storedCode) {
  if (tier === "a") {
    const label = familyLabel(src.fam);
    return label ? `Same model — ${label}` : "Same model";
  }
  if (tier === "b" || tier === "c") return TIER_REASON[tier];
  // The offline build's code was written from both shoes' full attributes.
  if (storedCode) return matchReasonText(storedCode);
  if (!sameKind(src, c)) return "Also in this size";
  return matchReasonText(matchReasonCode(scoringShape(src), scoringShape(c)));
}

/**
 * The sellable alternatives to (product, size), best first —
 * `{ rows, candidates, inSize, sizeGateRemoved, tiers }`.
 *
 * @param sourceProduct    the shoe the size was tapped on
 * @param requestedSize    the size the customer asked for, as that shoe labels it
 * @param candidates       the products to choose from — the catalogue the
 *                         screen already holds. Omitted ⇒ the stored
 *                         neighbours alone (the pre-2026-10-09 pool).
 * @param neighbours       product[NEIGHBOURS_FIELD]: the offline list. Breaks
 *                         ties inside a tier; never decides membership.
 * @param resolveProduct   pid -> product record (or null). MUST follow merges.
 * @param sizesOf          product -> the sizes on its record
 * @param availabilityKnown product -> can this screen answer for it at all?
 *                         FALSE for a Pine/hub3 shoe and a non-footwear line.
 * @param sizeAvailable    (product, ownLabel) -> sellable right now. The SAME
 *                         sneakerOut test that greys the size chip, plus
 *                         fail-closed readiness — so the sheet only offers a
 *                         size that shoe's own chip would show as available.
 * @param isSellable       product -> not deactivated, has a photo, has a price
 * @param profileOf        product -> profile (altProfile.profileOfProduct)
 * @param limit            default MAX_ALTERNATIVES_SHOWN
 *
 * rows: [{ product, sizes, why, code, tier, hasRequestedSize, matchedSize }].
 *   Every row is sellable in the requested size; `matchedSize` is that shoe's
 *   own label for it; `sizes` every size it can sell right now.
 * candidates: how many products were looked at.
 * inSize: how many were sellable in the requested size (the whole pool).
 * sizeGateRemoved: stored neighbours that could sell SOME size but not this
 *   one (telemetry, log only — the measure of the old failure).
 * tiers: { a, b, c, d } — how many rows each tier supplied.
 */
export function alternativesForSize({
  neighbours, requestedSize, sourceProduct = null, candidates = null, resolveProduct, sizesOf,
  availabilityKnown, sizeAvailable, isSellable, profileOf = profileOfProduct, limit = MAX_ALTERNATIVES_SHOWN,
}) {
  const parsed = parseNeighbours(neighbours);
  const wantKey = requestedSizeKey(requestedSize, sourceProduct);
  const sourceId = sourceProduct?.id || null;
  const tiers = { a: 0, b: 0, c: 0, d: 0 };

  // Stored-neighbour rank: a tie-break inside a tier, nothing more.
  const storedRank = new Map();
  const storedCode = new Map();
  parsed.forEach((n, i) => {
    const p = resolveProduct(n.pid);
    if (p && !storedRank.has(p.id)) { storedRank.set(p.id, i); storedCode.set(p.id, n.code); }
  });

  // ── THE POOL ───────────────────────────────────────────────────────────────
  const list = Array.isArray(candidates) ? candidates : parsed.map((n) => resolveProduct(n.pid));
  const seen = new Set(sourceId ? [sourceId] : []);
  const pool = [];
  let looked = 0;
  for (const raw of list) {
    if (!raw) continue;
    looked += 1;
    // A merged-away record resolves to its survivor, which may already be in
    // the pool under its own pid — the same shoe twice is a worse list.
    const product = raw.mergedInto ? resolveProduct(raw.id) : raw;
    if (!product || seen.has(product.id)) continue;
    seen.add(product.id);
    if (!isSellable(product)) continue;
    const grid = sizesOf(product) || [];
    const matchedSize = matchingSizeLabel(product, grid, wantKey);
    if (matchedSize === undefined) continue;
    if (!availabilityKnown(product)) continue;
    if (!sizeAvailable(product, matchedSize)) continue;
    pool.push({ product, grid, matchedSize });
  }

  // ── THE RANKING ────────────────────────────────────────────────────────────
  let rows = [];
  if (pool.length) {
    const src = (sourceProduct && profileOf(sourceProduct)) || profileOf({ id: sourceId || "" });
    const srcShape = scoringShape(src);
    const TIER_ORDER = { a: 0, b: 1, c: 2, d: 3 };
    const scored = pool.map((entry) => {
      const prof = profileOf(entry.product);
      const tier = tierOf(src, prof);
      const shape = scoringShape(prof);
      return {
        entry, prof, tier,
        // Same fallback line ("lacoste-gripshot") is worth a brand-sized nudge.
        sim: scorePair(srcShape, shape).score + (src.fam && src.fam === prof.fam && !isModelFamily(src) ? 10 : 0),
        cw: colourwayCloseness(src, prof),
        rank: storedRank.has(entry.product.id) ? storedRank.get(entry.product.id) : Infinity,
      };
    });
    // Inside the family a KNOWN different cut (a Jordan 1 High for a Jordan 1
    // Low) goes after every same-or-unknown cut — "Air Force 1 Low" is the
    // owner's own example of a family (Fable spec review).
    const cutOff = (p) => (src.cut && p.cut && src.cut !== p.cut ? 1 : 0);
    scored.sort((x, y) => (TIER_ORDER[x.tier] - TIER_ORDER[y.tier])
      || (x.tier === "a" ? cutOff(x.prof) - cutOff(y.prof) : 0)
      // Inside the model family the COLOURWAY leads; elsewhere overall likeness.
      || (x.tier === "a" ? (y.cw - x.cw) || (y.sim - x.sim) : (y.sim - x.sim) || (y.cw - x.cw))
      || (x.rank - y.rank)
      || String(x.entry.product.id).localeCompare(String(y.entry.product.id)));
    rows = scored.slice(0, limit).map(({ entry, prof, tier }) => {
      tiers[tier] += 1;
      const { product, grid, matchedSize } = entry;
      // The card prints every size it can sell — computed for the shown rows
      // only, so a catalogue walk does not cost a resolver call per size.
      const sizes = grid.filter((s) => s === matchedSize || sizeAvailable(product, s));
      return {
        product, sizes, tier,
        why: reasonFor(tier, src, prof, storedCode.get(product.id)),
        code: storedCode.get(product.id) || matchReasonCode(srcShape, scoringShape(prof)),
        hasRequestedSize: true, matchedSize,
      };
    });
  }

  // ── TELEMETRY ONLY: what the old twelve-neighbour pool would have lost ─────
  let sizeGateRemoved = 0;
  const pooled = new Set(pool.map((e) => e.product.id));
  for (const pid of storedRank.keys()) {
    if (pooled.has(pid)) continue;
    const p = resolveProduct(pid);
    if (!p || !isSellable(p) || !availabilityKnown(p)) continue;
    if ((sizesOf(p) || []).some((s) => sizeAvailable(p, s))) sizeGateRemoved += 1;
  }

  return { rows, candidates: looked, inSize: pool.length, sizeGateRemoved, tiers };
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
