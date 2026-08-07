// ─── DOMINANT COLOURS — cheap within-code discrimination, never selection ────
// (Owner spec 2026-08-07.) When one style code resolves to two or three
// sibling colourways, the label cannot say which one the operator is holding —
// but a quick photo of the SHOE can put the likely match first. This module is
// that, and deliberately nothing more:
//
//   • dominant-colour extraction (coarse quantisation on a downscaled canvas),
//     NOT embeddings, NOT open-set recognition — this discriminates black from
//     white among two or three candidates, which is the entire job;
//   • an ORDERING signal only. The functions here sort a candidate list; they
//     never pick, never auto-select, never hide a candidate. The human always
//     taps the shoe they are holding.
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
  try {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
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
    if (typeof source !== "string") URL.revokeObjectURL(url);
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // ignore transparency
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return quantiseColours(pixels);
  } catch {
    return [];
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

/**
 * PURE: order candidates so the closest colour match sits FIRST. Candidates
 * without a stored palette keep their relative order, after every candidate
 * with one. The input array is not mutated, nothing is removed, nothing is
 * selected — ordering is the only effect, by contract (owner spec: colours
 * order the list, NEVER auto-select).
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
