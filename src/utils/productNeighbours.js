// ─── WHAT ELSE WOULD THIS CUSTOMER TAKE? ─────────────────────────────────────
//
// A shop assistant taps size 8, the chip greys out, and today that is the end
// of it — the reason is stated and the sale walks out of the door. This is the
// ranking that turns the refusal into "not that one, but these, right now".
//
// ── COMPUTED OFFLINE, ALWAYS ─────────────────────────────────────────────────
// 1,410 sneakers is ~1M pairs. Scoring that in a phone at the moment a chip is
// tapped is a frozen screen in front of a customer, and re-scoring it on every
// tap is the same work done again for an answer that has not changed. The
// script (scripts/shopify/build-neighbours.mjs) runs the whole matrix once and
// writes the top twelve onto each product; the app reads a list and does
// nothing else. This module is the arithmetic both halves share, so the list
// the app renders can never be ranked by different rules from the list the
// script wrote.
//
// ── THE WEIGHTS ARE ONE OBJECT ───────────────────────────────────────────────
// SIMILARITY_WEIGHTS, below. Owner brief: silhouette and category dominate,
// colourFamily and priceBand rank, and BRAND IS A POSITIVE WEIGHT AND NOT A
// FILTER — "a shopper who wanted an adidas may take a Nike, and a resale buyer
// who wants the brand will see it ranked first anyway". Numbers scattered
// through the scoring function would make that policy impossible to read and
// impossible to change.
//
// ── THE ONE HARD EXCLUSION ───────────────────────────────────────────────────
// Silhouette GROUP. Everything else is a weight; this is a wall. A customer
// refused a running shoe is not in the market for a slide, and no weighting
// small enough to be honest about the rest of the catalogue keeps a slide out
// of the top five for a shopper whose size is missing in a thin category. It is
// the difference between a ranked list and a random one.

import { colourFamily } from "./productAttributes.js";

// ── SILHOUETTE GROUPS — the wall ─────────────────────────────────────────────
// A shoe may only be offered as an alternative to another shoe in its own
// group. Deliberately coarse: low-top/mid/high-top/runner all substitute for
// each other in this shop's trade, and nothing else substitutes for anything.
export const SILHOUETTE_GROUP = Object.freeze({
  "low-top": "trainer", mid: "trainer", "high-top": "trainer", runner: "trainer",
  slide: "open", sandal: "open",
  boot: "boot",
  "soccer-boot": "cleat",
  loafer: "formal", dress: "formal",
});

/** The group a silhouette substitutes within, or "" for an unknown silhouette. */
export function silhouetteGroup(silhouette) {
  return SILHOUETTE_GROUP[String(silhouette ?? "").trim()] || "";
}

// ── THE WEIGHTS ──────────────────────────────────────────────────────────────
// Every term is scored 0..1 and multiplied by its weight, so a weight reads
// directly as "how many points is this worth". They do not need to sum to
// anything; only their ratios rank.
export const SIMILARITY_WEIGHTS = Object.freeze({
  // DOMINANT — what the shoe IS.
  silhouette: 30,        // exact match within the group (the group itself is a wall)
  categoryKey: 25,       // sneakers vs slides vs soccer-boots — the catalogue's own line

  // RANKING — what it looks like and what it costs.
  colourFamily: 18,      // family, not colour: burgundy ranks beside oxblood
  colourExact: 6,        // ...and the exact same colour is worth a little more again
  priceBand: 12,         // one band apart still scores; two bands apart scores nothing
  upperMaterial: 8,
  pattern: 5,
  // v2, added when the pilot forced the schema wider. soleType outweighs
  // soleColour: two shoes with the same kind of sole are alike in a way two
  // shoes whose soles happen to be the same colour are not.
  soleType: 6,
  finish: 5,
  closure: 4,
  soleColour: 3,
  // MEASURED 82.9% "round" across the pilot. It is kept because the 17% it does
  // separate are separated well, and it is weighted for what it is worth: a
  // term that agrees four times in five is nearly free agreement.
  toeShape: 2,

  // A POSITIVE WEIGHT, NOT A FILTER. Big enough that a same-brand shoe wins a
  // tie and rises to the top of an otherwise equal field; small enough that it
  // can never outrank a shoe that is actually more like the one the customer
  // was refused. Owner decision — do not turn this into a filter.
  brand: 15,

  styleTag: 4,           // per shared tag, capped by MAX_STYLE_TAGS
});

/** How many neighbours are stored per product. */
export const MAX_NEIGHBOURS = 12;

/** Where the ordered list lives on the product record. */
export const NEIGHBOURS_FIELD = "alternatives";

// ── The profile a product is scored on ───────────────────────────────────────
// Resolved attributes PLUS the two record fields that rank but are not
// attributes (categoryKey, brand). Built in one place so the script and any
// future caller cannot assemble it differently.
export function neighbourProfile(product, attrs) {
  if (!attrs) return null;
  const sil = attrs.silhouette || "";
  const group = silhouetteGroup(sil);
  if (!group) return null;                 // an unknown silhouette cannot be placed
  return {
    pid: product?.id || "",
    group,
    silhouette: sil,
    categoryKey: String(product?.categoryKey || "").trim(),
    brand: String(product?.brand || "").trim().toLowerCase(),
    colourFamily: attrs.colourFamily || colourFamily(attrs.primaryColour),
    primaryColour: attrs.primaryColour || "",
    priceBand: attrs.priceBand || "",
    upperMaterial: attrs.upperMaterial || "",
    pattern: attrs.pattern || "",
    soleType: attrs.soleType || "",
    closure: attrs.closure || "",
    finish: attrs.finish || "",
    soleColour: attrs.soleColour || "",
    toeShape: attrs.toeShape || "",
    styleTags: Array.isArray(attrs.styleTags) ? attrs.styleTags : [],
  };
}

// Price bands are ORDERED, so "one band apart" is a real relationship and
// scoring it 0 would rank a R1,100 shoe no closer to a R1,000 one than to a
// R300 one. Two apart is another world and scores nothing.
const BAND_ORDER = ["budget", "core", "mid", "premium", "luxury"];
function bandCloseness(a, b) {
  if (!a || !b) return 0;
  const i = BAND_ORDER.indexOf(a), j = BAND_ORDER.indexOf(b);
  if (i === -1 || j === -1) return 0;
  const d = Math.abs(i - j);
  return d === 0 ? 1 : d === 1 ? 0.4 : 0;
}

const eq = (a, b) => (a && b && a === b ? 1 : 0);

/**
 * How alike are these two? Returns { score, terms } — `terms` is what each
 * weight actually contributed, so a ranking can be explained rather than
 * merely trusted, and so the spot-check can print WHY.
 *
 * Returns score 0 across a silhouette-group wall, and for a product against
 * itself (a product is never its own alternative).
 */
export function scorePair(a, b) {
  const terms = {};
  if (!a || !b || a.pid === b.pid) return { score: 0, terms };
  if (a.group !== b.group) return { score: 0, terms };   // the wall

  const W = SIMILARITY_WEIGHTS;
  terms.silhouette = W.silhouette * eq(a.silhouette, b.silhouette);
  terms.categoryKey = W.categoryKey * eq(a.categoryKey, b.categoryKey);
  terms.colourFamily = W.colourFamily * eq(a.colourFamily, b.colourFamily);
  terms.colourExact = W.colourExact * eq(a.primaryColour, b.primaryColour);
  terms.priceBand = W.priceBand * bandCloseness(a.priceBand, b.priceBand);
  terms.upperMaterial = W.upperMaterial * eq(a.upperMaterial, b.upperMaterial);
  terms.pattern = W.pattern * eq(a.pattern, b.pattern);
  terms.soleType = W.soleType * eq(a.soleType, b.soleType);
  terms.finish = W.finish * eq(a.finish, b.finish);
  terms.closure = W.closure * eq(a.closure, b.closure);
  terms.soleColour = W.soleColour * eq(a.soleColour, b.soleColour);
  terms.toeShape = W.toeShape * eq(a.toeShape, b.toeShape);
  terms.brand = W.brand * eq(a.brand, b.brand);
  const shared = a.styleTags.filter((t) => b.styleTags.includes(t)).length;
  terms.styleTag = W.styleTag * shared;

  let score = 0;
  for (const v of Object.values(terms)) score += v;
  return { score, terms };
}

// ── "WHY IT MATCHED", in one short line ──────────────────────────────────────
// Stored as a single character next to the pid rather than as text: the list
// lives on /products, which every device streams in full on every session, and
// twelve sentences per product would be about 300 KB of prose on the hot node.
// The app renders the sentence from this map.
export const MATCH_REASONS = Object.freeze({
  a: "Same shape, colour and brand",
  s: "Same shape and colour",
  h: "Same shape, same brand",
  c: "Same colour, similar price",
  m: "Same material and colour",
  k: "Same shape, similar price",
  b: "Same brand, similar shoe",
  x: "A similar shoe",
});

/**
 * The strongest true thing that can be said about this pair, as a code.
 * Ordered most-informative first, and every branch must be TRUE of the pair —
 * a reason line that overstates the match is worse than the generic one,
 * because the assistant reads it out to the customer.
 */
export function matchReasonCode(a, b) {
  const sameSil = eq(a.silhouette, b.silhouette) === 1;
  const sameFam = eq(a.colourFamily, b.colourFamily) === 1;
  const sameBrand = eq(a.brand, b.brand) === 1;
  const sameMat = eq(a.upperMaterial, b.upperMaterial) === 1;
  const nearPrice = bandCloseness(a.priceBand, b.priceBand) > 0;
  if (sameSil && sameFam && sameBrand) return "a";
  if (sameSil && sameFam) return "s";
  if (sameSil && sameBrand) return "h";
  if (sameMat && sameFam) return "m";
  if (sameFam && nearPrice) return "c";
  if (sameSil && nearPrice) return "k";
  if (sameBrand) return "b";
  return "x";
}

/** The sentence for a stored code, falling back to the generic one. */
export function matchReasonText(code) {
  return MATCH_REASONS[code] || MATCH_REASONS.x;
}

// ── Storage encoding ─────────────────────────────────────────────────────────
// "<pid>:<code>", one string per neighbour. Compact because it rides on the hot
// node; a pid never contains a colon, so the split is unambiguous.
export function encodeNeighbour(pid, code) {
  return `${pid}:${code}`;
}

/**
 * Read a stored list. Tolerates the object shape RTDB hands back for an array
 * with any hole in it, and drops anything malformed rather than rendering it —
 * a bad entry must not be able to put a broken row in front of a customer.
 */
export function parseNeighbours(value) {
  const raw = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  const out = [];
  for (const s of raw) {
    if (typeof s !== "string") continue;
    const i = s.lastIndexOf(":");
    if (i <= 0) continue;
    const pid = s.slice(0, i), code = s.slice(i + 1);
    if (!pid || !code) continue;
    out.push({ pid, code, why: matchReasonText(code) });
  }
  return out;
}

/**
 * The top `limit` neighbours of `target` from `candidates`, best first.
 * Ties break on pid so a re-run produces the identical list and a diff of two
 * runs shows only what actually moved.
 *
 * A zero score is never a neighbour: across the silhouette wall, or with
 * nothing at all in common, "no suggestion" is the right answer and an empty
 * list is what the sheet is built to handle.
 */
export function topNeighbours(target, candidates, { limit = MAX_NEIGHBOURS } = {}) {
  if (!target) return [];
  const scored = [];
  for (const c of candidates) {
    const { score } = scorePair(target, c);
    if (score <= 0) continue;
    scored.push({ pid: c.pid, score, code: matchReasonCode(target, c) });
  }
  scored.sort((x, y) => (y.score - x.score) || x.pid.localeCompare(y.pid));
  return scored.slice(0, limit);
}
