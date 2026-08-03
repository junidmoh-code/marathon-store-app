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

  return rows.sort(byName);
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
    // The TRUE sum, negatives included. A hub cell can legitimately sit negative
    // (a dispatch off an uncounted cell), and hiding that behind a clamp would
    // conceal exactly the discrepancy a stock-take exists to find.
    total: sizes.reduce((t, s) => t + s.expected, 0),
    seeded,
    sizes,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

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
  const sizes = raw
    .map((s) => stockSizeKey(s))
    .filter(isCountableSizeKey)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .map((sizeKey) => ({ sizeKey, label: sizeLabelOf(sizeKey), expected: 0 }))
    .sort((a, b) => footwearSizeRank(a.sizeKey) - footwearSizeRank(b.sizeKey));
  if (!sizes.length) return null;
  return makeRow(product, sizes, true);
}

/**
 * Merge manually-added (seeded) rows into the hub rows, dropping any that the
 * hub snapshot already covers — adding a product that turns out to HAVE cells
 * must not produce two rows for one product.
 */
export function mergeSeededRows(hubRows, seededRows) {
  const have = new Set(hubRows.map((r) => r.id));
  return [...hubRows, ...seededRows.filter((r) => r && !have.has(r.id))].sort(byName);
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
 * The variance list: every recorded cell where actual !== expected.
 * Sorted by absolute delta, largest first — the numbers worth arguing about are
 * at the top rather than buried in alphabetical order.
 */
export function varianceRows(counted = {}, productsById = new Map()) {
  const byId = productsById instanceof Map ? productsById : new Map(Object.entries(productsById || {}));
  return Object.entries(counted)
    .map(([key, rec]) => ({ key, ...rec }))
    .filter((r) => Number(r.actual) !== Number(r.expected))
    .map((r) => ({
      ...r,
      delta: Number(r.actual) - Number(r.expected),
      name: byId.get(r.productId)?.name || r.productId,
      sizeLabel: sizeLabelOf(r.sizeKey),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
}

/** Filter rows by the search box (name or code), case/punctuation-insensitive. */
export function filterRows(rows, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q) || (r.code && r.code.toLowerCase().includes(q))
  );
}
