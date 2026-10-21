// ── estimateParcel(lines) — the parcel an order becomes ──────────────────────
// Pure. No staff typing: size and weight are computed from what the order
// contains, using the per-category numbers in /config/shipping. Staff only
// ever see the result.
//
//   estimateParcel(lines, config?) → {
//     boxCode, lengthCm, widthCm, heightCm,          the box TCG is told about
//     actualKg, volumetricKg, chargeableKg,          chargeable = max(actual, volumetric)
//     service, dropBoxEligible, lockerSize,          from the drop-box rule
//     fits, items, unmeasured,                       diagnostics for the card
//   }
//
// PACKING. Every unit is one item with packed dims (largest first). Footwear
// keeps its own shoebox footprint — a box is never squashed; soft goods are
// folded and stack by their thickness. Items are laid in 1–4 side-by-side
// columns, each column a stack (shortest column takes the next item); for
// every layout, the smallest standard box whose dims fit the block (in any
// orientation) is a candidate, and the smallest candidate wins.
//
// THE DROP-BOX RULE. The parcel goes in a TCG locker when it fits a
// configured locker's size AND is at or under its weight threshold — the
// smallest such locker names the service. Above every threshold: door
// collection, `doorServiceCode`.
import { DEFAULT_SHIPPING_CONFIG, mergeShippingConfig } from "./shippingConfig.js";

const round2 = (n) => Math.round(n * 100) / 100;
const sortDesc = (dims) => [...dims].sort((a, b) => b - a);
const volume = (d) => d[0] * d[1] * d[2];
const fitsIn = (inner, outer) => {
  const a = sortDesc(inner), b = sortDesc(outer);
  return a[0] <= b[0] && a[1] <= b[1] && a[2] <= b[2];
};

// ── classification ───────────────────────────────────────────────────────────
// Category/subcategory are the app's own tree (src/utils/productCategory.js).
// A line may carry `kind` explicitly; otherwise this decides.
const KIDS_RE = /\b(kids?|junior|jnr|youth|infants?|toddlers?|baby|gs|ps|td|grade school|pre-?school)\b/i;
const SLIDES_RE = /\b(slides?|sandals?|flip ?flops?|slippers?|crocs?|clogs?)\b/i;
const SET_RE = /\b(tracksuit|track ?suit|set|2 ?piece|two ?piece)\b/i;
const BOTTOM_RE = /\b(pants?|jeans?|denim|cargos?|shorts?|trousers?|joggers?|track ?pants?|leggings?|skirt)\b/i;
const CAP_RE = /\b(caps?|hats?|beanies?|bucket|snapback|trucker)\b/i;
const BAG_RE = /\b(bags?|backpacks?|duffel|sling|pouch|tote|wallet)\b/i;

/** The size as a number, for banding. "5_5" (RTDB-encoded) → 5.5. NaN if not numeric. */
export function shoeSizeNumber(size) {
  const s = String(size ?? "").trim().replace(/^(uk|us|eu)\s*/i, "").replace("_", ".");
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** EU adult sizes (36–50) → UK, so one band table serves both. */
export function toUkAdultSize(n) {
  return n >= 36 && n <= 50 ? round2(n - 33.5) : n;
}

export function isKidsShoe(line) {
  if (line?.kids === true) return true;
  const text = `${line?.name ?? ""} ${line?.title ?? ""} ${line?.subcategory ?? ""}`;
  if (KIDS_RE.test(text)) return true;
  // EU kids sizes (16–35) are the only numbers in that range a shoe uses
  // (src/utils/footwearLine.js: "Kids shoes are 26–33").
  const n = shoeSizeNumber(line?.size);
  return n >= 16 && n <= 35;
}

export function classifyLine(line) {
  if (line?.kind) return line.kind;
  const category = String(line?.category ?? "").trim();
  const sub = String(line?.subcategory ?? "").trim();
  const text = `${line?.name ?? ""} ${line?.title ?? ""}`;
  if (category === "Perfume") return "perfume";
  if (category === "Footwear") {
    if (sub === "Sandals & Slides" || SLIDES_RE.test(text)) return "slides";
    return isKidsShoe(line) ? "sneakerKids" : "sneakerAdult";
  }
  if (category === "Accessories") return sub === "Bags" || BAG_RE.test(text) ? "bag" : "accessory";
  if (category === "Clothing") {
    if (sub === "Caps & Hats") return "cap";
    if (sub === "Tracksuits & Sets") return "tracksuitSet";
    if (["Jeans & Denim", "Cargos & Pants", "Shorts & Vests"].includes(sub)) return "foldedBottoms";
    if (sub && sub !== "Clothing — Uncategorized") return "foldedTop";
    if (CAP_RE.test(text)) return "cap";
    if (SET_RE.test(text)) return "tracksuitSet";
    if (BOTTOM_RE.test(text)) return "foldedBottoms";
    return "foldedTop";
  }
  // No usable category: name keywords, then the folded-top fallback (the
  // card lists it under "guessed" so it is visible, never silent).
  if (SLIDES_RE.test(text)) return "slides";
  if (CAP_RE.test(text)) return "cap";
  if (BAG_RE.test(text)) return "bag";
  return null;
}

/** kg for one unit of `kind`, stepped by size band where the kind has bands. */
export function itemWeightKg(spec, line) {
  if (!Array.isArray(spec.bands)) return Number(spec.kg) || 0;
  const n = toUkAdultSize(shoeSizeNumber(line?.size));
  const bands = [...spec.bands].sort((a, b) => a.upToSize - b.upToSize);
  if (!Number.isFinite(n)) return Number(bands[Math.floor((bands.length - 1) / 2)]?.kg) || 0; // no size → middle band
  return Number((bands.find((b) => n <= b.upToSize) ?? bands[bands.length - 1]).kg) || 0;
}

/** One packed item per unit. Unclassifiable lines pack as a folded top and are reported. */
export function expandLines(lines, config) {
  const items = [];
  const guessed = [];
  for (const line of lines ?? []) {
    const qty = Math.max(0, Math.floor(Number(line?.qty ?? line?.quantity ?? 1)));
    let kind = classifyLine(line);
    if (!kind || !config.items[kind]) {
      guessed.push(line?.name ?? line?.title ?? line?.productId ?? "?");
      kind = "foldedTop";
    }
    const spec = config.items[kind];
    const dims = sortDesc([spec.lengthCm, spec.widthCm, spec.heightCm].map(Number));
    const kg = itemWeightKg(spec, line);
    for (let i = 0; i < qty; i++) items.push({ kind, l: dims[0], w: dims[1], h: dims[2], kg });
  }
  // Largest first: volume, then footprint (a shoebox before a folded tee
  // even though the tee's footprint is wider).
  items.sort((a, b) => b.l * b.w * b.h - a.l * a.w * a.h || b.l * b.w - a.l * a.w);
  return { items, guessed };
}

/** The block `items` form in `k` side-by-side stacked columns. */
export function layoutBlock(items, k) {
  const cols = Array.from({ length: k }, () => ({ l: 0, w: 0, h: 0 }));
  for (const it of items) {
    const c = cols.reduce((m, x) => (x.h < m.h ? x : m), cols[0]);
    c.l = Math.max(c.l, it.l);
    c.w = Math.max(c.w, it.w);
    c.h += it.h;
  }
  const used = cols.filter((c) => c.h > 0);
  return [Math.max(...used.map((c) => c.l)), used.reduce((s, c) => s + c.w, 0), Math.max(...used.map((c) => c.h))];
}

export function chooseBox(items, boxes) {
  const sorted = [...boxes].sort((a, b) =>
    volume([a.lengthCm, a.widthCm, a.heightCm]) - volume([b.lengthCm, b.widthCm, b.heightCm]));
  let best = null;
  for (let k = 1; k <= Math.min(items.length, 4); k++) {
    const block = layoutBlock(items, k);
    const box = sorted.find((b) => fitsIn(block, [b.lengthCm, b.widthCm, b.heightCm]));
    if (!box) continue;
    const v = volume([box.lengthCm, box.widthCm, box.heightCm]);
    if (!best || v < best.v) best = { box, block, v };
  }
  return best;
}

/** The smallest configured locker this parcel fits, or null. */
export function chooseLocker(dims, actualKg, dropBox) {
  if (!dropBox?.enabled) return null;
  const lockers = [...(dropBox.lockers ?? [])].sort((a, b) =>
    volume([a.lengthCm, a.widthCm, a.heightCm]) - volume([b.lengthCm, b.widthCm, b.heightCm]));
  return lockers.find((lk) => fitsIn(dims, [lk.lengthCm, lk.widthCm, lk.heightCm]) && actualKg <= Number(lk.maxKg)) ?? null;
}

export function estimateParcel(lines, config = DEFAULT_SHIPPING_CONFIG) {
  const cfg = config === DEFAULT_SHIPPING_CONFIG ? config : mergeShippingConfig(config);
  const { items, guessed } = expandLines(lines, cfg);
  if (items.length === 0) throw new Error("estimateParcel: the order has no units to ship");

  const best = chooseBox(items, cfg.boxes ?? []);
  // Nothing fits: no standard box is big enough. Ship the single-stack block
  // as a custom parcel, rounded up, and say so (fits: false) — the card shows
  // it and Junid adds a box.
  const dims = best
    ? [best.box.lengthCm, best.box.widthCm, best.box.heightCm].map(Number)
    : layoutBlock(items, 1).map(Math.ceil);
  const [lengthCm, widthCm, heightCm] = sortDesc(dims);
  const tare = best ? Number(best.box.tareKg) || 0 : 0;
  const actualKg = round2(items.reduce((s, it) => s + it.kg, 0) + tare);
  const divisor = Number(cfg.volumetricDivisor) || 4000;
  const volumetricKg = round2((lengthCm * widthCm * heightCm) / divisor);
  const chargeableKg = Math.max(actualKg, volumetricKg);

  const locker = chooseLocker([lengthCm, widthCm, heightCm], actualKg, cfg.dropBox);
  const kinds = [...new Set(items.map((i) => i.kind))];
  const unmeasured = [
    ...kinds.filter((k) => cfg.items[k]?.measured !== true).map((k) => `item:${k}`),
    ...(best && best.box.measured !== true ? [`box:${best.box.code}`] : []),
    ...(locker && locker.measured !== true ? [`locker:${locker.size}`] : []),
  ];

  return {
    boxCode: best ? best.box.code : null,
    lengthCm, widthCm, heightCm,
    actualKg, volumetricKg, chargeableKg,
    service: locker ? locker.serviceCode : cfg.doorServiceCode,
    dropBoxEligible: !!locker,
    lockerSize: locker ? locker.size : null,
    fits: !!best,
    items: items.length,
    guessed,
    unmeasured,
  };
}
