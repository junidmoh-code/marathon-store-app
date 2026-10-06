// ── THE LIFT: the shoe and its box, taken out of Gemini's footwear photo ─────
// Gemini is given the fixed footwear plate and told to use it exactly, but it
// repaints it: the pedestal picks up wear, marks and a slightly different shape
// from one generation to the next (Junid, 5 Oct: G-0102's pedestal against
// G-0004's). So Gemini's background is not kept. This finds what Gemini ADDED
// to the plate — the shoe and the box — and lifts only those; place.mjs then
// puts them on the untouched plate. (A cut-out is a filled outline: what shows
// THROUGH a shoe — the wall through a strap's opening — and a pixel or two at
// its edge come along with it, resampled once to the layout's size.)
//
// HOW, with no model call: every pixel of Gemini's photo is compared with the
// plate around the same spot (a few pixels of tolerance, because the repaint
// drifts). What is found is "evidence" of a product:
//   · COLOUR  — no plate pixel nearby has this colour;
//   · SMOOTH  — the plate is mesh here (busy) and Gemini's photo is not.
// The evidence is cleaned, its enclosed holes are filled, and a gap along a row
// is bridged only where the plate itself is plain (a black rail behind a black
// shoe, the white pedestal under a white sole) — there the product cannot be
// told from the plate by its pixels, so the product's own outline decides.
// The lower group (on the pedestal) is the shoe; the upper one (on the rail)
// is the box. Pixels are copied, never warped and never recoloured.
import sharp from "sharp";

export const LIFT_METHOD = "difference from the plate (colour + mesh) — no model call";
const TOL = 6;            // px (at the plate's size): how far Gemini's repaint may drift
const STRONG = 20, WEAK = 8;   // colour difference (0–255): a seed, and what may grow from one
const MESH_STD = 16;      // the plate's local contrast that counts as mesh
const SHADOW_MAX = 48;  // a soft shadow darkens the pedestal by less than this
const CONTACT_DARK = 26; // darker than the pedestal's white by this much is no longer the pedestal: a sole, or the line where one touches
const REDRAWN = 0.4;     // more of the photo than this differing from the plate: Gemini redrew the backdrop
const SOFT_EDGE = 5;    // a brightness step (over 2 px) larger than this is an outline, not soft shadow
const WIN = 4;            // half-window of the local-contrast measure (9×9)

const grey = (rgb, n) => { const g = new Float32Array(n); for (let i = 0; i < n; i++) g[i] = 0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2]; return g; };

/** Local standard deviation of a grey image over a (2r+1)² window. */
export function localStd(g, W, H, r = WIN) {
  const S = new Float64Array((W + 1) * (H + 1)), Q = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0, q = 0;
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x]; s += v; q += v * v;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + s;
      Q[(y + 1) * (W + 1) + x + 1] = Q[y * (W + 1) + x + 1] + q;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), n = (y1 - y0) * (x1 - x0);
      const at = (A) => A[y1 * (W + 1) + x1] - A[y0 * (W + 1) + x1] - A[y1 * (W + 1) + x0] + A[y0 * (W + 1) + x0];
      const m = at(S) / n;
      out[y * W + x] = Math.sqrt(Math.max(0, at(Q) / n - m * m));
    }
  }
  return out;
}

/** The least colour difference between each photo pixel and any plate pixel within ±TOL. */
export function tolerantDiff(a, b, W, H, R = TOL) {
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x; let best = 255;
      for (let dy = -R; dy <= R && best > 3; dy += 2) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx += 2) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          const v = Math.max(Math.abs(a[3 * i] - b[3 * j]), Math.abs(a[3 * i + 1] - b[3 * j + 1]), Math.abs(a[3 * i + 2] - b[3 * j + 2]));
          if (v < best) best = v;
        }
      }
      d[i] = best;
    }
  }
  return d;
}

// ── small binary-image tools (Uint8Array of 0/1) ────────────────────────────
function boxPass(m, W, H, r, need) {
  // Separable: a pixel is set when at least `need`(r) of its (2r+1) neighbours along the line are.
  const run = (src, horizontal) => {
    const out = new Uint8Array(W * H);
    const N = horizontal ? W : H, M = horizontal ? H : W;
    for (let j = 0; j < M; j++) {
      let c = 0;
      const at = (k) => (horizontal ? src[j * W + k] : src[k * W + j]);
      for (let k = 0; k < Math.min(N, r + 1); k++) c += at(k);
      for (let k = 0; k < N; k++) {
        const n = Math.min(N - 1, k + r) - Math.max(0, k - r) + 1;
        if (need === "any" ? c > 0 : c === n) { if (horizontal) out[j * W + k] = 1; else out[k * W + j] = 1; }
        if (k + r + 1 < N) c += at(k + r + 1);
        if (k - r >= 0) c -= at(k - r);
      }
    }
    return out;
  };
  return run(run(m, true), false);
}
export const dilate = (m, W, H, r) => boxPass(m, W, H, r, "any");
export const erode = (m, W, H, r) => boxPass(m, W, H, r, "all");

/** 8-connected components → [{ id, area, left, top, right, bottom }] and a label map (Int32Array, 0 = none). */
export function label(m, W, H) {
  const lab = new Int32Array(W * H), comps = [], stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s]) continue;
    const id = comps.length + 1, c = { id, area: 0, left: W, top: H, right: 0, bottom: 0 };
    lab[s] = id; stack.push(s);
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p - x) / W;
      c.area += 1; if (x < c.left) c.left = x; if (x > c.right) c.right = x; if (y < c.top) c.top = y; if (y > c.bottom) c.bottom = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (m[q] && !lab[q]) { lab[q] = id; stack.push(q); }
      }
    }
    comps.push(c);
  }
  return { lab, comps };
}

/** Fill every hole the mask encloses (background not reachable from the image edge). */
export function fillHoles(m, W, H) {
  const out = new Uint8Array(W * H).fill(1), stack = [];
  const push = (p) => { if (!m[p] && out[p]) { out[p] = 0; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p - x) / W;
    if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W);
  }
  return out;
}

/** Strip from the mask every pixel of `soft` that can be reached from outside the mask through `soft` pixels. */
export function stripFromOutside(m, soft, W, H) {
  const out = Uint8Array.from(m), stack = [];
  const tryPush = (p) => { if (out[p] && soft[p]) { out[p] = 0; stack.push(p); } };
  for (let p = 0; p < W * H; p++) {
    if (m[p]) continue;
    const x = p % W, y = (p - x) / W;
    if (x > 0) tryPush(p - 1); if (x < W - 1) tryPush(p + 1); if (y > 0) tryPush(p - W); if (y < H - 1) tryPush(p + W);
  }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p - x) / W;
    if (x > 0) tryPush(p - 1); if (x < W - 1) tryPush(p + 1); if (y > 0) tryPush(p - W); if (y < H - 1) tryPush(p + W);
  }
  return out;
}

/** Bridge a gap along a row (and then a column) between two parts of the mask, only across pixels where `plain` is set. */
export function bridgePlain(m, plain, W, H, maxGap) {
  const out = Uint8Array.from(m);
  const line = (N, idx) => {
    let last = -1;
    for (let k = 0; k < N; k++) {
      if (!m[idx(k)]) continue;
      if (last >= 0 && k - last > 1 && k - last <= maxGap) {
        let ok = true;
        for (let t = last + 1; t < k && ok; t++) if (!plain[idx(t)]) ok = false;
        if (ok) for (let t = last + 1; t < k; t++) out[idx(t)] = 1;
      }
      last = k;
    }
  };
  for (let y = 0; y < H; y++) line(W, (k) => y * W + k);
  for (let x = 0; x < W; x++) line(H, (k) => k * W + x);
  return out;
}

/**
 * WHEN GEMINI REDREW THE WHOLE BACKDROP (closer, darker, softer) nothing can be learnt from the plate. The
 * product is then found in the photo alone: the backdrop is colourless mesh (busy) and black rails (dark
 * columns running the height of the photo); a product is COLOURED, or it is SMOOTH and not a rail.
 * photo: raw RGB at W×H. → { mask, darkPlain (the rails: a gap across one may be bridged), shadow (none) }
 */
export function evidenceFromPhoto(photo, W, H) {
  const n = W * H, g = grey(photo, n), t = localStd(g, W, H);
  const chroma = (i) => Math.max(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]) - Math.min(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]);
  const railCol = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    let dark = 0;
    for (let y = 0; y < H; y++) { const i = y * W + x; if (g[i] < 75 && chroma(i) < 30) dark += 1; }
    if (dark >= 0.5 * H) railCol[x] = 1;
  }
  const wide = Uint8Array.from(railCol);
  for (let x = 0; x < W; x++) if (railCol[x]) for (let k = Math.max(0, x - 4); k <= Math.min(W - 1, x + 4); k++) wide[k] = 1;
  // How busy the mesh is in THIS photo: the middle value of the upper half, off the rails.
  const sample = [];
  for (let y = 8; y < 0.5 * H; y += 6) for (let x = 8; x < W - 8; x += 6) if (!wide[x]) sample.push(t[y * W + x]);
  sample.sort((a, b) => a - b);
  const mesh = sample.length ? sample[sample.length >> 1] : MESH_STD;
  const mask = new Uint8Array(n), rails = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % W;
    if (wide[x] && g[i] < 75 && chroma(i) < 30) { rails[i] = 1; continue; }
    if (chroma(i) >= 28 || t[i] < 0.4 * mesh) mask[i] = 1;
  }
  return { mask, darkPlain: rails, shadow: new Uint8Array(n), fromPhotoOnly: true };
}

/**
 * The evidence mask at the plate's size. photo / plate: raw RGB at W×H.
 * → { mask (0/1), plain (0/1: the plate is not mesh here) }
 */
export function evidence(photo, plate, W, H) {
  const d = tolerantDiff(photo, plate, W, H);
  const ga = grey(photo, W * H);
  const ta = localStd(ga, W, H), tb = localStd(grey(plate, W * H), W, H);
  const strong = new Uint8Array(W * H), weak = new Uint8Array(W * H), plain = new Uint8Array(W * H), shadow = new Uint8Array(W * H), darkPlain = new Uint8Array(W * H), darker = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const smooth = tb[i] >= MESH_STD && ta[i] <= 0.45 * tb[i];
    // MESH OVER MESH is the backdrop, however Gemini redrew it (a little closer, a little coarser): where the
    // plate is mesh and the photo is still a busy, colourless pattern, a colour difference proves nothing.
    const cm = Math.max(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]) - Math.min(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]);
    const stillMesh = tb[i] >= MESH_STD && ta[i] >= 0.6 * tb[i] && cm < 20;
    if (!stillMesh && (d[i] >= STRONG || smooth)) strong[i] = 1;
    if (!stillMesh && (d[i] >= WEAK || smooth)) weak[i] = 1;
    if (tb[i] < MESH_STD) plain[i] = 1;
    // A SOFT SHADOW on the pedestal: the plate is plain and light here, and the photo is the same
    // neutral surface, only a little darker. (The dark line where the sole touches is darker than this.)
    if (tb[i] < MESH_STD) {
      const pl = 0.299 * plate[3 * i] + 0.587 * plate[3 * i + 1] + 0.114 * plate[3 * i + 2];
      const ph = 0.299 * photo[3 * i] + 0.587 * photo[3 * i + 1] + 0.114 * photo[3 * i + 2];
      const chroma = Math.max(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]) - Math.min(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]);
      // …and it is SOFT: an outline (the edge of a white sole on the white pedestal) is not shadow, and stops the peel.
      const x = i % W, y = (i - x) / W;
      const gx = x > 0 && x < W - 1 ? ga[i + 1] - ga[i - 1] : 0, gy = y > 0 && y < H - 1 ? ga[i + W] - ga[i - W] : 0;
      if (pl >= 150 && ph < pl - 4 && ph > pl - SHADOW_MAX && chroma < 24 && Math.abs(gx) + Math.abs(gy) < SOFT_EDGE) shadow[i] = 1;
      if (pl >= 150) darker[i] = Math.max(0, Math.min(255, Math.round(pl - ph)));
      if (pl < 90) darkPlain[i] = 1;
    }
  }
  // Specks out of the seeds; then a weak pixel counts only when it belongs to a group that holds a seed.
  const seeds = dilate(erode(strong, W, H, 2), W, H, 2);
  const { lab, comps } = label(weak, W, H);
  const keep = new Uint8Array(comps.length + 1);
  for (let i = 0; i < W * H; i++) if (seeds[i] && lab[i]) keep[lab[i]] = 1;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && keep[lab[i]]) mask[i] = 1;
  let on = 0;
  for (let i = 0; i < W * H; i++) on += mask[i];
  return { mask, plain, shadow, darkPlain, darker, diff: d, share: on / (W * H) };
}

const MIN_AREA = 0.004;   // of the canvas: smaller groups are repaint noise, not a product

/**
 * Find the shoe and the box in the evidence. spec.pedestal (fractions) says where the pedestal is.
 * → { shoe: { mask, rect }, box: { mask, rect } | null } or { problem }
 */
export function findProducts(ev, W, H, line) {
  // Close small gaps and fill holes; then drop everything thin — the repainted pedestal's outline, the
  // shadow line under the sole, a sliver of pedestal — by an opening wider than any of them.
  const thin = Math.max(3, Math.round(0.006 * W));
  // Nothing under the sole line is the shoe: Gemini's pedestal goes, however it was redrawn.
  const cut = Uint8Array.from(ev.mask);
  for (let x = 0; x < W; x++) for (let y = Math.max(0, line[x] + 1); y < H; y++) cut[y * W + x] = 0;
  let m = fillHoles(erode(dilate(cut, W, H, 3), W, H, 3), W, H);
  // The soft shadow Gemini drew on the pedestal around the shoe is not the shoe: it is peeled off from the
  // outside in, and stops at anything that is not soft shadow (the dark contact line, the shoe itself).
  m = stripFromOutside(m, ev.shadow, W, H);
  m = dilate(erode(m, W, H, thin), W, H, thin);
  // (ev.darkPlain: the plate's black rails, or — from the photo alone — the photo's own.)
  // A gap along a row or column is bridged only across a black rail (a dark shoe in front of it leaves no evidence), and only as wide as a rail.
  m = fillHoles(bridgePlain(m, ev.darkPlain, W, H, Math.round(0.06 * W)), W, H);
  m = dilate(erode(m, W, H, thin), W, H, thin);
  const { lab, comps } = label(m, W, H);
  const big = comps.filter((c) => c.area >= MIN_AREA * W * H);
  if (!big.length) return { problem: "nothing could be told apart from the backdrop" };
  // The shoe stands on the pedestal: its lowest point is on the sole line, above the panel.
  const onPedestal = (c) => {
    const x = Math.round((c.left + c.right) / 2);
    return c.bottom >= line[x] - 0.03 * H && c.bottom <= line.panelTop && c.right >= line.panelLeft && c.left <= line.panelRight;
  };
  const shoes = big.filter(onPedestal).sort((a, b) => b.area - a.area);
  if (!shoes.length) return { problem: "no shoe was found standing on the pedestal" };
  const shoeC = shoes[0];
  const above = big.filter((c) => c !== shoeC && c.bottom < shoeC.top + 0.25 * (shoeC.bottom - shoeC.top) && (c.left + c.right) / 2 / W > 0.2 && (c.left + c.right) / 2 / W < 0.8).sort((a, b) => b.area - a.area);
  const boxC = above[0] || null;
  const pick = (c) => {
    const w = c.right - c.left + 1, h = c.bottom - c.top + 1, mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lab[(c.top + y) * W + c.left + x] === c.id) mask[y * w + x] = 1;
    return { mask, rect: { left: c.left, top: c.top, width: w, height: h }, area: c.area };
  };
  const shoe = pick(shoeC);
  if (shoe.rect.left <= 1 || shoe.rect.left + shoe.rect.width >= W - 1) return { problem: "the shoe runs off the side of the photo" };
  if (shoe.rect.width < 0.2 * W) return { problem: "the shoe found is too small to be the whole shoe" };
  if (shoe.rect.height > 0.6 * H) return { problem: "the shoe could not be told apart from the box or the backdrop" };
  // A shoe side-on is longer than it is tall (a boot nearly square). Something clearly taller than long is a
  // shoe joined to the box above it, or to the backdrop: not cut.
  if (shoe.rect.width < 0.9 * shoe.rect.height) return { problem: "the shoe could not be told apart from the box above it" };
  // …and so is an HOURGLASS: wide at the top, a waist, wide at the bottom — a box resting on the shoe. A shoe
  // on its own mostly widens toward the sole (a boot's shaft narrows a little at the ankle — not by half).
  if (hourglass(shoe)) return { problem: "the shoe could not be told apart from the box above it" };
  let box = boxC ? pick(boxC) : null;
  if (box) {
    // A box is a rectangle standing square to the camera: its own outline, row by row, is filled across
    // (a black box in front of a black rail leaves no evidence in the middle).
    const { width: w, height: h } = box.rect;
    for (let y = 0; y < h; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < w; x++) if (box.mask[y * w + x]) { if (l < 0) l = x; r = x; }
      for (let x = l; l >= 0 && x <= r; x++) box.mask[y * w + x] = 1;
    }
    // A shelf or bracket Gemini drew under the box is not the box: rows at the bottom that are clearly
    // wider than the box itself are dropped.
    const widths = [];
    for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) n += box.mask[y * w + x]; widths.push(n); }
    const mid = [...widths].sort((a, b) => a - b)[h >> 1];
    let keep = h;
    while (keep > 0.6 * h && widths[keep - 1] > 1.1 * mid) keep -= 1;
    if (keep < h) {
      let l = w, r = -1;
      for (let y = 0; y < keep; y++) for (let x = 0; x < w; x++) if (box.mask[y * w + x] && widths[y] <= 1.1 * mid) { if (x < l) l = x; if (x > r) r = x; }
      if (r >= l) {
        const nw = r - l + 1, nm = new Uint8Array(nw * keep);
        for (let y = 0; y < keep; y++) for (let x = 0; x < nw; x++) nm[y * nw + x] = box.mask[y * w + l + x];
        box = { mask: nm, rect: { left: box.rect.left + l, top: box.rect.top, width: nw, height: keep }, area: box.area };
      }
    }
  }
  // Only something that looks like packaging is placed as the box: big enough, and filling its own outline
  // (a box or a bag does; a bracket, a shelf or a patch of repainted wall does not). Otherwise no box is placed.
  if (box) {
    let on = 0;
    for (let i = 0; i < box.mask.length; i++) on += box.mask[i];
    if (on < 0.006 * W * H || on < 0.72 * box.rect.width * box.rect.height) box = null;
  }
  return { shoe, box };
}

/**
 * WHERE THE PEDESTAL ENDS AND THE SHOE BEGINS — read from Gemini's own photo, because Gemini redraws the
 * pedestal (a little smaller, lower, differently lit) and no comparison with the plate can be trusted there.
 * The pedestal is known by its black front panel: the widest dark band in the lower part of the photo.
 * From the panel's top edge each column is walked UP through the pedestal's white — its front face, then
 * its top surface — until something that is not that white: the dark line where a sole touches, a coloured
 * sole, or (beside the shoe) the mesh. That height, smoothed along the pedestal, is the sole line.
 * photo: raw RGB at W×H. → Int32Array(W) of rows (keep rows ≤ line[x]), or null when no panel is found.
 */
export function soleLine(photo, W, H) {
  const lum = (i) => 0.299 * photo[3 * i] + 0.587 * photo[3 * i + 1] + 0.114 * photo[3 * i + 2];
  const chroma = (i) => Math.max(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]) - Math.min(photo[3 * i], photo[3 * i + 1], photo[3 * i + 2]);
  // The panel: rows (in the lower 45%) whose longest run of dark neutral pixels is at least a third of the width.
  const rows = [];
  for (let y = Math.round(0.55 * H); y < H - 2; y++) {
    let best = 0, bl = 0, run = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (lum(i) < 70 && chroma(i) < 30) { run += 1; if (run > best) { best = run; bl = x - run + 1; } } else run = 0;
    }
    rows.push(best >= 0.33 * W ? { y, left: bl, right: bl + best - 1 } : null);
  }
  let band = null, cur = null;
  for (const r of [...rows, null]) {
    if (r) { cur = cur || []; cur.push(r); continue; }
    if (cur && (!band || cur.length > band.length)) band = cur;
    cur = null;
  }
  if (!band || band.length < 0.02 * H || band.length > 0.25 * H) return null;
  const top = band[0].y;
  const mid = band[band.length >> 1];
  // The pedestal's white, read from its front face just above the panel.
  const face = [];
  for (let x = mid.left + 4; x < mid.right - 4; x += 3) for (let y = top - 8; y <= top - 4; y++) if (y > 0) face.push(lum(y * W + x));
  if (face.length < 20) return null;
  face.sort((a, b) => a - b);
  const white = face[face.length >> 1];
  if (white < 120) return null;
  const isWhite = (i) => lum(i) >= white - CONTACT_DARK && chroma(i) < 26;
  const line = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let y = top - 3;
    // Two pixels in a row that are not the pedestal's white end the walk.
    while (y > 1 && (isWhite(y * W + x) || isWhite((y - 1) * W + x))) y -= 1;
    line[x] = y;
  }
  // A running median along the pedestal: one stray column cannot notch the sole.
  const out = new Int32Array(W), R = 5, v = [];
  for (let x = 0; x < W; x++) {
    v.length = 0;
    for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R); k++) v.push(line[k]);
    v.sort((a, b) => a - b);
    out[x] = v[v.length >> 1];
  }
  return Object.assign(out, { panelTop: top, panelLeft: mid.left, panelRight: mid.right, white });
}

/** Is the piece wide, then clearly narrower, then wide again, going down? (Its widest row in the top third and in the bottom third, against its narrowest row between them.) */
export function hourglass(piece) {
  const { mask, rect } = piece, w = rect.width, h = rect.height, widths = new Int32Array(h);
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) n += mask[y * w + x]; widths[y] = n; }
  let a = 0, ay = 0, c = 0, cy = h - 1;
  for (let y = 0; y < h / 3; y++) if (widths[y] > a) { a = widths[y]; ay = y; }
  for (let y = Math.ceil((2 * h) / 3); y < h; y++) if (widths[y] > c) { c = widths[y]; cy = y; }
  let b = Infinity;
  for (let y = ay; y <= cy; y++) if (widths[y] < b) b = widths[y];
  return b <= 0.5 * Math.min(a, c);
}

/** The share of a piece's pixels that are clearly coloured. */
export function colouredShare(photo, W, piece) {
  const { mask, rect } = piece; let on = 0, col = 0;
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    if (!mask[y * rect.width + x]) continue;
    const i = 3 * ((rect.top + y) * W + rect.left + x);
    on += 1;
    if (Math.max(photo[i], photo[i + 1], photo[i + 2]) - Math.min(photo[i], photo[i + 1], photo[i + 2]) >= 28) col += 1;
  }
  return on ? col / on : 0;
}

/**
 * The pedestal as it stands in a photo, by its black front panel and the white body around it.
 * left / right are the sides of its BODY, read just above the panel (its widest part, a little wider than the
 * top surface's flat part). → { panelTop, left, right, backRim, frontEdge } in pixels, or null.
 */
export function pedestalIn(photo, W, H) {
  const line = soleLine(photo, W, H);
  if (!line) return null;
  const y = line.panelTop - 6, lum = (x) => 0.299 * photo[3 * (y * W + x)] + 0.587 * photo[3 * (y * W + x) + 1] + 0.114 * photo[3 * (y * W + x) + 2];
  let left = line.panelLeft, right = line.panelRight;
  while (left > 1 && lum(left - 1) >= line.white - 45) left -= 1;
  while (right < W - 2 && lum(right + 1) >= line.white - 45) right += 1;
  // The top surface: its back rim (where the walk up from the panel meets the wall) and its front edge
  // (the strongest brightness step between the rim and the panel, across the panel's width).
  const rims = [];
  for (let x = line.panelLeft + 20; x < line.panelRight - 20; x++) rims.push(line[x]);
  rims.sort((a, b) => a - b);
  const backRim = rims.length ? rims[rims.length >> 1] : null;
  const at = (x, yy) => 0.299 * photo[3 * (yy * W + x)] + 0.587 * photo[3 * (yy * W + x) + 1] + 0.114 * photo[3 * (yy * W + x) + 2];
  let best = 0, frontEdge = null;
  for (let yy = (backRim ?? 0) + 12; backRim !== null && yy < line.panelTop - 10; yy++) {
    let g = 0;
    for (let x = line.panelLeft + 20; x < line.panelRight - 20; x += 2) g += at(x, yy - 3) - at(x, yy + 3);
    if (Math.abs(g) > best) { best = Math.abs(g); frontEdge = yy; }
  }
  return { panelTop: line.panelTop, left, right, panelLeft: line.panelLeft, panelRight: line.panelRight, backRim, frontEdge };
}

async function cutPng(hi, hiW, hiH, piece, W, H) {
  // The piece's mask, at the plate's size, laid over the photo at its own (higher) resolution.
  const sx = hiW / W, sy = hiH / H;
  const left = Math.max(0, Math.floor(piece.rect.left * sx)), top = Math.max(0, Math.floor(piece.rect.top * sy));
  const width = Math.min(hiW - left, Math.ceil(piece.rect.width * sx)), height = Math.min(hiH - top, Math.ceil(piece.rect.height * sy));
  const alpha = await sharp(Buffer.from(piece.mask.map((v) => v * 255)), { raw: { width: piece.rect.width, height: piece.rect.height, channels: 1 } })
    .resize(width, height, { fit: "fill", kernel: "cubic" }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgb = await sharp(hi, { raw: { width: hiW, height: hiH, channels: 3 } }).extract({ left, top, width, height }).raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = alpha[i]; }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const fracRect = (r, W, H) => ({ left: r.left / W, top: r.top / H, right: (r.left + r.width) / W, bottom: (r.top + r.height) / H });

/**
 * Lift the shoe and the box out of Gemini's footwear photo.
 *   photoBuf: Gemini's photo (any size, the plate's framing) · plate: { buffer, width, height } · spec: the footwear layout
 * → { shoe: png, box: png | null, found: { shoe, box } (fractions of the canvas) } or { problem }
 */
export async function liftFromPlate(photoBuf, plate, { allowColourless = false } = {}) {
  const W = plate.width, H = plate.height;
  const at = (buf, w, h, blur) => { let s = sharp(buf).flatten({ background: "#ffffff" }).toColourspace("srgb").resize(w, h, { fit: "cover", position: "centre" }).removeAlpha(); if (blur) s = s.blur(blur); return s.raw().toBuffer(); };
  // (flatten: a photo with transparency is read on white, never with undefined colour under it)
  const [photo, plateRaw] = await Promise.all([at(photoBuf, W, H, 1.2), at(plate.buffer, W, H, 1.2)]);
  const line = soleLine(photo, W, H);
  if (!line) return { problem: "the model changed the pedestal — its black front panel could not be found" };
  // Against the plate when Gemini kept the backdrop; from the photo alone when it redrew it (too much differs).
  let ev = evidence(photo, plateRaw, W, H), found = ev.share <= REDRAWN ? findProducts(ev, W, H, line) : { problem: "redrawn" };
  if (found.problem) {
    const second = findProducts(evidenceFromPhoto(photo, W, H), W, H, line);
    if (second.problem) return { problem: found.problem === "redrawn" ? second.problem : found.problem };
    // From the photo alone only a COLOURED shoe is trusted: a white, grey or black one cannot be told from a
    // redrawn pedestal and backdrop well enough to cut.
    if (!allowColourless && colouredShare(photo, W, second.shoe) < 0.5) return { problem: "the model redrew the backdrop, and a shoe with no colour cannot be told apart from it" };
    found = second; found.fromPhotoOnly = true;
  }
  // The pixels are copied from the photo at its own resolution (never above twice the plate's).
  const m = await sharp(photoBuf).metadata();
  const k = Math.max(1, Math.min(2, (m.width || W) / W));
  const hiW = Math.round(W * k), hiH = Math.round(H * k);
  const hi = await at(photoBuf, hiW, hiH, 0);
  return {
    shoe: await cutPng(hi, hiW, hiH, found.shoe, W, H),
    box: found.box ? await cutPng(hi, hiW, hiH, found.box, W, H) : null,
    found: { shoe: fracRect(found.shoe.rect, W, H), box: found.box ? fracRect(found.box.rect, W, H) : null },
    how: found.fromPhotoOnly ? "from the photo alone (the model redrew the backdrop)" : "against the plate",
  };
}
