// ── OBJECTIVE MEASUREMENTS (the learning log) — pixels only, no model call ──
// The mini's measure.mjs, unchanged (marathon-group-poster f7d4bba): how sharp,
// how noisy, how creased, how far the background is from the plate. Numbers
// for the weekly report to compare loved and rejected photos by — never a
// verdict, never a reason to hold a photo back.
import sharp from "sharp";

export const NORM = 512;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** A fractional box → a pixel window inside w×h (null if degenerate). Pure. */
export function pixelBox(b, w, h) {
  if (!b) return null;
  const left = Math.max(0, Math.floor(b.left * w)), top = Math.max(0, Math.floor(b.top * h));
  const right = Math.min(w, Math.ceil(b.right * w)), bottom = Math.min(h, Math.ceil(b.bottom * h));
  return right - left >= 8 && bottom - top >= 8 ? { left, top, width: right - left, height: bottom - top } : null;
}

/** Grey pixels of a region (whole image if no box), resized to fit NORM. → { data, width, height } */
async function greyRegion(buf, box = null, { blur = 0 } = {}) {
  const m = await sharp(buf).metadata();
  let img = sharp(buf);
  if (box) {
    const px = pixelBox(box, m.width, m.height);
    if (!px) return null;
    img = img.extract(px);
  }
  img = sharp(await img.toBuffer()).resize(NORM, NORM, { fit: "inside" });
  if (blur) img = img.blur(blur);
  const { data, info } = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
  // greyscale() can still hand back several channels when the input had alpha.
  const ch = info.channels;
  const g = ch === 1 ? data : Uint8Array.from({ length: info.width * info.height }, (_, i) => data[i * ch]);
  return { data: g, width: info.width, height: info.height };
}

/** Variance of the 3×3 Laplacian [0 1 0; 1 −4 1; 0 1 0] over the interior. Pure. */
export function laplacianVariance({ data, width, height }) {
  let n = 0, s = 0, s2 = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const l = data[i - width] + data[i + width] + data[i - 1] + data[i + 1] - 4 * data[i];
    n += 1; s += l; s2 += l * l;
  }
  return n ? s2 / n - (s / n) ** 2 : null;
}

/** Std of (pixel − its 3×3 mean) inside a window — the high-pass residue. Pure. */
export function highpassStd({ data, width }, { left, top, size }) {
  let n = 0, s = 0, s2 = 0;
  for (let y = top + 1; y < top + size - 1; y++) for (let x = left + 1; x < left + size - 1; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += data[(y + dy) * width + x + dx];
    const h = data[y * width + x] - m / 9;
    n += 1; s += h; s2 += h * h;
  }
  return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : null;
}

/** Fraction of interior pixels whose Sobel gradient exceeds `thr`. Pure. */
export function edgeDensity({ data, width, height }, thr = 24) {
  let n = 0, e = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const p = (dx, dy) => data[(y + dy) * width + x + dx];
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    n += 1; if (Math.hypot(gx, gy) > thr) e += 1;
  }
  return n ? e / n : null;
}

const inAny = (x, y, boxes) => boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
const grow = (b, m) => ({ left: b.left - m, top: b.top - m, right: b.right + m, bottom: b.bottom + m });

/** The flattest background patch (lowest pixel spread) clear of every product box. Pure. */
export function flattestPatch(g, exclude = [], size = 48) {
  let best = null;
  for (let top = 0; top + size <= g.height; top += size) for (let left = 0; left + size <= g.width; left += size) {
    const f = { left: left / g.width, top: top / g.height, right: (left + size) / g.width, bottom: (top + size) / g.height };
    if (exclude.some((b) => f.left < b.right && f.right > b.left && f.top < b.bottom && f.bottom > b.top)) continue;
    let s = 0, s2 = 0;
    for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) { const v = g.data[y * g.width + x]; s += v; s2 += v * v; }
    const n = size * size, spread = s2 / n - (s / n) ** 2;
    if (!best || spread < best.spread) best = { left, top, size, spread };
  }
  return best;
}

/** Mean |output − plate| outside the product, overall and per channel (0–255). */
export async function backgroundDiff(outBuf, plateBuf, exclude = []) {
  const m = await sharp(outBuf).metadata();
  const w = 256, h = Math.max(8, Math.round(256 * m.height / m.width));
  const rgb = (b) => sharp(b).resize(w, h, { fit: "fill" }).toColourspace("srgb").removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([rgb(outBuf), rgb(plateBuf)]);
  const ex = exclude.map((x) => grow(x, 0.02));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inAny((x + 0.5) / w, (y + 0.5) / h, ex)) continue;
    const i = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) sum[c] += Math.abs(a[i + c] - b[i + c]);
    n += 1;
  }
  if (!n) return null;
  const [r, g, bl] = sum.map((s) => r2(s / n));
  return { mad: r2((r + g + bl) / 3), perChannel: { r, g: g, b: bl }, coverage: r4(n / (w * h)) };
}

const inset = (b, f = 0.1) => b && { left: b.left + (b.right - b.left) * f, right: b.right - (b.right - b.left) * f, top: b.top + (b.bottom - b.top) * f, bottom: b.bottom - (b.bottom - b.top) * f };

/**
 * All four, for one finished photo. Each is independent: one that cannot be
 * computed (no product box, a decode error) is null with its reason — never a
 * reason to lose the photo.
 *   { kind, out, outBox, exclude: [boxes], plate (buffer), src (buffer), srcBox, checker }
 */
export async function objectiveMeasurements({ kind, out, outBox, exclude = [], plate = null, src = null, srcBox = null, checker = null }) {
  const res = { sharpness: null, noise: null, crease: null, background: null };
  const why = (e) => ({ unavailable: String(e?.message || e).slice(0, 100) });
  const skip = [outBox, ...exclude].filter(Boolean);
  try {
    const g = outBox ? await greyRegion(out, outBox) : null;
    res.sharpness = g ? { laplacianVar: r2(laplacianVariance(g)) } : { unavailable: "the product was not located" };
  } catch (e) { res.sharpness = why(e); }
  try {
    const g = await greyRegion(out);
    const p = flattestPatch(g, skip.map((b) => grow(b, 0.02)));
    res.noise = p ? { highpassStd: r2(highpassStd(g, p)), patch: { left: r4(p.left / g.width), top: r4(p.top / g.height), size: r4(p.size / g.width) } } : { unavailable: "no background patch clear of the product" };
  } catch (e) { res.noise = why(e); }
  if (kind !== "footwear") {
    try {
      const [o, s] = outBox && srcBox ? await Promise.all([greyRegion(out, inset(outBox), { blur: 2 }), greyRegion(src, inset(srcBox), { blur: 2 })]) : [null, null];
      const od = o && edgeDensity(o), sd = s && edgeDensity(s);
      res.crease = od != null && sd != null
        ? { delta: r4(od - sd), output: r4(od), source: r4(sd), stillCreased: checker?.stillCreased ?? null }
        : { unavailable: "the garment was not located in both photos", stillCreased: checker?.stillCreased ?? null };
    } catch (e) { res.crease = { ...why(e), stillCreased: checker?.stillCreased ?? null }; }
  }
  try { res.background = plate ? await backgroundDiff(out, plate, skip) : { unavailable: "no plate" }; }
  catch (e) { res.background = why(e); }
  return res;
}
