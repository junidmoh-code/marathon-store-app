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
  // Month-name production dates — 01JAN2024, 15 MAY 23, DEC2024. These would
  // otherwise fit the Lacoste dd+AAA+dddd shape and leak into fingerprints,
  // splitting the same shoe per manufacturing run.
  /\b\d{0,2}\s?(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?\d{2,4}\b/g,
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
  // Lacoste — 7-43SMA0033 1R5 / 47SMA0057042. FIRST: its tail would otherwise
  // be claimed piecemeal by the broader adidas/NB shapes below. The colour
  // suffix group is greedy-optional so "43SMA0033 1R5" comes out whole.
  { format: "lacoste-ref", re: /(?<![A-Z0-9])(?:7[-\s]?)?\d{2}(?!(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d)[A-Z]{3}\d{4}(?:[-\s]?[A-Z0-9]{2,3})?(?![A-Z0-9])/g },
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
  // ── MULTI-TOKEN WIDENING (owner spec 2026-08-13) — appended LAST on purpose:
  // span consumption means these can only claim characters no brand pattern
  // wanted, so every extraction that worked before produces the identical
  // candidates it always did; these ADD tokens, never change one.
  //
  // SPLIT NUMERIC — a production line printed as two digit groups. The Lacoste
  // label prints "35289 0625"; the article-code shapes above cannot see it
  // (their separator sits after 6 digits, this one after 4-6), yet the run-
  // together form 352890625 is exactly the code some products already hold.
  // format:null → the candidate gate below names it by what it NORMALISES to
  // (numeric-6-3 / puma-6-2) and drops any total length that matches nothing.
  { format: null, re: /(?<![A-Z0-9])\d{4,6}[-\s]\d{2,5}(?![A-Z0-9])(?![-\s]?\d)/g },
  // LABEL SERIAL — letter/digit interleaved runs (Timberland A6CWNEN3, the
  // Lacoste production-order TTJJ21FB00001). Two letter→digit alternations
  // minimum; the trailing guard is the same substring trap every shape carries.
  { format: "label-serial", re: /(?<![A-Z0-9])(?:[A-Z]+\d+){2,}[A-Z]{0,8}(?![A-Z0-9])(?![-\s]?\d)/g },
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
      // A format:null pattern (the split-numeric widening) is named by what
      // its match NORMALISES to — the gate above already proved it is one.
      found.push({ raw, normalised, format: format || styleCodeFormat(normalised) });
    }
  }
  return found.slice(0, MAX_CANDIDATES);
}

// ── LABEL FINGERPRINT — identity when no known format matches ────────────────
// (Owner principle 2026-08-06: we do not need the manufacturer's official
// article number, we need a STABLE FINGERPRINT — identical on every pair of
// the same shoe, different on other shoes. Never reject a label that produced
// readable text.)
//
// Construction, deterministic end to end:
//   1. uppercase, tokenise on everything non-alphanumeric;
//   2. DROP the per-pair variable parts —
//        · size-system tokens and their attached numbers (US/UK/EU/JP/CM/CHN…,
//          already blanked by maskNonCodeText, plus bare size words),
//        · date/production tokens and EVERY pure-numeric token (dates like
//          0520 or 1222, per-unit serials, and per-SIZE GTIN/barcodes are all
//          numeric; a purely numeric article number would have matched a known
//          format upstream and never reached this fallback),
//        · boilerplate label words (MADE, IN, country names, SIZE, …);
//   3. KEEP model-bearing tokens (POWERCOURT, CLOUDNOVA) and article-shaped
//      mixed tokens (SWA, 0520A-style alnum mixes);
//   4. SORT + de-dupe so OCR reading order between two photos cannot change
//      the identity, then join and normalise;
//   5. cap to the 32-char ceiling styleCodeNormalised must satisfy: 24 chars
//      of tokens + an 8-hex digest of the FULL token string, so truncation can
//      never merge two long-but-different labels.
// The result is a legal styleCodeNormalised (its own uppercase, ≤32, A-Z0-9)
// and claims /style_code_index like any verified code — uniqueness is NEVER
// weakened, a collision with another product's claim is a duplicate → merge.
const FINGERPRINT_STOPWORDS = new Set([
  "SIZE", "TAILLE", "TALLA", "GROSSE", "GR",
  "US", "UK", "EU", "EUR", "FR", "JP", "JPN", "CM", "CHN", "CN", "KR", "BR", "MX", "AU", "D",
  "MADE", "IN", "FABRIQUE", "AU", "HECHO", "EN",
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  "CHINA", "CHINE", "VIETNAM", "INDONESIA", "INDONESIE", "CAMBODIA", "CAMBODGE", "INDIA", "INDE",
  "THAILAND", "TURKEY", "PORTUGAL", "ITALY", "ITALIE",
]);

/**
 * The STABLE TOKEN SET of a label — the per-pair variable parts stripped
 * (sizes in every system, dates numeric and month-name, pure-numeric serials/
 * GTINs, boilerplate). This is the unit the alias store matches on (owner
 * design fix 2026-08-06): identity is assigned once and looked up by token
 * OVERLAP afterwards, never by re-derived string equality.
 * @returns {string[]} sorted unique tokens; [] when nothing stable survives
 */
function labelTokens(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  // Reuse the SAME masking the extractor trusts — sizes-with-system and dates
  // vanish before tokenisation, exactly once, in one place.
  const masked = maskNonCodeText(text.toUpperCase());
  const tokens = masked.split(/[^A-Z0-9]+/).filter(Boolean)
    .filter((t) => !/^\d+$/.test(t))                 // every pure-numeric token is per-pair noise here
    .filter((t) => !FINGERPRINT_STOPWORDS.has(t))
    .filter((t) => t.length >= 3 || /\d/.test(t))    // 1-2 letter fragments carry no identity
    .map((t) => t.slice(0, 24));                     // bound token length
  // Bounded COUNT too — a noisy Vision response must not balloon the cache
  // row or the response (the alias store applies the same 40-token policy).
  return [...new Set(tokens)].sort().slice(0, 40);
}

function labelFingerprint(text) {
  const tokens = labelTokens(text);
  if (!tokens.length) return null;
  const unique = tokens;
  // The digest is computed over the DELIMITED token list and ALWAYS appended.
  // Concatenation alone is ambiguous — {"CLOUDNOVA","MONO"} and
  // {"CLOUDNOVAM","ONO"} concatenate identically once sorted, and two
  // different shoes silently sharing one identity is the failure this whole
  // feature forbids. The tradeoff is deliberate and fail-closed: an OCR pass
  // that SPLITS the same label's words differently now produces a DIFFERENT
  // fingerprint (a recoverable "never registered" false signal) instead of two
  // different labels ever producing the SAME one (an unrecoverable silent
  // merge). Uniqueness wins.
  const delimited = unique.join("|");
  const concat = unique.join("").replace(/[^A-Z0-9]/g, "");
  if (!concat) return null;
  const digest = crypto.createHash("sha1").update(delimited).digest("hex").slice(0, 8).toUpperCase();
  return concat.slice(0, 24) + digest;
}

// ── LABEL EXTRAS — everything ELSE the label offers ──────────────────────────
// (Owner evidence 2026-08-07.) The standard Nike tongue label prints NO
// colourway text — but some labels DO: RTFKT-style Nike labels print a
// colourway line under the model name ("WOLF GREY/PHOTO BLUE"), and we were
// discarding it. Brand research (2026-08-07, PR notes) says the wider picture:
// Nike/Jordan/Asics/UA encode colour as a numeric suffix INSIDE the style code
// and print a colourway sentence only on the BOX label; adidas/Puma/NB/
// Converse never print one at all. So a printed colourway line is a BONUS
// signal — extracted when present, used to ORDER candidates and prefill a
// name, never required and never trusted as identity.
//
// The UPC is likewise captured but NON-AUTHORITATIVE: a genuine UPC is per
// size-SKU, yet this stock reuses one UPC across a size run (HF5509-002 across
// US 7/8/8.5), so the system must never assume one code — style or UPC —
// means one shoe. The UPC is stored as evidence, never used as a key and
// never written to /barcodes (which is our own internally-minted namespace).
//
// Colourway detection is deliberately conservative: a line qualifies only when
// it is slash-separated segments whose words are mostly known colour words.
// A model name ("DUNK GENESIS") never matches; an address never matches. The
// model-name line is NOT regex-guessed here — only tier 2 (a vision model that
// can see the layout) may propose one.
const COLOUR_LEXICON = new Set([
  "BLACK", "WHITE", "GREY", "GRAY", "RED", "BLUE", "GREEN", "YELLOW", "ORANGE",
  "PURPLE", "PINK", "BROWN", "TAN", "BEIGE", "CREAM", "NAVY", "TEAL", "AQUA",
  "VOLT", "CRIMSON", "OBSIDIAN", "SAIL", "BONE", "PLATINUM", "SILVER", "GOLD",
  "GUM", "INFRARED", "BRED", "ROYAL", "TURQUOISE", "LIME", "OLIVE", "KHAKI",
  "MAROON", "BURGUNDY", "CORAL", "SALMON", "MINT", "LAVENDER", "MAGENTA",
  "CYAN", "IVORY", "CHARCOAL", "STONE", "SAND", "TAUPE", "MULTI", "PHOTO",
  "WOLF", "COOL", "DARK", "LIGHT", "PALE", "DEEP", "BRIGHT", "PURE", "OFF",
  "UNIVERSITY", "VARSITY", "TOTAL", "HYPER", "RACER", "COURT", "GAME", "TRUE",
  "MIDNIGHT", "SUMMIT", "PHANTOM", "ANTHRACITE", "SMOKE", "DUSTY", "ICED",
  "METALLIC", "GLACIER", "OCEAN", "DESERT", "CACTUS", "PINE", "FOREST",
  "CANYON", "LASER", "ATOMIC", "ELECTRIC", "NEON", "PASTEL", "VINTAGE",
  "UNDYED", "MONO", "TRIPLE", "CORE", "CLOUD", "CHALK", "FROST", "ARCTIC",
]);

// A UPC/EAN/GTIN digit run: 12 (UPC-A), 13 (EAN-13) or 14 (GTIN-14 — the
// photographed labels print "00197859117222", a zero-padded 14) digits,
// standing alone. Taken from the RAW text, not the masked text — masking can
// eat digits that belong to dates, but a 12-14 digit run never matches the
// date shapes.
const UPC_RE = /(?<!\d)(\d{12,14})(?!\d)/;

/**
 * Is this OCR line a printed colourway line? ("WOLF GREY/PHOTO BLUE")
 * Conservative on purpose: slash-separated segments, every segment 1-4 words,
 * and a MAJORITY of words drawn from the colour lexicon. Fails to null, never
 * to a guess.
 * @returns {string|null} the cleaned line, or null
 */
function detectColourwayLine(line) {
  if (typeof line !== "string") return null;
  const clean = line.toUpperCase().replace(/[^A-Z/ ]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean.includes("/")) return null;
  const segments = clean.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2 || segments.length > 5) return null;
  const words = segments.flatMap((s) => s.split(" ")).filter(Boolean);
  if (!words.length || words.length > 12) return null;
  const colourWords = words.filter((w) => COLOUR_LEXICON.has(w)).length;
  // Majority rule: at least half the words must be colour words, and every
  // segment must contain at least one — "AIR/MAX 90" never qualifies.
  if (colourWords * 2 < words.length) return null;
  if (!segments.every((s) => s.split(" ").some((w) => COLOUR_LEXICON.has(w)))) return null;
  return segments.join("/");
}

/**
 * Everything beyond the style code that a label's OCR text offers.
 * @param {unknown} text  full OCR text
 * @returns {{colourway: string|null, upc: string|null}}
 */
function extractLabelExtras(text) {
  if (typeof text !== "string" || !text.trim()) return { colourway: null, upc: null };
  let colourway = null;
  for (const line of text.split(/\r?\n/)) {
    const hit = detectColourwayLine(line);
    if (hit) { colourway = hit; break; }
  }
  const upcMatch = UPC_RE.exec(text.replace(/[\s-](?=\d)/g, "")) || UPC_RE.exec(text);
  return { colourway, upc: upcMatch ? upcMatch[1] : null };
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
function buildOcrCacheRecord({ candidates, source, nowMs, ttlMs = OCR_CACHE_TTL_MS, tokens = null, extras = null, preferred = null }) {
  const codes = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c === "string" ? normaliseStyleCode(c) : normaliseStyleCode(c && c.normalised)))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
  const at = Number.isFinite(nowMs) ? nowMs : 0;
  const rec = {
    candidates: [...new Set(codes)],
    source: OCR_SOURCES.includes(source) ? source : "vision",
    at,
    expiresAt: at + ttlMs,
    // Schema version: 2 = the token-set era (owner design fix 2026-08-06).
    // RTDB drops null/empty children, so "computed and found none" cannot be
    // stored literally — fpv is how a candidates-less row proves it was
    // written whole. fpv:1 rows (the brief fingerprint-string era) are
    // deliberately STALE under v2 so they upgrade to tokens on one re-read.
    fpv: 2,
  };
  // Tier 2's pick (`pk`) rides the cache so a retake of a settled multi-token
  // label resolves in one step without re-billing tier 2. Stored only when it
  // names one of the row's own candidates — a stray pick must not survive.
  if (typeof preferred === "string" && rec.candidates.includes(normaliseStyleCode(preferred))) {
    rec.pk = normaliseStyleCode(preferred);
  }
  // The stable TOKEN SET rides the cache (a small map, no payload) so a retake
  // of the same no-format label re-bills nothing and still matches aliases.
  if (Array.isArray(tokens) && tokens.length) {
    const tk = {};
    for (const t of tokens) if (t) tk[String(t)] = true;
    if (Object.keys(tk).length) rec.tk = tk;
  }
  // Label extras (colourway line / UPC / model name) ride the cache too, in
  // short keys and bounded lengths — a retake must not re-bill to re-learn a
  // line the first read already extracted. Absent values are OMITTED, never
  // stored as null (RTDB drops nulls; omit-don't-copy is the house rule).
  if (extras && typeof extras === "object") {
    if (typeof extras.colourway === "string" && extras.colourway) rec.cw = extras.colourway.slice(0, 64);
    if (typeof extras.upc === "string" && extras.upc) rec.upc = extras.upc.slice(0, 14);
    if (typeof extras.modelName === "string" && extras.modelName) rec.mn = extras.modelName.slice(0, 64);
  }
  return rec;
}

/** A cached row is usable only while unexpired — lazy expiry, so we never serve stale. */
function isOcrCacheFresh(record, nowMs) {
  if (!record) return false;
  // RTDB DELETES an empty-array child, so a zero-candidate row (token-set or
  // genuinely unreadable) reads back with NO candidates key at all. An fpv≥2
  // marker vouches for such a row; anything older (fpv:1 fingerprint-string
  // era, or unmarked legacy) is deliberately stale and re-reads once.
  if (!Array.isArray(record.candidates) && !(record.fpv >= 2)) return false;
  const exp = Number(record.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp > (Number.isFinite(nowMs) ? nowMs : 0);
}

module.exports = {
  labelFingerprint,
  labelTokens,
  COLOUR_LEXICON,
  detectColourwayLine,
  extractLabelExtras,
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
