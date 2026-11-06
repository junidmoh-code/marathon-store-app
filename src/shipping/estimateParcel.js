// ── estimateParcel(lines) — the ONE parcel an order ships as ─────────────────
// Pure. No staff typing: size and weight are computed from what the order
// contains, using /config/shipping. Staff only ever see the result.
//
// THE PARCEL RULE (Junid, 2026-10-23 — correcting 21 Oct): an order ALWAYS
// ships as ONE parcel. Never split.
//   • 1 pair = one shoebox, cfg.shoebox (34 × 23 × 13 cm);
//   • more pairs = shoeboxes stacked and/or side by side: 2 pairs 34 × 23 × 26,
//     3 pairs 34 × 23 × 39, 4 pairs 2×2 → 34 × 46 × 26 — of every stack/column
//     arrangement the one with the SMALLEST LONGEST SIDE wins (ties → smaller
//     volume);
//   • a stack that leaves a slot empty (5 pairs in a 2 × 3 grid) is declared
//     at the volume of the boxes actually in it (34 × 46 × 32.5, not 39): the
//     packers close the gap, and TCG measures what they send
//     (TCG200369959T, 6 Nov 2026 — 34×46×39 declared, 16 kg, R355.68;
//     TCG measured it at 15 kg and re-rated it R249.60);
//   • soft goods (caps, tees, perfume …) are stuffed inside at no extra size
//     until the fill budget (cfg.shoebox.fillBudgetKg × pairs) is used; what
//     overflows lies flat on top, adding its own flat thickness (flatCm);
//   • an item that is neither (a bag) lies on top the same way;
//   • no footwear: one flat courier bag (cfg.flatBag) as thick as the goods,
//     or, past its maxHeightCm, a box from the box list (a custom parcel,
//     fits: false, when none holds it).
// NO PADDING: every size is the goods' or the box's own; nothing is rounded
// up. Weight = everything (plus a bag's or box's tare). Chargeable =
// max(actual, volumetric) for that single parcel. A calibration factor
// (cfg.calibration[class].factor) learned from TCG's own measurements may
// scale the declared volume (scripts/shipping/reconcile.mjs).
//
//   estimateParcel(lines, config?) → {
//     parcels: [ ONE { kind: "shoebox"|"flatBag"|"box"|"custom", boxCode, lengthCm, widthCm, heightCm, calibrationClass,
//                      actualKg, volumetricKg, chargeableKg, contents: [{ kind, kg }],
//                      pairs, layout: { columns, rows } | null, overflowBundles } ],
//     parcelCount: 1, actualKg, chargeableKg,
//     service, dropBoxEligible, lockerSize,         door-to-door unless the parcel fits a locker AND the drop box is on
//     fits, items, guessed, unmeasured,             diagnostics for the cards
//   }
import { DEFAULT_SHIPPING_CONFIG, mergeShippingConfig } from "./shippingConfig.js";

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
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

/**
 * A kids size on the EU scale. EU 16+ as is. UK kids sizes repeat (toddler
 * 3–9.5, junior 10–13.5, then 1–6), so 7–9.5 reads as toddler, below 7 as
 * junior / grade school — an approximation; the band only steps weight.
 */
export function toEuKidsSize(n) {
  if (!Number.isFinite(n)) return n;
  if (n >= 16) return n;
  if (n >= 10) return n + 17.5;
  return n >= 7 ? n + 17 : n + 33;
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
  const raw = shoeSizeNumber(line?.size);
  const n = spec.sizeScale === "euKids" ? toEuKidsSize(raw) : toUkAdultSize(raw);
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

/**
 * Do `items` pack into `outer` in flat layers? Each item lies flat (its smallest
 * side up); identical items share layers, as many per layer as the floor holds
 * (either way round); the layers stack. Every side of the box is tried as "up".
 * Catches what the side-by-side columns miss: 6 caps + a bag are 2×2 caps per
 * layer in a 55×40×35 box, but 3+ columns of caps in a row are wider than any box.
 */
export function fitsInLayers(items, outer) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.l}x${it.w}x${it.h}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { l: it.l, w: it.w, h: it.h, n: 1 });
  }
  const [x, y, z] = outer.map(Number);
  // A box or item with a missing, zero or negative side (a bad Shipping card
  // row) never claims a fit.
  const positive = (n) => Number.isFinite(n) && n > 0;
  if (![x, y, z].every(positive)) return false;
  if (![...groups.values()].every((g) => [g.l, g.w, g.h].every(positive))) return false;
  for (const [a, b, up] of [[x, y, z], [x, z, y], [y, z, x]]) {
    let height = 0;
    for (const g of groups.values()) {
      const perLayer = Math.max(Math.floor(a / g.l) * Math.floor(b / g.w), Math.floor(a / g.w) * Math.floor(b / g.l));
      if (perLayer === 0) { height = Infinity; break; }
      height += Math.ceil(g.n / perLayer) * g.h;
    }
    if (height <= up + 1e-9) return true;   // 3 × 8.4 is 25.200000000000003
  }
  return false;
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
  // The smallest box the items fit in layers, when that is smaller than (or
  // the only answer besides) the column layouts.
  const layered = sorted.find((b) => fitsInLayers(items, [b.lengthCm, b.widthCm, b.heightCm]));
  if (layered) {
    const v = volume([layered.lengthCm, layered.widthCm, layered.heightCm]);
    if (!best || v < best.v) best = { box: layered, block: [layered.lengthCm, layered.widthCm, layered.heightCm].map(Number), v };
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

/**
 * How thick `items` lie flat, one on another: each item's flatCm (its
 * smallest side when the card gives none); a cap after the first nests into
 * it (nestCm). Pure.
 */
export function flatThicknessCm(items, config) {
  let caps = 0;
  let t = 0;
  for (const it of items) {
    const spec = config.items?.[it.kind] ?? {};
    const flat = Number(spec.flatCm);
    const own = Number.isFinite(flat) && flat > 0 ? flat : it.h;
    if (it.kind === "cap") {
      const nest = Number(spec.nestCm);
      t += caps++ === 0 ? own : Number.isFinite(nest) && nest >= 0 ? nest : own;
    } else t += own;
  }
  return round1(t);
}

/**
 * The flat courier bag (cfg.flatBag) for goods with no footwear, or null when
 * there is no bag, an item's footprint is wider than the bag, or the goods
 * are thicker than its maxHeightCm. Height = the goods' own flat thickness
 * (never below minHeightCm). Pure.
 */
export function flatBagParcel(items, cfg, divisor) {
  const bag = cfg.flatBag;
  const L = Number(bag?.lengthCm), W = Number(bag?.widthCm);
  if (!(L > 0 && W > 0)) return null;
  const footprint = sortDesc([L, W]);
  if (!items.every((it) => it.l <= footprint[0] && it.w <= footprint[1])) return null;
  const thick = flatThicknessCm(items, cfg);
  const max = Number(bag.maxHeightCm);
  if (Number.isFinite(max) && max > 0 && thick > max) return null;
  const heightCm = round1(Math.max(Number(bag.minHeightCm) || 0, thick));
  return finish({
    kind: "flatBag", boxCode: "BAG", lengthCm: footprint[0], widthCm: footprint[1], heightCm,
    actualKg: round2(items.reduce((t, it) => t + it.kg, 0) + (Number(bag.tareKg) || 0)),
    contents: items.map((it) => ({ kind: it.kind, kg: it.kg })),
    measured: bag.measured === true,
  }, divisor);
}

// One flat parcel from a set of items: the smallest standard box (or a custom
// parcel when none holds them, fits: false).
function flatParcel(items, cfg, divisor) {
  const best = chooseBox(items, cfg.boxes ?? []);
  const dims = best ? [best.box.lengthCm, best.box.widthCm, best.box.heightCm].map(Number) : layoutBlock(items, 1).map(Math.ceil);
  const [lengthCm, widthCm, heightCm] = sortDesc(dims);
  const actualKg = round2(items.reduce((t, it) => t + it.kg, 0) + (best ? Number(best.box.tareKg) || 0 : 0));
  return finish({
    kind: best ? "box" : "custom", boxCode: best ? best.box.code : null,
    lengthCm, widthCm, heightCm, actualKg,
    contents: items.map((it) => ({ kind: it.kind, kg: it.kg })),
    measured: best ? best.box.measured === true : false,
  }, divisor);
}

function finish(parcel, divisor) {
  const volumetricKg = round2((parcel.lengthCm * parcel.widthCm * parcel.heightCm) / divisor);
  return { ...parcel, volumetricKg, chargeableKg: Math.max(parcel.actualKg, volumetricKg) };
}

/**
 * Pure: how `pairs` shoeboxes are arranged into one block — `columns` boxes
 * side by side (width grows), `rows` stacked (height grows), length is the
 * box's own. Every grid that holds them is tried; the smallest LONGEST side
 * wins, ties by volume. → { columns, rows, lengthCm, widthCm, heightCm }:
 * 1 → 34×23×13, 2 → 34×23×26, 3 → 34×23×39, 4 → 34×46×26.
 * A grid with an empty slot is declared at the boxes' own volume — the height
 * is pairs ÷ columns boxes high, not a full row more: 5 → 34×46×32.5 (the
 * packers close the gap; TCG measured TCG200369959T at 59.1×37×26.7).
 */
export function shoeboxStack(pairs, shoebox) {
  const [l, w, h] = sortDesc([shoebox.lengthCm, shoebox.widthCm, shoebox.heightCm].map(Number));
  let best = null;
  for (let columns = 1; columns <= pairs; columns++) {
    const rows = Math.ceil(pairs / columns);
    if (columns > 1 && (columns - 1) * rows >= pairs) continue; // a column would be empty
    // No empty slot is ever declared: the height is the boxes' own.
    const dims = [l, w * columns, round1((h * pairs) / columns)];
    const longest = Math.max(...dims);
    const v = volume(dims);
    if (!best || longest < best.longest || (longest === best.longest && v < best.v)) best = { columns, rows, dims, longest, v };
  }
  return { columns: best.columns, rows: best.rows, lengthCm: best.dims[0], widthCm: best.dims[1], heightCm: best.dims[2] };
}

// The calibration factor's bounds: a learned correction never more than a
// quarter either way (a wild TCG measurement cannot run away with the table).
export const CALIBRATION_MIN = 0.75;
export const CALIBRATION_MAX = 1.25;

/** The class a parcel is calibrated under: shoebox:1 | shoebox:2 | shoebox:3+ | flatBag | box. Pure. */
export function parcelClass(p) {
  if (p?.kind === "shoebox") {
    const n = Number(p.pairs) || 0;
    return n >= 3 ? "shoebox:3+" : `shoebox:${Math.max(1, n)}`;
  }
  return p?.kind === "flatBag" ? "flatBag" : "box";
}

/** cfg.calibration[class].factor, clamped; 1 when absent or unusable. Pure. */
export function calibrationFactor(calibration, cls) {
  const f = Number(calibration?.[cls]?.factor);
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, f));
}

export function estimateParcel(lines, config = DEFAULT_SHIPPING_CONFIG) {
  const cfg = config === DEFAULT_SHIPPING_CONFIG ? config : mergeShippingConfig(config);
  const { items, guessed } = expandLines(lines, cfg);
  if (items.length === 0) throw new Error("estimateParcel: the order has no units to ship");
  const divisor = Number(cfg.volumetricDivisor) || 4000;
  const sb = cfg.shoebox ?? {};
  const budgetPerPair = Math.max(0, Number(sb.fillBudgetKg) || 0);

  const pairs = items.filter((it) => cfg.items[it.kind]?.ownShoebox === true);
  const stuffable = items.filter((it) => cfg.items[it.kind]?.ownShoebox !== true && cfg.items[it.kind]?.stuffable === true);
  const flat = items.filter((it) => cfg.items[it.kind]?.ownShoebox !== true && cfg.items[it.kind]?.stuffable !== true);

  let parcel;
  if (pairs.length === 0) {
    // No footwear: the flat courier bag, as thick as the goods; a box only
    // when the bag cannot hold them.
    parcel = { ...(flatBagParcel(items, cfg, divisor) ?? flatParcel(items, cfg, divisor)), pairs: 0, layout: null, overflowBundles: 0 };
  } else {
    // The shoebox block, soft goods inside up to the budget, the rest on top.
    const stack = shoeboxStack(pairs.length, sb);
    const budget = budgetPerPair * pairs.length;
    let stuffedKg = 0;
    const overflow = [];
    for (const it of stuffable) {
      if (stuffedKg + it.kg <= budget + 1e-9) stuffedKg += it.kg;
      else overflow.push(it);
    }
    // What does not fit inside lies flat on top: its own thickness, no bundle padding.
    const onTop = [...overflow, ...flat];
    const onTopCm = onTop.length ? flatThicknessCm(onTop, cfg) : 0;
    const overflowBundles = onTop.length;
    const actualKg = round2(items.reduce((t, it) => t + it.kg, 0));
    parcel = finish({
      kind: "shoebox", boxCode: "SHOEBOX",
      lengthCm: stack.lengthCm, widthCm: stack.widthCm, heightCm: round1(stack.heightCm + onTopCm),
      actualKg,
      contents: [...pairs, ...stuffable, ...flat].map((it) => ({ kind: it.kind, kg: it.kg })),
      measured: sb.measured === true,
      pairs: pairs.length, layout: { columns: stack.columns, rows: stack.rows }, overflowBundles,
    }, divisor);
  }

  // THE LEARNED CORRECTION (reconcile.mjs): TCG's own measurements of this
  // class of parcel, consistently off by more than 5%, scale the declared
  // volume through the height. Clamped; absent = the goods as they are.
  const calibrationClass = parcelClass(parcel);
  const factor = calibrationFactor(cfg.calibration, calibrationClass);
  if (factor !== 1) parcel = finish({ ...parcel, heightCm: round1(parcel.heightCm * factor) }, divisor);
  parcel = { ...parcel, calibrationClass, ...(factor !== 1 ? { calibrationFactor: factor } : {}) };

  const locker = chooseLocker([parcel.lengthCm, parcel.widthCm, parcel.heightCm], parcel.actualKg, cfg.dropBox);
  const kinds = [...new Set(items.map((i) => i.kind))];
  const unmeasured = [
    ...kinds.filter((k) => cfg.items[k]?.measured !== true).map((k) => `item:${k}`),
    ...(pairs.length && sb.measured !== true ? ["shoebox"] : []),
    ...(parcel.kind === "box" && parcel.measured !== true ? [`box:${parcel.boxCode}`] : []),
    ...(parcel.kind === "flatBag" && parcel.measured !== true ? ["flatBag"] : []),
    ...(locker && locker.measured !== true ? [`locker:${locker.size}`] : []),
  ];
  const { measured, ...one } = parcel;
  void measured;
  return {
    parcels: [one],
    parcelCount: 1,
    actualKg: one.actualKg,
    chargeableKg: one.chargeableKg,
    service: locker ? locker.serviceCode : cfg.doorServiceCode,
    dropBoxEligible: !!locker,
    lockerSize: locker ? locker.size : null,
    fits: one.kind !== "custom",
    items: items.length,
    guessed,
    unmeasured,
  };
}
