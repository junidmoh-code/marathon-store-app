// ─── STYLE CODE OCR — CANDIDATE EXTRACTION, CONFUSABLES, CACHE SHAPE ─────────
// The pure half of reading a manufacturer style code off a photo of an
// inside-tongue label. No network, no Firebase — every function here is a
// deterministic string/array transform, so the hard parts are unit-testable
// without a single API call.
//
// ── WHAT AN INSIDE-TONGUE LABEL ACTUALLY SAYS ────────────────────────────────
// A Nike label is roughly:
//
//     NIKE, INC. ONE BOWERMAN DR
//     BEAVERTON, OR 97005 USA
//     CT8527-016
//     US 9   UK 8   EUR 42.5   CM 27
//     08/15/19 - 01/20/20
//     MADE IN VIETNAM
//
// Three of those lines contain digit runs that a naive regex happily mistakes
// for a style code:
//   • the SIZE line       — "EUR 42.5", "CM 27"
//   • the PRODUCTION DATE — "08/15/19 - 01/20/20". Strip the slashes from
//     "08/15/2019" and you get 8 digits, which is EXACTLY the Puma 6+2 shape.
//   • the ADDRESS        — "OR 97005"
// So extraction MASKS sizes and dates out of the text before it looks for a
// code. Masking replaces them with spaces rather than deleting them, so every
// character offset stays valid for the span bookkeeping below.
//
// ── THE SUBSTRING TRAP (this is the never-truncate rule, in regex form) ──────
// The adidas shape is [A-Z]{1,2}\d{4,6}. Run it against "CT8527-016" and it
// matches "CT8527" — a six-character PREFIX of a nine-character code. That is
// precisely the collapse this whole feature forbids: CT8527-016 and CT8527-700
// would both reduce to "CT8527" and become one product.
//
// Two independent guards stop it:
//   1. SPAN CONSUMPTION — patterns run most-specific first and mark the
//      characters they matched. A later pattern may not match inside a span an
//      earlier one already claimed.
//   2. A NEGATIVE LOOKAHEAD on the loose shapes — "not if a separator and more
//      digits follow".
// Either alone would probably do. Both, because "probably" is not good enough
// for the rule the entire design rests on.

"use strict";

const crypto = require("node:crypto");
const { normaliseStyleCode, styleCodeFormat } = require("./style-code.cjs");

// ── Masking ──────────────────────────────────────────────────────────────────
// Order matters: dates before sizes, because "42.5" inside a size line must not
// be eaten by the date pattern's decimal-ish alternation.
const MASK_PATTERNS = [
  // Production date range / any printed date: 08/15/19, 08-15-2019, 08.15.19
  /\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g,
  // Size markers in every regional spelling the labels use.
  /\b(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU)\s*[-:]?\s*\d+(?:[.,]\d+)?\b/g,
  // "SIZE 9" / "SIZE: 42.5"
  /\bSIZE\s*[-:]?\s*\d+(?:[.,]\d+)?\b/g,
];

/**
 * Blank out the parts of a label that are known NOT to be style codes,
 * preserving length so character offsets stay meaningful.
 */
function maskNonCodeText(upperText) {
  let out = upperText;
  for (const re of MASK_PATTERNS) {
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

// ── Extraction patterns, MOST SPECIFIC FIRST ─────────────────────────────────
// Each allows the separator the brand prints (hyphen or space) between blocks.
// `(?<![A-Z0-9])` / `(?![A-Z0-9])` stop a match starting or ending mid-token.
const EXTRACTION_PATTERNS = [
  // Nike / Jordan modern — CT8527-016
  { format: "nike-alpha-6-3", re: /(?<![A-Z0-9])[A-Z]{2}\d{4}[-\s]?\d{3}(?![A-Z0-9])/g },
  // Nike / Jordan legacy — 315122-111
  { format: "numeric-6-3", re: /(?<![A-Z0-9])\d{6}[-\s]?\d{3}(?![A-Z0-9])/g },
  // Puma — 380190-01. Guarded so it cannot claim the first 8 digits of a 9.
  { format: "puma-6-2", re: /(?<![A-Z0-9])\d{6}[-\s]?\d{2}(?![A-Z0-9])(?![-\s]?\d)/g },
  // New Balance — ML574EVG, U574WR2
  { format: "new-balance", re: /(?<![A-Z0-9])[A-Z]{1,3}\d{3,4}[A-Z]{1,3}\d{0,2}(?![A-Z0-9])/g },
  // adidas — IE3437. The lookahead is THE substring-trap guard: never match a
  // letters+digits run that is followed by a separator and more digits, because
  // that run is the head of a longer code, not a code.
  { format: "adidas-block", re: /(?<![A-Z0-9])[A-Z]{1,2}\d{4,6}(?![A-Z0-9])(?![-\s]?\d)/g },
];

const MAX_CANDIDATES = 8; // a label has one code; more than a handful means noise

/**
 * Pull every plausible style code out of raw OCR text.
 *
 * @param {unknown} text  full text from an OCR pass
 * @returns {Array<{raw:string, normalised:string, format:string}>}
 *          de-duplicated by normalised code, in the order found, capped.
 */
function extractStyleCodeCandidates(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const masked = maskNonCodeText(text.toUpperCase());

  const consumed = [];              // [start, end) spans already claimed
  const overlaps = (s, e) => consumed.some(([cs, ce]) => s < ce && e > cs);

  const found = [];
  const seen = new Set();
  for (const { re, format } of EXTRACTION_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // GUARD 1: a more specific pattern already owns these characters.
      if (overlaps(start, end)) continue;
      const raw = m[0].trim();
      const normalised = normaliseStyleCode(raw);
      // Belt-and-suspenders: the normalised result must still be a shape we
      // recognise. Masking + span bookkeeping should guarantee it; this catches
      // the case where they don't.
      if (!normalised || styleCodeFormat(normalised) === null) continue;
      consumed.push([start, end]);
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      found.push({ raw, normalised, format });
    }
  }
  return found.slice(0, MAX_CANDIDATES);
}

// ── Confusable-character retry (tier 3) ──────────────────────────────────────
// OCR reliably confuses these glyph pairs on a small printed label. When a
// candidate misses in BOTH the cache and the catalog, we retry the LOOKUP with
// the plausible misreadings — no additional vision call, which is the whole
// point: this tier is free.
//
// Substitution is used ONLY to widen a lookup. It is NEVER applied to
// normalisation, where swapping 0/O could merge two genuinely different codes.
const CONFUSABLE_PAIRS = [["0", "O"], ["1", "I"], ["8", "B"], ["5", "S"], ["2", "Z"]];

const CONFUSABLE_MAP = (() => {
  const m = new Map();
  for (const [a, b] of CONFUSABLE_PAIRS) {
    m.set(a, (m.get(a) || []).concat(b));
    m.set(b, (m.get(b) || []).concat(a));
  }
  return m;
})();

const MAX_CONFUSABLE_VARIANTS = 24; // hard cost ceiling — 2^n is not a plan

/**
 * Plausible misreadings of a code, nearest-first (one substitution before two).
 *
 * Variants that do not land on a recognised shape are dropped: they cannot be
 * real style codes, so looking them up would spend quota to learn nothing.
 *
 * @returns {string[]} normalised variants, excluding the input, capped.
 */
function confusableVariants(code, { max = MAX_CONFUSABLE_VARIANTS } = {}) {
  const base = normaliseStyleCode(code);
  if (!base) return [];

  const positions = [];
  for (let i = 0; i < base.length; i++) {
    if (CONFUSABLE_MAP.has(base[i])) positions.push(i);
  }
  if (!positions.length) return [];

  const out = [];
  const seen = new Set([base]);
  const push = (s) => {
    if (seen.has(s)) return;
    seen.add(s);
    if (styleCodeFormat(s) === null) return; // cannot be a real code — don't spend a lookup
    out.push(s);
  };
  const swapAt = (s, i, to) => s.slice(0, i) + to + s.slice(i + 1);

  // Distance 1 — by far the common case (one smudged glyph).
  for (const i of positions) {
    for (const to of CONFUSABLE_MAP.get(base[i])) push(swapAt(base, i, to));
    if (out.length >= max) return out.slice(0, max);
  }
  // Distance 2 — a poor photo can lose two.
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const i = positions[a], j = positions[b];
      for (const toI of CONFUSABLE_MAP.get(base[i])) {
        for (const toJ of CONFUSABLE_MAP.get(base[j])) {
          push(swapAt(swapAt(base, i, toI), j, toJ));
          if (out.length >= max) return out.slice(0, max);
        }
      }
    }
  }
  return out.slice(0, max);
}

// ── OCR result cache ─────────────────────────────────────────────────────────
// Keyed on a hash of the IMAGE BYTES, so a staff member who retakes the same
// photo, or two people photographing the same label, do not re-bill the OCR.
//
// ── THIS NODE STORES CANDIDATES ONLY ─────────────────────────────────────────
// Never the Vision response payload. A full DOCUMENT_TEXT_DETECTION response is
// tens of kilobytes of per-symbol bounding boxes; multiplied by every photo
// taken in every shop and re-downloaded on every read, that is exactly the
// shape of node that has already cost this project real money in RTDB
// download bandwidth. What we keep is what we need: the codes, where they came
// from, when, and when to bin them.
const OCR_CACHE_PATH = "style_code_ocr_cache";
const OCR_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const OCR_SOURCES = ["vision", "gemini"];

/** Stable content hash of the image bytes — the cache key. */
function imageHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * The ONLY shape written to /style_code_ocr_cache. Deliberately tiny, and
 * constructed rather than spread, so a fat payload cannot leak in by accident.
 */
function buildOcrCacheRecord({ candidates, source, nowMs, ttlMs = OCR_CACHE_TTL_MS }) {
  const codes = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c === "string" ? normaliseStyleCode(c) : normaliseStyleCode(c && c.normalised)))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
  const at = Number.isFinite(nowMs) ? nowMs : 0;
  return {
    candidates: [...new Set(codes)],
    source: OCR_SOURCES.includes(source) ? source : "vision",
    at,
    expiresAt: at + ttlMs,
  };
}

/** A cached row is usable only while unexpired — lazy expiry, so we never serve stale. */
function isOcrCacheFresh(record, nowMs) {
  if (!record || !Array.isArray(record.candidates)) return false;
  const exp = Number(record.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp > (Number.isFinite(nowMs) ? nowMs : 0);
}

module.exports = {
  MASK_PATTERNS,
  EXTRACTION_PATTERNS,
  MAX_CANDIDATES,
  CONFUSABLE_PAIRS,
  MAX_CONFUSABLE_VARIANTS,
  OCR_CACHE_PATH,
  OCR_CACHE_TTL_MS,
  OCR_SOURCES,
  maskNonCodeText,
  extractStyleCodeCandidates,
  confusableVariants,
  imageHash,
  buildOcrCacheRecord,
  isOcrCacheFresh,
};
