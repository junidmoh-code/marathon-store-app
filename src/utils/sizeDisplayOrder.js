// ─── THE ORDER A SIZE PICKER SHOWS ───────────────────────────────────────────
// A product's `sizes` array is stored in the order it was typed, so a shoe
// entered as 10, 6, 7… offered 10 first on the Place Order sheet (Diesel slide
// black, 2026-10-03). An all-numeric run is sorted ascending with the size
// registry's own comparator; anything else keeps its stored order — a letter
// run is already written in canonical order, and a mixed or kids run has no
// single scale to sort on. Display only: never mutates the stored array, and
// the cart, the order and the stock cell all still carry the size string as is.
//
// Its own module, not sizeRuns.js: that module's export list is pinned as the
// registry's add-only surface, and a display helper does not belong on it.
import { sizeFamily, compareSizes } from "./sizeRuns";

export function orderSizesForDisplay(sizes) {
  const list = Array.isArray(sizes) ? [...sizes] : [];
  return sizeFamily(list) === "numeric" ? list.sort(compareSizes) : list;
}
