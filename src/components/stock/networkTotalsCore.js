// ─── NETWORK TOTALS — PURE LOGIC ──────────────────────────────────────────────
// One number per product: every size, at every location, added together. This
// module holds all of the arithmetic and none of the RTDB, so the rules below
// can be tested and mutation-proved without a database.
//
// ── WHY THIS EXISTS SEPARATELY FROM THE LOCATOR ──────────────────────────────
// Locator answers "where is it" — it sums `product.sizes`, the sizes the product
// RECORD declares. That is right for a per-size breakdown and WRONG for a total:
// a cell can exist at a size the record no longer lists (a size run was edited, a
// collapse moved a product to one-size, a merge landed a survivor's cells) and
// those units are still on a shelf. This module sums the CELLS THAT EXIST, never
// a declared size list, so nothing physical can fall out of the total.
//
// ── NEGATIVES ARE NEVER CLAMPED ──────────────────────────────────────────────
// 980 cells in the live data are negative, totalling −1,583 units, and hub3 is
// net −749 on its own. A clamp would turn the single loudest signal in the data
// into a silent zero. sumProduct() adds the raw qty and separately reports every
// negative cell it passed, so the card can SHOW the drag instead of hiding it.
//
// ── ARRAY-SHAPED CELL MAPS ───────────────────────────────────────────────────
// RTDB hands back a JS ARRAY, not an object, when a node's keys are consecutive
// numeric strings — which is exactly what a sneaker's size run ("6","7","8"…)
// looks like. `/stock/hub1/{pid}` really does arrive as [null,null,…,{qty:22}].
// Object.keys() covers both shapes (it skips array holes), so every reader here
// goes through it and never assumes an object.

// Every location's cell map for ONE product, summed.
//
//   byLoc: { locationId: { sizeKey: cell } | [ …cells ] | null }
//
// Returns:
//   total          net units across every location and every size, RAW
//   cellCount      how many cells were counted
//   locationCount  how many locations hold at least one cell
//   negatives      [{ locationId, sizeKey, qty }] — every cell below zero
//   negativeUnits  the sum of those (a negative number, or 0)
//   perLocation    { locationId: net units } — only locations with cells
//
// A product with no cells anywhere returns total 0 with cellCount 0. That is the
// honest answer for the 196 live products in that state: zero, not blank, not an
// error, and `cellCount === 0` lets the card say "none recorded anywhere" rather
// than implying a counted zero.
export function sumProduct(byLoc) {
  let total = 0, cellCount = 0, negativeUnits = 0;
  const negatives = [];
  const perLocation = {};
  let locationCount = 0;

  for (const locationId of Object.keys(byLoc || {})) {
    const cells = byLoc[locationId];
    if (!cells || typeof cells !== "object") continue;
    let locTotal = 0, locCells = 0;
    for (const sizeKey of Object.keys(cells)) {
      const cell = cells[sizeKey];
      if (!cell || typeof cell !== "object") continue;
      const qty = typeof cell.qty === "number" && Number.isFinite(cell.qty) ? cell.qty : 0;
      locTotal += qty;
      locCells += 1;
      if (qty < 0) { negatives.push({ locationId, sizeKey, qty }); negativeUnits += qty; }
    }
    if (locCells > 0) { perLocation[locationId] = locTotal; locationCount += 1; cellCount += locCells; total += locTotal; }
  }

  return { total, cellCount, locationCount, negatives, negativeUnits, perLocation };
}

// Order rows for display. Rows whose total has NOT arrived yet sort last in both
// directions and keep a stable name order among themselves — a row must never
// jump from the bottom of the list to the top and back while its read lands.
// Ties break on name so the order is deterministic across renders.
export function sortRows(rows, direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const aHas = a && a.totals != null, bHas = b && b.totals != null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && a.totals.total !== b.totals.total) return sign * (a.totals.total - b.totals.total);
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });
}

// Which products the card should be holding totals for right now: one page of
// the search result when there is a query, otherwise one page of the catalogue.
// Kept pure so the test can prove the card never asks for more than it shows.
//
// SEARCH IS PAGED TOO, and that is a cost decision, not a tidiness one. Measured
// on the live catalogue, a broad query like "nike" or "air force" matches far
// more than a screenful: unpaged it pulled 115–121 KB in one keystroke, versus
// 44 KB for a page of 25. Paging both modes makes every page of this card cost
// the same, whichever way he got to it.
export function visibleProducts(products, matches, query, pageSize) {
  const q = String(query ?? "").trim();
  const source = q ? (matches || []) : (products || []);
  return source.slice(0, Math.max(0, pageSize));
}
