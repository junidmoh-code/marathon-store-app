// ─── LABEL ALIASES — identity assigned once, looked up fuzzily ever after ────
// (Owner design fix 2026-08-06.) The shipped fingerprint was RE-DERIVED from
// OCR on every scan and compared for exact equality — but OCR is not
// deterministic across photos, so the same shoe drifted to a new fingerprint,
// read as "never registered", and the immutable styleCodeNormalised made
// re-registration impossible. Unrecoverable, and it would happen in normal use.
//
// THE PRINCIPLE: a label reading is an ALIAS, not a key. Identity is assigned
// ONCE at registration, when a human has already found and confirmed the
// product. Every later scan is a LOOKUP — fuzzy, because a human is holding
// the shoe and can confirm. Every reading a human confirms becomes a FURTHER
// alias, so accuracy improves with use instead of degrading.
//
//   /label_aliases/{aliasId} = {
//     productId,                 // the one product this reading points at
//     t: { TOKEN: true, ... },   // the token SET — a map, NEVER an array
//                                // (real RTDB deletes empty arrays, and
//                                // 12-token arrays round-trip as objects
//                                // anyway; a map is the honest shape)
//     n,                         // token count, for cheap scoring
//     addedAt, addedBy,          // server-stamped provenance
//   }
//
// The node is written and read ONLY by the labelAlias callable on the Admin
// SDK — no client rules needed, no rules change. styleCodeNormalised now holds
// real manufacturer codes ONLY; token identities never touch it, so the
// immutability rule can never dead-end a registration again.
//
// ── MATCHING: CONTAINMENT, not Jaccard, not equality ─────────────────────────
// score = |A ∩ B| / min(|A|, |B|)
// Chosen because OCR variance is mostly LOSS and SPLIT: a glare-shortened read
// of the same label is close to a SUBSET of the registered reading, which
// containment scores near 1.0 while Jaccard punishes the size asymmetry. Two
// different shoes share brand/colour boilerplate but differ on model tokens,
// which keeps containment mid-range — and the shared-token floor stops tiny
// sets from ever matching silently.
//
// ── THE BANDS (conservative on purpose) ──────────────────────────────────────
//   HIGH  ≥ 0.80 containment AND ≥ 3 shared tokens → resolve silently.
//         A silent wrong match is unrecoverable, so silence demands 80% of the
//         smaller set shared and at least 3 real tokens of evidence. A clean
//         re-read of the same label with one token split differently scores
//         ~0.85-0.92 here; a different shoe of the same line ("CLOUDNOVA" vs
//         "CLOUDMONSTER" colourways) shares brand/colour tokens but tops out
//         well under 0.8 against the model tokens it lacks.
//   MID   ≥ 0.45 → show the candidate LARGE and ask. A human yes files the new
//         reading as another alias; a human no costs one tap. Wrong-but-asked
//         is recoverable, so this band is wide by design.
//   LOW   < 0.45 → genuinely unregistered; the calm never-registered path.
//   AMBIGUITY DOWNGRADE: if TWO different products both score ≥ HIGH, neither
//   resolves silently — the scan drops to MID and the human decides.

"use strict";

const { normaliseStyleCode, styleCodeFormat } = require("./style-code.cjs");

const LABEL_ALIASES_PATH = "label_aliases";

const BANDS = Object.freeze({
  HIGH: 0.8,
  MID: 0.45,
  MIN_SHARED: 3,   // tokens two readings must share before silence is allowed
  MIN_TOKENS: 2,   // a reading with fewer distinct tokens carries no identity
});

const MAX_TOKENS = 40;      // a label has ~a dozen useful tokens; more is noise
const MAX_TOKEN_LEN = 24;
// An alias this close to an existing one for the SAME product is the same
// reading — storing it again adds noise, not accuracy.
const DEDUPE_CONTAINMENT = 0.9;

/** Clean, bound, de-dupe, sort. Returns [] when nothing usable survives. */
function normaliseAliasTokens(tokens) {
  const arr = Array.isArray(tokens) ? tokens : [];
  const out = new Set();
  for (const t of arr) {
    const clean = String(t ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_TOKEN_LEN);
    if (clean.length >= 2 && !/^\d+$/.test(clean)) out.add(clean);
    if (out.size >= MAX_TOKENS) break;
  }
  return [...out].sort();
}

/** Token array → RTDB map. Refuses sets too small to be an identity. */
function tokensToMap(tokens) {
  const clean = normaliseAliasTokens(tokens);
  if (clean.length < BANDS.MIN_TOKENS) return null;
  const map = {};
  for (const t of clean) map[t] = true;
  return map;
}

/** RTDB map (or legacy array) → token array. */
function tokensFromNode(node) {
  if (!node) return [];
  if (Array.isArray(node)) return normaliseAliasTokens(node);
  if (typeof node === "object") return normaliseAliasTokens(Object.keys(node));
  return [];
}

/** |A ∩ B| and containment |A∩B| / min(|A|,|B|). */
function overlap(aTokens, bTokens) {
  const a = new Set(aTokens);
  let shared = 0;
  for (const t of bTokens) if (a.has(t)) shared++;
  const denom = Math.min(a.size, new Set(bTokens).size);
  return { shared, containment: denom ? shared / denom : 0 };
}

/**
 * Score a scan's tokens against every stored alias; best score per product.
 * @param {string[]} scanTokens
 * @param {object} aliasesNode  the whole /label_aliases node ({id: record})
 * @returns {Array<{productId, score, shared, aliasId}>} sorted best-first
 */
function scoreAliases(scanTokens, aliasesNode) {
  const tokens = normaliseAliasTokens(scanTokens);
  if (tokens.length < BANDS.MIN_TOKENS) return [];
  const best = new Map();
  for (const [aliasId, rec] of Object.entries(aliasesNode || {})) {
    if (!rec || !rec.productId) continue;
    const aliasTokens = tokensFromNode(rec.t);
    if (!aliasTokens.length) continue;
    const { shared, containment } = overlap(tokens, aliasTokens);
    const prev = best.get(rec.productId);
    // Ties on containment break by SHARED tokens — a three-token exact alias
    // must beat a two-token subset alias, or bandFor sees the weaker evidence.
    if (!prev || containment > prev.score || (containment === prev.score && shared > prev.shared)) {
      best.set(rec.productId, { productId: rec.productId, score: containment, shared, aliasId });
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score || y.shared - x.shared);
}

/** The three-band outcome, with the ambiguity downgrade. */
function bandFor(scored) {
  const top = scored[0];
  if (!top) return "low";
  const meetsHigh = top.score >= BANDS.HIGH && top.shared >= BANDS.MIN_SHARED;
  if (meetsHigh) {
    const second = scored[1];
    // Two DIFFERENT products both over the silent bar → nobody resolves
    // silently; the human decides. A silent wrong match is unrecoverable.
    if (second && second.score >= BANDS.HIGH && second.shared >= BANDS.MIN_SHARED) return "mid";
    return "high";
  }
  if (top.score >= BANDS.MID) return "mid";
  return "low";
}

/** Is this reading already covered by an existing alias of the same product? */
function isDuplicateAlias(tokens, productId, aliasesNode) {
  const clean = normaliseAliasTokens(tokens);
  for (const rec of Object.values(aliasesNode || {})) {
    if (!rec || rec.productId !== productId) continue;
    const { containment } = overlap(clean, tokensFromNode(rec.t));
    if (containment >= DEDUPE_CONTAINMENT) return true;
  }
  return false;
}

// ── CODE ALIASES — every code-shaped token on one label IS the same shoe ─────
// (Owner spec 2026-08-08, the Diesel Big D incident.) Some labels print TWO
// code-shaped tokens (190935-505 AND 740750-35). There is exactly ONE shoe in
// the operator's hand, so every token on that label refers to the same
// product — which token the operator happened to tap must not mint a second
// identity. The tapped token goes down the normal capture/claim path and may
// become styleCodeNormalised (still the single canonical code, still
// immutable); EVERY token on the label is additionally filed here as a CODE
// ALIAS, so a colleague who later taps or scans the OTHER token resolves to
// the SAME product.
//
// A code-alias record shares /label_aliases with the token-set records but is
// a different animal: `c` (a map of normalised codes, never an array) instead
// of `t`, and it is looked up EXACTLY, never fuzzily — a style code either is
// or is not on a label. Token-set scoring skips these records (no `t`), and
// exact code lookup skips token records (no `c`); the two kinds cannot bleed
// into each other's matching.
//
// Exact lookup FAILS CLOSED: if two records point one code at two DIFFERENT
// products (a race two devices could theoretically produce), the lookup
// answers null and the human decides — never a silent coin-flip.

const MAX_ALIAS_CODES = 8; // same ceiling as OCR candidate extraction

/** Clean a candidate-code list: normalised, format-valid, deduped, capped. */
function normaliseAliasCodes(codes) {
  const arr = Array.isArray(codes) ? codes : [];
  const out = new Set();
  for (const c of arr) {
    const norm = normaliseStyleCode(c);
    if (norm && styleCodeFormat(norm) !== null) out.add(norm);
    if (out.size >= MAX_ALIAS_CODES) break;
  }
  return [...out].sort();
}

/** Code array → RTDB map, or null when nothing usable survives. */
function codesToMap(codes) {
  const clean = normaliseAliasCodes(codes);
  if (!clean.length) return null;
  const map = {};
  for (const c of clean) map[c] = true;
  return map;
}

/**
 * EVERY distinct product the records point this code at. Normally 0 or 1;
 * 2+ is the write race two devices can produce (the check-then-push attach
 * is deliberately not transactional) — the callers turn that into a
 * duplicate-queue entry so a human resolves it; it must never stay a silent
 * permanent dead end.
 */
function codeAliasOwnersAll(code, aliasesNode) {
  const norm = normaliseStyleCode(code);
  if (!norm) return [];
  const owners = new Set();
  for (const rec of Object.values(aliasesNode || {})) {
    if (!rec || !rec.productId || !rec.c || typeof rec.c !== "object") continue;
    if (rec.c[norm]) owners.add(rec.productId);
  }
  return [...owners].sort();
}

/**
 * EXACT code-alias lookup over the whole node.
 * @returns {{productId, aliasId}|null} null when unknown OR when two records
 *          disagree on the owner (fail closed — a human decides, never a race).
 */
function codeAliasOwner(code, aliasesNode) {
  const norm = normaliseStyleCode(code);
  if (!norm) return null;
  let hit = null;
  for (const [aliasId, rec] of Object.entries(aliasesNode || {})) {
    if (!rec || !rec.productId || !rec.c || typeof rec.c !== "object") continue;
    if (!rec.c[norm]) continue;
    if (hit && hit.productId !== rec.productId) return null; // disagreement → fail closed
    if (!hit) hit = { productId: rec.productId, aliasId };
  }
  return hit;
}

/** Is every one of these codes already filed for this product? */
function isDuplicateCodeAlias(codes, productId, aliasesNode) {
  const clean = normaliseAliasCodes(codes);
  if (!clean.length) return true; // nothing to file is "already filed"
  const have = new Set();
  for (const rec of Object.values(aliasesNode || {})) {
    if (!rec || rec.productId !== productId || !rec.c || typeof rec.c !== "object") continue;
    for (const k of Object.keys(rec.c)) have.add(k);
  }
  return clean.every((c) => have.has(c));
}

module.exports = {
  LABEL_ALIASES_PATH,
  BANDS,
  MAX_TOKENS,
  DEDUPE_CONTAINMENT,
  normaliseAliasTokens,
  tokensToMap,
  tokensFromNode,
  overlap,
  scoreAliases,
  bandFor,
  isDuplicateAlias,
  MAX_ALIAS_CODES,
  normaliseAliasCodes,
  codesToMap,
  codeAliasOwner,
  codeAliasOwnersAll,
  isDuplicateCodeAlias,
};
