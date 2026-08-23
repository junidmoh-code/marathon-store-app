// ─── THE PRIMARY CODE OF A MULTI-CODE LABEL — chosen in code, never asked ────
// A tongue label is a SET of tokens (owner spec 2026-08-13 / 2026-08-23): a
// Lacoste label prints an article code, a production code and a serial; a
// Timberland label prints two codes. Every token is filed as an identity of the
// shoe, and every token resolves the shoe — so WHICH token heads the set only
// matters in two places: the style number a registration writes when the
// product holds none yet, and the order the pooled candidate list is walked.
//
// The reader used to ASK the operator to tap "the style number" whenever the
// server offered no learned-layout pick and no tier-2 preference. Staff will
// not answer that question at a shelf (owner spec 2026-08-23: "never ask
// which code"), so the choice is made HERE, deterministically, and reported:
//
//   1. A server pick still wins (a layout rule a human taught, then tier 2's
//      own preference) — chooseFromLabelRead applies those before this rule.
//   2. Otherwise, rank every candidate by the STRENGTH of its format as an
//      identity, and take the strongest:
//        rank 0  brand article shapes with a colourway/suffix structure —
//                lacoste-ref, nike-alpha-6-3, new-balance
//        rank 1  adidas-block (a loose letters+digits block) and
//                label-serial (a long interleaved run) — both brand-shaped,
//                neither provably the colourway-specific one
//        rank 2  bare numeric shapes — numeric-6-3, puma-6-2 (a Lacoste
//                production line is one of these: a real identity, a weaker
//                head)
//        rank 3  anything else that still passed the server's format gate
//   3. Inside a rank the LONGER token wins — a longer token is the more
//      specific identity, and a wrong head is permanent (it becomes
//      styleCodeNormalised when the product holds none) while a right one
//      costs nothing. So on a Timberland label A6CWNEN3 (8) heads A8425 (5).
//   4. Remaining ties keep the SERVER'S ORDER — the order the tokens were read
//      off the label, top to bottom. Same label, same answer, every device.
//
// On a Lacoste label this heads the set with 45SMA0018 (article) over
// 352890625 (production) and the serial; on a Timberland label with A6CWNEN3
// over A8425.
// Whatever it picks, the OTHER tokens are never dropped — they ride `allCodes`
// into filing and lookup exactly as before. Pure; no I/O.

import { styleCodeFormat } from "./styleCode.js";

const FORMAT_RANK = {
  "lacoste-ref": 0,
  "nike-alpha-6-3": 0,
  "new-balance": 0,
  "adidas-block": 1,
  "label-serial": 1,
  "numeric-6-3": 2,
  "puma-6-2": 2,
};

export function primaryCodeRank(code) {
  const f = styleCodeFormat(code);
  return f && Object.prototype.hasOwnProperty.call(FORMAT_RANK, f) ? FORMAT_RANK[f] : 3;
}

/**
 * Index (into `candidates`) of the token that heads the set. -1 when empty.
 * Order: lowest rank, then LONGEST normalised token, then earliest (stable).
 */
export function choosePrimaryCodeIndex(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  let best = -1;
  let bestRank = Infinity;
  let bestLen = -1;
  list.forEach((c, i) => {
    if (!c) return;
    const r = primaryCodeRank(c);
    const len = String(c).replace(/[^A-Za-z0-9]/g, "").length;
    if (r < bestRank || (r === bestRank && len > bestLen)) { bestRank = r; bestLen = len; best = i; }
  });
  return best;
}

export function choosePrimaryCode(candidates) {
  const i = choosePrimaryCodeIndex(candidates);
  return i >= 0 ? candidates[i] : null;
}
