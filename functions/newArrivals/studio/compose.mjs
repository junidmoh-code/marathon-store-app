// ── THE PHOTO STUDIO'S PURE HELPERS ─────────────────────────────────────────
// Copied UNCHANGED from marathon-group-poster (f7d4bba), the Mac mini pipeline
// that made the signed-off baseline photos: the category → plate class, the
// brand → box key, the placement sentence, the layout diagram, the request's
// image preparation and the packaging layer. They decide what Gemini is sent,
// so they stay as they were; functions/test/studio-baseline.test.mjs pins the
// prompt they build. New rules go in prompt.mjs (layers), never here.
import sharp from "sharp";
import crypto from "node:crypto";

// ── plates.mjs ──────────────────────────────────────────────────────────────
export const FOOTWEAR_KEYS = Object.freeze(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes", "sandals"]);
// Sets by nature — two pieces hung side by side, fence zoomed out.
export const TWOPIECE_KEYS = Object.freeze(["tracksuits"]);
// One garment, sneaker-zoom fence.
export const SINGLE_KEYS = Object.freeze(["t-shirts", "golf-t-shirts", "hoodies", "sweaters", "jackets", "pants", "jeans", "shorts",
  "cargo-pants", "basketball-vests", "baseball-shirts", "soccer-jerseys", "dresses", "underwear"]);
export const APPAREL_KEYS = Object.freeze([...SINGLE_KEYS, ...TWOPIECE_KEYS]);
export const UNKNOWN_FRAMING = "unknown framing";

export const ROLES = Object.freeze({
  footwear: { plate: "footwear-plate.png", reference: "footwear-reference.png", layoutBox: "footwear-layout-box.png" },
  single: { plate: "fence-single.png", reference: null },
  twopiece: { plate: "fence-twopiece.png", reference: "twopiece-reference.png" },
});
export const KINDS = Object.freeze(Object.keys(ROLES));
export const isApparel = (kind) => kind === "single" || kind === "twopiece";

/**
 * The framing class from the app's category — "footwear" | "single" | "twopiece"
 * — or null when the category has no plate. `pieces` (from the source photo),
 * when known, must agree with the category; a disagreement is ambiguous and
 * returns UNKNOWN_FRAMING rather than a guess. Pure.
 */
export function kindFor(product, { pieces = null } = {}) {
  const key = String(product?.categoryKey || "").trim();
  let kind = null;
  if (key) kind = FOOTWEAR_KEYS.includes(key) ? "footwear" : TWOPIECE_KEYS.includes(key) ? "twopiece" : SINGLE_KEYS.includes(key) ? "single" : null;
  else if (String(product?.category || "").trim() === "Footwear") kind = "footwear";
  else if (String(product?.category || "").trim() === "Clothing") return UNKNOWN_FRAMING; // no key: set or single cannot be told
  if (!kind || pieces === null || pieces === undefined || kind === "footwear") return kind;
  const n = Number(pieces);
  if (kind === "single" && n === 1) return kind;
  if (kind === "twopiece" && n === 2) return kind;
  return UNKNOWN_FRAMING;
}


// ── boxes.mjs ───────────────────────────────────────────────────────────────
// Canonical brand keys, and the spellings the app's brand field actually holds.
// Only spellings that name ONE brand for certain. Fragments of a name that
// could be several brands ("Christian" — Louboutin or Dior? "Alexander",
// "Karl", "Dolce", "On") are deliberately absent: those shoes get no box.
const ALIASES = {
  "nike": "nike", "adidas": "adidas", "dolce & gabbana": "dolce-gabbana", "d&g": "dolce-gabbana",
  "gucci": "gucci", "louis vuitton": "louis-vuitton", "lacoste": "lacoste", "lacoster": "lacoste",
  "diesel": "diesel", "boss": "boss", "hugo boss": "boss", "karl lagerfeld": "karl-lagerfeld",
  "on running": "on", "jordan": "jordan", "air jordan": "jordan", "alexander mcqueen": "alexander-mcqueen",
  "mcqueen": "alexander-mcqueen", "under armour": "under-armour", "replay": "replay", "dior": "dior", "christian dior": "dior",
  "givenchy": "givenchy", "christian louboutin": "christian-louboutin", "louboutin": "christian-louboutin",
  "timberland": "timberland", "dsquared2": "dsquared2", "puma": "puma",
  "valentino": "valentino", "valentino garavani": "valentino", "amiri": "amiri", "supreme": "supreme", "giuseppe zanotti": "giuseppe-zanotti", "zanotti": "giuseppe-zanotti",
  "havaianas": "havaianas", "havanas": "havaianas", "new balance": "new-balance", "asics": "asics", "reebok": "reebok",
  "vans": "vans", "converse": "converse", "balenciaga": "balenciaga", "prada": "prada", "versace": "versace", "fila": "fila",
};

/** The canonical brand key, or null when the brand cannot be named for certain. Pure. */
export function brandKey(brand) {
  const b = String(brand || "").trim().toLowerCase().replace(/\s+/g, " ");
  return ALIASES[b] || null;
}


// ── layout.mjs ──────────────────────────────────────────────────────────────
/** Placement instructions for the generator, in plain percentages. Pure. */
export function placementText(kind, spec) {
  const pc = (x) => `${Math.round(x * 1000) / 10}%`;
  if (kind === "footwear" && spec.shoe) {
    const lines = [
      `PLACEMENT (fractions of the canvas, measured from the reference; x from the left, y from the top):`,
      `the shoe's heel at x=${pc(spec.shoe.heelX)}, its toe tip at x=${pc(spec.shoe.toeX)} (shoe ${pc(spec.shoe.width)} of the frame width), its sole resting on the pedestal top at y=${pc(spec.shoe.soleY)};`,
      `scale the shoe UNIFORMLY to that width — never stretch it; its height follows its own proportions.`,
    ];
    if (spec.box) lines.push(`the box centred at x=${pc(spec.box.centreX)}${spec.box.centreMinusRailX !== undefined ? " on the middle rail" : ""}, its bottom edge at y=${pc(spec.box.bottom)}, front panel square to the camera, scaled uniformly.`);
    return lines.join(" ");
  }
  if (kind !== "footwear" && spec.garment) {
    return [
      `PLACEMENT (fractions of the canvas, measured from the reference): the garment hangs from the fence on a hanger,`,
      `the ${kind === "twopiece" ? "set (both pieces together)" : "garment"} centred at x=${pc(spec.garment.centreX)}, scaled uniformly to FIT the framing box`,
      `x ${pc(spec.garment.left)}–${pc(spec.garment.right)}, y ${pc(spec.garment.topY)}–${pc(spec.garment.hemY)} (the box in the LAYOUT DIAGRAM; the garment's own top — the hanger hook sits above it): as large as possible,`,
      `touching the box's sides or its bottom, never outside it; front facing, full length, hanging straight;`,
      kind === "twopiece" ? "the two pieces side by side exactly as in the REFERENCE;" : "",
      `scale uniformly — never stretch.`,
    ].join(" ");
  }
  return "";
}

/** The LAYOUT DIAGRAM for the generator: a neutral grey canvas of the plate's
 *  size with the target box(es) outlined in black. Deliberately NOT drawn over
 *  the plate — a coloured overlay bled into the generated fence (2 Oct). */
export async function layoutGuideImage(kind, spec, plateBuf, genFrame = null) {
  const meta = await sharp(plateBuf).metadata();
  // Drawn in the GENERATION frame (the supported aspect the model is asked for),
  // so the boxes land where they will be after the cover-crop to the plate.
  const W = meta.width, H = genFrame ? Math.round(meta.width / genFrame.aspect) : meta.height, sw = Math.max(4, W / 180);
  const map = (b) => (genFrame ? toGenFrame(b, genFrame) : b);
  // Boxes only — no words a model might copy into the photo.
  const r = (b) => `<rect x="${b.left * W}" y="${b.top * H}" width="${(b.right - b.left) * W}" height="${(b.bottom - b.top) * H}" fill="none" stroke="#000" stroke-width="${sw}" stroke-dasharray="${sw * 4} ${sw * 2}"/>`;
  let s = "";
  if (kind === "footwear") {
    if (spec.shoe) s += r(map({ left: spec.shoe.heelX, right: spec.shoe.toeX, top: spec.shoe.topY, bottom: spec.shoe.soleY }));
    if (spec.box) s += r(map(spec.box));
  } else if (spec.garment) {
    s += r(map({ left: spec.garment.left, right: spec.garment.right, top: spec.garment.topY, bottom: spec.garment.hemY }));
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: "#d8d8d8" } })
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`) }]).jpeg({ quality: 88 }).toBuffer();
}

/**
 * Plate-frame fractions → generation-frame fractions. The model is asked for
 * the supported aspect nearest the plate; the result is cover-cropped (centred)
 * to the plate. A box at plate-y lands at gen-y = (y·Hp + offset)/Hg. Pure.
 */
export function genFrameOf(plateW, plateH, aspect) {
  const Hg = plateW / aspect;
  return { aspect, scaleY: plateH / Hg, offsetY: (Hg - plateH) / 2 / Hg };
}
export function toGenFrame(b, f) {
  const y = (v) => v * f.scaleY + f.offsetY;
  return { left: b.left, right: b.right, top: y(b.top), bottom: y(b.bottom) };
}

// ── generate.mjs ────────────────────────────────────────────────────────────
export const RATIOS = { "1:1": 1, "2:3": 2 / 3, "3:2": 1.5, "3:4": 0.75, "4:3": 4 / 3, "4:5": 0.8, "5:4": 1.25, "9:16": 9 / 16, "16:9": 16 / 9, "21:9": 21 / 9 };
/** The supported generation aspect closest to the plate's canvas. Pure. */

export function closestAspect(width, height) {
  const r = width / height;
  return Object.entries(RATIOS).sort((a, b) => Math.abs(Math.log(a[1] / r)) - Math.abs(Math.log(b[1] / r)))[0][0];
}

/** The plate's EXACT canvas: uniform scale to cover, centred — never a stretch. */
export const toCanvas = (buf, { width, height }) => sharp(buf).resize(width, height, { fit: "cover", position: "centre" }).jpeg({ quality: 93 }).toBuffer();

export const forModel = (buf, edge = 2048) => sharp(buf).rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();

/** One image sent to the model, for the learning log: role, where it came from, its exact bytes' sha256 and size. */
export async function inputOf(role, buf, { url = null, file = null } = {}) {
  const m = await sharp(buf).metadata();
  return { role, ...(url ? { url } : {}), ...(file ? { file } : {}), sha256: crypto.createHash("sha256").update(buf).digest("hex"), width: m.width, height: m.height, bytes: buf.length };
}

/**
 * LAYER packaging (Junid, 4 Oct): the shoe's own branded box or bag standing in
 * the SHOE PHOTO is part of the product shot — kept and staged with the shoe,
 * never stripped out; never invented when the photo has none. Footwear only.
 */
export const PACKAGING_LAYER = [
  "PACKAGING: if the SHOE PHOTO shows this product's own branded box or bag, it is part of the product shot.",
  "Keep that very same box or bag — its exact branding, colours and text, never redrawn or changed — and stage it",
  "beside or behind the shoe, on the pedestal or against the mesh fence, like a product photograph.",
  "It is NOT \"something else\" added to the scene and NOT among the things to remove below. When no separate BOX PHOTO is given, the BOX PHOTO sentence above",
  "does not apply and this packaging rule does; when it is the same box as the BOX PHOTO, show it once.",
  "If the SHOE PHOTO shows no box or bag, never add one.",
].join(" ");
