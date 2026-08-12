// ─── PER-SIZE STYLE CODES — the Lacoste rule (owner spec 2026-08-12) ─────────
// Lacoste encodes the SIZE into the article reference: the same shoe in the
// same colourway carries a DIFFERENT printed code per size. Two physical
// labels off one runner, verbatim:
//
//     745SMA004-21G   UK 6.5 · EUR 40
//     745SMA006-21G   UK 9.5 · EUR 44
//
// Identical prefix, identical colourway suffix, one digit moves with size.
// This is the OPPOSITE of Nike, which prints one code across every size AND
// every colourway — so identity may be broader OR narrower than a product,
// per brand, and nothing here may assume either.
//
// THE RULE, derived from the live catalogue (59 Lacoste-format products,
// evidence pull 2026-08-12) and the two physical labels above — two NORMALISED
// codes are per-size siblings of ONE shoe if and only if:
//
//   1. both match the catalogued Lacoste article shape ("lacoste-ref" in
//      styleCode.js) AND parse as prefix + 3 letters + 4-digit article +
//      a PRESENT 2-3 char colourway suffix;
//   2. season/size prefix and gender letters are identical;
//   3. the printed colourway suffix is identical — enforced as the FINAL
//      3 CHARS being identical, which is stricter than the parsed suffix
//      group on purpose: when the suffix group is only 2 chars the printed
//      colour code's first character sits in the parsed article block (the
//      745SMA004-21G labels normalise that way), and a difference there is a
//      DIFFERENT COLOUR, never a size;
//   4. the 4-digit article block differs in EXACTLY one digit.
//
// What the live evidence pinned: every existing same-shape pair that differs
// by one character differs INSIDE the final 3 chars — the Missouri Mid family
// (743SMA0169 + 1M3/4M3/5M3, three colours), the Powercourt pair (…65T/66T),
// the Audysol and Elite Active families — so this rule fires on NONE of them.
// Codes captured WITHOUT a colour suffix (744SMA0113…) refuse at clause 1:
// there the boundary between article and colour is unknowable, and the manual
// link panel asks a human instead. Nike/adidas/Puma/NB shapes never reach
// clause 2. Same fit in a different colour is a DIFFERENT product, always.
//
// Used by the count's scan resolution (auto-file a label alias, HubCleanup)
// and by the report-only sweep script (scripts/sweep-per-size-codes.mjs).
// This module never writes anything and never merges anything.

import { normaliseStyleCode, styleCodeFormat } from "./styleCode.js";
import { isMergedAway } from "./mergedProducts.js";

// prefix (optional 7 + 2 digits) · gender letters · 4-digit article · colour.
// The suffix is REQUIRED here — that is clause 1's "no suffix, no automatic".
const LACOSTE_PARSE = /^(7?\d{2})([A-Z]{3})(\d{4})([A-Z0-9]{2,3})$/;

/** Are these two NORMALISED codes per-size printings of one shoe? */
export function perSizeSiblingCodes(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b || a === b) return false;
  if (styleCodeFormat(a) !== "lacoste-ref" || styleCodeFormat(b) !== "lacoste-ref") return false;
  const mA = a.match(LACOSTE_PARSE);
  const mB = b.match(LACOSTE_PARSE);
  if (!mA || !mB) return false;                    // no colourway suffix → ask, never assume
  if (mA[1] !== mB[1] || mA[2] !== mB[2]) return false; // season/size prefix + gender letters
  if (mA[4] !== mB[4]) return false;               // parsed colourway suffix
  if (a.slice(-3) !== b.slice(-3)) return false;   // printed colour code, clause 3
  let diff = 0;
  for (let i = 0; i < 4; i++) if (mA[3][i] !== mB[3][i]) diff += 1;
  return diff === 1;
}

/**
 * The live catalogue products whose registered code is a per-size sibling of
 * this scanned code. Merged-away records never answer. Pure — the caller
 * decides what a 1-hit (auto-link) versus a 2+-hit (ask) means.
 */
export function findPerSizeSiblings(scanned, products) {
  const code = normaliseStyleCode(scanned);
  if (!code) return [];
  const out = [];
  for (const p of products || []) {
    if (!p || !p.id || isMergedAway(p) || !p.styleCodeNormalised) continue;
    if (perSizeSiblingCodes(code, String(p.styleCodeNormalised))) out.push(p);
  }
  return out;
}

/**
 * The ONE product a scanned code may auto-link to, or null when a human must
 * decide. Two gates beyond findPerSizeSiblings:
 *
 *   • exactly one live sibling — two candidates is a question, never a guess;
 *   • that sibling must not ITSELF sit in a per-size cluster. The 2026-08-12
 *     sweep found five live Gripshot records (742CFA0005/6/7/12/16-2G4) whose
 *     codes rule-link but whose names claim different colours — data that
 *     incoherent must go to a human, and a new scan one digit away from
 *     exactly one member of such a cluster must NOT be pulled in silently.
 */
export function perSizeAutoCandidate(scanned, products) {
  // Callers without the count's resolve-first guarantee (the sweep, future
  // surfaces) still never guess past an exact live owner: an exact owner's
  // code is by construction one digit from any candidate sibling's code, so
  // it always appears in that candidate's cluster and the cluster gate below
  // refuses. Pinned by test — no separate exact-owner branch exists because
  // it would be unreachable (CodeRabbit, PR #348, resolved by proof).
  const sibs = findPerSizeSiblings(scanned, products);
  if (sibs.length !== 1) return null;
  const only = sibs[0];
  const cluster = findPerSizeSiblings(only.styleCodeNormalised, products)
    .filter((p) => p.id !== only.id);
  return cluster.length ? null : only;
}
