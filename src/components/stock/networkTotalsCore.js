// ─── TOTAL STOCK — PURE LOGIC ─────────────────────────────────────────────────
// One number per product: every size, at every COUNTED location, added together.
// This module holds all of the arithmetic and none of the RTDB, so the rules
// below can be tested and mutation-proved without a database.
//
// ── WHICH LOCATIONS COUNT ────────────────────────────────────────────────────
// Every LIVE location except Pine and Hub 3 — owner decision 2026-08-22.
//
// "Live" is read from the registry's own `active` flag, not from a list here.
// Studio and Base were consolidated into Central in July 2026 and are carried in
// /locations as active:false purely so historical movements stay valid; they do
// not exist as places any more. Deriving the set from `active` means a location
// retired later drops out of this number on its own, with no code change.
//
// The two named exclusions are a separate thing — Pine and Hub 3 are live, they
// are simply not part of the pool he reorders against. They live in
// EXCLUDED_LOCATIONS below rather than in the screen, so the number and the
// caption that explains it can never drift apart.
//
// ── WHY THIS EXISTS SEPARATELY FROM THE LOCATOR ──────────────────────────────
// Locator answers "where is it" — it sums `product.sizes`, the sizes the product
// RECORD declares. That is right for a per-size breakdown and WRONG for a total:
// a cell can exist at a size the record no longer lists (a size run was edited, a
// collapse moved a product to one-size, a merge landed a survivor's cells) and
// those units are still on a shelf. This module sums the CELLS THAT EXIST, never
// a declared size list, so nothing physical can fall out of the total.
//
// ── NEGATIVE CELLS DO NOT COUNT ──────────────────────────────────────────────
// OWNER DECISION 2026-08-22, and a deliberate reversal of how this shipped an
// hour earlier: a negative cell contributes ZERO, and nothing about it is shown.
// The card is a clean list of names and numbers for the pre-order research pass,
// and a −50 in the middle of it was noise he did not want.
//
// Stated plainly because it is a real trade: 980 cells in the live data are
// negative (−1,583 units) and hub3 was net −749 on its own, so this card is
// "what we can count on having", not "what the ledger says". The negatives are
// still real, still visible in Inventory Health's Negative Inventory card, and
// still the ledger's problem to fix — they are just not this screen's job.
//
// ── _meta IS NOT A CELL ──────────────────────────────────────────────────────
// `/stock/{loc}/{pid}/_meta` sits at the SIZE level and is an object, so a naive
// reader counts it as a cell with no qty. The total stays right (it contributes
// 0) but everything the card says ABOUT the total goes wrong: a product whose
// only remaining node at a location is a drained cell's surviving _meta would
// claim "1 cell across 1 location" instead of "no stock recorded anywhere" —
// suppressing the one honest zero-state this module exists to protect. Every
// other stock reader in this repo skips it (hubCountCore, hubCleanupCore,
// product-merge, missingFootwearCore, refillSatisfied); so does this one.
//
// ── ARRAY-SHAPED CELL MAPS ───────────────────────────────────────────────────
// RTDB hands back a JS ARRAY, not an object, when a node's keys are consecutive
// numeric strings — which is exactly what a sneaker's size run ("6","7","8"…)
// looks like. `/stock/hub1/{pid}` really does arrive as [null,null,…,{qty:22}].
// Object.keys() covers both shapes (it skips array holes), so every reader here
// goes through it and never assumes an object.

// The two locations this card does not count. Owner's call: Pine and Hub 3 are
// not part of the pool he reorders against, so their units would distort the
// research number rather than inform it. Named here once; the screen reads this
// list to build both the read plan and the line that tells him what it summed.
export const EXCLUDED_LOCATIONS = ["marathon-pine", "hub3"];

// The locations to sum. `registry` is the /locations map ({ id: {active,…} });
// a location is counted when it is not explicitly retired (active === false) and
// is not one of the two named exclusions.
//
// THE REGISTRY IS THE CLOSED SET, and that is the whole answer to "what about a
// location in /stock that isn't in /locations". Nothing here enumerates /stock's
// own top level, because listing its keys means downloading the 5.36 MB node
// this screen exists to avoid — and it would buy nothing, since the live
// stock_movements rules validate `from`/`to` against /locations existence, so
// units cannot legitimately reach an unregistered location in the first place.
// An id passed in that the registry does not describe is still counted (a caller
// that knows about a location is trusted); the screen simply never has one.
export function countedLocations(locationIds, registry) {
  return [...(locationIds || [])]
    .filter((id) => !EXCLUDED_LOCATIONS.includes(id))
    .filter((id) => (registry && registry[id] ? registry[id].active !== false : true))
    .sort();
}

// Every location's cell map for ONE product, summed.
//
//   byLoc: { locationId: { sizeKey: cell } | [ …cells ] | null }
//
// Returns:
//   total          units across every counted location and every size, with any
//                  negative cell contributing zero
//   cellCount      how many cells were counted (a negative cell still counts as
//                  a cell — it exists, it just adds nothing)
//   locationCount  how many locations hold at least one cell
//   perLocation    { locationId: units } — only locations with cells
//
// A product with no cells anywhere returns total 0 with cellCount 0.
export function sumProduct(byLoc) {
  let total = 0, cellCount = 0;
  const perLocation = {};
  let locationCount = 0;

  for (const locationId of Object.keys(byLoc || {})) {
    const cells = byLoc[locationId];
    if (!cells || typeof cells !== "object") continue;
    let locTotal = 0, locCells = 0;
    for (const sizeKey of Object.keys(cells)) {
      if (sizeKey === "_meta") continue;
      const cell = cells[sizeKey];
      if (!cell || typeof cell !== "object") continue;
      const raw = typeof cell.qty === "number" && Number.isFinite(cell.qty) ? cell.qty : 0;
      locTotal += raw > 0 ? raw : 0;      // a negative cell adds nothing
      locCells += 1;
    }
    if (locCells > 0) { perLocation[locationId] = locTotal; locationCount += 1; cellCount += locCells; total += locTotal; }
  }

  return { total, cellCount, locationCount, perLocation };
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
