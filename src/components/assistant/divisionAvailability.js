// ─── A DIVISION'S OWN STOCK, ON THE ASSISTANT'S ORDER SCREEN ─────────────────
//
// Junid, 9 Nov 2026: Hub 3 is counted. Pine and Concrete assistants see what
// Hub 3 holds, exactly as Marathon PE and Trophy see Hub 1 and Hub 2.
//
// WHICH hub a shop reads is not decided here — that is the network registry
// (sectionRouting / sectionSneakerHubs: a shop reads the hubs on its own side
// of the wall that serve it, and nothing else). This file holds the
// questions the screen asks of the cells it has already read:
//
//   • heldProductKey     which products have a cell at this shop's hubs?
//   • productUnavailable is every size of a product out, for this shop?
//   • unavailableHint    what the size sheet says when it is
//
// Pure: no firebase, no clock, no React. The cells are the DECODED maps the
// screen streams (useStockCellsState: { pid: { size: { qty } } }).

/**
 * The screen's read state for one hub subtree (useStockCellsState:
 * { cells, settled, error }) as the `{ cells, ready }` the questions below
 * take. Ready only once the subtree has ANSWERED and not errored — the same
 * test the size chips' ✕ waits for (App.jsx sneakerGateReady).
 */
export function hubReadState(state) {
  return { cells: (state && state.cells) || {}, ready: !!state && state.settled === true && !state.error };
}

/**
 * The ids of every product with a cell at one of the given hubs — each
 * `{ cells, ready }` — as one string, so the screen can tell "the list changed"
 * from "a quantity changed". A hub that has not answered says nothing.
 *
 * A CELL, NOT A UNIT. This decides whether a product belongs in the shop's
 * catalogue. Asking for a unit would drop a shoe from the grid the moment its
 * last pair sold; with a cell it stays, and reads Unavailable.
 */
export function heldProductKey(hubs) {
  const held = new Set();
  for (const h of hubs || []) {
    if (!h || h.ready !== true || !h.cells) continue;
    for (const pid of Object.keys(h.cells)) {
      const sizes = h.cells[pid];
      if (sizes && typeof sizes === "object" && Object.values(sizes).some((c) => c !== null && c !== undefined)) held.add(pid);
    }
  }
  return [...held].sort().join("\n");
}

/** A predicate over products, from heldProductKey's answer. */
export function heldPredicate(key) {
  const held = new Set(key ? key.split("\n") : []);
  return (product) => !!product && held.has(product.id);
}

/** One step: does one of these hubs have a cell for the product? */
export const stockedAtHubs = (hubs) => heldPredicate(heldProductKey(hubs));

/**
 * The product ids, out of `products`, that are unavailable to this shop.
 * `judge(product)` returns productUnavailable's arguments for one product, or
 * null for "not judged" (a deactivated line, which says so itself).
 * One pass, so the screen can keep the answer until its inputs change.
 */
export function unavailableProductIds(products, judge) {
  const out = new Set();
  for (const p of products || []) {
    if (!p || !p.id) continue;
    const args = judge(p);
    if (args && productUnavailable(args)) out.add(p.id);
  }
  return out;
}

/**
 * Is this product unavailable to this shop — every size out?
 *
 *   sizes     the sizes the card offers (already filtered of blanks)
 *   known     has availability been ANSWERED for this product? (the hub that
 *             would supply it is read and not errored). Unknown is never
 *             "unavailable": a card must not say so before the hub answers.
 *   sizeOut   (size) => boolean: does the hub have none to give, leaving this
 *             device's cart out of it? A size can show ✕ because the cart holds
 *             the last pair while the card, truthfully, is not Unavailable.
 *
 * A product with no sizes is not "unavailable" (there is nothing to be out of).
 */
export function productUnavailable({ sizes, known, sizeOut }) {
  if (known !== true) return false;
  const list = Array.isArray(sizes) ? sizes : [];
  if (!list.length) return false;
  return list.every((s) => sizeOut(s) === true);
}

/**
 * The line the size sheet shows for an unavailable product.
 *
 * `similar`: the product is one the alternatives sheet answers for (footwear).
 * The alternatives are found per SIZE — every row is sellable in the size
 * asked for — so the sheet asks for the customer's size rather than guessing
 * one. Anything else is only told where it is not.
 */
export function unavailableHint(hubLabels, { similar = true } = {}) {
  const where = (hubLabels || []).filter(Boolean).join(" or ") || "the hub";
  return similar
    ? `No size of this is at ${where} right now. Tap the customer's size to see similar shoes that are.`
    : `No size of this is at ${where} right now.`;
}
