// ─── THE SHARED GENERATOR'S LOOK FOR KINDS WITH NO NEW ARRIVALS PLATE ────────
// Caps & beanies, perfume, bags, belts, sunglasses, watches, chains … have no
// New Arrivals look of their own. Their staging (written for Black Friday on
// 19 Nov, Junid) lives HERE, inside the one shared generator (studio.mjs
// generate → generateOther), so every in-app Generate of such a product goes
// through the same model, size and finishing as footwear and clothing.
// Moved unchanged from functions/blackFriday/styles.cjs (20 Nov 2026), which
// re-exports it. Junid's own plates: fence-single.png for things that hang,
// footwear-plate.png's white pedestal for things that stand.
"use strict";

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
    "COLOUR: match the product's true colour exactly as it appears in the product photo — the same hue, the same darkness. Never lighten, brighten, fade or shift it, even though the studio light is brighter than the photo's.",
    "SET: if the product photo shows a set or several pieces sold together (for example a watch with a bracelet and a necklace, or a gift box), show EVERY piece of the set together — never just one of them.",
    ...(hasBox ? ["BOX (the third image): this product's own box. If you show a box, it is exactly this one."] : []),
    `STAGING: ${s.text}`,
    "One product only, centred, in sharp focus, photorealistic, with a soft natural contact shadow. No text, no price, no watermark, no people, no hands, no other products." + (hasBox ? "" : " Do not add a box, a stand or any object that is not in the product photo."),
    conditionClause,
  ].filter(Boolean).join("\n\n");
}

module.exports = { STAGING, HANG, STAND, stagingFor, promptFor, hasStaging: (kind) => Object.prototype.hasOwnProperty.call(STAGING, kind) };
