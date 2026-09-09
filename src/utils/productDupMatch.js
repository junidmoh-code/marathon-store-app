// ─── PRODUCT DUPLICATE MATCHING — THE CLOTHING HALF OF THE INTAKE GATE ────────
// Clothing product NAMES in this catalogue ARE the supplier's article code:
// "44712", "44712-01", "8801 BLACK". Three shops receive the same delivery, three
// people type the same code into Admin → Products → Add Product, and the
// catalogue grows three records for one garment. The style-code gate
// (StyleCodeGate.jsx + styleCodeGateLogic.js) already closes this hole for
// sneakers, because a sneaker carries a manufacturer style code on its tongue
// label and the gate demands it FIRST. Clothing carries no such label, so that
// gate is not enforced for it and the name field is the only thing typed.
//
// This module is the matcher that lets the name field answer the same question
// the style-code gate answers: "is this already in the catalogue?"
//
// ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────
// It is NOT a second style-code system. Code recognition is delegated wholesale
// to utils/styleCode.js — normaliseStyleCode for the identity spelling and
// isKnownStyleCodeFormat for "is this string code-shaped". Every brand shape
// this file understands is a shape that file already understood, and adding a
// brand there widens this automatically.
//
// It is also NOT a decider. Like buildLinkSuggestions (utils/linkSuggestions.js)
// it RANKS and explains; the operator taps, or does not. The one place a
// decision is made from this output — resolve-to-one-exact-code — lives in the
// UI and is spelled out there.
//
// ── SUBSTRING MATCHING IS FORBIDDEN ──────────────────────────────────────────
// This is the single rule the whole file is built around, and it is the rule
// productSearch.js deliberately BREAKS (its `codeMatchesQuery` accepts a 3+ char
// substring, which is right for a human hunting through a list and catastrophic
// here). Article codes in this catalogue are dense and adjacent:
//
//     44712   144712   447120   44712-01
//
// Under substring matching, typing 44712 "finds" the first three and the
// operator is asked to confirm a product that is not theirs — or worse, routes a
// delivery of 44712 into 144712's stock cells. Every comparison in this file is
// therefore TOKEN-BOUNDARY ONLY: a code token is equal to another code token, or
// it is not a match. 44712 matches 44712. It does not match 144712, it does not
// match 447120, and the tests pin exactly that.
//
// The one loosening is `partial_code`, and it is NOT a prefix rule. It fires only
// when the printed code was SEGMENTED by a real separator — 44712-01 splits into
// ["44712","01"] — so the stem "44712" is a token the label itself drew a
// boundary around. 447120 has no separator, produces no stem, and can never
// reach that tier. That distinction is the reason extractTokens tracks segments
// at all.
//
// ── THE THREE TIERS ──────────────────────────────────────────────────────────
//   exact_code    a code token typed equals a code token in the product's name,
//                 or its styleCodeNormalised, or one of its barcodes. This is
//                 identity: two records answering to one code IS the duplicate.
//   partial_code  the typed code is the stem of a segmented product code (or the
//                 reverse) — 44712 against 44712-01. Same article, probably a
//                 colourway. Worth showing, never worth deciding on: the
//                 style-code work is emphatic that CT8527-016 and CT8527-700 are
//                 DIFFERENT SHOES (see the header of utils/styleCode.js), and
//                 the same is true of a supplier's colour suffix.
//   fuzzy_name    word overlap. Loosest tier, and floored hard — see FUZZY_FLOOR.

import { normaliseStyleCode, isKnownStyleCodeFormat } from "./styleCode.js";

// ── TUNING, NAMED ────────────────────────────────────────────────────────────
// A digit run this long or longer is treated as a code rather than a word. Four
// is the shortest article code the live clothing catalogue actually prints; three
// would swallow "500" out of "Levi 500" and turn a model number into an identity
// claim.
export const CODE_DIGIT_MIN = 4;
// Words shorter than this carry no ranking signal ("XL", "2", "V"). They are
// still WORDS — they simply do not count toward overlap.
export const WORD_MIN = 3;
// A fuzzy match must share at least this many words. One shared word is a brand
// name; "NIKE" typed would otherwise surface every Nike product in the shop.
export const FUZZY_MIN_SHARED = 2;
// …and must clear this ratio, measured against the LARGER of the two word sets.
// Measuring against the smaller one makes a short typed string match everything
// that contains it, which is substring matching wearing a ratio's clothes.
export const FUZZY_FLOOR = 0.5;
// The hard cap on how many suggestions may ever be returned. A panel longer than
// this stops being a check and becomes a list to scroll past.
export const MAX_CANDIDATES = 8;

export const TIER_EXACT_CODE = "exact_code";
export const TIER_PARTIAL_CODE = "partial_code";
export const TIER_FUZZY_NAME = "fuzzy_name";

// Strongest first. rankCandidates sorts on this before it sorts on score, so a
// weak exact-code match always outranks a strong fuzzy one.
export const TIER_RANK = {
  [TIER_EXACT_CODE]: 3,
  [TIER_PARTIAL_CODE]: 2,
  [TIER_FUZZY_NAME]: 1,
};

/**
 * Uppercase, punctuation and separators reduced to single spaces, trimmed.
 *
 * DELIBERATELY DIFFERENT from normaliseStyleCode, which strips separators
 * ENTIRELY because it is building one identity key from one code. Here the
 * separators are the token boundaries — collapsing "44712 01" into "4471201"
 * would destroy the only evidence that tells a two-part code from a seven-digit
 * one — so they become spaces and are kept.
 *
 * @param {unknown} s
 * @returns {string} "" when there is nothing usable
 */
export function normaliseForMatch(s) {
  if (typeof s !== "string") return "";
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

// Is this bare (separator-free) run a code rather than a word? Either it is a
// long enough digit run, or it is a shape utils/styleCode.js already recognises
// as something a brand prints.
function isCodeToken(bare) {
  if (!bare) return false;
  if (/^\d+$/.test(bare)) return bare.length >= CODE_DIGIT_MIN;
  return isKnownStyleCodeFormat(bare);
}

/**
 * Split a string into the tokens matching works on.
 *
 * Returns three lists, all uppercase and all deduped:
 *   words      every alphanumeric run, in order. The fuzzy tier's vocabulary.
 *   codes      the IDENTITY spelling of every code-shaped run: separators
 *              removed, so "44712-01" is the single token "4471201" — exactly
 *              what normaliseStyleCode would produce for it. Two products
 *              sharing one of these share a code.
 *   codeStems  the leading segment of every code the SOURCE STRING itself
 *              separated: "44712-01" → "44712". Empty for any run with no
 *              separator, which is what keeps 447120 from ever pretending to be
 *              44712 with a suffix.
 *
 * @param {unknown} s
 * @returns {{words: string[], codes: string[], codeStems: string[]}}
 */
export function extractTokens(s) {
  const empty = { words: [], codes: [], codeStems: [] };
  if (typeof s !== "string" || !s.trim()) return empty;

  const words = normaliseForMatch(s).split(" ").filter(Boolean);

  // Scan the raw string for alphanumeric runs joined by INTERNAL separators
  // (hyphen, slash, underscore, dot — every character a supplier prints between
  // the article block and the colour block). A trailing or leading separator is
  // not part of the run.
  const upper = typeof s === "string" ? s.toUpperCase() : "";
  const codes = [];
  const codeStems = [];
  const RUN = /[A-Z0-9]+(?:[-/_.][A-Z0-9]+)*/g;
  let m;
  while ((m = RUN.exec(upper)) !== null) {
    const run = m[0];
    const segments = run.split(/[-/_.]/).filter(Boolean);
    const bare = normaliseStyleCode(run);
    if (!isCodeToken(bare)) continue;
    if (!codes.includes(bare)) codes.push(bare);
    // Only a run the label ITSELF segmented yields a stem, and only when that
    // stem is code-shaped in its own right — "T-SHIRT" must not donate "T".
    if (segments.length >= 2) {
      const stem = segments[0];
      if (isCodeToken(stem) && !codeStems.includes(stem)) codeStems.push(stem);
    }
  }

  return { words, codes, codeStems };
}

// Every code a PRODUCT answers to, as identity spellings. Three sources, and all
// three are the catalogue's own record of the code — nothing is inferred:
//   • its name (which for clothing IS the article code)
//   • styleCodeNormalised, the field the style-code gate claims and owns
//   • its barcodes — top-level, per-size, and the printed EAN a perfume carries
// The barcode fields are read the way productSearch.js reads them, so a code the
// POS resolves is a code this panel sees.
function productCodeTokens(product) {
  const out = { codes: [], codeStems: [], byCode: new Map() };
  const add = (code, why) => {
    const bare = normaliseStyleCode(code);
    if (!bare || out.byCode.has(bare)) return;
    out.codes.push(bare);
    out.byCode.set(bare, why);
  };

  const nameTokens = extractTokens(product && product.name);
  for (const c of nameTokens.codes) add(c, "name");
  for (const st of nameTokens.codeStems) if (!out.codeStems.includes(st)) out.codeStems.push(st);

  if (product && typeof product.styleCodeNormalised === "string") add(product.styleCodeNormalised, "style code");

  for (const c of productBarcodes(product)) add(c, "barcode");

  return out;
}

// Barcode-ish fields, as raw strings. Mirrors productSearch.js `productCodes`
// deliberately — one product, one set of codes, wherever it is being searched.
function productBarcodes(p) {
  const out = [];
  if (!p || typeof p !== "object") return out;
  if (p.barcode != null) out.push(String(p.barcode));
  if (p.sku != null) out.push(String(p.sku));
  if (p.printedBarcode != null) out.push(String(p.printedBarcode));
  if (p.barcodes && typeof p.barcodes === "object") {
    for (const c of Object.values(p.barcodes)) if (c != null) out.push(String(c));
  }
  return out;
}

// The words that carry ranking signal: long enough to mean something, and not a
// code (a code is matched as a code or not at all — letting it also count as a
// word would let the fuzzy tier re-admit near-code matches through the back door).
function signalWords(tokens) {
  const codeSet = new Set([...tokens.codes, ...tokens.codeStems]);
  const seen = new Set();
  const out = [];
  for (const w of tokens.words) {
    if (w.length < WORD_MIN) continue;
    if (codeSet.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Score ONE product against what the operator typed.
 *
 * @param {string} typed         the raw contents of the product-name field
 * @param {object} product       a /products record
 * @returns {{tier: string, score: number, reason: string}|null}
 *          null when this product is not a candidate at all.
 *
 * `score` is confidence WITHIN the tier, in [0,1]. It never crosses tiers — see
 * TIER_RANK. `reason` is operator-facing and says which evidence fired, because
 * a suggestion the operator cannot account for is a suggestion they will
 * dismiss without reading.
 */
export function scoreCandidate(typed, product) {
  if (!product || typeof product !== "object" || !product.id) return null;
  const t = extractTokens(typed);
  const p = productCodeTokens(product);

  // ── TIER 1: the same code. Identity, not similarity. ──
  for (const code of t.codes) {
    if (p.byCode.has(code)) {
      const why = p.byCode.get(code);
      return { tier: TIER_EXACT_CODE, score: 1, reason: `${code} matches this product's ${why}` };
    }
  }

  // ── TIER 2: the same ARTICLE, a different printed suffix. ──
  // Both directions: the operator may type the short form against a stored long
  // one, or the long form against a stored short one.
  for (const code of t.codes) {
    if (p.codeStems.includes(code)) {
      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: `${code} is the first part of this product's code` };
    }
  }
  for (const stem of t.codeStems) {
    if (p.byCode.has(stem)) {
      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: `this product's code ${stem} is the first part of what you typed` };
    }
    // Two SIBLING colourways — 44712-01 typed against a stored 44712-99. Both
    // labels drew the same boundary around the same article block, so this is
    // still a boundary match and not a prefix guess. It is deliberately the
    // WEAKEST thing partial_code will show: styleCode.js is emphatic that a
    // colour suffix makes a different product, so this may suggest and must
    // never resolve.
    if (p.codeStems.includes(stem)) {
      return { tier: TIER_PARTIAL_CODE, score: 0.75, reason: `${stem} is the first part of both codes — this may be another colourway` };
    }
  }

  // ── TIER 3: word overlap, floored. ──
  const tw = signalWords(t);
  const pw = signalWords(extractTokens(product.name));
  if (!tw.length || !pw.length) return null;
  const pwSet = new Set(pw);
  const shared = tw.filter((w) => pwSet.has(w));
  if (shared.length < FUZZY_MIN_SHARED) return null;
  // AGAINST THE LARGER SET, on purpose. Dividing by the smaller one would score
  // "NIKE AIR" against "NIKE AIR FORCE 1 TRIPLE WHITE" at 1.0 and reintroduce
  // substring behaviour through arithmetic.
  const ratio = shared.length / Math.max(tw.length, pw.length);
  if (ratio < FUZZY_FLOOR) return null;
  return {
    tier: TIER_FUZZY_NAME,
    score: ratio,
    reason: `shares ${shared.length} word${shared.length === 1 ? "" : "s"} with this name`,
  };
}

/**
 * Rank a catalogue against what was typed.
 *
 * Sorted strongest-tier-first, then by score, then by name so the order is
 * deterministic across renders. Deduped by product id. Capped at MAX_CANDIDATES
 * however large a `limit` is asked for.
 *
 * PURE, AND IN MEMORY. The Add Product screen already holds the whole catalogue
 * (AdminView receives `products` and hands it to NewProductForm), so this costs
 * ZERO reads — which is the reason it matches in memory rather than querying.
 *
 * @param {unknown} typed
 * @param {Array} products
 * @param {number} limit
 * @returns {Array<{product: object, tier: string, score: number, reason: string}>}
 */
export function rankCandidates(typed, products, limit = MAX_CANDIDATES) {
  const list = Array.isArray(products) ? products : [];
  const cap = Math.max(0, Math.min(Number.isFinite(limit) ? limit : MAX_CANDIDATES, MAX_CANDIDATES));
  if (!cap) return [];
  const seen = new Set();
  const rows = [];
  for (const product of list) {
    if (!product || !product.id || seen.has(product.id)) continue;
    seen.add(product.id);
    const hit = scoreCandidate(typed, product);
    if (hit) rows.push({ product, ...hit });
  }
  rows.sort((a, b) =>
    (TIER_RANK[b.tier] - TIER_RANK[a.tier]) ||
    (b.score - a.score) ||
    String(a.product.name ?? "").localeCompare(String(b.product.name ?? "")));
  return rows.slice(0, cap);
}
