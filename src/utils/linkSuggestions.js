// ─── LINK-PANEL SUGGESTIONS — the panel must never open BLANK ────────────────
// (Owner spec 2026-08-13.) PR #348's link panel opened an empty search box —
// so the operator found the shoe BY NAME, which is exactly the duplicate-
// creating behaviour the style-code system exists to remove. This module ranks
// the catalogue the operator already has in memory against the label they just
// read, so the panel opens with the most plausible owners on screen, photo
// first. SUGGEST, NEVER DECIDE: nothing here writes anything or auto-links —
// every row is a button the operator must tap, and the tap files through the
// existing alias doors exactly as a search pick does.
//
// RANKING (strongest first), derived from the LIVE catalogue on 2026-08-13
// (713 code rows over 4,165 live products; 1,431 real label reads in the OCR
// cache; the 33 unresolved scans hub staff filed on 2026-08-12):
//
//   PENDING-EXACT  a product's pendingStyleCode equals the scan verbatim.
//                  resolveStyleNumber only matches confirmed codes, so this is
//                  the one exact match that can still reach the panel.
//   FAMILY         the Lacoste per-size shape, loosened from the auto-link
//                  rule (perSizeStyleCode.js) for SUGGESTING: same parse shape,
//                  same length, same season/gender prefix, same printed colour
//                  code (final 3 chars), article block 1-2 digits apart. The
//                  auto rule demands exactly 1 digit and exactly one candidate
//                  because it acts silently; a suggestion is confirmed by a
//                  human against a photo, so 2 digits is safe and is what
//                  chains the live Gripshot cluster (0005/06/07/12/16 → a
//                  scanned 0011 surfaces all five). EQUAL LENGTH is load-
//                  bearing: a 13-char and a 12-char Lacoste code parse their
//                  article blocks at different offsets, and the live catalogue
//                  showed exactly one such false pairing (745SMA00042A9 navy
//                  vs 745SMA0042A9 light green) — different lengths drop to
//                  the misread tier, which says "check the photo" instead of
//                  "same family".
//   MISREAD        one character away from a registered code (substitution or
//                  one dropped/added character) with the difference OUTSIDE
//                  the colour segment. OCR noise lands here (the live
//                  unresolved list's 039564-38 → 034564-38 Timberland).
//   COLOURWAY      one character away but the difference IS the colour
//                  segment. The live catalogue holds 54 such registered pairs
//                  and every one is a different colourway of the same shoe —
//                  so this tier is worded as a warning ("may be a different
//                  colour"), scored below everything, and shown only when it
//                  is all there is.
//   NAME           the model name the label prints ("GRIPSHOT MID 2233SP2"),
//                  when the OCR response carried one, token-matched against
//                  product names. Tokens that hit more than NAME_DF_CAP
//                  product names (brand words: LACOSTE, NIKE…) carry no
//                  signal and are ignored — measured, not guessed: GRIPSHOT
//                  hits 20 names, LACOSTE hits ~150.
//   ALIAS          for token readings: the labelAlias callable's own top-3
//                  containment candidates (PR #329 matching), which the count
//                  flow already fetched before opening the panel. Low-band
//                  candidates were previously discarded on the floor — here
//                  they become visible, ranked below code and name evidence.
//
// ── THE TWO THRESHOLDS (owner spec 2026-08-13, the SFA/SMA incident) ─────────
// SUGGESTING is cheap and LOOSE — a wrong suggestion costs the operator a
// glance at a photo. AUTO-LINKING is dangerous and TIGHT — it acts silently.
// The tight threshold lives in perSizeStyleCode.js (perSizeAutoCandidate:
// exactly one digit apart, exactly one candidate, cluster-refusal) and is NOT
// used by anything in this file. This file is the loose threshold, and it got
// looser after the live count proved the confident tiers alone still dead-end:
// the shoe registered as 745SFA000521G rejected its own label 745SMA004-21G —
// Lacoste splits ONE shoe across article families by size band (SFA vs SMA),
// so gender letters and length both differ and only the trailing colour code
// survives. Hence three LOOSE tiers below the confident ones:
//
//   COLOUR-CODE    LACOSTE-REF codes only: identical printed colour segment,
//                  shared leading segment (≥3 chars) — the SFA/SMA case.
//                  Strong enough to sit just under misread (a heavy name
//                  match at the 58 cap may still edge it — deliberate); NOT
//                  flagged weak, so the intake gate's pre-duplicate question
//                  fires on it too (this is exactly the label that used to
//                  sail into the create form and mint a duplicate). Other
//                  formats never enter: a Nike body sharing only a colour
//                  segment is a different shoe, not a size-band sibling.
//   BRAND-SEGMENT  same format, shared leading segment ≥4 chars. weak: true.
//   SUBSTRING      longest common substring ≥6 anywhere in the code.
//                  weak: true.
//
// weak: true marks rows for BROWSING, not evidence: the link panel shows
// them, but StyleCodeGate's blocking pre-duplicate step ignores them (else
// every registration would trip an interstitial of prefix-cousins).
//
// And the fallback: buildLinkSuggestions({ fillToMin: N }) pads the result to
// N rows with the CLOSEST catalogue candidates (tier "closest", honest reason,
// score capped under every real tier) — the count panel passes 10 so it is
// NEVER empty while the catalogue holds anything. Callers that need the old
// "empty means nothing plausible" contract simply don't pass fillToMin.
//
// Cross-validated against every live code as a synthetic scan: no confident
// tier ever puts a mismatched-colour candidate on top. ZERO extra reads: the
// catalogue is the in-memory prop, the alias candidates rode the match call
// the flow already made. Everything here is still SUGGEST, NEVER DECIDE.

import { normaliseStyleCode, styleCodeFormat, formatStyleCodeForDisplay } from "./styleCode.js";
import { isMergedAway } from "./mergedProducts.js";

// Tier scores — spacing is deliberate: family always beats misread, misread
// beats name, name beats alias containment, colourway sits under everything.
export const TIER_SCORES = Object.freeze({
  exact: 105,        // includeExact callers only — see codeSuggestions
  pendingExact: 100,
  family: 90,        // + (2 - artDiff) * 3  → 93 for one digit apart, 90 for two
  misread: 60,
  colourCode: 57,    // the SFA/SMA tier — just under misread, above name's base
  truncated: 55,
  name: 50,          // + 2 per extra distinctive token hit, capped at 58
  alias: 20,         // + containment * 25, capped at 45
  colourway: 30,
  brandSegment: 24,  // + 1 per shared prefix char beyond 4, capped at 29. weak
  substring: 12,     // + 3 per shared char beyond 6, capped at 27. weak
  closest: 10,       // CAP for fillToMin fallback rows — under every real tier
});

// Loose-tier floors — measured against the live catalogue, not guessed:
// colour+prefix needs 3 shared leading chars (745S… shares 4 in the SFA/SMA
// case; 2 would pair every DD-prefix Nike with every white colourway);
// prefix-only needs 4; a bare shared substring needs 6 (5 pairs half the
// Lacoste catalogue via "SMA0").
export const COLOUR_PREFIX_MIN = 3;
export const BRAND_SEGMENT_MIN = 4;
export const SUBSTRING_MIN = 6;

// A name-token that appears in more product names than this is a brand or
// category word, not a model name — it identifies nothing.
export const NAME_DF_CAP = 30;

// Words a tongue label prints that say nothing about WHICH shoe it is.
const GENERIC_LABEL_TOKENS = new Set([
  "THE", "AND", "FOR", "WITH", "LOW", "MID", "HIGH", "MEN", "MENS", "WOMEN", "WOMENS",
  "KIDS", "UNISEX", "GENDER", "SHOE", "SHOES", "SNEAKER", "SNEAKERS", "SIZE",
  "UPPER", "SOLE", "OUTSOLE", "INSOLE", "LINING", "RUBBER", "TEXTILE", "LEATHER",
  "CANVAS", "SYNTHETIC", "MADE", "CHINA", "VIETNAM", "INDONESIA", "CAMBODIA", "INDIA",
  "FABRIQUE", "HECHO", "IMPORTED", "DESIGNED",
]);

const LACOSTE_PARSE = /^(7?\d{2})([A-Z]{3})(\d{4})([A-Z0-9]{2,3})$/;

/**
 * Split a normalised code into its body and printed colour segment, per the
 * catalogued brand shapes (styleCode.js). Formats with no separate colour
 * block (adidas-block, unknown) return colour "" — they can never enter the
 * family or colourway tiers, only the whole-code misread tier.
 */
export function splitStyleCode(code) {
  const f = styleCodeFormat(code);
  if (f === "nike-alpha-6-3" || f === "numeric-6-3") return { format: f, body: code.slice(0, -3), colour: code.slice(-3) };
  if (f === "puma-6-2") return { format: f, body: code.slice(0, -2), colour: code.slice(-2) };
  if (f === "lacoste-ref") {
    const m = code.match(LACOSTE_PARSE);
    // Suffix-less Lacoste: the article/colour boundary is unknowable
    // (perSizeStyleCode.js clause 1) — no colour segment, no family tier.
    if (m) return { format: f, body: code.slice(0, -3), colour: code.slice(-3), lacoste: { prefix: m[1], gender: m[2], article: m[3] } };
    return { format: f, body: code, colour: "" };
  }
  if (f === "new-balance") {
    const m = code.match(/^([A-Z]{1,3}\d{3,4})([A-Z]{1,3}\d{0,2})$/);
    if (m) return { format: f, body: m[1], colour: m[2] };
  }
  return { format: f, body: code, colour: "" };
}

const commonPrefixLen = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

/** Longest common substring (contiguous) — the shared fragment itself. */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return "";
  let best = 0, end = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; end = i; }
      }
    }
    prev = cur;
  }
  return a.slice(end - best, end);
}

const hamming = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** Edit distance capped at 1: equal-length hamming 1, or one insertion. */
export function isOneEditApart(a, b) {
  if (a === b) return false;
  if (a.length === b.length) return hamming(a, b) === 1;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

// OCR confusable folding — COMPARISON ONLY, never identity. styleCode.js
// forbids O↔0-style "fixes" on the identity key because folding can collapse
// two real codes into one; here BOTH sides fold the same way purely to ask
// "could these be the same printed characters?", and a human confirms against
// the photo before anything links. Live evidence: the 2026-08-12 floor scan
// 742CFA0011264 is the registered Gripshot family read with G→6.
const OCR_FOLD = { O: "0", I: "1", G: "6", S: "5", B: "8", Z: "2" };
export const foldConfusables = (code) => code.replace(/[OIGSBZ]/g, (c) => OCR_FOLD[c]);

// A truncated label read: the scan is a strict prefix of a registered code
// (the OCR dropped the trailing colour block) or vice versa. The floor of 8
// shared characters keeps this to long-code brands (Lacoste bases are 10) —
// a 6-char Nike body prefix would fan out across colourways and is refused.
export const TRUNCATED_MIN_SHARED = 8;
export const TRUNCATED_MAX_MISSING = 3;
export function isTruncatedPair(a, b) {
  if (a === b || a.length === b.length) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= TRUNCATED_MIN_SHARED && l.length - s.length <= TRUNCATED_MAX_MISSING && l.startsWith(s);
}

/** Every code identity a product carries that suggestions may rank against. */
function productCodes(p) {
  const out = [];
  const seen = new Set();
  for (const [field, raw] of [["confirmed", p.styleCodeNormalised], ["pending", p.pendingStyleCode]]) {
    const code = normaliseStyleCode(raw);
    if (code && !seen.has(code)) { seen.add(code); out.push({ code, field }); }
  }
  return out;
}

// The family reason's mask: shared article digits stay, moving digits become
// "•", the printed colour code rides behind a hyphen the way the label shows
// it — "same code family — 742CFA00••-2G4".
function familyMask(scanSplit, articles) {
  const chars = scanSplit.lacoste.article.split("");
  for (const art of articles) {
    for (let i = 0; i < chars.length; i++) if (art[i] !== chars[i]) chars[i] = "•";
  }
  return `${scanSplit.lacoste.prefix}${scanSplit.lacoste.gender}${chars.join("")}-${scanSplit.colour}`;
}

/**
 * Code-similarity suggestions for a scanned normalised code, ranked against
 * every confirmed AND pending style code in the in-memory catalogue.
 * Pure, zero reads. Returns [{ product, code, field, tier, score, reason }].
 */
export function codeSuggestions(scanNormalised, products, { includeExact = false } = {}) {
  const scan = normaliseStyleCode(scanNormalised);
  if (!scan) return [];
  const ss = splitStyleCode(scan);
  const hits = [];
  for (const p of products || []) {
    if (!p || !p.id || isMergedAway(p)) continue;
    for (const { code, field } of productCodes(p)) {
      if (code === scan) {
        // In the COUNT flow, confirmed exact owners resolve before the panel
        // ever opens — an exact hit surviving to there is a PENDING code. The
        // INTAKE gate (capture-only mode) does no exact pre-check at all, so
        // it asks for confirmed owners too via includeExact.
        if (field === "confirmed" && !includeExact) continue;
        hits.push(field === "confirmed"
          ? { product: p, code, field, tier: "exact", score: TIER_SCORES.exact,
              reason: `already registered with exactly this code` }
          : { product: p, code, field, tier: "pendingExact", score: TIER_SCORES.pendingExact,
              reason: `carries exactly this code — awaiting confirmation` });
        continue;
      }
      const sc = splitStyleCode(code);
      // FAMILY — the per-size printing shape, human-confirmed so 1-2 digits.
      if (ss.lacoste && sc.lacoste && scan.length === code.length
          && ss.lacoste.prefix === sc.lacoste.prefix && ss.lacoste.gender === sc.lacoste.gender
          && ss.colour === sc.colour) {
        const artDiff = hamming(ss.lacoste.article, sc.lacoste.article);
        if (artDiff >= 1 && artDiff <= 2) {
          hits.push({ product: p, code, field, tier: "family", score: TIER_SCORES.family + (2 - artDiff) * 3,
                      artDiff, reason: null /* mask filled below, across the whole family */ });
          continue;
        }
      }
      if (isOneEditApart(scan, code) || isOneEditApart(foldConfusables(scan), foldConfusables(code))) {
        const colourDiffers = ss.colour && sc.colour && scan.length === code.length && ss.colour !== sc.colour
          && foldConfusables(ss.colour) !== foldConfusables(sc.colour);
        if (colourDiffers) {
          hits.push({ product: p, code, field, tier: "colourway", score: TIER_SCORES.colourway,
                      reason: `registered as ${formatStyleCodeForDisplay(code)} — differs only in the colour code, so this may be a DIFFERENT colour of the same shoe. Check the photo carefully.` });
        } else {
          hits.push({ product: p, code, field, tier: "misread", score: TIER_SCORES.misread,
                      reason: `one character off its registered code ${formatStyleCodeForDisplay(code)} — could be a misread. Check the shoe against the photo.` });
        }
        continue;
      }
      if (isTruncatedPair(scan, code)) {
        hits.push({ product: p, code, field, tier: "truncated", score: TIER_SCORES.truncated,
                    reason: `reads like its registered code ${formatStyleCodeForDisplay(code)} with the end cut off — labels lose their last characters to glare. Check the photo.` });
        continue;
      }
      // ── LOOSE TIERS from here down (see the header) — suggesting is cheap ──
      const prefixLen = commonPrefixLen(scan, code);
      // COLOUR-CODE — the SFA/SMA case: identical printed colour segment,
      // shared lead. Lengths may DIFFER (745SFA000521G is 13 chars,
      // 745SMA00421G is 12) — that mismatch is exactly why the family tier
      // could never reach this pair. LACOSTE-REF ONLY: that is the one
      // catalogued brand that splits one shoe across article families (see
      // perSizeStyleCode.js). On Nike/adidas/Puma-style bodies the colour
      // segment repeats across genuinely different shoes (DD1391-100 and
      // DD1503-100 are two shoes that both happen to be white), and because
      // this tier is NOT weak, an open floor here would reach StyleCodeGate's
      // BLOCKING step on every common colourway — the substitute pair's one
      // shared blocker on PR #353. Extend per brand only with evidence.
      if (ss.format === "lacoste-ref" && sc.format === "lacoste-ref"
          && ss.colour && ss.colour === sc.colour
          && prefixLen >= COLOUR_PREFIX_MIN) {
        hits.push({ product: p, code, field, tier: "colourCode", score: TIER_SCORES.colourCode,
                    reason: `same colour code ${ss.colour} — its registered code is ${formatStyleCodeForDisplay(code)}, and some brands split one shoe across code families by size. Check the photo.` });
        continue;
      }
      // BRAND-SEGMENT — the codes start the same way. Browsing evidence only,
      // capped UNDER the colourway warning tier: measured on the live
      // 2026-08-13 unresolved list, a higher cap let a prefix-cousin outrank
      // a one-edit colour sibling on four real scans — the wrong order.
      if (ss.format && ss.format === sc.format && prefixLen >= BRAND_SEGMENT_MIN) {
        hits.push({ product: p, code, field, tier: "brandSegment", weak: true,
                    score: Math.min(TIER_SCORES.brandSegment + (prefixLen - BRAND_SEGMENT_MIN), 29),
                    reason: `same code family — both start ${scan.slice(0, prefixLen)}… (registered as ${formatStyleCodeForDisplay(code)})` });
        continue;
      }
      // SUBSTRING — a long shared fragment anywhere. Browsing evidence only.
      const frag = longestCommonSubstring(scan, code);
      if (frag.length >= SUBSTRING_MIN) {
        hits.push({ product: p, code, field, tier: "substring", weak: true,
                    score: Math.min(TIER_SCORES.substring + (frag.length - SUBSTRING_MIN) * 3, 27),
                    reason: `shares “${frag}” with its registered code ${formatStyleCodeForDisplay(code)}` });
      }
    }
  }
  const family = hits.filter((h) => h.tier === "family");
  if (family.length) {
    const mask = familyMask(ss, family.map((h) => splitStyleCode(h.code).lacoste.article));
    for (const h of family) h.reason = `same code family — ${mask} (this brand prints a different code per size)`;
  }
  return hits;
}

const nameTokens = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3);

/**
 * Model-name suggestions: the words the label prints, matched against product
 * names. `labelText` is the OCR's modelName line or a token reading joined.
 * Token document frequencies are computed against the live catalogue on every
 * call (a few thousand short strings — microseconds, and always current), so
 * brand words disqualify THEMSELVES by breadth instead of by a hand-kept list.
 */
export function modelNameSuggestions(labelText, products) {
  const raw = Array.isArray(labelText) ? labelText.join(" ") : labelText;
  const toks = [...new Set(nameTokens(raw))].filter((t) => !GENERIC_LABEL_TOKENS.has(t) && !/^\d+$/.test(t));
  if (!toks.length) return [];
  const live = (products || []).filter((p) => p && p.id && !isMergedAway(p));
  const nameSets = live.map((p) => new Set(nameTokens(p.name)));
  const df = new Map(toks.map((t) => [t, 0]));
  nameSets.forEach((set) => { for (const t of toks) if (set.has(t)) df.set(t, df.get(t) + 1); });
  const distinctive = toks.filter((t) => df.get(t) >= 1 && df.get(t) <= NAME_DF_CAP);
  if (!distinctive.length) return [];
  const hits = [];
  live.forEach((p, i) => {
    const matched = distinctive.filter((t) => nameSets[i].has(t));
    if (!matched.length) return;
    hits.push({
      product: p, code: normaliseStyleCode(p.styleCodeNormalised) || null, field: p.styleCodeNormalised ? "confirmed" : null,
      tier: "name", score: Math.min(TIER_SCORES.name + (matched.length - 1) * 2, 58),
      reason: `the label prints “${matched.join(" ")}” — this product's name matches it`,
    });
  });
  return hits;
}

/**
 * Alias-store candidates (the match call's top-3, any band) resolved against
 * the local catalogue. Candidates the operator already rejected, and ids not
 * visible locally (merged away mid-session), are skipped — this is a
 * suggestion list, not a resolver.
 */
export function aliasSuggestions(candidates, products, excludeIds = []) {
  const excluded = new Set(excludeIds || []);
  const out = [];
  for (const c of candidates || []) {
    if (!c || !c.productId || excluded.has(c.productId)) continue;
    const p = (products || []).find((x) => x && x.id === c.productId && !isMergedAway(x));
    if (!p) continue;
    const containment = typeof c.score === "number" ? Math.max(0, Math.min(1, c.score)) : 0;
    out.push({
      product: p, code: normaliseStyleCode(p.styleCodeNormalised) || null, field: p.styleCodeNormalised ? "confirmed" : null,
      tier: "alias", score: Math.min(TIER_SCORES.alias + Math.round(containment * 25), 45),
      reason: `its saved label reading shares ${c.shared || "some"} word${c.shared === 1 ? "" : "s"} with this one`,
    });
  }
  return out;
}

/**
 * The NEVER-EMPTY fallback (owner spec 2026-08-13): when the real tiers found
 * fewer than the panel wants to show, rank the WHOLE in-memory catalogue by
 * whatever weak affinity exists — longest shared code fragment (≥3 chars),
 * shared label/name words INCLUDING brand words (a brand word is useless as
 * evidence but fine for browsing: "same brand, similar name") — and return the
 * closest, honestly labelled. Scores are capped under every real tier so a
 * filler can never outrank evidence. Falling back to a blank search box is the
 * failure this exists to fix: the operator hunted BY NAME and made duplicates.
 */
export function closestCandidates({ normalised, labelWords, products, excludeIds, limit = 10 }) {
  const scan = normaliseStyleCode(normalised);
  const toks = [...new Set(nameTokens(Array.isArray(labelWords) ? labelWords.join(" ") : labelWords || ""))]
    .filter((t) => !GENERIC_LABEL_TOKENS.has(t) && !/^\d+$/.test(t));
  const excluded = new Set(excludeIds || []);
  const rows = [];
  for (const p of products || []) {
    if (!p || !p.id || isMergedAway(p) || excluded.has(p.id)) continue;
    let frag = "", fragCode = null, fragField = null;
    if (scan) {
      for (const { code, field } of productCodes(p)) {
        const f = longestCommonSubstring(scan, code);
        if (f.length > frag.length) { frag = f; fragCode = code; fragField = field; }
      }
    }
    const nameSet = new Set(nameTokens(p.name));
    const sharedWords = toks.filter((t) => nameSet.has(t));
    const raw = (frag.length >= 3 ? frag.length : 0) + sharedWords.length * 2;
    const bits = [];
    if (frag.length >= 3) bits.push(`its code shares “${frag}”`);
    if (sharedWords.length) bits.push(`its name shares “${sharedWords.join(" ")}”`);
    // The displayed code is the one the fragment actually came from — a
    // pending code's fragment quoted against the confirmed code would show a
    // code the fragment isn't in (Kimi, PR #353).
    const rowCode = frag.length >= 3 ? fragCode : (normaliseStyleCode(p.styleCodeNormalised) || null);
    rows.push({
      product: p, code: rowCode,
      field: frag.length >= 3 ? fragField : (p.styleCodeNormalised ? "confirmed" : null),
      tier: "closest", weak: true, raw,
      score: Math.min(TIER_SCORES.closest, raw),
      reason: bits.length
        ? `not a close match — but ${bits.join(" and ")}`
        : `no code or name overlap — shown so the list is never empty`,
    });
  }
  rows.sort((a, b) => b.raw - a.raw
    || String(a.product.name || "").localeCompare(String(b.product.name || "")));
  return rows.slice(0, limit).map(({ raw, ...r }) => ({ ...r, reasons: [r.reason] }));
}

/**
 * THE entry point: everything the link panel knows about this label, ranked.
 *
 *   kind "code":   normalised (+ modelName when the OCR carried one, and
 *                  allCodes — EVERY code-shaped token the label printed;
 *                  each contributes candidates to this ONE merged list.
 *                  Owner spec 2026-08-13: the Timberland's A6CWNEN3 and
 *                  A8425 both feed the same list, the operator picks by
 *                  photo. `tokens` — the label's stable word set — feeds the
 *                  name tier here too, so a code-ful read still surfaces
 *                  "GRIPSHOT"-style wording matches.)
 *   kind "tokens": tokens (+ aliasCandidates from the match call, and
 *                  excludeIds for candidates the operator already rejected)
 *
 * Deduped by product — a product hit through several tiers keeps its best
 * score and shows every reason. Sorted best-first.
 *
 * fillToMin = 0 (the default) keeps the old contract: an EMPTY return means
 * nothing plausible exists and the caller says so honestly. fillToMin = N
 * pads the tail with closestCandidates rows (tier "closest", weak, honestly
 * worded) so the COUNT panel is never empty — a filler never outranks a real
 * tier, and the row's reason never dresses it up as one.
 */
export function buildLinkSuggestions({ kind, normalised, modelName, tokens, allCodes, aliasCandidates, excludeIds, products, includeExact = false, fillToMin = 0 }) {
  let hits = [];
  if (kind === "code") {
    hits = hits.concat(codeSuggestions(normalised, products, { includeExact }));
    // POOL THE OTHER TOKENS (owner spec 2026-08-13). Every further code-shaped
    // token the label printed ranks the catalogue exactly as the primary does,
    // into this one list — each row's reason names WHICH token found it, so
    // "matched A8425" and "matched A6CWNEN3" sit side by side and the photo
    // decides. Additive only: with no allCodes the list is byte-identical to
    // what it always was.
    const primary = normaliseStyleCode(normalised);
    const pooled = [...new Set((Array.isArray(allCodes) ? allCodes : [])
      .map(normaliseStyleCode).filter((c) => c && c !== primary))];
    // includeExact is ALWAYS on for the pooled tokens: the caller's "exact
    // owners resolved before the panel" rationale covers the PRIMARY code's
    // resolution path, but an alternate token's owner is found by the
    // any-token round trip — and when that call failed or was degraded, this
    // row is the one honest recovery the operator gets. Suggest, never
    // decide: the row is still a button.
    for (const extra of pooled) {
      for (const h of codeSuggestions(extra, products, { includeExact: true })) {
        hits.push({ ...h, reason: `${h.reason} (via the label's other token ${formatStyleCodeForDisplay(extra)})` });
      }
    }
    if (modelName) hits = hits.concat(modelNameSuggestions(modelName, products));
    // The label's word set (model-name line included) — same name tier the
    // token flow uses; DF caps silence brand words, the dedupe folds overlap.
    if (Array.isArray(tokens) && tokens.length) hits = hits.concat(modelNameSuggestions(tokens, products));
    // The alias store's candidates ride the CODE panel too (review, PR #354):
    // a label registered pre-widening as a token reading now extracts a code,
    // lands in this panel — and its own HIGH/MID alias match must not vanish.
    if (Array.isArray(aliasCandidates) && aliasCandidates.length) {
      hits = hits.concat(aliasSuggestions(aliasCandidates, products, excludeIds));
    }
  } else if (kind === "tokens") {
    hits = hits.concat(modelNameSuggestions(tokens, products));
    // A code-less read may still carry a clean model-name line the merged
    // token set dropped (≥2-of-3 frame agreement) — score it too; the
    // per-product dedupe folds any overlap (CodeRabbit, PR #349).
    if (modelName) hits = hits.concat(modelNameSuggestions(modelName, products));
    hits = hits.concat(aliasSuggestions(aliasCandidates, products, excludeIds));
  }
  if (excludeIds && excludeIds.length) {
    const ex = new Set(excludeIds);
    hits = hits.filter((h) => !ex.has(h.product.id));
  }
  const byId = new Map();
  for (const h of hits) {
    const prev = byId.get(h.product.id);
    if (!prev) { byId.set(h.product.id, { ...h, reasons: [h.reason] }); continue; }
    if (!prev.reasons.includes(h.reason)) prev.reasons.push(h.reason);
    // The best tier owns the row — including its weak/strong standing. On a
    // dead-equal score, strong beats weak (no current tier values can tie
    // across the divide, but the gate's weak filter must never lose real
    // evidence to a future rescore — Kimi, PR #353).
    if (h.score > prev.score || (h.score === prev.score && prev.weak && !h.weak)) {
      prev.score = h.score; prev.tier = h.tier; prev.code = h.code; prev.field = h.field; prev.weak = h.weak;
    }
  }
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  if (fillToMin > 0 && ranked.length < fillToMin) {
    return ranked.concat(closestCandidates({
      normalised: kind === "code" ? normalised : "",
      labelWords: [modelName, ...(Array.isArray(tokens) ? tokens : [])].filter(Boolean),
      products,
      excludeIds: [...(excludeIds || []), ...ranked.map((h) => h.product.id)],
      limit: fillToMin - ranked.length,
    }));
  }
  return ranked;
}
