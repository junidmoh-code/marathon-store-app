// ── PLACING THE CUT-OUT ON JUNID'S PLATE (the split method) ─────────────────
// The mini's placement code, unchanged (marathon-group-poster f7d4bba,
// src/split.mjs): which piece is the shoe and which its packaging, where each
// goes on the plate at the measured layout, the soft shadows, the composite.
// Pure geometry plus sharp — no model call.
import sharp from "sharp";
import { solidBox } from "./cutout.mjs";

const r3 = (x) => Math.round(x * 1000) / 1000;

// ── PACKAGING (Junid, 4 Oct) ────────────────────────────────────────────────
// The shoe's own branded box or bag is a second solid piece in Gemini's photo.
// Packaging is the more RECTANGULAR piece (its solid area fills its outline):
// a box ≈ 1, a paper bag with handles less, a shoe or slide much less. A PAIR
// of shoes/slides are two pieces of about the same fill — never packaging.
export const PACKAGING_MIN_FILL = 0.72;   // a shoe box ≥ 0.95; a paper bag with handles ≈ 0.75–0.85; a side-on shoe/slide ≈ 0.6–0.7
export const PACKAGING_MIN_LEAD = 0.06;   // and clearly more rectangular than the other piece (a pair is about equal)

/**
 * Footwear cut-out pieces → { shoe, packaging }. Pure.
 * One piece: the shoe alone (nothing invented). Two pieces: the more
 * rectangular one is packaging only when it is packaging-like (fill ≥
 * PACKAGING_MIN_FILL and ≥ PACKAGING_MIN_LEAD above the other); otherwise both
 * are the product (a pair) and stay together as the shoe — a shoe never goes
 * in the box slot.
 */
export function classifyFootwear(pieces) {
  if (!pieces?.length) return { shoe: null, packaging: null, pair: false };
  if (pieces.length < 2) return { shoe: pieces[0], packaging: null, pair: false };
  const [a, b] = pieces.slice(0, 2).sort((p, q) => q.fill - p.fill);
  if (a.fill >= PACKAGING_MIN_FILL && a.fill - b.fill >= PACKAGING_MIN_LEAD) return { shoe: b, packaging: a, pair: false };
  return { shoe: unionPieces([a, b]), packaging: null, pair: true };
}

// ── PLACEMENT (pixels of the plate canvas; uniform scale only) ──────────────
/**
 * Packaging STAGED BEHIND the shoe (Junid, 4 Oct: "beside or behind it as part
 * of the composition"): at the SAME scale as the shoe (both come from one
 * Gemini photo, so their real relative size is kept), standing on the plinth a
 * little further back (its base slightly above the sole line), its centre
 * toward the heel end so the shoe partly covers it. Never larger than
 * `maxH` of the canvas (scaled down uniformly). Pure.
 */
export function placeBehind(size, shoeRect, shoeScale, canvas, { lift = 0.025, centreAt = 0.32, maxH = 0.5 } = {}) {
  let scale = shoeScale;
  if (size.height * scale > maxH * canvas.height) scale = (maxH * canvas.height) / size.height;
  const width = size.width * scale, height = size.height * scale;
  const bottom = shoeRect.top + shoeRect.height - lift * canvas.height;
  let left = shoeRect.left + centreAt * shoeRect.width - width / 2;
  left = Math.max(0, Math.min(canvas.width - width, left));
  return { left, top: bottom - height, width, height, scale };
}

/** Shoe: its length heel→toe = the spec's, heel at heelX, sole on soleY. Pure. */
export function placeShoe(size, spec, canvas) {
  const W = canvas.width, H = canvas.height, s = spec.shoe;
  const width = (s.toeX - s.heelX) * W;
  const scale = width / size.width;
  const height = size.height * scale;
  return { left: s.heelX * W, top: s.soleY * H - height, width, height, scale };
}

/** Fit inside a box (fractions): the binding dimension fills it, centred across; top- or centre-aligned. Pure. */
export function placeInBox(size, box, canvas, { align = "top" } = {}) {
  const W = canvas.width, H = canvas.height;
  const bw = (box.right - box.left) * W, bh = (box.bottom - box.top) * H;
  const scale = Math.min(bw / size.width, bh / size.height);
  const width = size.width * scale, height = size.height * scale;
  const left = ((box.left + box.right) / 2) * W - width / 2;
  const top = align === "top" ? box.top * H : box.top * H + (bh - height) / 2;
  return { left, top, width, height, scale };
}

/** Two pieces side by side in the spec's item boxes, ONE common scale (true relative size). Pure. */
export function placeTwoPiece(sizes, items, canvas) {
  const W = canvas.width, H = canvas.height;
  const scale = Math.min(...sizes.map((sz, i) => Math.min(((items[i].right - items[i].left) * W) / sz.width, ((items[i].bottom - items[i].top) * H) / sz.height)));
  return sizes.map((sz, i) => {
    const width = sz.width * scale, height = sz.height * scale;
    return { left: items[i].centreX * W - width / 2, top: items[i].top * H, width, height, scale };
  });
}

const frac = (p, canvas) => ({ left: r3(p.left / canvas.width), top: r3(p.top / canvas.height), right: r3((p.left + p.width) / canvas.width), bottom: r3((p.top + p.height) / canvas.height), scale: r3(p.scale) });
const intRect = (p) => ({ left: Math.round(p.left), top: Math.round(p.top), width: Math.max(1, Math.round(p.width)), height: Math.max(1, Math.round(p.height)) });

/** Placed vs spec, edge by edge (as judge() records them). Pure. */
export function placementDeviations(kind, placed, spec) {
  const d = (edge, want, got) => ({ edge, spec: r3(want), got: r3(got), off: r3(got - want) });
  if (kind === "footwear") {
    const s = placed.shoe;
    const out = [d("shoe.heelX", spec.shoe.heelX, s.left), d("shoe.toeX", spec.shoe.toeX, s.right), d("shoe.soleY", spec.shoe.soleY, s.bottom)];
    if (placed.box && spec.box) out.push(d("box.centreX", (spec.box.left + spec.box.right) / 2, (placed.box.left + placed.box.right) / 2));
    return out;
  }
  const g = placed.garment || unionRect(placed.pieces);
  const b = spec.box;
  return [d("garment.top", b.top, g.top), d("garment.centreX", (b.left + b.right) / 2, (g.left + g.right) / 2),
    { edge: "garment.fit", spec: 1, got: r3(Math.max((g.right - g.left) / (b.right - b.left), (g.bottom - g.top) / (b.bottom - b.top))), off: 0 }];
}
const unionRect = (rs) => rs.reduce((u, b) => ({ left: Math.min(u.left, b.left), top: Math.min(u.top, b.top), right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }));

// ── SHADOWS (an alpha layer of black, blurred) ──────────────────────────────
// A one-channel blur (sharp hands a single raw channel back as RGB unless told).
const blur1 = (buf, W, H, sigma) => sharp(buf, { raw: { width: W, height: H, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
async function blackWithAlpha(alpha, W, H, sigma) {
  const a = sigma > 0.3 ? await blur1(alpha, W, H, sigma) : alpha;
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = a[i];
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/** Drop shadow: the product's own silhouette, offset down-right, blurred, faint (hanging on the fence / box on the rail). */
export async function dropShadow(piecePngScaled, rect, canvas, { dx = 0.006, dy = 0.01, sigma = 0.01, opacity = 0.32 } = {}) {
  const W = canvas.width, H = canvas.height;
  const { data, info } = await sharp(piecePngScaled).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(W * H);
  const ox = rect.left + Math.round(dx * W), oy = rect.top + Math.round(dy * H);
  for (let y = 0; y < info.height; y++) {
    const ty = oy + y; if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < info.width; x++) {
      const tx = ox + x; if (tx < 0 || tx >= W) continue;
      alpha[ty * W + tx] = Math.round(data[y * info.width + x] * opacity);
    }
  }
  return blackWithAlpha(alpha, W, H, Math.max(1, sigma * W));
}

/** Contact shadow on the pedestal: a soft ellipse under the sole plus a tight dark line where it touches. */
export async function contactShadow(rect, canvas) {
  const W = canvas.width, H = canvas.height;
  const alpha = Buffer.alloc(W * H);
  const cx = rect.left + rect.width / 2, sole = rect.top + rect.height;
  const ellipse = (rx, ry, cy, op) => {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) alpha[y * W + x] = Math.max(alpha[y * W + x], Math.round(255 * op));
      }
    }
  };
  ellipse(rect.width * 0.5, Math.max(3, 0.012 * H), sole - 0.002 * H, 0.42);
  const soft = await blur1(alpha, W, H, Math.max(1, 0.008 * W));
  const tight = Buffer.alloc(W * H);
  const cy = sole - 0.0015 * H, rx = rect.width * 0.44, ry = Math.max(1.5, 0.0035 * H);
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) tight[y * W + x] = Math.round(255 * 0.6);
    }
  }
  const t = await blur1(tight, W, H, Math.max(0.5, 0.0025 * W));
  for (let i = 0; i < W * H; i++) soft[i] = Math.min(255, soft[i] + t[i] - Math.round((soft[i] * t[i]) / 255));
  return blackWithAlpha(soft, W, H, 0);
}

// ── COMPOSE ON THE PLATE ────────────────────────────────────────────────────
const scaled = (png, r) => sharp(png).resize(r.width, r.height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
const sizeOf = async (png) => { const m = await sharp(png).metadata(); return { width: m.width, height: m.height }; };

/**
 * Place the cut-out product on the plate at the spec position, with shadows.
 *   parts: footwear { shoe: png, box?: png } · single { garment: png } · twopiece { pieces: [png, png] } or { garment: png }
 * → { buffer (JPEG at the plate's own resolution), placed (fractions), deviations, productBox, boxBox }
 */
export async function composeOnPlate({ kind, plate, spec, parts, packagingAt = "behind" }) {
  const pm = await sharp(plate.buffer).metadata();
  const canvas = { width: pm.width, height: pm.height };
  const layers = [], shadows = [], placed = {};
  if (kind === "footwear") {
    const sp = intRect(placeShoe(await sizeOf(parts.shoe), spec, canvas));
    placed.shoe = frac({ ...sp, scale: sp.width / (await sizeOf(parts.shoe)).width }, canvas);
    if (parts.box && packagingAt === "behind") {
      // The box / bag standing in the shoe photo: staged behind the shoe on the plinth (drawn first, so the shoe is in front).
      const pp = intRect(placeBehind(await sizeOf(parts.box), sp, sp.width / (await sizeOf(parts.shoe)).width, canvas));
      const ps = await scaled(parts.box, pp);
      shadows.push(await contactShadow(pp, canvas));
      layers.push({ input: ps, left: pp.left, top: pp.top });
      placed.packaging = frac({ ...pp, scale: pp.width / (await sizeOf(parts.box)).width }, canvas);
    } else if (parts.box && spec.box) {
      // Its OWN separate box photo: the reference layout (Junid, 2 Oct) — on the middle rail.
      const bp = intRect(placeInBox(await sizeOf(parts.box), spec.box, canvas, { align: "centre" }));
      const bs = await scaled(parts.box, bp);
      shadows.push(await dropShadow(bs, bp, canvas));
      layers.push({ input: bs, left: bp.left, top: bp.top });
      placed.box = frac({ ...bp, scale: bp.width / (await sizeOf(parts.box)).width }, canvas);
    }
    shadows.push(await contactShadow(sp, canvas));
    layers.push({ input: await scaled(parts.shoe, sp), left: sp.left, top: sp.top });
  } else if (kind === "twopiece" && parts.pieces?.length === 2 && spec.items?.length === 2) {
    const sizes = await Promise.all(parts.pieces.map(sizeOf));
    const rects = placeTwoPiece(sizes, spec.items, canvas).map(intRect);
    placed.pieces = [];
    for (let i = 0; i < 2; i++) {
      const s = await scaled(parts.pieces[i], rects[i]);
      shadows.push(await dropShadow(s, rects[i], canvas, { dx: 0.008, dy: 0.012, sigma: 0.012, opacity: 0.3 }));
      layers.push({ input: s, left: rects[i].left, top: rects[i].top });
      placed.pieces.push(frac({ ...rects[i], scale: rects[i].width / sizes[i].width }, canvas));
    }
  } else {
    const png = parts.garment;
    const gp = intRect(placeInBox(await sizeOf(png), spec.box, canvas, { align: "top" }));
    const s = await scaled(png, gp);
    shadows.push(await dropShadow(s, gp, canvas, { dx: 0.008, dy: 0.012, sigma: 0.012, opacity: 0.3 }));
    layers.push({ input: s, left: gp.left, top: gp.top });
    placed.garment = frac({ ...gp, scale: gp.width / (await sizeOf(png)).width }, canvas);
  }
  const buffer = await sharp(plate.buffer).removeAlpha()
    .composite([...shadows.map((input) => ({ input, left: 0, top: 0 })), ...layers])
    .jpeg({ quality: 93 }).toBuffer();
  const productBox = placed.shoe || placed.garment || (placed.pieces && unionRect(placed.pieces));
  return { buffer, canvas, placed, deviations: placementDeviations(kind, placed, spec), productBox, boxBox: placed.box || placed.packaging || null };
}


export function mirrorPiece(p) {
  const data = Buffer.alloc(p.data.length);
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const a = (y * p.width + x) * 4, b = (y * p.width + (p.width - 1 - x)) * 4;
    data[b] = p.data[a]; data[b + 1] = p.data[a + 1]; data[b + 2] = p.data[a + 2]; data[b + 3] = p.data[a + 3];
  }
  return { ...p, data };
}

export function unionPieces(ps) {
  const left = Math.min(...ps.map((p) => p.left)), top = Math.min(...ps.map((p) => p.top));
  const right = Math.max(...ps.map((p) => p.left + p.width)), bottom = Math.max(...ps.map((p) => p.top + p.height));
  const width = right - left, height = bottom - top, data = Buffer.alloc(width * height * 4);
  for (const p of ps) for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const s = (y * p.width + x) * 4; if (!p.data[s + 3]) continue;
    const d = ((p.top - top + y) * width + (p.left - left + x)) * 4;
    p.data.copy(data, d, s, s + 4);
  }
  return { data, width, height, left, top, fill: 0 };
}

/** A piece cropped to its SOLID outline (the soft edge stays): what the spec's edges are measured against. */
export async function trimPng(p) {
  const b = solidBox(p);
  const png = await sharp(p.data, { raw: { width: p.width, height: p.height, channels: 4 } }).png().toBuffer();
  if (!b) return png;
  return sharp(png).extract({ left: b.left, top: b.top, width: b.width, height: b.height }).png().toBuffer();
}
