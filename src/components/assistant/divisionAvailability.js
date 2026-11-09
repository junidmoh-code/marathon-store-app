// ─── A DIVISION'S OWN STOCK, ON THE ASSISTANT'S ORDER SCREEN ─────────────────
//
// Junid, 9 Nov 2026: Hub 3 is counted. Pine and Concrete assistants see what
// Hub 3 holds, exactly as Marathon PE and Trophy see Hub 1 and Hub 2.
//
// WHICH hub a shop reads is not decided here — that is the network registry
// (sectionRouting / sectionSneakerHubs: a shop reads the hubs on its own side
// of the wall that serve it, and nothing else). This file holds the two
// questions the screen asks of the cells it has already read:
//
//   • stockedAtHubs      does one of this shop's hubs hold a unit of a product?
//   • productUnavailable is every size of a product out, for this shop?
//
// Pure: no firebase, no clock, no React. The cells are the DECODED maps the
// screen streams (useStockCellsState: { pid: { size: { qty } } }).

/**
 * A predicate over products: true when one of the given hubs — each
 * `{ cells, ready }`, the screen's read state for one hub subtree — has been
 * READ and books at least one unit of the product in any size.
 *
 * A hub that has not answered says nothing: it never makes a product stocked.
 * Booked units, not available ones: this decides whether a product belongs in
 * the shop's catalogue at all, and a pair promised to an order is still the
 * shop's stock.
 */
export function stockedAtHubs(hubs) {
  const stocked = new Set();
  for (const h of hubs || []) {
    if (!h || h.ready !== true || !h.cells) continue;
    for (const pid of Object.keys(h.cells)) {
      if (stocked.has(pid)) continue;
      const sizes = h.cells[pid];
      if (!sizes || typeof sizes !== "object") continue;
      for (const k of Object.keys(sizes)) {
        const cell = sizes[k];
        const qty = cell && typeof cell === "object" ? cell.qty : cell;
        if (Number(qty) > 0) { stocked.add(pid); break; }
      }
    }
  }
  return (product) => !!product && stocked.has(product.id);
}

/**
 * Is this product unavailable to this shop — every size out?
 *
 *   sizes     the sizes the card offers (already filtered of blanks)
 *   known     has availability been ANSWERED for this product? (the hub that
 *             would supply it is read and not errored). Unknown is never
 *             "unavailable": a card must not say so before the hub answers.
 *   sizeOut   (size) => boolean, the screen's own per-size answer — the same
 *             one that draws the ✕ on the size chip, so a card and its sizes
 *             cannot disagree.
 *
 * A product with no sizes is not "unavailable" (there is nothing to be out of).
 */
export function productUnavailable({ sizes, known, sizeOut }) {
  if (known !== true) return false;
  const list = Array.isArray(sizes) ? sizes : [];
  if (!list.length) return false;
  return list.every((s) => sizeOut(s) === true);
}
