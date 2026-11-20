// ─── BLACK FRIDAY 2026 — THE HOUSE LOOK FOR EACH KIND OF PRODUCT ─────────────
// Junid, 19 Nov evening: the AI look is chosen by the product's category, and
// the sneaker formula is never used for anything else.
//   sneakers  → the New Arrivals footwear look (black-rail mesh fence, white
//               pedestal, box mounted above, side-on, one direction) — studio engine
//   clothing  → the New Arrivals hanger look on the same fence (wider fence for
//               two-piece sets) — studio engine
//   every other kind → a staging written HERE, on the same backdrop family:
//               Junid's own plates (fence-single.png for things that hang,
//               footwear-plate.png's white pedestal for things that stand).
// The product is ALWAYS kept exactly as photographed: same type, colour and details.
"use strict";

// The kinds the build gives a product (marathon-group-poster src/bf/core.mjs kindOf).
const ESTABLISHED = Object.freeze(["sneakers", "clothing"]);

// The app categories (categoryKey) the studio engine knows, and how a Black
// Friday clothing item it does not know is framed: a set on the two-piece
// fence, anything else on one hanger.
const TWO_PIECE = Object.freeze(["tracksuits", "ladies-tracksuits", "suits"]);
const KNOWN_SINGLE = Object.freeze(["t-shirts", "golf-t-shirts", "hoodies", "sweaters", "jackets", "pants", "jeans", "shorts", "cargo-pants", "basketball-vests", "baseball-shirts", "soccer-jerseys", "dresses", "underwear"]);
/** The categoryKey to hand the studio engine for a clothing product. Pure. */
function clothingKeyFor(categoryKey) {
  const k = String(categoryKey || "");
  if (TWO_PIECE.includes(k)) return "tracksuits";
  if (KNOWN_SINGLE.includes(k)) return k;
  return "baseball-shirts"; // shirts and any other single garment: one hanger (the "single" plate)
}

// The stagings themselves live in the ONE shared generator (newArrivals/studio/staging.cjs, 20 Nov 2026).
const { STAGING, HANG, STAND, stagingFor, promptFor } = require("../newArrivals/studio/staging.cjs");

module.exports = { ESTABLISHED, TWO_PIECE, KNOWN_SINGLE, STAGING, HANG, STAND, clothingKeyFor, stagingFor, promptFor };
