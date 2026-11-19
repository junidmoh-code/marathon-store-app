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

const HANG = "fence-single.png";
const STAND = "footwear-plate.png";
const STAGING = Object.freeze({
  headwear: { plate: HANG, text: "Display it AS HEADWEAR: a cap hung by its back strap on a single small hook on the fence at head height, peak and front logo turned three-quarters to the camera; a beanie shown upright, gently filled out as if worn, on the same hook. It must stay exactly this cap or beanie — never a shoe, a garment or any other product." },
  perfume: { plate: STAND, text: "Stand the bottle UPRIGHT on the white pedestal, its label facing the camera. If the product photo shows its box, stand that same box upright just behind and beside the bottle, its front visible. Keep the bottle's exact shape, cap, label, glass and liquid colour." },
  bags: { plate: HANG, text: "Hang the bag by its own strap or handle from a single hook on the fence, its front facing the camera, natural shape (not stuffed out of shape). Keep its exact shape, size, hardware, stitching and logos." },
  belts: { plate: HANG, text: "Hang the belt in one neat loop from a single hook on the fence, the buckle at the front facing the camera. Keep the exact buckle, leather or fabric, colour and logo." },
  sunglasses: { plate: STAND, text: "Rest the sunglasses on the white pedestal, arms open, lenses facing the camera, a slight three-quarter turn. Keep the exact frame shape, lens tint and logos." },
  watches: { plate: STAND, text: "Show the watch on the white pedestal, dial facing the camera, the strap curved naturally as if closed around a wrist. Keep the exact dial, case, strap and every marking." },
  jewellery: { plate: STAND, text: "Drape the chain or bracelet neatly over the white pedestal, any pendant or clasp detail facing the camera. Keep the exact links, metal colour and every detail." },
  accessories: { plate: HANG, text: "Display it the way a shop shows this kind of item — hung from a single hook on the fence, or standing on a small white shelf if it cannot hang — its front facing the camera." },
});

/** The staging for a kind (never the sneaker formula for anything but sneakers). Pure. */
const stagingFor = (kind) => STAGING[kind] || STAGING.accessories;

/** The prompt for a non-established kind. Pure. */
function promptFor(kind, { hasBox = false, conditionClause = "" } = {}) {
  const s = stagingFor(kind);
  return [
    "You are photographing a real product for a shop's Black Friday post, in the shop's own house style.",
    "BACKDROP (the first image): the shop's own studio backdrop — a black-rail mesh fence" + (s.plate === STAND ? " with a white pedestal" : "") + ". Keep it exactly: the same fence, the same light, the same colours. Do not redraw, recolour or extend it.",
    "PRODUCT (the second image): the real item being sold. Show THIS EXACT ITEM: the same kind of product, the same colour or colours, the same logos, text, pattern, stitching, materials, hardware and every detail, the same proportions. NEVER turn it into another kind of product, NEVER change its colour, NEVER add, remove or redesign any part.",
    ...(hasBox ? ["BOX (the third image): this product's own box. If you show a box, it is exactly this one."] : []),
    `STAGING: ${s.text}`,
    "One product only, centred, in sharp focus, photorealistic, with a soft natural contact shadow. No text, no price, no watermark, no people, no hands, no other products.",
    conditionClause,
  ].filter(Boolean).join("\n\n");
}

module.exports = { ESTABLISHED, TWO_PIECE, KNOWN_SINGLE, STAGING, HANG, STAND, clothingKeyFor, stagingFor, promptFor };
