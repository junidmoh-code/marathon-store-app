// ─── DOMINANT COLOURS — within-code discrimination from a shoe photo ─────────
// (Owner spec 2026-08-07, EXTENDED 2026-08-08.) When one style code resolves
// to two or three sibling colourways, the label cannot say which one the
// operator is holding — but a quick photo of the SHOE can. This module is:
//
//   • dominant-colour extraction (coarse quantisation on a downscaled canvas),
//     NOT embeddings, NOT open-set recognition — this discriminates black from
//     white among two or three candidates, which is the entire job;
//   • an ORDERING signal (orderByColourAffinity — sorts, hides nothing), AND —
//     the 2026-08-08 owner spec — an AUTO-SELECTOR (selectByColourAffinity)
//     that picks WITHOUT asking, but ONLY when one candidate wins by a clear
//     margin. Everything about the selector FAILS CLOSED: any missing palette,
//     any near tie, any washed-out photo falls through to the side-by-side
//     picker. Asking is always better than a silent wrong match, which routes
//     stock onto the wrong product and cannot be spotted later.
//
// Stored on the product as `dominantColours: [{r,g,b,w}]` (top swatches by
// pixel weight, w summing ≤1) at registration when the optional shoe photo was
// taken. Absent on products registered without one — every reader tolerates
// that, and an absent palette simply sorts after every present one.
//
// The extraction half needs a browser canvas; the ordering half is pure and
// unit-tested (dominantColours.test.js). Keep them in that order in this file.

const SWATCH_COUNT = 3;      // top-N swatches stored — enough to tell colourways apart
const SAMPLE_SIZE = 48;      // downscale target; 2304 pixels is plenty for dominance
const BUCKET = 32;           // channel quantisation step (8 levels/channel)

/**
 * Extract dominant colours from an image source (File/Blob or data URL).
 * Browser-only (canvas). Resolves to [{r,g,b,w}] sorted by weight, or [] when
 * the image cannot be decoded — extraction failing must never block anything.
 */
export async function extractDominantColours(source) {
  // The blob URL is revoked in `finally` — a decode failure, a null canvas
  // context or a getImageData throw would otherwise leak the Blob for the
  // document lifetime, and the picker lets the operator retake repeatedly on
  // memory-constrained shop tablets.
  let url = null;
  const owned = typeof source !== "string";
  try {
    url = owned ? URL.createObjectURL(source) : source;
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      // A remote product photo (Storage URL) taints the canvas without CORS
      // opt-in, and getImageData then throws — which read as "no palette" and
      // silently disabled every comparison against a stored image. The bucket
      // serves CORS headers (set 2026-05-20); the attribute is what asks for
      // them. Local blobs/data-URLs are unaffected.
      if (!owned) el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // ignore transparency
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return quantiseColours(pixels);
  } catch {
    return [];
  } finally {
    if (owned && url) URL.revokeObjectURL(url);
  }
}

/**
 * PURE: bucket pixels into coarse colour bins, return the top swatches by
 * weight. Exported for tests — no canvas involved.
 * @param {Array<[r,g,b]>} pixels
 * @returns {Array<{r:number,g:number,b:number,w:number}>}
 */
export function quantiseColours(pixels) {
  const list = Array.isArray(pixels) ? pixels : [];
  if (!list.length) return [];
  const bins = new Map(); // "r|g|b" bucket → { sum: [r,g,b], n }
  for (const px of list) {
    if (!Array.isArray(px) || px.length < 3) continue;
    const key = `${Math.floor(px[0] / BUCKET)}|${Math.floor(px[1] / BUCKET)}|${Math.floor(px[2] / BUCKET)}`;
    const bin = bins.get(key) || { sum: [0, 0, 0], n: 0 };
    bin.sum[0] += px[0]; bin.sum[1] += px[1]; bin.sum[2] += px[2]; bin.n++;
    bins.set(key, bin);
  }
  const total = [...bins.values()].reduce((n, b) => n + b.n, 0);
  if (!total) return [];
  return [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, SWATCH_COUNT)
    .map((b) => ({
      r: Math.round(b.sum[0] / b.n),
      g: Math.round(b.sum[1] / b.n),
      b: Math.round(b.sum[2] / b.n),
      w: Math.round((b.n / total) * 100) / 100,
    }));
}

/** PURE: weighted distance between two palettes (best-pairing greedy). Lower =
 *  more alike. Infinity when either side is empty — "unknown" sorts last. */
export function paletteDistance(a, b) {
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

// ── AUTO-SELECT THRESHOLDS (owner spec 2026-08-08) ───────────────────────────
// RGB-Euclidean units, 0–441 scale, on paletteDistance's weighted average.
// MEASURED 2026-08-08 against every multi-owner code in the live catalogue
// (12 codes, 26 sibling pairs, product-photo vs product-photo with this exact
// quantisation): distances run 1–252 with median 30, heavily COMPRESSED by
// the shared white studio backgrounds — even a black-vs-white pair can sit
// near 21. The owner's own evidence pair (RTFKT White Photo Blue vs White
// Gray, HF0438-001) measures 39. So the margin sits at 55: above every
// near-twin in the catalogue, below the three genuinely separable groups
// (Bapesta black-vs-white 252, NOCTA 139, Powercourt-vs-Lerond 80). A
// smaller margin would start auto-picking between pairs the metric provably
// compresses, which is the silent wrong match this whole design forbids —
// asking is always the cheaper failure. Expect ~9 of the current 12
// multi-owner codes to stay in the ask band; the answer memory (below) is
// what makes those stop asking per-shoe.
export const AUTO_SELECT_MARGIN = 55;    // runner-up must trail by at least this
export const AUTO_SELECT_CLOSE_MAX = 150; // and the winner must actually resemble the photo
export const ANSWER_MATCH_MAX = 40;      // a stored answer counts only this close

/**
 * PURE: decide a colourway from the shoe photo — or refuse to.
 * Auto-selects ONLY when (owner spec 2026-08-08):
 *   • the photo produced a palette, AND
 *   • EVERY candidate has a stored palette (a missing one could be the true
 *     match — comparing around it would be a silent guess), AND
 *   • the best candidate is genuinely close (≤ closeMax), AND
 *   • the runner-up trails by at least `margin`.
 * Anything else asks. `ordered` always carries the affinity ordering so the
 * picker can still put the likely match first.
 * @returns {{kind:"auto", product, bestD, secondD}|{kind:"ask", ordered}}
 */
export function selectByColourAffinity(candidates, photoColours,
  { margin = AUTO_SELECT_MARGIN, closeMax = AUTO_SELECT_CLOSE_MAX } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const ordered = orderByColourAffinity(list, photoColours);
  if (list.length < 2) return { kind: "ask", ordered };
  if (!Array.isArray(photoColours) || !photoColours.length) return { kind: "ask", ordered };
  const scored = list
    .map((c) => ({ c, d: paletteDistance(photoColours, c && c.dominantColours) }))
    .sort((x, y) => x.d - y.d);
  // Infinity = a candidate with no stored palette. ANY such candidate blocks
  // auto-selection — fail closed, the human looks.
  if (scored.some((s) => !Number.isFinite(s.d))) return { kind: "ask", ordered };
  const [best, second] = scored;
  if (best.d > closeMax) return { kind: "ask", ordered };
  if (second.d - best.d < margin) return { kind: "ask", ordered };
  return { kind: "auto", product: best.c, bestD: best.d, secondD: second.d };
}

/**
 * PURE: does a previously ANSWERED colourway question decide this photo?
 * Rows are {productId, p: palette} (the styleCodeSibling "colourwayAnswers"
 * shape). A row counts only within `maxDistance`; if every counting row names
 * the SAME product, that product resolves silently — the question is never
 * asked twice for the same physical shoe. Rows that disagree inside the
 * radius resolve NOTHING (fail closed — the human decides).
 * @returns {string|null} productId, or null
 */
export function matchColourwayAnswers(rows, photoColours, { maxDistance = ANSWER_MATCH_MAX } = {}) {
  if (!Array.isArray(photoColours) || !photoColours.length) return null;
  const list = Array.isArray(rows) ? rows : Object.values(rows || {});
  let hit = null;
  for (const rec of list) {
    if (!rec || typeof rec.productId !== "string" || !rec.productId) continue;
    const d = paletteDistance(photoColours, rec.p);
    if (d > maxDistance) continue;
    if (hit && hit !== rec.productId) return null; // disagreement → ask
    hit = rec.productId;
  }
  return hit;
}

/**
 * PURE: order candidates so the closest colour match sits FIRST. Candidates
 * without a stored palette keep their relative order, after every candidate
 * with one. The input array is not mutated, nothing is removed, nothing is
 * selected — ordering is the only effect here; selection is
 * selectByColourAffinity's job, under its margins.
 * @param {Array<object>} candidates  products (palette read from .dominantColours)
 * @param {Array<{r,g,b,w}>} photoColours  from the operator's quick photo
 */
export function orderByColourAffinity(candidates, photoColours) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (!Array.isArray(photoColours) || !photoColours.length) return list;
  return list
    .map((c, i) => ({ c, i, d: paletteDistance(photoColours, c && c.dominantColours) }))
    .sort((x, y) => (x.d - y.d) || (x.i - y.i)) // stable: unknowns (Infinity) keep order
    .map((x) => x.c);
}
