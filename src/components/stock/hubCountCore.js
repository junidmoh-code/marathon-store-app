// ─── HUB SNEAKER COUNT — PURE CORE ────────────────────────────────────────────
// Every decision this feature makes about WHAT to count and WHAT counts as done
// lives here, with no React and no Firebase, so it is unit-testable and the view
// stays a renderer. The view owns only the one-shot reads and the writes.
//
// ── THE THREE DATA FACTS THIS MODULE ENCODES ─────────────────────────────────
//
// 1. SNEAKER = CATEGORY, NEVER productType. `isFootwearProduct` (imported, not
//    re-implemented) tests `category === "Footwear"`. Measured live: 1,369
//    products carry category Footwear while only 580 carry productType
//    "sneaker" and 858 carry no productType at all. Keying off productType
//    would silently hide two-thirds of the shoes from the count.
//
// 2. SIZE KEYS ARE STORED ENCODED. /stock cells are keyed by stockSizeKey, so
//    "5.5" lives at "5_5". This module keeps the ENCODED key as the identity of
//    a size cell everywhere (row keys, session records, movement writes) and
//    decodes only for display. One key, no translation layer to get wrong.
//
// 3. THE "_" SENTINEL IS EXCLUDED. "_" is the one-size cell (stockSizeKey folds
//    null / "" / "Free Size" into it). A shoe has no one-size cell; any "_" cell
//    sitting on a footwear product at a hub is a data artefact — the Free_Size
//    phantom class of bug — not a physical pair on a shelf. Counting it would
//    invite someone to "correct" a phantom into a real number. Excluded from
//    the count list, and excluded from the M in "N of M".
//
// Also filtered: the "_meta" key, which appears at BOTH the product level
// (/stock/{loc}/_meta) and the size level (/stock/{loc}/{pid}/_meta) and is not
// a stock cell.

import { isFootwearProduct, footwearSizeRank } from "./missingFootwearCore";
import { decodeSizeKey, stockSizeKey } from "../../utils/sizeKey";
import { warehouseLocations, labelFor } from "./locations";
import { SIZES_FOOTWEAR } from "../../utils/productTaxonomy";

export const ONE_SIZE_SENTINEL = "_";
const META_KEY = "_meta";

/** Not a countable size cell: the one-size sentinel and the _meta side-node. */
export function isCountableSizeKey(k) {
  return typeof k === "string" && k !== ONE_SIZE_SENTINEL && k !== META_KEY && k.length > 0;
}

/**
 * The hub picker's options, resolved from the LIVE /locations registry — never
 * from a hardcoded "hub1"/"hub2" list. Active warehouses only (`central` is a
 * warehouse too and is deliberately INCLUDED: it holds sneaker stock and there
 * is no reason the same count screen shouldn't reach it). Stores and in_transit
 * are excluded by `warehouseLocations`, and deactivated locations (studio, base)
 * by its `active` filter.
 */
export function hubOptions(registry) {
  return warehouseLocations(registry)
    .filter((l) => l && l.id)
    .map((l) => ({ id: l.id, label: labelFor(l.id, registry) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Stable identity of one countable cell, used as the session record key. */
export function cellKey(productId, sizeKey) {
  return `${productId}::${sizeKey}`;
}

/** Display label for a stored (encoded) size key: "5_5" → "5.5". */
export function sizeLabelOf(sizeKey) {
  return decodeSizeKey(sizeKey);
}

const qtyOf = (cell) => (cell && typeof cell.qty === "number" ? cell.qty : 0);

/**
 * Build the count list: every sneaker product holding at least one countable
 * size cell at this hub.
 *
 * @param products  the catalogue (array of product records)
 * @param hubStock  the RAW one-shot snapshot of /stock/{hub} → { pid: { sizeKey: cell } }
 *                  (encoded size keys, exactly as stored — no decode applied)
 * @returns rows sorted by name, each with its size rows sorted by numeric size
 */
export function buildHubRows({ products = [], hubStock = {} }) {
  const byId = products instanceof Map ? products : new Map((products || []).map((p) => [p?.id, p]).filter(([id]) => id));
  const rows = [];

  for (const pid of Object.keys(hubStock || {})) {
    if (pid === META_KEY) continue;
    const product = byId.get(pid);
    // A cell whose product record is missing or is not footwear is not part of a
    // SNEAKER count. Skipping silently is correct here: the hub holds clothing
    // cells too, and this screen is explicitly the sneaker count.
    if (!product || !isFootwearProduct(product)) continue;

    const sizes = sizeRowsFor(hubStock[pid]);
    if (!sizes.length) continue;                       // only "_" / "_meta" → nothing to count
    rows.push(makeRow(product, sizes));
  }

  return rows.sort(byQuantityDesc);
}

function sizeRowsFor(node) {
  return Object.keys(node || {})
    .filter(isCountableSizeKey)
    .map((sizeKey) => ({ sizeKey, label: sizeLabelOf(sizeKey), expected: qtyOf(node[sizeKey]) }))
    .sort((a, b) => footwearSizeRank(a.sizeKey) - footwearSizeRank(b.sizeKey));
}

function makeRow(product, sizes, seeded = false) {
  return {
    id: product.id,
    name: product.name || "(unnamed)",
    code: product.barcode != null ? String(product.barcode) : (product.sku != null ? String(product.sku) : ""),
    photoUrl: product.photoUrl || "",
    // The TRUE sum, negatives included — every write path fences and computes
    // against reality, never the display.
    total: sizes.reduce((t, s) => t + s.expected, 0),
    // What the UI SHOWS (owner direction 2026-08-03: no negative numbers on the
    // count screen — a shelf cannot hold −3 pairs, and to a counter the minus is
    // noise). Each below-zero cell displays as 0; the truth stays in `total` and
    // in per-size `expected`, and counting the cell is what actually fixes it.
    displayTotal: sizes.reduce((t, s) => t + Math.max(0, s.expected), 0),
    seeded,
    sizes,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
// List order (owner direction 2026-08-03): biggest stacks first. Counting runs
// top-down through the physical bulk of the hub instead of hopping the alphabet.
// Sorts on the DISPLAYED total so the order matches what the screen says.
const byQuantityDesc = (a, b) => (b.displayTotal - a.displayTotal) || byName(a, b);

/**
 * A row for a product that is physically on the shelf but has NO cell at this
 * hub (requirement: "add a product that is present but has no cell"). Every size
 * is seeded from zero, so confirming leaves nothing behind and adjusting writes
 * the first real movement into a fresh cell.
 *
 * The size run comes from the product's own `sizes` when it has them, falling
 * back to the taxonomy footwear run. The "_" sentinel is stripped either way.
 */
export function seededRowFor(product) {
  if (!product || !product.id) return null;
  const raw = Array.isArray(product.sizes) && product.sizes.length ? product.sizes : SIZES_FOOTWEAR;
  return seededRowForSizes(product, raw.map((s) => stockSizeKey(s)));
}

/** A seeded row restricted to specific (already-encoded) size keys. */
export function seededRowForSizes(product, sizeKeys) {
  if (!product || !product.id) return null;
  const sizes = (sizeKeys || [])
    .filter(isCountableSizeKey)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .map((sizeKey) => ({ sizeKey, label: sizeLabelOf(sizeKey), expected: 0 }))
    .sort((a, b) => footwearSizeRank(a.sizeKey) - footwearSizeRank(b.sizeKey));
  if (!sizes.length) return null;
  return makeRow(product, sizes, true);
}

/**
 * Merge manually-added (seeded) rows into the hub rows.
 *
 * ── MERGES BY SIZE, NOT BY PRODUCT ───────────────────────────────────────────
 * The obvious "drop any seeded row whose product already appears" is WRONG, and
 * wrong in a way that destroys the add-a-missing-product flow. Sequence: a shoe
 * with sizes 8/9/10 has no cell at this hub, so it is added as a seeded row.
 * The counter finds 3 pairs of size 9 and adjusts. That write CREATES a real
 * cell — but only for size 9. On the next rebuild the product now appears in
 * `hubRows` with a single size, and a product-level dedupe would discard the
 * seeded row carrying 8 and 10 entirely. Those sizes vanish from the screen, the
 * "add" search excludes the product because it is now listed, and no reload
 * brings them back — /stock genuinely only holds the one cell. Any pairs of 8 or
 * 10 on that shelf become uncountable, silently, and the N-of-M denominator
 * SHRINKS mid-count.
 *
 * So: union the size lists. A real cell always wins over a seeded placeholder
 * for the same size; seeded sizes the hub has no cell for yet stay visible until
 * the counter deals with them too.
 */
export function mergeSeededRows(hubRows, seededRows) {
  const seedById = new Map((seededRows || []).filter((r) => r && r.id).map((r) => [r.id, r]));

  const merged = hubRows.map((row) => {
    const seed = seedById.get(row.id);
    if (!seed) return row;
    seedById.delete(row.id);
    const have = new Set(row.sizes.map((s) => s.sizeKey));
    const extra = seed.sizes.filter((s) => !have.has(s.sizeKey));
    if (!extra.length) return row;
    const sizes = [...row.sizes, ...extra].sort((a, b) => footwearSizeRank(a.sizeKey) - footwearSizeRank(b.sizeKey));
    return { ...row, sizes,
      total: sizes.reduce((t, s) => t + s.expected, 0),
      displayTotal: sizes.reduce((t, s) => t + Math.max(0, s.expected), 0),
      seeded: true };
  });

  return [...merged, ...seedById.values()].sort(byQuantityDesc);
}

/**
 * Rebuild seeded rows from what this session already recorded.
 *
 * Seeded rows are created by a human tapping "add", which means they live in one
 * device's memory. Without this, a reload — or a second counter's tablet — shows
 * none of them, so work that WAS recorded looks undone and the same shelf gets
 * counted twice. Every recorded cell carries its productId and sizeKey, so the
 * rows are reconstructible from RTDB, which is where the shared truth lives.
 *
 * Two cases, deliberately different:
 *   • the product has NO countable cell at this hub → restore its FULL size run
 *     (it is still entirely "added from zero")
 *   • the product HAS cells, but a recorded size has none → restore only that
 *     size. Restoring the full run here would invent sizes this hub never
 *     carried and inflate the denominator.
 */
export function recoverSeededRows({ counted = {}, hubStock = {}, products = [] }) {
  const byId = products instanceof Map ? products : new Map((products || []).map((p) => [p?.id, p]).filter(([id]) => id));
  const missing = new Map();                       // pid -> Set(sizeKey)

  for (const rec of Object.values(counted || {})) {
    if (!rec || !rec.productId || !isCountableSizeKey(rec.sizeKey)) continue;
    const node = hubStock[rec.productId];
    if (node && node[rec.sizeKey]) continue;       // a real cell exists — nothing to recover
    if (!missing.has(rec.productId)) missing.set(rec.productId, new Set());
    missing.get(rec.productId).add(rec.sizeKey);
  }

  const rows = [];
  for (const [pid, keys] of missing) {
    const product = byId.get(pid);
    if (!product) continue;
    const node = hubStock[pid];
    const hasAnyCell = !!node && Object.keys(node).some(isCountableSizeKey);
    const row = hasAnyCell ? seededRowForSizes(product, [...keys]) : seededRowFor(product);
    if (row) rows.push(row);
  }
  return rows;
}

/** N of M for the progress readout: M = countable cells, N = those recorded. */
export function progressOf(rows, counted = {}) {
  let total = 0, done = 0;
  for (const row of rows) {
    for (const s of row.sizes) {
      total++;
      if (counted[cellKey(row.id, s.sizeKey)]) done++;
    }
  }
  return { done, total };
}

/** Is every size on this row already recorded? Drives the settled/dimmed state. */
export function isRowSettled(row, counted = {}) {
  return row.sizes.length > 0 && row.sizes.every((s) => counted[cellKey(row.id, s.sizeKey)]);
}

/**
 * THE STALENESS TEST — the anti-clobber guard, stated once.
 *
 * `expected` is the number the counter was SHOWN when they opened the row.
 * `live` is what /stock holds at the moment of the write, re-read one-shot.
 * If they disagree, someone else moved that cell (another counter, a POS sale, a
 * transfer) and this counter's arithmetic is against a base that no longer
 * exists. The caller must refuse the write and re-show, never absorb it.
 */
export function isStaleExpectation(expected, live) {
  return Number(expected) !== Number(live);
}

/**
 * The History tab (owner direction 2026-08-03, replacing the Variance list):
 * EVERY recorded cell, newest first — the log of what has been counted, by
 * outcome. Pending rows (a warehouse counter's recorded mismatch, action
 * "flag") are the admin's apply queue and surface with their Apply button in
 * the view; unsettled rows still mean "walk back to that shelf".
 */
export function historyRows(counted = {}, productsById = new Map()) {
  const byId = productsById instanceof Map ? productsById : new Map(Object.entries(productsById || {}));
  return Object.entries(counted)
    .map(([key, rec]) => ({ key, ...rec }))
    .map((r) => ({
      ...r,
      delta: Number(r.actual) - Number(r.expected),
      pending: r.action === "flag",
      unsettled: r.settled === false,
      live: r.live == null ? Number(r.actual) : Number(r.live),
      name: byId.get(r.productId)?.name || r.productId,
      sizeLabel: sizeLabelOf(r.sizeKey),
    }))
    // Newest first — `at` is ISO, so string order is time order. Ties (same
    // millisecond is possible across devices) break by name for stability.
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")) || a.name.localeCompare(b.name));
}

/** Filter rows by the search box (name or code), case/punctuation-insensitive. */
export function filterRows(rows, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q) || (r.code && r.code.toLowerCase().includes(q))
  );
}
