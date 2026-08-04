// ─── MANUFACTURER STYLE CODE — NORMALISATION + FORMAT RECOGNITION ────────────
// Sneakers arrive without boxes, so there is no box barcode to scan. What every
// shoe DOES carry is the manufacturer style code printed on the inside-tongue
// label. That code is the canonical identity key for intake: staff enter or
// photograph it FIRST, and everything downstream (cache lookup, catalog fetch,
// add-stock routing) keys off the NORMALISED form produced here.
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────
// NORMALISATION NEVER TRUNCATES. CT8527-016 and CT8527-700 are DIFFERENT
// PRODUCTS — same silhouette, different colorway, different shoe on the shelf.
// Any "tidy up" that dropped the trailing block (or capped length, or matched on
// a prefix) would silently merge two products into one catalogue record and one
// stock cell. Normalisation here is exactly two operations, both lossless:
//   1. uppercase
//   2. drop every character that is not A–Z or 0–9  (hyphens, spaces, slashes…)
// Nothing is reordered, substituted or shortened. In particular we deliberately
// do NOT "fix" O↔0 or I↔1 OCR confusions: those substitutions can collapse two
// real codes into one, which is the exact failure this file forbids.
//
// The output is [A-Z0-9]+ only, which is always a safe RTDB key (no . # $ / [ ]).
//
// ── FORMAT RECOGNITION IS A SANITY GATE, NOT A GATEKEEPER ────────────────────
// styleCodeFormat() recognises the shapes the major brands actually print. It is
// used in ONE place: validating a string a VISION MODEL read off a label photo,
// before that string is allowed anywhere near a lookup. A model that hallucinates
// "AIR JORDAN 4" into the code field must be caught there.
//
// It is NOT a precondition for resolving. Manual entry is never shape-gated and
// the resolver never rejects on shape — a code is rejected only when the
// resolver finds nothing for it. Brands mint new formats faster than any regex
// list tracks them, so shape is evidence, never authority.
//
// PARITY: functions/lib/style-code.cjs is the server-side twin of this module
// (ESM/CJS boundary — they cannot share a file today). src/utils/styleCode.test.js
// imports BOTH and pins them to identical output. Change one, change the other.

// The shapes the brands in our catalogue actually print, checked against the
// NORMALISED form (uppercase, separators already gone). Order matters only for
// which name is reported; the shapes are mutually exclusive in practice.
export const STYLE_CODE_FORMATS = [
  // Nike / Jordan modern: two letters + 6+3 digits.  CT8527-016 → CT8527016
  { name: "nike-alpha-6-3", re: /^[A-Z]{2}\d{7}$/ },
  // Nike / Jordan legacy: all-numeric 6+3.           315122-111 → 315122111
  { name: "numeric-6-3", re: /^\d{9}$/ },
  // Puma: numeric 6+2.                                380190-01  → 38019001
  { name: "puma-6-2", re: /^\d{8}$/ },
  // New Balance: model block then a colour suffix.    ML574EVG, U574WR2, M990GL6
  { name: "new-balance", re: /^[A-Z]{1,3}\d{3,4}[A-Z]{1,3}\d{0,2}$/ },
  // adidas: a single block, no separator at all.      IE3437, S79770, B75806
  { name: "adidas-block", re: /^[A-Z]{1,2}\d{4,6}$/ },
];

// Which brand family a code shape implies. Used ONLY for observability — the
// coverage-by-brand miss log (the KicksDB free tier is StockX-sourced and is
// thinner on adidas/Puma/Reebok than on Jordan and Dunk, and we need to measure
// that rather than guess at it). NEVER used to set a product's brand or
// category: shape is evidence, not authority, and Nike apparel prints the same
// format as Nike footwear.
export const BRAND_FAMILY_BY_FORMAT = {
  "nike-alpha-6-3": "Nike/Jordan",
  "numeric-6-3": "Nike/Jordan",
  "puma-6-2": "Puma",
  "new-balance": "New Balance",
  "adidas-block": "adidas",
};

/**
 * Best-guess brand family from the code's shape, or "unknown".
 * Observability only — see BRAND_FAMILY_BY_FORMAT.
 */
export function brandFamilyForStyleCode(raw) {
  return BRAND_FAMILY_BY_FORMAT[styleCodeFormat(raw)] || "unknown";
}

/**
 * Normalise a style code to its canonical identity key.
 *
 * Uppercase + strip every non-alphanumeric character. Lossless: no truncation,
 * no substitution, no reordering. Returns "" for anything unusable (null,
 * non-string, or a string with no alphanumerics at all) so callers get one
 * falsy sentinel to check rather than three.
 *
 * @param {unknown} raw
 * @returns {string} [A-Z0-9]* — safe as an RTDB key
 */
export function normaliseStyleCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Which known brand format this code matches, or null.
 *
 * Accepts a raw OR already-normalised string (it normalises first, so callers
 * cannot get a false negative by passing the hyphenated form).
 *
 * @param {unknown} raw
 * @returns {string|null} format name, or null when no known shape matches
 */
export function styleCodeFormat(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return null;
  const hit = STYLE_CODE_FORMATS.find((f) => f.re.test(norm));
  return hit ? hit.name : null;
}

/**
 * Does this look like a style code any of our brands would print?
 *
 * ONLY for gating vision output (see the header). Never use it to refuse a
 * manually-typed code or to short-circuit a resolve.
 */
export function isKnownStyleCodeFormat(raw) {
  return styleCodeFormat(raw) !== null;
}

/**
 * Re-insert the hyphen a brand prints, when the shape makes its position
 * unambiguous. Used for display and for building catalog-query candidates —
 * NEVER for the identity key, which is always the normalised form.
 *
 * Shapes with no canonical separator (adidas, New Balance) come back unchanged.
 *
 * @param {unknown} raw
 * @returns {string} display form, or "" when the code is unusable
 */
export function formatStyleCodeForDisplay(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return "";
  switch (styleCodeFormat(norm)) {
    case "nike-alpha-6-3": // CT8527016 → CT8527-016
    case "numeric-6-3":    // 315122111 → 315122-111
      return `${norm.slice(0, -3)}-${norm.slice(-3)}`;
    case "puma-6-2":       // 38019001  → 380190-01
      return `${norm.slice(0, -2)}-${norm.slice(-2)}`;
    default:
      return norm;
  }
}

/**
 * The ordered list of strings to try against an external catalog for one code.
 *
 * External catalogs store SKUs the way the brand prints them — usually
 * hyphenated. Staff type them both ways. So we try, in order and without
 * duplicates:
 *   1. exactly what the human typed (highest fidelity to the label)
 *   2. the canonical hyphenated form, when the shape makes it unambiguous
 *   3. the bare normalised form
 *
 * Every candidate is a spelling of THE SAME code — this widens how we ask, never
 * what we accept. The caller must still verify the returned record's SKU
 * normalises to the identical key (see verifyStyleCodeMatch in the resolver).
 *
 * @param {unknown} raw   what the human typed / the model read, if available
 * @returns {string[]}    non-empty unless the code is unusable
 */
export function styleCodeQueryCandidates(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return [];
  const typed = typeof raw === "string" ? raw.trim() : "";
  const out = [];
  for (const c of [typed, formatStyleCodeForDisplay(norm), norm]) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
