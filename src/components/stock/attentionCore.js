// ─── ATTENTION · CORE ─────────────────────────────────────────────────────────
// Pure logic behind the Attention workspace: what's running out, what's piled
// up, and what isn't selling. No React, no Firebase — every rule here is unit
// tested in attentionCore.test.js.
//
// Attention answers a SHOPKEEPER's question ("what do I reorder, what's dead
// money"), which is why it lives beside — not inside — Inventory Health. Health
// is the refill engine's control centre (targets, exceptions, auto-transfers);
// this reads the same /stock tree with none of that machinery.
//
// THREE VIEWS, one row shape:
//   LOW   — quantity at or under a chosen bucket. The reorder list.
//   OVER  — quantity at or over a chosen bucket. Cash sitting still.
//   DEAD  — in stock, but nothing SOLD in the window.

import { topCategory } from "../../utils/productCategory";
import { decodeSizeKey } from "../../utils/sizeKey";

// LOCATION IS A PROPERTY OF THE ROW, NOT A FILTER (owner call). The LIST is
// never split by building — a style is one line whose quantity is the total we
// own anywhere. But each row still carries its per-location holdings so the card
// can show WHERE that stock sits, and break a single location down into sizes
// on demand.
const SHOP_SET = new Set(["marathon-pe", "marathon-pine", "trophy"]);
export const isShopLocation = (loc) => SHOP_SET.has(loc);

export const LOCATION_LABELS = Object.freeze({
  "marathon-pe": "Marathon PE", "marathon-pine": "Marathon Pine", trophy: "Trophy",
  hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", hubC: "Hub C",
  central: "Central", base: "Base", studio: "Studio", warehouse1: "Warehouse 1",
  in_transit: "In Transit",
});
export const locationLabel = (loc) => LOCATION_LABELS[loc] || loc;

const NO_SIZE_KEY = "_";

// ── Views ───────────────────────────────────────────────────────────────────
export const VIEW_LOW = "low";
export const VIEW_OVER = "over";
export const VIEW_DEAD = "dead";

// Quantity thresholds. LOW reads "this many or fewer", OVER "this many or more"
// — deliberately overlapping ladders, picked one rung at a time, so the operator
// tightens or loosens the list rather than hunting a band.
export const LOW_STEPS = Object.freeze([
  { id: "1", label: "1 left", max: 1 },
  { id: "3", label: "3 & under", max: 3 },
  { id: "5", label: "Under 5", max: 4 },
  { id: "10", label: "Under 10", max: 9 },
  { id: "20", label: "Under 20", max: 19 },
]);
// Highest first — overstock is read top-down ("what do we have FAR too much
// of"), so the biggest pile is the opening question and 20+ is the last, widest
// rung rather than the entry point.
export const OVER_STEPS = Object.freeze([
  { id: "200", label: "200+", min: 200 },
  { id: "100", label: "100+", min: 100 },
  { id: "50", label: "50+", min: 50 },
  { id: "20", label: "20+", min: 20 },
]);

// A style with one or two left is nearly SOLD OUT, not stagnant — there is
// nothing left to move. The dead list therefore starts from a real holding.
export const DEAD_MIN_STEPS = Object.freeze([
  { id: "3", label: "3+ units", min: 3 },
  { id: "5", label: "5+ units", min: 5 },
  { id: "10", label: "10+ units", min: 10 },
  { id: "20", label: "20+ units", min: 20 },
]);

export const DEFAULT_LOW_STEP = "3";
// The MENU runs highest-first (200+ … 20+), but the screen OPENS on 50+: only 4
// styles in the catalogue reach 200+, so defaulting to the top rung would greet
// the owner with an all-but-empty grid. 50+ is 91 styles / R5m — a real list.
export const DEFAULT_OVER_STEP = "50";
export const DEFAULT_DEAD_MIN = "5";

export const DEAD_WINDOWS = Object.freeze([
  { days: 7, label: "7 days" }, { days: 14, label: "14 days" },
  { days: 30, label: "30 days" }, { days: 60, label: "60 days" },
]);

export const findStep = (steps, id, fallbackId) =>
  steps.find((s) => s.id === id) || steps.find((s) => s.id === fallbackId) || steps[0];

// ── /stock → per-product, per-location index ────────────────────────────────
//
// Input is the raw /stock snapshot: { [loc]: { [pid]: { [sizeKey]: { qty } } } }.
// Cells with a non-finite qty are SKIPPED — an absent count is "unknown", never
// zero. Size keys arrive in two spellings (the warehouse writes "5.5", the POS
// writes "5_5"); both are normalised to the DECODED form so one size is one row.
//
// Returns Map(pid → { total, sizes: Map(size→qty),
//                     byLocation: Map(loc → { qty, sizes: Map(size→qty) }) }).
export function buildAttentionIndex(stockTree) {
  const index = new Map();
  if (!stockTree || typeof stockTree !== "object") return index;

  for (const [loc, productsAtLoc] of Object.entries(stockTree)) {
    if (!productsAtLoc || typeof productsAtLoc !== "object") continue;

    for (const [pid, sizes] of Object.entries(productsAtLoc)) {
      if (!sizes || typeof sizes !== "object") continue;

      for (const [rawKey, cell] of Object.entries(sizes)) {
        const qty = typeof cell === "number" ? cell : cell?.qty;
        if (typeof qty !== "number" || !Number.isFinite(qty)) continue;

        let entry = index.get(pid);
        if (!entry) { entry = { total: 0, sizes: new Map(), byLocation: new Map() }; index.set(pid, entry); }
        const size = rawKey === NO_SIZE_KEY ? NO_SIZE_KEY : decodeSizeKey(rawKey);
        entry.total += qty;
        entry.sizes.set(size, (entry.sizes.get(size) || 0) + qty);

        let at = entry.byLocation.get(loc);
        if (!at) { at = { qty: 0, sizes: new Map() }; entry.byLocation.set(loc, at); }
        at.qty += qty;
        at.sizes.set(size, (at.sizes.get(size) || 0) + qty);
      }
    }
  }
  return index;
}

// ── Movement ledger ─────────────────────────────────────────────────────────
//
// Only `sold` counts as movement. A transfer_out from a hub to a shop is stock
// being shuffled inside the business, not a customer buying it — counting it
// would report a stagnant pile as healthy. `ts` is an ISO STRING here, so parse
// it; a numeric comparison silently matches nothing.
export function soldUnitsByProduct(movements, sinceMs) {
  const sold = new Map();
  if (!movements || typeof movements !== "object") return sold;
  for (const mv of Object.values(movements)) {
    if (mv?.type !== "sold") continue;
    const at = Date.parse(mv?.ts);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    if (!mv?.productId) continue;
    const qty = Number(mv?.qty);
    sold.set(mv.productId, (sold.get(mv.productId) || 0) + (Number.isFinite(qty) ? Math.abs(qty) : 0));
  }
  return sold;
}

// Products DELIVERED inside the window. Without this, "not moving" lies: a style
// that landed two days ago has no sales yet by definition, so it tops the dead
// list for being new. Rows carry `justArrived` so they can be tagged or hidden.
export function receivedProductIds(movements, sinceMs) {
  const arrived = new Set();
  if (!movements || typeof movements !== "object") return arrived;
  for (const mv of Object.values(movements)) {
    if (mv?.type !== "received") continue;
    const at = Date.parse(mv?.ts);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    if (mv?.productId) arrived.add(mv.productId);
  }
  return arrived;
}

// ── Row shaping ─────────────────────────────────────────────────────────────

// Size chips, biggest first. Zero/negative cells are dropped — a row about
// what's LEFT shouldn't carry empty sizes.
export function sizeBreakdown(sizes) {
  return Array.from(sizes || [])
    .filter(([, qty]) => qty > 0)
    .map(([size, qty]) => ({ size: size === NO_SIZE_KEY ? "One size" : size, qty }))
    .sort((a, b) => b.qty - a.qty || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
}

// Where this style physically sits, biggest holding first. Each entry carries
// its own size split so the card can expand one location into sizes on click.
// Empty/negative holdings are dropped — a location with nothing in it is not a
// place the stock "is".
export function locationBreakdown(byLocation) {
  return Array.from(byLocation || [])
    .filter(([, at]) => at.qty > 0)
    .map(([loc, at]) => ({
      loc, label: locationLabel(loc), qty: at.qty, shop: isShopLocation(loc),
      sizes: sizeBreakdown(at.sizes),
    }))
    .sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

// Cash tied up in this row, at COST. Retail would flatter the number; the
// owner's question is "how much of my money is sitting in this pile".
// Returns null when the product has no cost price — shown as "—", never 0,
// so a missing price can't read as free stock.
export function rowCostValue(product, total) {
  const cost = num(product?.stockPrice);
  return cost == null ? null : cost * total;
}

function toRow(pid, product, entry) {
  return {
    id: pid,
    product,
    name: product?.name || pid,
    brand: product?.brand || "",
    category: topCategory(product),
    subcategory: product?.subcategory || "",
    photo: product?.photoUrl || product?.photo || null,
    total: entry.total,
    // The size + location breakdowns are NOT built here. Shaping every match
    // meant ~2700 pairs of array sorts on each filter change, of which only the
    // ~48 rows actually on screen were ever looked at — which is what made
    // changing an option feel like it hadn't taken. The raw entry rides along
    // and each rendered card shapes its own (see AttentionView).
    entry,
    sizeCount: entry.sizes.size,
    costValue: rowCostValue(product, entry.total),
    retailPrice: num(product?.retailPrice),
  };
}

// ── Sorting ─────────────────────────────────────────────────────────────────
export const SORTS = Object.freeze([
  { id: "qtyAsc", label: "Fewest first", cmp: (a, b) => a.total - b.total },
  { id: "qtyDesc", label: "Most first", cmp: (a, b) => b.total - a.total },
  { id: "valueDesc", label: "Highest value", cmp: (a, b) => (b.costValue ?? -1) - (a.costValue ?? -1) },
  { id: "name", label: "Name A–Z", cmp: (a, b) => a.name.localeCompare(b.name) },
  { id: "sizes", label: "Most sizes", cmp: (a, b) => b.sizeCount - a.sizeCount },
]);
export const findSort = (id) => SORTS.find((s) => s.id === id) || SORTS[0];

// Shortage lists open on the most urgent row; pile lists open on the biggest.
export const defaultSortFor = (view) => (view === VIEW_LOW ? "qtyAsc" : "qtyDesc");

function matchesSearch(row, needle) {
  const q = String(needle || "").trim().toLowerCase();
  if (!q) return true;
  return `${row.name} ${row.brand} ${row.subcategory} ${row.category}`.toLowerCase().includes(q);
}

// ── The one selector every view uses ────────────────────────────────────────
//
// `productsById` is a plain object keyed by product id. A /stock row whose
// product is gone from the catalogue is dropped (we can't name or classify it).
// `productsById` is a plain object keyed by product id. A /stock row whose
// product is gone from the catalogue is dropped (we can't name or classify it).
export function selectAttentionRows({
  index, productsById, view, lowStepId, overStepId, deadMinId,
  category = "all", brand = "all", search = "", sortId,
  soldMap, arrivedSet, hideJustArrived,
}) {
  const low = findStep(LOW_STEPS, lowStepId, DEFAULT_LOW_STEP);
  const over = findStep(OVER_STEPS, overStepId, DEFAULT_OVER_STEP);
  const deadMin = findStep(DEAD_MIN_STEPS, deadMinId, DEFAULT_DEAD_MIN);
  const rows = [];

  for (const [pid, entry] of index || []) {
    // Every view is about stock we actually hold. A style at zero has no
    // reorder signal here (it's simply out) and no movement problem.
    if (entry.total <= 0) continue;

    if (view === VIEW_LOW && entry.total > low.max) continue;
    if (view === VIEW_OVER && entry.total < over.min) continue;

    let justArrived = false;
    if (view === VIEW_DEAD) {
      // A style down to its last one or two hasn't stalled — it has nearly sold
      // out, and there is nothing left for it to move. Requiring a real holding
      // is what makes this list about dead money rather than remnants.
      if (entry.total < deadMin.min) continue;
      if (soldMap?.get(pid) > 0) continue;
      justArrived = Boolean(arrivedSet?.has(pid));
      if (hideJustArrived && justArrived) continue;
    }

    const product = productsById?.[pid];
    if (!product) continue;

    const row = toRow(pid, product, entry);
    if (category !== "all" && row.category !== category) continue;
    if (brand !== "all" && row.brand !== brand) continue;
    if (!matchesSearch(row, search)) continue;

    rows.push(view === VIEW_DEAD ? { ...row, justArrived } : row);
  }

  const cmp = findSort(sortId || defaultSortFor(view)).cmp;
  rows.sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
  return rows;
}

// Headline numbers for the current filter — styles, units, and the cash those
// units represent. `valueKnown` reports how many rows actually had a cost
// price, so a total built from partial data is never presented as complete.
export function summarise(rows) {
  let units = 0, value = 0, valueKnown = 0;
  for (const r of rows) {
    units += r.total;
    if (r.costValue != null) { value += r.costValue; valueKnown += 1; }
  }
  return { styles: rows.length, units, value, valueKnown, valueMissing: rows.length - valueKnown };
}

