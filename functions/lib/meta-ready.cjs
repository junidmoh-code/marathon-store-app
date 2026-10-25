// ─── META-READY PHOTO — square, product ~80%, background edge to edge ────────
// (Junid, 25 Oct 2026, COMMIT 6.) "Whenever a primary photo is set, also make
// a Meta-ready version: 1:1 square, product filling about 80% of the frame,
// background extended edge to edge, no white borders. Stored alongside, never
// replacing the primary."
//
// LOCAL AND FREE: sharp only — no AI, no paid service. One copy, CommonJS, so
// the primaryPhotoMetaReady trigger (functions/primaryPhoto/metaReady.cjs),
// the Mac mini's reconciler and the test script all run the same code.
//
// THE STEPS (analysis on a ≤400px copy, the cut on the full-size photo):
//   1. FRAME — flat bands along any edge are cut off: a photo letterboxed
//      into a white square, a white mount, the dark border of a screenshot.
//      A band is a row/column whose pixels are ≥ 92% within a small distance
//      of one colour (the same colour band after band); at most 35% of a side
//      is ever cut. A flat studio backdrop cut this way loses nothing — step 4
//      fills with that same backdrop colour.
//   2. BACKGROUND — the median colour of the inner image's outer ring, and
//      how uniform that ring is.
//   3. PRODUCT — every pixel clearly unlike the background; its bounding box
//      (rows/columns with < 1% such pixels are noise).
//   4. SQUARE — side = the box's longer side ÷ 0.8, centred on the box. Where
//      the square runs past the photo, the background is EXTENDED with its own
//      colour (a flat backdrop) or mirrored outwards (a scene). When the
//      product cannot be told from a busy backdrop (the box is nearly the
//      whole photo), the square is CUT from the photo instead — centred,
//      never mirrored — so no repeated seam appears at the edges.
//   5. 1080 × 1080 JPEG.
"use strict";

const SIZE = 1080;
const FILL = 0.8;
const NEAR_WHITE = 235;          // min channel for "near-white"
const WHITE_SPREAD = 14;         // max − min channel for "near-white" (not a pale colour)
const BAND_SHARE = 0.92;
const BAND_DIST = 30;            // |Δr|+|Δg|+|Δb| from the band's colour
const MAX_TRIM = 0.35;
const ANALYSE = 400;

function isNearWhite(r, g, b) {
  return Math.min(r, g, b) >= NEAR_WHITE && Math.max(r, g, b) - Math.min(r, g, b) <= WHITE_SPREAD;
}

/** PURE: the flat-band frame on each side of an RGB raster (rows/cols to cut). */
function whiteFrame(px, w, h) {
  const at = (x, y) => { const i = (y * w + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
  const dist = (a, c) => Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]);
  // A line is flat when ≥ BAND_SHARE of it sits near its own median colour,
  // and a run of bands must keep the colour it started with.
  const flatColour = (pts) => {
    const c = [0, 1, 2].map((k) => median(pts.map((p) => p[k])));
    return pts.filter((p) => dist(p, c) <= BAND_DIST).length / pts.length >= BAND_SHARE ? c : null;
  };
  // A FRAME, not a backdrop: the line just inside the run must be mostly
  // something else. A flat studio backdrop runs on into the product's own
  // lines (still mostly backdrop), so it is never cut; a white mount or a
  // screenshot border meets the photo (≥ 90% different) and is.
  const run = (lineAt, n, cap) => {
    let k = 0, first = null;
    while (k < cap) {
      const c = flatColour(lineAt(k));
      if (!c || (first && dist(c, first) > BAND_DIST)) break;
      first = first || c; k++;
    }
    if (!k || k >= cap) return 0;
    // The middle 60% of the line two pixels in (past the resampled seam; the
    // ends may still be the perpendicular frame).
    const line = lineAt(Math.min(k + 2, n - 1));
    const mid = line.slice(Math.floor(line.length * 0.2), Math.ceil(line.length * 0.8));
    return mid.filter((p) => dist(p, first) <= BAND_DIST).length / mid.length <= 0.1 ? k : 0;
  };
  const capH = Math.floor(h * MAX_TRIM), capW = Math.floor(w * MAX_TRIM);
  const row = (y) => Array.from({ length: w }, (_, x) => at(x, y));
  const t = run((k) => row(k), h, capH);
  const b = run((k) => row(h - 1 - k), h, capH);
  const col = (x) => Array.from({ length: Math.max(1, h - b - t) }, (_, j) => at(x, t + j));
  const l = run((k) => col(k), w, capW);
  const r = run((k) => col(w - 1 - k), w, capW);
  return { t, b, l, r };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/** PURE: background colour + uniformity from the outer ring of a region. */
function background(px, w, region) {
  const { x0, y0, x1, y1 } = region;
  const R = [], G = [], B = [];
  const ring = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) * 0.02));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (y - y0 >= ring && y1 - 1 - y >= ring && x - x0 >= ring && x1 - 1 - x >= ring) continue;
      const i = (y * w + x) * 3; R.push(px[i]); G.push(px[i + 1]); B.push(px[i + 2]);
    }
  }
  const bg = [median(R), median(G), median(B)];
  const devs = R.map((_, k) => Math.abs(R[k] - bg[0]) + Math.abs(G[k] - bg[1]) + Math.abs(B[k] - bg[2]));
  // Median, not mean: a product touching the edge must not make a studio
  // backdrop look like a scene.
  const spread = median(devs);
  return { bg, spread, uniform: spread <= 18 };
}

/** PURE: the product's bounding box inside a region (analysis coordinates). */
function productBox(px, w, region, bg, spread) {
  const { x0, y0, x1, y1 } = region;
  const T = Math.max(48, spread * 3);
  const cols = new Array(x1 - x0).fill(0), rows = new Array(y1 - y0).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      if (d > T) { cols[x - x0]++; rows[y - y0]++; }
    }
  }
  const minC = Math.max(1, (y1 - y0) * 0.01), minR = Math.max(1, (x1 - x0) * 0.01);
  const first = (a, m) => a.findIndex((v) => v >= m);
  const last = (a, m) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] >= m) return i; return -1; };
  const bx0 = first(cols, minC), bx1 = last(cols, minC), by0 = first(rows, minR), by1 = last(rows, minR);
  if (bx0 < 0 || by0 < 0 || bx1 - bx0 < 4 || by1 - by0 < 4) return { x0, y0, x1, y1, found: false };
  return { x0: x0 + bx0, y0: y0 + by0, x1: x0 + bx1 + 1, y1: y0 + by1 + 1, found: true };
}

/**
 * PURE: the plan in FULL-SIZE pixels. `a` = analysis { px, w, h }, `W,H` = full size.
 * → { inner:{left,top,width,height}, crop:{left,top,width,height}, pad:{top,bottom,left,right}, fill:{mode,colour}, box, frame }
 */
function plan(a, W, H, { fill = FILL } = {}) {
  const { px, w, h } = a;
  const frame = whiteFrame(px, w, h);
  // Two analysis pixels past a cut frame: its seam is blurred by resampling
  // and JPEG, and would otherwise read as "not background" all round.
  const seam = (n) => (n > 0 ? n + 2 : 0);
  const region = { x0: seam(frame.l), y0: seam(frame.t), x1: w - seam(frame.r), y1: h - seam(frame.b) };
  if (region.x1 - region.x0 < 8 || region.y1 - region.y0 < 8) Object.assign(region, { x0: 0, y0: 0, x1: w, y1: h });
  const { bg, spread, uniform } = background(px, w, region);
  const box = productBox(px, w, region, bg, spread);
  const sx = W / w, sy = H / h;
  const inner = { left: Math.round(region.x0 * sx), top: Math.round(region.y0 * sy) };
  inner.width = Math.max(1, Math.round(region.x1 * sx) - inner.left);
  inner.height = Math.max(1, Math.round(region.y1 * sy) - inner.top);
  // Box in full-size pixels, relative to the inner image.
  const bx0 = box.x0 * sx - inner.left, bx1 = box.x1 * sx - inner.left;
  const by0 = box.y0 * sy - inner.top, by1 = box.y1 * sy - inner.top;
  // A scene (not a flat backdrop) is CUT, never extended, whenever the
  // product fits the photo's short side: a mirrored scene shows seams. The
  // square is as close to the 80% fill as the photo allows. Only a product
  // wider than the short side is extended (mirrored).
  const longest = Math.max(bx1 - bx0, by1 - by0);
  const short = Math.min(inner.width, inner.height);
  // "The product" covering (nearly) the whole photo means it could not be told
  // from a busy backdrop: then the square is simply the photo's short side.
  const blind = !box.found || ((bx1 - bx0) >= inner.width * 0.9 && (by1 - by0) >= inner.height * 0.9);
  const lost = !uniform && (blind || longest <= short);
  const side = lost
    ? (blind ? short : Math.max(Math.round(longest), Math.min(short, Math.round(longest / fill))))
    : Math.round(longest / fill);
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  let wx0 = Math.round(cx - side / 2), wy0 = Math.round(cy - side / 2);
  if (lost) {   // cut, never extend: clamp the window inside the photo
    wx0 = Math.min(Math.max(0, wx0), inner.width - side);
    wy0 = Math.min(Math.max(0, wy0), inner.height - side);
  }
  const wx1 = wx0 + side, wy1 = wy0 + side;
  const crop = { left: Math.max(0, wx0), top: Math.max(0, wy0) };
  crop.width = Math.min(inner.width, wx1) - crop.left;
  crop.height = Math.min(inner.height, wy1) - crop.top;
  const pad = { left: Math.max(0, -wx0), top: Math.max(0, -wy0), right: Math.max(0, wx1 - inner.width), bottom: Math.max(0, wy1 - inner.height) };
  return {
    frame, inner, crop, pad, side, found: box.found, cut: lost,
    fill: uniform ? { mode: "colour", colour: { r: bg[0], g: bg[1], b: bg[2] } } : { mode: "mirror" },
  };
}

/**
 * sharp → { buffer (1080² JPEG), info }. `sharp` is passed in (the trigger and
 * the scripts each resolve their own copy).
 */
async function makeMetaReady(sharp, input, { size = SIZE, fill = FILL } = {}) {
  const base = sharp(input, { failOn: "none" }).rotate().flatten({ background: "#ffffff" });
  const { data: full, info: fi } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const W = fi.width, H = fi.height;
  const { data: small, info: si } = await sharp(full, { raw: { width: W, height: H, channels: fi.channels } })
    .removeAlpha().resize({ width: ANALYSE, height: ANALYSE, fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const p = plan({ px: small, w: si.width, h: si.height }, W, H, { fill });
  // Inner (frame cut) → crop (window ∩ inner) → extend (window beyond inner).
  let img = sharp(full, { raw: { width: W, height: H, channels: fi.channels } }).removeAlpha().extract(p.inner);
  img = sharp(await img.raw().toBuffer(), { raw: { width: p.inner.width, height: p.inner.height, channels: 3 } }).extract(p.crop);
  // sharp's mirror extension can reach at most one image-width; repeat until done.
  let cur = { buf: await img.raw().toBuffer(), w: p.crop.width, h: p.crop.height };
  let pad = { ...p.pad };
  while (pad.left || pad.right || pad.top || pad.bottom) {
    const step = {
      left: Math.min(pad.left, cur.w - 1), right: Math.min(pad.right, cur.w - 1),
      top: Math.min(pad.top, cur.h - 1), bottom: Math.min(pad.bottom, cur.h - 1),
    };
    const ext = p.fill.mode === "colour"
      ? { ...pad, background: p.fill.colour }
      : { ...step, extendWith: "mirror" };
    const out = await sharp(cur.buf, { raw: { width: cur.w, height: cur.h, channels: 3 } }).extend(ext).raw().toBuffer({ resolveWithObject: true });
    const used = p.fill.mode === "colour" ? pad : step;
    pad = { left: pad.left - used.left, right: pad.right - used.right, top: pad.top - used.top, bottom: pad.bottom - used.bottom };
    cur = { buf: out.data, w: out.info.width, h: out.info.height };
  }
  const buffer = await sharp(cur.buf, { raw: { width: cur.w, height: cur.h, channels: 3 } })
    .resize(size, size, { fit: "fill" }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { buffer, info: { width: size, height: size, fill: p.cut ? "cut" : p.fill.mode, frameCut: p.frame, productFound: p.found, sourceWidth: W, sourceHeight: H } };
}

module.exports = { SIZE, FILL, isNearWhite, whiteFrame, background, productBox, plan, makeMetaReady };
