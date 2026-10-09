// ─── IS THIS LINE FOOTWEAR? — the cross-app contract ──────────────────────────
// MIRROR: marathon-pos-app/src/shared/footwearLine.js — KEEP THE TWO IN SYNC.
// Same contract as sizeKey.js / sizeClass.js / categoryTree.js, and for the same
// reason: both apps write the same /stock, so a disagreement here does not
// degrade gracefully — it loses stock.
//
// ONE decision rides on this function, in two places:
//   • store-app — a footwear order does NOT write a hub→shop transfer on Send.
//   • POS       — a footwear sale deducts at the HUB, not the shop.
// If the two apps ever answer differently for the same line, the stock is
// deducted in one place and never credited in the other. That is exactly the
// failure that produced 361 negative footwear cells at Marathon PE.
//
// ── THE RULE: TWO INDEPENDENT KEYS MUST AGREE ────────────────────────────────
//   1. the CATALOGUE says footwear, and
//   2. the LINE'S SIZE is numeric (a shoe size), not a letter size
// Anything else is NOT footwear and keeps today's behaviour exactly.
//
// WHY BOTH. Each key covers the other's blind spot, measured on live data:
//   • Size alone fails on kids shoes. Sizes 26–33 overlap the pants-waist range
//     (waists start at 28), so 28–33 read as clothing. The catalogue key rescues
//     them.
//   • The catalogue alone fails on stray data. "Designer Light Brown 9551" is
//     category Clothing carrying sizes S–XXL plus a stray "5.5"; the size key
//     stops that one line being treated as a shoe.
//
// WHY NOT productType. It is the obvious choice and it is WRONG: 12 live
// products are clothing — Nike Puffer Jacket, Windrunner Jacket, Diesel Cargo
// Jeans, FC Barcelona Away Jersey, Portugal tracksuit and more — carrying
// productType "sneaker". Gate on it and those deduct from a hub.
//
// WHY POSITIVE, NEVER NEGATIVE. `!isClothing` would treat every product with a
// MISSING productType as footwear. The direction of failure is the whole design:
//   • false NEGATIVE → a shoe behaves as it does today. Visible, harmless.
//   • false POSITIVE → clothing deducted from a hub, corrupting stock the refill
//     engine actively manages (867 non-footwear products sit at both a hub and a
//     shop, 4,095 units at the hubs).
// So the answer is NO unless both keys positively say yes.

// Registry keys in the taxonomy's FOOTWEAR group. The precise signal when a
// product has been assigned; `category` is the fallback until the backlog clears.
export const FOOTWEAR_CATEGORY_KEYS = Object.freeze([
  "sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes",
]);

// The legacy top-level category that means footwear. Agrees with the size
// evidence on 3,718 of 3,723 live products (99.9%).
export const FOOTWEAR_LEGACY_CATEGORY = "Footwear";

// Clothing letter sizes: XS, S, M, L and every extra-large spelling —
// repeated-X (XL/XXL/XXXL…) and numeric (2XL/3XL/4XL…). Mirrors the POS's
// sizeClass.js so both apps classify the same strings identically.
const CLOTHING_LETTER_RE = /^(XS|S|M|L|X+L|[2-9]X+L)$/;

/**
 * Does this SIZE look like a shoe size? Numeric only — half sizes included.
 * A letter size, a one-size sentinel, an empty or unknown token → false.
 *
 * NOTE: unlike the POS shoebox rule this does NOT apply the waist-28 cutoff.
 * Kids shoes are 26–33 and would be lost. The waist ambiguity is resolved by
 * requiring the catalogue key as well, not by guessing from the number.
 */
export function sizeLooksLikeShoe(size) {
  if (typeof size !== "string" && typeof size !== "number") return false;
  const s = String(size).trim();
  if (!s || s === "_") return false;
  if (CLOTHING_LETTER_RE.test(s.toUpperCase())) return false;
  // Accept the RTDB-encoded half size ("5_5") as well as the raw "5.5" — the
  // POS and the store-app both key /stock cells with the encoded form, and a
  // return path may hand us either.
  return /^\d+(\.\d+)?$/.test(s) || /^\d+_\d+$/.test(s);
}

/** Does the CATALOGUE say this product is footwear? */
export function productIsFootwear(product) {
  if (!product) return false;
  const key = typeof product.categoryKey === "string" ? product.categoryKey.trim() : "";
  if (key) return FOOTWEAR_CATEGORY_KEYS.includes(key);
  return product.category === FOOTWEAR_LEGACY_CATEGORY;
}

/**
 * THE GATE. True only when the catalogue says footwear AND the size is a shoe
 * size. `product` may be null/undefined (unknown product) → false, keeping
 * today's behaviour.
 *
 * @param {object|null} product  the /products record
 * @param {string|number|null} size  the LINE's size (raw or RTDB-encoded)
 */
export function isFootwearLine(product, size) {
  return productIsFootwear(product) && sizeLooksLikeShoe(size);
}
