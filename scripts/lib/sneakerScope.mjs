// ── WHICH PRODUCTS ARE "SNEAKERS" FOR THIS BUILD ─────────────────────────────
// One definition, shared by the extractor, the neighbour builder and the census
// scripts, so a product that is enriched is exactly a product that can be
// suggested and a product that can be ranked.
//
// It is productIsFootwear (src/utils/footwearLine.js — the cross-app contract
// the POS mirrors) plus "designer-shoes", which the owner brief names and which
// footwearLine does not carry because it never had a stock consequence. Four
// live products, and leaving them out would leave four shoes able to be
// suggested-to but never suggested.
//
// Measured 2026-09-06 across 4,710 /products records:
//   sneakers 1,257 · soccer-boots 80 · slides 64 · designer-shoes 4
//   + legacy category "Footwear" with no categoryKey
//   = 1,410 products, of which 1,407 carry a photo.
//
// The other three footwearLine keys (running-shoes, boots, loafers, kids-shoes)
// have NO live products today. They are kept in scope anyway: a product
// assigned one of them tomorrow must be enriched without anybody remembering
// to widen a list.
import { FOOTWEAR_CATEGORY_KEYS, FOOTWEAR_LEGACY_CATEGORY } from "../../src/utils/footwearLine.js";

export const SNEAKER_CATEGORY_KEYS = Object.freeze([...FOOTWEAR_CATEGORY_KEYS, "designer-shoes"]);

export const SNEAKER_SCOPE_NOTE =
  `scope: footwear categoryKeys [${SNEAKER_CATEGORY_KEYS.join(", ")}], ` +
  `falling back to legacy category "${FOOTWEAR_LEGACY_CATEGORY}" when a product has no key`;

/**
 * Is this product in the sneaker group? Mirrors productIsFootwear's precedence
 * exactly — an assigned categoryKey WINS over the legacy category, and a blank
 * key falls through to it.
 */
export function isSneakerProduct(product) {
  if (!product) return false;
  const key = typeof product.categoryKey === "string" ? product.categoryKey.trim() : "";
  if (key) return SNEAKER_CATEGORY_KEYS.includes(key);
  return product.category === FOOTWEAR_LEGACY_CATEGORY;
}
