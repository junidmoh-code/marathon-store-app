// ─── THE ONLINE POOL — what the website may sell, for screens ────────────────
// The one definition of "sellable online" lives in scripts/shopify/inventory.mjs
// (networkTotals + ONLINE_EXCLUDED_LOCATIONS) and is what the Shopify push
// sends. The Cloud Function trigger and the social generator carry copies; this
// is the copy for the app's own screens, so the Total Stock card can show the
// exact number Shopify is being told beside its own "what we own" total
// (docs/SHOPIFY-STOCK-TRUTH.md). Pinned byte-for-byte to the push by
// onlinePool.test.js — if they ever disagree, that test fails.
//
// The rule:
//   · locations: every one EXCEPT In Transit (not pickable) and Hub 3, Pine and
//     Concrete (counts not trusted online — owner decision 2026-09-08)
//   · sizes: only the sizes the product record lists (a stray cell does not ship)
//   · a negative cell counts 0
import { stockSizeKey } from "./sizeKey.js";

export const ONLINE_EXCLUDED_LOCATIONS = Object.freeze([
  "in_transit", "hub3", "marathon-pine", "concrete", "concrete-stockroom",
]);

/**
 * Units the website may sell for one product.
 *   byLoc  { locationId: { sizeKey: cell } | [cells] }  (/stock/{loc}/{pid} as read)
 *   sizes  the product record's own size list
 */
export function onlineUnits(byLoc, sizes) {
  const totals = {};
  for (const size of Array.isArray(sizes) ? sizes : []) totals[stockSizeKey(size)] = 0;
  for (const [loc, cells] of Object.entries(byLoc || {})) {
    if (ONLINE_EXCLUDED_LOCATIONS.includes(loc)) continue;
    if (!cells || typeof cells !== "object") continue;
    for (const [key, cell] of Object.entries(cells)) {
      if (!(key in totals)) continue;
      const qty = cell !== null && typeof cell === "object" ? cell.qty : cell;
      totals[key] += Math.max(0, Number(qty) || 0);
    }
  }
  return Object.values(totals).reduce((a, b) => a + b, 0);
}
