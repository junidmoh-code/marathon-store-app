// ─── COLOURWAY ANSWERS — a shoe, once identified, stays identified ───────────
// (Owner spec 2026-08-08.) When one style code owns several colourway siblings
// the picker asks WHICH shoe the operator is holding. The answer is worth more
// than one count entry: stored against the shoe's own signature — its label
// reading (the code) plus its COLOUR signature (the dominant-colour palette of
// the quick photo) — the same physical shoe resolves silently next time.
//
//   /colourway_answers/{code}/{pushId} = {
//     productId,                   // the colourway the human picked
//     p: [{r,g,b,w}, ...],         // the photo's palette at answer time
//     at, by,                      // server-stamped provenance
//   }
//
// The node is written and read ONLY by the styleCodeSibling callable on the
// Admin SDK — no client rules needed, no rules change. MATCHING happens on the
// client (src/utils/dominantColours.js matchColourwayAnswers) where the photo
// was taken; this module is the storage contract plus the server-side
// validation and dedupe. Matching FAILS CLOSED: rows that disagree inside the
// match radius resolve nothing, and the human is asked — a silent wrong match
// routes stock onto the wrong product and cannot be spotted later.

"use strict";

const COLOURWAY_ANSWERS_PATH = "colourway_answers";
const MAX_ANSWER_SWATCHES = 4;
const MAX_ANSWERS_PER_CODE = 40; // a code owns a handful of colourways; more is noise
// A new answer this close to a stored one FOR THE SAME PRODUCT is the same
// shoe photographed again — storing it adds noise, not accuracy.
const ANSWER_DEDUPE_DISTANCE = 20;

/** Validate + bound a palette from the client. Returns a clean copy or null. */
function cleanPalette(palette) {
  if (!Array.isArray(palette) || !palette.length) return null;
  const out = [];
  for (const sw of palette.slice(0, MAX_ANSWER_SWATCHES)) {
    if (!sw || typeof sw !== "object") return null;
    const r = Number(sw.r), g = Number(sw.g), b = Number(sw.b), w = Number(sw.w);
    if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
    if (!Number.isFinite(w) || w <= 0 || w > 1) return null;
    out.push({ r: Math.round(r), g: Math.round(g), b: Math.round(b), w: Math.round(w * 100) / 100 });
  }
  return out.length ? out : null;
}

/** CJS twin of src/utils/dominantColours.js paletteDistance — weighted
 *  best-pairing greedy distance; Infinity when either side is empty. The
 *  client twin decides matching; this one only powers the dedupe here, but
 *  parity is pinned by test so the two can never quietly diverge. */
function paletteDistance(a, b) {
  const pa = Array.isArray(a) ? a.filter(Boolean) : [];
  const pb = Array.isArray(b) ? b.filter(Boolean) : [];
  if (!pa.length || !pb.length) return Infinity;
  let sum = 0;
  let weight = 0;
  for (const sw of pa) {
    let best = Infinity;
    for (const other of pb) {
      const d = Math.sqrt((sw.r - other.r) ** 2 + (sw.g - other.g) ** 2 + (sw.b - other.b) ** 2);
      if (d < best) best = d;
    }
    const w = Number(sw.w) || 1;
    sum += best * w;
    weight += w;
  }
  return weight ? sum / weight : Infinity;
}

/** Is this answer already covered by a stored one for the same product? */
function isDuplicateAnswer(rows, productId, palette) {
  for (const rec of Object.values(rows || {})) {
    if (!rec || rec.productId !== productId) continue;
    if (paletteDistance(palette, rec.p) <= ANSWER_DEDUPE_DISTANCE) return true;
  }
  return false;
}

module.exports = {
  COLOURWAY_ANSWERS_PATH,
  MAX_ANSWER_SWATCHES,
  MAX_ANSWERS_PER_CODE,
  ANSWER_DEDUPE_DISTANCE,
  cleanPalette,
  paletteDistance,
  isDuplicateAnswer,
};
