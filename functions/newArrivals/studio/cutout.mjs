// ── CUT-OUT (the split method) — no model call ──────────────────────────────
// Gemini's product-only photo (product on plain light grey) → the product with
// a transparent background, split into its pieces (shoe + box; garment(s)).
//
// THE MATTE here is a flood of the grey background from the picture's edges
// (greyMatte): the Mac mini used a local ONNX model, which does not belong in
// a Cloud Function shared by 86 functions. The flood follows the grey through
// gentle changes (a soft shadow, a slight gradient) and stops at the product's
// edge — so a coloured, white or dark product is cut cleanly. A product that
// is itself the background's light grey has no edge to stop at: the cut-out
// then fails its own sanity check and the split method says so (the photo
// Gemini made is kept; Full Gemini is the method for that item).
//
// Everything after the matte — the de-fringe, the connected pieces, the toe
// direction — is the mini's code, unchanged (marathon-group-poster f7d4bba).
import sharp from "sharp";

export const CUTOUT_METHOD = "grey background flood from the edges + grey de-fringe";

/** The background's colour: the median of the image's border pixels. Pure on raw RGB(A). */
export function borderColour(data, w, h, ch) {
  const rs = [], gs = [], bs = [];
  const push = (i) => { rs.push(data[i * ch]); gs.push(data[i * ch + 1]); bs.push(data[i * ch + 2]); };
  for (let x = 0; x < w; x += 2) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y += 2) { push(y * w); push(y * w + w - 1); }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/**
 * Clean a matte in place: clear near-transparent pixels and faint pixels that
 * ARE the background colour; de-fringe partly transparent edge pixels against
 * the background (c = (c − (1 − a)·bg) / a). Pure on raw RGBA.
 */
export function refineMatte(rgba, w, h, bg) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4, a = rgba[o + 3] / 255;
    if (a < 0.04) { rgba[o + 3] = 0; continue; }
    const d = Math.hypot(rgba[o] - bg[0], rgba[o + 1] - bg[1], rgba[o + 2] - bg[2]);
    if (a < 0.5 && d < 14) { rgba[o + 3] = 0; continue; }
    if (a < 0.98) {
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.max(0, Math.min(255, Math.round((rgba[o + c] - (1 - a) * bg[c]) / a)));
    }
  }
  return rgba;
}

/**
 * Connected pieces of the solid part of a matte (alpha > 50%), 4-connected.
 * → { labels: Int32Array (0 = none), comps: [{ id, area, left, top, right, bottom, fill }] } largest first. Pure.
 */
export function components(rgba, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (labels[s] || rgba[s * 4 + 3] <= 127) continue;
    const id = ++next;
    let sp = 0, area = 0, left = w, right = -1, top = h, bottom = -1;
    stack[sp++] = s; labels[s] = id;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w, y = (i / w) | 0;
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !labels[j] && rgba[j * 4 + 3] > 127) { labels[j] = id; stack[sp++] = j; }
    }
    comps.push({ id, area, left, top, right, bottom, fill: area / ((right - left + 1) * (bottom - top + 1)) });
  }
  comps.sort((a, b) => b.area - a.area);
  return { labels, comps };
}

const grow = (b, m, w, h) => ({ left: Math.max(0, b.left - m), top: Math.max(0, b.top - m), right: Math.min(w - 1, b.right + m), bottom: Math.min(h - 1, b.bottom + m) });
const inside = (x, y, b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

/**
 * Group the pieces: the `n` largest solid pieces are the products; specks are
 * dropped, and small bits (a hanger hook, a lace end) join the big piece whose
 * box (grown 3%) holds their centre. Pure. → [{ ids:Set, left, top, right, bottom, area, fill }]
 */
export function groupPieces(comps, w, h, n) {
  if (!comps.length) return [];
  const minBig = comps[0].area * 0.15;
  const big = comps.slice(0, n).filter((c, i) => i === 0 || c.area >= minBig);
  const groups = big.map((c) => ({ ids: new Set([c.id]), left: c.left, top: c.top, right: c.right, bottom: c.bottom, area: c.area, fill: c.fill }));
  const m = Math.round(0.03 * Math.max(w, h));
  for (const c of comps.slice(big.length)) {
    if (c.area < comps[0].area * 0.0005) continue;           // a speck of matte noise
    const cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2;
    const g = groups.find((gr) => inside(cx, cy, grow(gr, m, w, h)));
    if (!g) continue;                                       // something stray, away from the product
    g.ids.add(c.id); g.area += c.area;
    g.left = Math.min(g.left, c.left); g.top = Math.min(g.top, c.top); g.right = Math.max(g.right, c.right); g.bottom = Math.max(g.bottom, c.bottom);
  }
  return groups;
}

/**
 * One piece as its own RGBA image, cropped tight: the solid pixels of its
 * components plus the soft edge pixels (alpha ≤ 50%, no label) within 4 px of
 * its box. Other pieces' pixels are left out. Pure → { data, width, height, left, top }.
 */
export function extractPiece(rgba, labels, w, h, group) {
  const b = grow(group, 4, w, h);
  const width = b.right - b.left + 1, height = b.bottom - b.top + 1;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (b.top + y) * w + (b.left + x), o = (y * width + x) * 4;
      const l = labels[i];
      if (l ? !group.ids.has(l) : rgba[i * 4 + 3] === 0) continue;
      data[o] = rgba[i * 4]; data[o + 1] = rgba[i * 4 + 1]; data[o + 2] = rgba[i * 4 + 2]; data[o + 3] = rgba[i * 4 + 3];
    }
  }
  return { data, width, height, left: b.left, top: b.top };
}

/** The tight box of the solid pixels of a raw RGBA piece. Pure. */
export function solidBox({ data, width, height }) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 127) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  }
  return right < 0 ? null : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Which way a shoe's TOE points, from its silhouette: the toe end of a shoe
 * sits LOWER than the heel end (the collar and heel counter are the tallest
 * part). Compares the top edge over the outer 18% at each end. Pure.
 * → "right" | "left" | "unclear"
 */
export function toeDirection(piece) {
  const b = solidBox(piece);
  if (!b || b.width < 10) return "unclear";
  const tops = [];
  for (let x = b.left; x <= b.right; x++) {
    let t = -1;
    for (let y = b.top; y <= b.bottom; y++) if (piece.data[(y * piece.width + x) * 4 + 3] > 127) { t = y; break; }
    tops.push(t < 0 ? b.bottom : t);
  }
  const k = Math.max(1, Math.round(tops.length * 0.18));
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const leftTop = med(tops.slice(0, k)), rightTop = med(tops.slice(-k));
  const d = (rightTop - leftTop) / b.height;
  return d > 0.08 ? "right" : d < -0.08 ? "left" : "unclear";
}

/**
 * The matte: the grey background, flooded in from every edge, made transparent.
 * A pixel joins the background when it is close to the pixel it was reached
 * from (`step` — a gentle change), still near the background's own colour
 * (`wide`) and as neutral as it (`chroma` — a coloured product never floods).
 * Grey enclosed by the product (`hole`) is removed in a second pass.
 * → RGBA PNG of the same size.
 */
export async function greyMatte(buf, { step = 5, wide = 80, chroma = 14, hole = 7 } = {}) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const bg = borderColour(data, w, h, ch);
  const bgCast = [bg[0] - bg[1], bg[1] - bg[2]];
  const background = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  // How far a pixel is from the background's colour: its largest channel difference.
  const off = (i) => { const o = i * ch; return Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2])); };
  const near = (i) => {
    if (off(i) > wide) return false;
    const o = i * ch;
    return Math.abs(data[o] - data[o + 1] - bgCast[0]) <= chroma && Math.abs(data[o + 1] - data[o + 2] - bgCast[1]) <= chroma;
  };
  const seed = (i) => { if (!background[i] && near(i) && off(i) <= step * 4) { background[i] = 1; stack[top++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  const reach = (from, to) => {
    if (background[to] || !near(to)) return;
    const a = from * ch, b = to * ch;
    if (Math.abs(data[a] - data[b]) > step || Math.abs(data[a + 1] - data[b + 1]) > step || Math.abs(data[a + 2] - data[b + 2]) > step) return;
    background[to] = 1; stack[top++] = to;
  };
  while (top > 0) {
    const i = stack[--top], x = i % w, y = (i - x) / w;
    if (x > 0) reach(i, i - 1);
    if (x < w - 1) reach(i, i + 1);
    if (y > 0) reach(i, i - w);
    if (y < h - 1) reach(i, i + w);
  }
  // ENCLOSED GREY — a gap inside a sleeve, a lace loop, between the pieces of a
  // set — is not reachable from the edges. Any patch of pixels that are the
  // background's own colour (tightly: `hole`) and big enough to be a gap, not a
  // speck of the product, is background too.
  const holeMin = Math.max(150, Math.round(w * h * 0.0002));
  const seen = new Uint8Array(w * h);
  const isHole = (i) => !background[i] && off(i) <= hole && near(i);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isHole(start)) continue;
    let n = 0; top = 0;
    stack[top++] = start; seen[start] = 1;
    const members = [];
    while (top > 0) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      members.push(i); n += 1;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && isHole(j)) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (n >= holeMin) for (const i of members) background[i] = 1;
  }
  // A one-pixel soft edge: the alpha is blurred slightly, then never raised above solid.
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = background[i] ? 0 : 255;
  const soft = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = data[i * ch]; rgba[i * 4 + 1] = data[i * ch + 1]; rgba[i * 4 + 2] = data[i * ch + 2];
    rgba[i * 4 + 3] = background[i] ? Math.min(soft[i], 96) : soft[i];
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/**
 * The whole cut-out: matte → refine → pieces. `matte(buf)` → RGBA PNG (default: the grey flood).
 *   pieces: how many products to look for (footwear with its box: 2; a two-piece set: 2; else 1)
 * → { width, height, bg, coverage, pieces: [{ data, width, height, left, top, area, fill }], method }
 */
export async function cutOut(buf, { pieces = 1, matte = greyMatte } = {}) {
  const src = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = borderColour(src.data, src.info.width, src.info.height, src.info.channels);
  const m = await sharp(await matte(buf)).ensureAlpha().resize(src.info.width, src.info.height, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const w = m.info.width, h = m.info.height;
  const rgba = Buffer.from(m.data);
  refineMatte(rgba, w, h, bg);
  const { labels, comps } = components(rgba, w, h);
  const groups = groupPieces(comps, w, h, pieces);
  const out = groups.map((g) => ({ ...extractPiece(rgba, labels, w, h, g), area: g.area, fill: g.fill }));
  // How much of the frame the kept pieces cover: the sanity check on the cut-out.
  const coverage = out.reduce((n, p) => n + p.area, 0) / (w * h);
  return { width: w, height: h, bg, coverage, pieces: out, method: CUTOUT_METHOD };
}

/** A raw RGBA piece → PNG. */
export const piecePng = (p) => sharp(p.data, { raw: { width: p.width, height: p.height, channels: 4 } }).png().toBuffer();
