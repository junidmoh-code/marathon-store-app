// ─── NEW PRODUCT RECORD BUILDER ───────────────────────────────────────────────
// The pure shape-building half of Add Product, split out of the App.jsx save
// handler so THE critical guarantee is directly testable:
//
//   a product created through the new category form must be indistinguishable,
//   to every existing automation, from one created through the old form.
//
// "Every existing automation" means, concretely:
//   • functions/lib/refill-engine.cjs  isClothing()      → productType
//   • functions/displayChecks/lib.cjs  isClothingSale()  → category | productType
//   • marathon-pos-app ProductSearchScreen               → category / subcategory / brand
//   • marathon-pos-app shoeboxToggle                     → the size STRING only
//
// So this writes the legacy triple derived from the chosen category, and only
// ADDS `categoryKey` alongside. It never removes or rewrites a legacy field.

import { legacyFor, sizesOf, catByKey } from "./productTaxonomy.js";
import { normaliseStyleCode, formatStyleCodeForDisplay } from "./styleCode.js";

export const VALID_HUBS = ["hub1", "hub2", "hub3"];

/**
 * Phase 14A rule, unchanged: clothing cannot be stocked at Hub 1. Strips hub1
 * for clothing, drops anything that isn't a real hub, and falls back to a
 * sensible default rather than writing an empty list.
 */
export function cleanHubs(hubs, isClothing) {
  const cleaned = (Array.isArray(hubs) ? hubs : [])
    .filter((h) => (isClothing ? h !== "hub1" : true))
    .filter((h) => VALID_HUBS.includes(h));
  if (cleaned.length) return [...new Set(cleaned)];
  return isClothing ? ["hub2"] : ["hub1"];
}

/**
 * Build the /products record for a new product.
 *
 * Returns null when the category does not resolve — the caller must refuse the
 * save rather than write a product with no legacy fields, which would fall out
 * of refill, Display Checks and POS browse silently.
 *
 * @param {object}   registry   live taxonomy registry
 * @param {object}   form       { name, categoryKey, photo, hubs, stockPrice, retailPrice, hasShoeBoxOption }
 * @param {object}   extras     { id, photoUrl, brand, photoUploaded, styleCode }
 */
export function buildNewProduct(registry, form, extras = {}) {
  const cat = catByKey(registry, form && form.categoryKey);
  // legacyFor returns null for an unknown key, a RETIRED category, or a legacy
  // block whose category/productType are not legal values — see isLegalLegacy.
  // Refusing here is the guard that stops a console typo (productType
  // "apparel") from creating a product that silently sits outside the refill
  // sweep and Display Checks with nothing on screen to say so.
  const legacy = legacyFor(registry, form && form.categoryKey);
  if (!cat || !legacy) return null;

  const sizes = sizesOf(cat);
  if (!sizes.length) return null;

  const isClothing = legacy.productType === "clothing";

  const product = {
    name: String(form.name || "").trim(),
    // ── NEW — inert. Nothing in either repo reads it yet.
    categoryKey: cat.key,
    // ── LEGACY — load-bearing. Do not remove.
    category: legacy.category,
    brand: extras.brand ?? null,
    photo: form.photo,
    photoUrl: extras.photoUrl ?? null,
    hubs: cleanHubs(form.hubs, isClothing),
    sizes,
    id: extras.id,
  };

  // OMITTED, not written as null, when the category has no legacy equivalent:
  // Loafers and Dresses have no leaf in the old tree, and Perfume deliberately
  // carries no productType so it matches the 53 live perfume records and stays
  // out of the refill lane while Display Checks still fire on its CATEGORY.
  if (legacy.subcategory != null) product.subcategory = legacy.subcategory;
  if (legacy.productType != null) product.productType = legacy.productType;

  // Prices: empty / non-finite / non-positive → omit entirely. Writing 0 would
  // make the POS treat the product as free.
  const stockNum = Number(form.stockPrice);
  const retailNum = Number(form.retailPrice);
  if (Number.isFinite(stockNum) && stockNum > 0) product.stockPrice = stockNum;
  if (Number.isFinite(retailNum) && retailNum > 0) product.retailPrice = retailNum;

  // Explicit for POS (legacy products without it read as false per SCHEMA.md).
  // Clothing NEVER has a shoebox regardless of form state.
  product.hasShoeBoxOption = isClothing ? false : !!form.hasShoeBoxOption;

  if (extras.photoUploaded && extras.photoUpdatedAt != null) product.photoUpdatedAt = extras.photoUpdatedAt;

  // ── STYLE CODE — the manufacturer code off the inside-tongue label ─────────
  // Two fields, both written or neither:
  //   styleCode            the human-readable form, as the brand prints it
  //   styleCodeNormalised  the identity key — uppercase, separators stripped.
  //                        THIS is what lookups, the /sneaker_models cache and
  //                        the duplicate check match on, and what the /products
  //                        .indexOn covers.
  // OMITTED (not written as null) when there is no code: clothing, accessories
  // and perfume have no style code, and a null on every one of them is 5,000
  // pointless bytes that also make "has a code" a two-condition test everywhere.
  // Absent means "no code" — every reader must tolerate it.
  const styleCodeNormalised = normaliseStyleCode(extras.styleCode);
  if (styleCodeNormalised) {
    // Keep the operator's spelling when they gave one; otherwise render the
    // canonical form. The KEY is always the normalised value either way.
    const typed = String(extras.styleCode || "").trim();
    product.styleCode = typed || formatStyleCodeForDisplay(styleCodeNormalised);
    product.styleCodeNormalised = styleCodeNormalised;
  }

  return product;
}
