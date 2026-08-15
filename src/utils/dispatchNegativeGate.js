// ─── MAY THIS DISPATCH DRIVE A HUB CELL NEGATIVE? ─────────────────────────────
// One question, one answer, one place. Used by the customer-order dispatch
// (`recordDispatchTransfer` in App.jsx) to decide whether to pass
// `allowNegative` into applyMovement.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The A1 stock-integrity rule is right: a SNEAKER dispatch always moves the
// ledger, because the parcel physically leaves the hub whether or not the hub
// cell was ever counted. The resulting hub negative is an honest shortage
// signal for the count team, not a bug.
//
// The gate that expressed that rule was a DENY-LIST — `allowNegative: !isClothing`
// — and a deny-list grants the exemption to everything nobody thought about.
// On 2026-07-27 four bottles of "Lacoste original 100ML" were dispatched out of
// hub1, a hub that has never held a single unit of perfume (hub1 holds exactly
// one perfume cell today: the −4 those four dispatches created). The negative
// floor in applyMovement would have refused all four; the deny-list disabled it
// because a perfume is "not clothing". hub1 went to −4 and Marathon PE was
// credited with four units whose ledger source was a shelf that never held them.
//
// So this is an ALLOW-LIST: the exemption is granted only to the class the A1
// rule was actually written for. Everything else — perfume, bags, watches,
// accessories, an unrecognised product — gets the floor back, and a short hub
// returns `insufficient_stock` so the picker resolves it instead of the ledger
// minting stock.
//
// ── WHY THE CATALOGUE, NOT `order.productType` ───────────────────────────────
// The obvious reading of "allow only sneakers" is `order.productType === "sneaker"`.
// It does not work, and would have been a NO-OP on the very incident above.
// Orders stamp their type at placement with `item.product.productType || "sneaker"`
// (App.jsx). All 63 perfume records deliberately OMIT `productType` — that
// omission is what keeps perfume out of the clothing refill lane — so every
// perfume order is already stamped `"sneaker"` in the order record. The four
// Case-3 orders carry `productType: "sneaker"` in insights_log. Reading the
// order's own stamp asks the poisoned field.
//
// The catalogue `productType` is no better as the key: measured on live data
// (4,167 products, 2026-08-15), 794 of the 1,398 genuine footwear records carry
// NO `productType` at all, so keying on it would strip the A1 exemption from
// 57% of real shoes. And four non-footwear records (a jacket, jeans, two
// designer-shoe/Clothing oddities) carry `productType: "sneaker"`.
//
// The reliable key is the one footwearLine.js already established for the same
// reason and documents at length: the CATALOGUE category. `productIsFootwear`
// agrees with the independent size evidence on 3,718 of 3,723 live products.
// This module reuses it rather than inventing a second answer to "is this a
// shoe?".
//
// ── WHY NOT `isFootwearLine` (catalogue AND shoe size) ───────────────────────
// Because a line that passes `isFootwearLine` never reaches this decision:
// since the 2026-07-29 sneakers-sell-from-hub cutover, `recordDispatchTransfer`
// short-circuits those lines and writes no transfer at all. What still reaches
// applyMovement is a footwear product whose LINE SIZE isn't numeric (a missing
// size, a "Free Size" sentinel). That is a real shoe leaving a real hub, so it
// keeps the A1 exemption exactly as it has today. Gating on the size as well
// would silently change behaviour for those lines, which this change must not do.

import { productIsFootwear } from "./footwearLine";

/**
 * May a customer-order dispatch of this product drive the source hub negative?
 *
 * TRUE only for a product the CATALOGUE says is footwear. Clothing, perfume,
 * bags, watches, accessories, and an unknown/absent product all answer false
 * and keep applyMovement's negative floor.
 *
 * @param {object|null|undefined} product  the /products record for the order's
 *   productId (NOT the order record — see the note above on why the order's own
 *   `productType` is not usable here). A missing product answers false.
 * @returns {boolean}
 */
export function dispatchAllowsNegative(product) {
  return productIsFootwear(product);
}
