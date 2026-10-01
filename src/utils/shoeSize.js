// ─── ONE ANSWER TO "IS THIS THE SAME SHOE SIZE?" ─────────────────────────────
//
// The alternatives sheet (alternativesCore.js) and the neighbour build
// (productNeighbours.js / build-neighbours.mjs) both have to decide whether a
// size on one shoe IS a size on another. Before 2026-10-01 nothing decided it:
// the sheet compared raw labels with `includes`, and the build did not look at
// sizes at all. This module is the one place that decides, and both halves call
// it, so the build can never prefer a candidate the sheet would then refuse.
//
// ── WHAT THE CATALOGUE ACTUALLY HOLDS (sampled 2026-10-01) ───────────────────
// A bounded sample of 1,600 /products records (six keyed windows of 250–350,
// never the whole node): every footwear size is a BARE UK number —
// "3" "4" "5" "5.5" "6" … "13" — the SIZES_FOOTWEAR run. No Y / C / GS / US /
// EU label appears. One sneaker record carried "S" and "XXL" (apparel letters
// on a shoe: p1777973357520), which are unclassifiable and never match.
// The kids-shoes category is seeded with EU 26–33.
//
// The other spellings are handled anyway, because a size label is typed by a
// person and the first one that arrives must not silently match the wrong
// physical size. THE RULE: two labels match only when they are the same number
// on the same SCALE. A kids 6Y is never an adult 6; a US 8 is never a UK 8 —
// no conversion table is applied, because a wrong conversion is a wrong pair.
//
// ── UNCLASSIFIABLE MEANS "MATCHES NOTHING" ───────────────────────────────────
// A label this cannot read with confidence returns null and is EXCLUDED from
// matching — on either side. A suggestion offered on a guess is the failure the
// whole sheet exists to avoid; a size that silently matches nothing just means
// one fewer row.

/** Scales a size can be on. Two sizes match only on the same scale. */
export const SHOE_SCALES = Object.freeze({
  uk: "uk",        // adult UK — the catalogue's own run (bare numbers 1–15)
  ukKids: "uk-kids", // bare UK numbers on a KIDS product's grid (productIsKidsGrid)
  us: "us",        // labelled US / US M
  usW: "us-w",     // US women's (labelled W)
  eu: "eu",        // labelled EU, or a bare number 16–50
  youth: "youth",  // Y / GS / youth — grade school
  child: "child",  // C / PS / K — pre-school and little kids
  toddler: "toddler", // TD / T — toddler and infant
});

// Scales that are a child's foot, whatever the number.
const KIDS_SCALES = new Set([SHOE_SCALES.youth, SHOE_SCALES.child, SHOE_SCALES.toddler, SHOE_SCALES.ukKids]);

// ── A BARE NUMBER ON A KIDS SHOE IS A KIDS SIZE ──────────────────────────────
// The label alone cannot tell a kids UK 10 from an adult UK 10 — both are "10"
// (architect review, PR #660). The PRODUCT can: the kids-shoes category, or a
// name carrying the trade's kids markers. Such a grid's bare UK numbers are
// keyed "uk-kids:", so they never meet an adult grid's "uk:".
const KIDS_NAME = /\b(kids|junior|youth|toddler|infant|gs|ps|td)\b/i;
export function productIsKidsGrid(product) {
  if (!product) return false;
  if (String(product.categoryKey || "").trim() === "kids-shoes") return true;
  return KIDS_NAME.test(String(product.name || ""));
}
// EU kids sizes run up to 35; at 35 and above an EU number is an adult foot.
const EU_ADULT_FROM = 35;

// A number with an optional half: "8", "8.5", "8,5", "8½", "8.0", and the RTDB
// key form "8_5" (sizeKey.js encodes "." to "_" in a /stock key).
const NUM = String.raw`(\d{1,2})(?:(?:[.,_](\d))|\s*(½))?`;

function numberOf(whole, frac, half) {
  const w = Number(whole);
  if (half) return w + 0.5;
  if (frac == null) return w;
  if (frac === "0") return w;
  if (frac === "5") return w + 0.5;
  return null;               // "8.3" is not a shoe size anyone sells — refuse it
}

// Prefix / suffix tokens. Order matters only in that every pattern is anchored,
// so exactly one can match a label.
const PATTERNS = [
  // Bare number. The catalogue's convention: 1–15 is adult UK, 16–50 is EU.
  { re: new RegExp(`^${NUM}$`), scale: (n) => (n >= 16 ? SHOE_SCALES.eu : SHOE_SCALES.uk) },
  { re: new RegExp(`^UK\\s*${NUM}$`), scale: () => SHOE_SCALES.uk },
  { re: new RegExp(`^${NUM}\\s*UK$`), scale: () => SHOE_SCALES.uk },
  { re: new RegExp(`^EU[R]?\\s*${NUM}$`), scale: () => SHOE_SCALES.eu },
  { re: new RegExp(`^${NUM}\\s*EU[R]?$`), scale: () => SHOE_SCALES.eu },
  { re: new RegExp(`^US\\s*(?:M\\s*)?${NUM}$`), scale: () => SHOE_SCALES.us },
  { re: new RegExp(`^${NUM}\\s*US$`), scale: () => SHOE_SCALES.us },
  { re: new RegExp(`^(?:US\\s*)?W\\s*${NUM}$`), scale: () => SHOE_SCALES.usW },
  { re: new RegExp(`^(?:US\\s*)?${NUM}\\s*W$`), scale: () => SHOE_SCALES.usW },
  // Kids. "6Y", "6 Y", "6.5Y", "GS 6", "6 GS", "YOUTH 6".
  { re: new RegExp(`^${NUM}\\s*(?:Y|GS|YOUTH)$`), scale: () => SHOE_SCALES.youth },
  { re: new RegExp(`^(?:GS|YOUTH)\\s*${NUM}$`), scale: () => SHOE_SCALES.youth },
  // "10C", "PS 10", "10 PS", "10K".
  { re: new RegExp(`^${NUM}\\s*(?:C|PS|K)$`), scale: () => SHOE_SCALES.child },
  { re: new RegExp(`^(?:PS|K)\\s*${NUM}$`), scale: () => SHOE_SCALES.child },
  // "5T", "TD 5", "5 TD".
  { re: new RegExp(`^${NUM}\\s*(?:T|TD)$`), scale: () => SHOE_SCALES.toddler },
  { re: new RegExp(`^TD\\s*${NUM}$`), scale: () => SHOE_SCALES.toddler },
];

/**
 * Read a size label. Returns `{ key, scale, value, kids }` or null when the
 * label cannot be classified with confidence (apparel letters, the "_" one-size
 * sentinel, "Free Size", "8.3", "8 / 42", an empty value …).
 *
 * `key` is what to compare: two sizes are the same physical size exactly when
 * their keys are equal.
 */
export function normaliseShoeSize(label, { kidsGrid = false } = {}) {
  if (label == null) return null;
  if (typeof label !== "string" && typeof label !== "number") return null;
  const t = String(label).trim().toUpperCase().replace(/\s+/g, " ");
  if (!t) return null;
  for (const { re, scale } of PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const value = numberOf(m[1], m[2], m[3]);
    if (value == null || value <= 0) return null;
    let sc = scale(value);
    if (kidsGrid && sc === SHOE_SCALES.uk) sc = SHOE_SCALES.ukKids;
    // A bare number past any shoe scale (a fitted-cap 57, a waist 32 that
    // reached a footwear grid) — refuse rather than call it EU.
    if (sc === SHOE_SCALES.eu && (value < 16 || value > 50)) return null;
    const kids = KIDS_SCALES.has(sc) || (sc === SHOE_SCALES.eu && value < EU_ADULT_FROM);
    return { key: `${sc}:${value}`, scale: sc, value, kids };
  }
  return null;
}

/** The comparison key for a label, or null when it cannot be classified. */
export function shoeSizeKey(label, opts) {
  return normaliseShoeSize(label, opts)?.key ?? null;
}

/**
 * The label in `sizes` that is the same physical size as `requested`, or
 * undefined. Returns the CANDIDATE'S OWN label — that is the one its stock
 * cells and its size grid are keyed by, which need not be byte-equal to the
 * label that was tapped on a different shoe.
 */
export function findMatchingSize(sizes, requested, { requestedKidsGrid = false, kidsGrid = false } = {}) {
  const want = shoeSizeKey(requested, { kidsGrid: requestedKidsGrid });
  if (!want || !Array.isArray(sizes)) return undefined;
  return sizes.find((s) => shoeSizeKey(s, { kidsGrid }) === want);
}

/**
 * The size range of a grid, for the offline neighbour build: the dominant
 * scale, its min and max, whether it is a child's range, the set of keys, and
 * every label that could not be classified (so the build can report them).
 *
 * Returns null when no label could be classified.
 */
export function shoeSizeRange(sizes, { kidsGrid = false } = {}) {
  const list = Array.isArray(sizes) ? sizes : sizes && typeof sizes === "object" ? Object.values(sizes) : [];
  const byScale = new Map();
  const unclassified = [];
  for (const s of list) {
    if (s == null || s === "" || s === "_") continue;      // sentinel / RTDB hole
    const n = normaliseShoeSize(s, { kidsGrid });
    if (!n) { unclassified.push(String(s)); continue; }
    if (!byScale.has(n.scale)) byScale.set(n.scale, []);
    byScale.get(n.scale).push(n);
  }
  if (!byScale.size) return unclassified.length ? { scale: null, lo: null, hi: null, kids: false, keys: [], unclassified } : null;
  // The dominant scale names the range. A grid mixing scales still contributes
  // ALL its keys to matching; only the summary picks one.
  const [scale, ns] = [...byScale.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const values = ns.map((n) => n.value);
  const keys = [...new Set([...byScale.values()].flat().map((n) => n.key))].sort();
  return {
    scale,
    lo: Math.min(...values),
    hi: Math.max(...values),
    kids: ns.every((n) => n.kids),
    keys,
    unclassified,
  };
}
