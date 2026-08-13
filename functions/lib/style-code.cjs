// ─── MANUFACTURER STYLE CODE — NORMALISATION + FORMAT RECOGNITION (server) ───
// SERVER TWIN of src/utils/styleCode.js. The two cannot share a file across the
// ESM/CJS boundary today, so they are kept byte-for-byte equivalent in BEHAVIOUR
// and pinned by src/utils/styleCode.test.js, which imports BOTH and asserts they
// agree on every case. If you change one, change the other or that test fails.
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────
// NORMALISATION NEVER TRUNCATES. CT8527-016 and CT8527-700 are DIFFERENT
// PRODUCTS. The normalised code is the KEY of /sneaker_models and the identity
// the whole intake flow routes on, so any prefix match, length cap or character
// substitution here would merge two real shoes into one catalogue record.
// Normalisation is exactly two lossless operations: uppercase, then drop every
// character that is not A–Z or 0–9. We deliberately do NOT "fix" O↔0 / I↔1 OCR
// confusions — those substitutions can collapse two distinct codes.
//
// Output is [A-Z0-9]+ only, which is always a safe RTDB key (no . # $ / [ ]).

"use strict";

// See src/utils/styleCode.js for the full commentary on each shape. Checked
// against the NORMALISED form (uppercase, separators already gone).
const STYLE_CODE_FORMATS = [
  { name: "nike-alpha-6-3", re: /^[A-Z]{2}\d{7}$/ },        // CT8527-016
  { name: "numeric-6-3", re: /^\d{9}$/ },                    // 315122-111
  { name: "puma-6-2", re: /^\d{8}$/ },                       // 380190-01
  { name: "new-balance", re: /^[A-Z]{1,3}\d{3,4}[A-Z]{1,3}\d{0,2}$/ }, // ML574EVG
  { name: "adidas-block", re: /^[A-Z]{1,2}\d{4,6}$/ },       // IE3437
  // Lacoste — 2 digits + 3 letters (SMA men / SFA women / SUJ-CUJ kids…) +
  // 4 digits, often behind a "7-" footwear-category prefix on the tongue label
  // and often carrying a 2-3 char colour suffix. Researched 2026-08-06 against
  // live listings: 43SMA0034 · 46SMA0032 · 7-47SMA0057042 · 46SMA0041J18 ·
  // 7-45SMA0004075. The label form (with the 7) and the web form (without)
  // normalise DIFFERENTLY — both are accepted; our own system always reads the
  // label, so identities stay consistent within it.
  { name: "lacoste-ref", re: /^7?\d{2}(?!(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d)[A-Z]{3}\d{4}(?:[A-Z0-9]{2,3})?$/ },
  // ── LABEL SERIAL — the multi-token-label widening (owner spec 2026-08-13) ──
  // Some labels print code tokens no brand list catalogues: Timberland prints
  // A6CWNEN3 and A8425 side by side, Lacoste adds a long production-order
  // serial (TTJJ21FB00001). These are letter/digit INTERLEAVED runs — at least
  // two letter→digit alternations, 6-16 chars — which no boilerplate word or
  // address fragment produces (OR97005 has one alternation and is refused).
  // APPENDED LAST deliberately: styleCodeFormat returns the FIRST match, so
  // every code that already had a brand name keeps it; this only widens what
  // counts as code-shaped. It is matching/alias vocabulary — the brands above
  // stay the canonical shapes staff are taught to look for.
  // The leading lookahead refuses strings composed ENTIRELY of size-system
  // markers + digits ("US10UK9", "EUR42CM27") — the one non-code shape that
  // also interleaves. The OCR path masks size lines before extraction; this
  // guard covers the paths that validate a bare string (tier-2 output, typed).
  { name: "label-serial", re: /^(?!(?:(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU|SIZE)\d+)+$)(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\d+){2,}[A-Z]{0,8}$/ },
];

// Brand family implied by a code's shape. OBSERVABILITY ONLY — it feeds the
// coverage-by-brand miss log (the KicksDB free tier is StockX-sourced and is
// thinner on adidas/Puma/Reebok than on Jordan and Dunk). NEVER used to set a
// product's brand or category: Nike apparel prints the same format as Nike
// footwear, so shape can never decide what a thing IS.
const BRAND_FAMILY_BY_FORMAT = {
  "nike-alpha-6-3": "Nike/Jordan",
  "numeric-6-3": "Nike/Jordan",
  "puma-6-2": "Puma",
  "new-balance": "New Balance",
  "adidas-block": "adidas",
  "lacoste-ref": "Lacoste",
  // label-serial is brand-agnostic by construction — deliberately absent here,
  // so brandFamilyForStyleCode reports "unknown" for it.
};

/** Best-guess brand family from shape, or "unknown". Observability only. */
function brandFamilyForStyleCode(raw) {
  return BRAND_FAMILY_BY_FORMAT[styleCodeFormat(raw)] || "unknown";
}

/** Uppercase + strip non-alphanumerics. Lossless. "" when unusable. */
function normaliseStyleCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Which known brand format this matches, or null. Normalises first. */
function styleCodeFormat(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return null;
  const hit = STYLE_CODE_FORMATS.find((f) => f.re.test(norm));
  return hit ? hit.name : null;
}

/**
 * Shape sanity gate — ONLY for validating a string a vision model read off a
 * label photo. Never used to refuse a manually-typed code, and never a
 * precondition for resolving: brands mint new formats faster than a regex list
 * tracks them, so shape is evidence, not authority.
 */
function isKnownStyleCodeFormat(raw) {
  return styleCodeFormat(raw) !== null;
}

/** Re-insert the brand's hyphen when its position is unambiguous. Display only. */
function formatStyleCodeForDisplay(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return "";
  switch (styleCodeFormat(norm)) {
    case "nike-alpha-6-3":
    case "numeric-6-3":
      return `${norm.slice(0, -3)}-${norm.slice(-3)}`;
    case "puma-6-2":
      return `${norm.slice(0, -2)}-${norm.slice(-2)}`;
    default:
      return norm;
  }
}

/**
 * Ordered spellings to try against an external catalog: what the human typed,
 * the canonical hyphenated form, then the bare normalised form. Widens how we
 * ASK, never what we ACCEPT — the caller still verifies the returned SKU
 * normalises to the identical key.
 */
function styleCodeQueryCandidates(raw) {
  const norm = normaliseStyleCode(raw);
  if (!norm) return [];
  const typed = typeof raw === "string" ? raw.trim() : "";
  const out = [];
  for (const c of [typed, formatStyleCodeForDisplay(norm), norm]) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

module.exports = {
  STYLE_CODE_FORMATS,
  BRAND_FAMILY_BY_FORMAT,
  brandFamilyForStyleCode,
  normaliseStyleCode,
  styleCodeFormat,
  isKnownStyleCodeFormat,
  formatStyleCodeForDisplay,
  styleCodeQueryCandidates,
};
