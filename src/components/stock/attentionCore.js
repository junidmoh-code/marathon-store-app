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

// The three sellable shop floors. Everything else under /stock (hub1/2/3,
// central, base, studio, in_transit) is warehouse — stock we own but that no
// customer can pick up today.
export const SHOP_LOCATIONS = Object.freeze(["marathon-pe", "marathon-pine", "trophy"]);
const SHOP_SET = new Set(SHOP_LOCATIONS);
export const isShopLocation = (loc) => SHOP_SET.has(loc);

// Scope = which locations the numbers describe. A row's "total" is always
// relative to the active scope, so "below 5" at Trophy means five on THAT
// floor — not five spread across the whole network.
export const SCOPE_ALL = "all";
export const SCOPE_SHOPS = "shops";
export const SCOPE_WAREHOUSE = "warehouse";

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
export const OVER_STEPS = Object.freeze([
  { id: "10", label: "10+", min: 10 },
  { id: "20", label: "20+", min: 20 },
  { id: "50", label: "50+", min: 50 },
  { id: "100", label: "100+", min: 100 },
]);
export const DEFAULT_LOW_STEP = "5";
export const DEFAULT_OVER_STEP = "20";

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
// Returns Map(pid → { total, shop, warehouse, sizes: Map(size→qty),
//                     byLocation: Map(loc → { qty, sizes: Map }) }).
export function buildAttentionIndex(stockTree) {
  const index = new Map();
  if (!stockTree || typeof stockTree !== "object") return index;

  for (const [loc, productsAtLoc] of Object.entries(stockTree)) {
    if (!productsAtLoc || typeof productsAtLoc !== "object") continue;
    const shop = isShopLocation(loc);

    for (const [pid, sizes] of Object.entries(productsAtLoc)) {
      if (!sizes || typeof sizes !== "object") continue;

      for (const [rawKey, cell] of Object.entries(sizes)) {
        const qty = typeof cell === "number" ? cell : cell?.qty;
        if (typeof qty !== "number" || !Number.isFinite(qty)) continue;

        let entry = index.get(pid);
        if (!entry) {
          entry = { total: 0, shop: 0, warehouse: 0, sizes: new Map(), byLocation: new Map() };
          index.set(pid, entry);
        }
        const size = rawKey === NO_SIZE_KEY ? NO_SIZE_KEY : decodeSizeKey(rawKey);

        entry.total += qty;
        if (shop) entry.shop += qty; else entry.warehouse += qty;
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

// Collapse an index entry down to the active scope. Returns null when the
// product holds nothing in that scope — the caller drops it, so switching to
// "Trophy" can't list styles Trophy has never carried.
export function scopeEntry(entry, scope) {
  if (!entry) return null;
  if (scope === SCOPE_ALL) {
    return { total: entry.total, shop: entry.shop, warehouse: entry.warehouse, sizes: entry.sizes, byLocation: entry.byLocation };
  }

  const wanted = scope === SCOPE_SHOPS
    ? (loc) => isShopLocation(loc)
    : scope === SCOPE_WAREHOUSE
      ? (loc) => !isShopLocation(loc)
      : (loc) => loc === scope;               // a single location id

  let total = 0, shop = 0, warehouse = 0;
  const sizes = new Map();
  const byLocation = new Map();
  let present = false;

  for (const [loc, at] of entry.byLocation) {
    if (!wanted(loc)) continue;
    present = true;
    total += at.qty;
    if (isShopLocation(loc)) shop += at.qty; else warehouse += at.qty;
    byLocation.set(loc, at);
    for (const [size, qty] of at.sizes) sizes.set(size, (sizes.get(size) || 0) + qty);
  }
  return present ? { total, shop, warehouse, sizes, byLocation } : null;
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

// Where the stock physically is, biggest holding first.
export function locationBreakdown(byLocation) {
  return Array.from(byLocation || [])
    .filter(([, at]) => at.qty > 0)
    .map(([loc, at]) => ({ loc, label: locationLabel(loc), qty: at.qty, shop: isShopLocation(loc) }))
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

function toRow(pid, product, scoped) {
  return {
    id: pid,
    product,
    name: product?.name || pid,
    brand: product?.brand || "",
    category: topCategory(product),
    subcategory: product?.subcategory || "",
    photo: product?.photoUrl || product?.photo || null,
    total: scoped.total,
    shop: scoped.shop,
    warehouse: scoped.warehouse,
    sizes: sizeBreakdown(scoped.sizes),
    locations: locationBreakdown(scoped.byLocation),
    costValue: rowCostValue(product, scoped.total),
    retailPrice: num(product?.retailPrice),
  };
}

// ── Sorting ─────────────────────────────────────────────────────────────────
export const SORTS = Object.freeze([
  { id: "qtyAsc", label: "Fewest first", cmp: (a, b) => a.total - b.total },
  { id: "qtyDesc", label: "Most first", cmp: (a, b) => b.total - a.total },
  { id: "valueDesc", label: "Highest value", cmp: (a, b) => (b.costValue ?? -1) - (a.costValue ?? -1) },
  { id: "name", label: "Name A–Z", cmp: (a, b) => a.name.localeCompare(b.name) },
  { id: "sizes", label: "Most sizes", cmp: (a, b) => b.sizes.length - a.sizes.length },
]);
export const findSort = (id) => SORTS.find((s) => s.id === id) || SORTS[0];

function matchesSearch(row, needle) {
  const q = String(needle || "").trim().toLowerCase();
  if (!q) return true;
  return `${row.name} ${row.brand} ${row.subcategory} ${row.category}`.toLowerCase().includes(q);
}

// ── The one selector every view uses ────────────────────────────────────────
//
// `productsById` is a plain object keyed by product id. A /stock row whose
// product is gone from the catalogue is dropped (we can't name or classify it).
export function selectAttentionRows({
  index, productsById, view, scope = SCOPE_ALL, lowStepId, overStepId,
  category = "all", brand = "all", search = "", sortId = "qtyAsc",
  soldMap, arrivedSet, hideJustArrived,
}) {
  const low = findStep(LOW_STEPS, lowStepId, DEFAULT_LOW_STEP);
  const over = findStep(OVER_STEPS, overStepId, DEFAULT_OVER_STEP);
  const rows = [];

  for (const [pid, entry] of index || []) {
    const scoped = scopeEntry(entry, scope);
    if (!scoped) continue;

    // Every view is about stock we actually hold. A style at zero has no
    // reorder signal here (it's simply out) and no movement problem.
    if (scoped.total <= 0) continue;

    if (view === VIEW_LOW && scoped.total > low.max) continue;
    if (view === VIEW_OVER && scoped.total < over.min) continue;

    let justArrived = false;
    if (view === VIEW_DEAD) {
      if (soldMap?.get(pid) > 0) continue;
      justArrived = Boolean(arrivedSet?.has(pid));
      if (hideJustArrived && justArrived) continue;
    }

    const product = productsById?.[pid];
    if (!product) continue;

    const row = toRow(pid, product, scoped);
    if (category !== "all" && row.category !== category) continue;
    if (brand !== "all" && row.brand !== brand) continue;
    if (!matchesSearch(row, search)) continue;

    rows.push(view === VIEW_DEAD ? { ...row, justArrived } : row);
  }

  const cmp = findSort(sortId).cmp;
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

// Brand list for the picker — only brands present in the current result set, so
// the dropdown can't offer a filter that yields nothing.
export function brandOptions(rows) {
  const counts = new Map();
  for (const r of rows) if (r.brand) counts.set(r.brand, (counts.get(r.brand) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([brand, count]) => ({ brand, count }));
}
