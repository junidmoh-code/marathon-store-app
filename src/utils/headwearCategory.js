// ─── NORMAL CAPS, BEANIES AND BUCKET HATS ARE "CAPS & BEANIES" — ALWAYS ──────
// Junid, 20 Nov 2026: in Missing Products some normal caps and beanies were
// solvable and others greyed "No refill policy covers this one-size product
// yet". Same kind of product, different result. The census
// (scripts/audit/caps-beanies-solve-census.mjs) found one cause for every
// greyed card: the record was filed as "Chains & Bracelets" (subcategory
// Jewellery). The Add Product form's category picker is a native iPad spinner
// in which Chains & Bracelets sits two rows above Caps & Beanies, and nothing
// compared the choice with the name — so a mis-pick was saved as-is, and the
// caps-beanies refill policy (keyed on categoryKey) never saw the product.
//
// THE RULE, decided by the NAME because the name is what the operator typed
// and the category is what the spinner landed on:
//   • a name saying beanie, cap or bucket hat is a normal piece of headwear;
//   • unless it says visor, fitted, 59FIFTY or "cap sleeve" — visors and
//     fitted caps keep their own categories and sizes (they are out of scope
//     by Junid's rule), and a cap-sleeve top is a garment;
//   • a normal piece of headwear filed under any category OTHER than one a
//     headwear item may legitimately carry (caps-beanies, fitted-caps,
//     visors) is re-filed as caps-beanies.
// A product already in fitted-caps is never moved, whatever its name says.
//
// This decides the KEY only. Sizes follow from the key through the taxonomy
// (caps-beanies is sizeMode "one" → ["_"]); the callers make sure the swap
// never strands a size (see newProductRecord.js and App.jsx).

export const CAPS_BEANIES_KEY = "caps-beanies";
export const FITTED_CAPS_KEY = "fitted-caps";
// Categories a headwear-named product may legitimately carry — never overridden.
const HEADWEAR_KEYS = new Set([CAPS_BEANIES_KEY, FITTED_CAPS_KEY, "visors"]);

const BEANIE = /\bbeanies?\b/i;
const BUCKET_HAT = /\bbucket[\s-]*hats?\b/i;
const CAP = /\bcaps?\b/i;
// Not headwear we sell as caps: cap-sleeve garments, cap-toe shoes, swim /
// shower caps, lens and bottle caps.
const NOT_NORMAL = /\bvisors?\b|\bfitted\b|\b59\s*fifty\b|\bcap[\s-]*sleeves?\b|\bcap[\s-]*toe\b|\b(swim|swimming|shower|lens|bottle)[\s-]*caps?\b/i;

/** "beanie" | "bucket-hat" | "cap" | null — null for anything else, visors and fitted caps included. */
export function normalHeadwearKind(name) {
  const n = String(name ?? "");
  if (!n.trim() || NOT_NORMAL.test(n)) return null;
  if (BEANIE.test(n)) return "beanie";
  if (BUCKET_HAT.test(n)) return "bucket-hat";
  if (CAP.test(n)) return "cap";
  return null;
}

/**
 * The category a product with this name MUST carry instead of `categoryKey`,
 * or null when `categoryKey` is already right (or the name is not normal
 * headwear). Pure.
 */
export function headwearCategoryKeyFor(name, categoryKey) {
  if (!normalHeadwearKind(name)) return null;
  const key = typeof categoryKey === "string" ? categoryKey.trim() : "";
  if (HEADWEAR_KEYS.has(key)) return null;
  return CAPS_BEANIES_KEY;
}

// The legacy triple Caps & Beanies writes (productTaxonomy.js seed row; the
// live registry is read first when the caller has it).
const CAPS_BEANIES_LEGACY_SEED = { category: "Clothing", subcategory: "Caps & Hats", productType: "clothing" };

/**
 * The extra fields to write when a product is RENAMED to a normal-headwear
 * name while filed elsewhere — or null. Only for a product that is already
 * one-size (sizes exactly ["_"]): the key and its legacy triple change, no
 * stock cell or barcode does. A still-sized product is left to the one-size
 * collapse (scripts/collapse-one-size-headwear.mjs), which moves its stock
 * and barcodes safely; a rename must never strand a size.
 *
 * @param {object} product  { sizes, categoryKey } as stored
 * @param {string} newName
 * @param {(key:string)=>object|null} [legacyOf]  registry lookup (legacyFor bound to the live registry)
 */
export function headwearRenamePatch(product, newName, legacyOf) {
  const fixKey = headwearCategoryKeyFor(newName, product && product.categoryKey);
  if (!fixKey) return null;
  const sizes = Array.isArray(product && product.sizes) ? product.sizes.map(String) : [];
  if (!(sizes.length === 1 && sizes[0] === "_")) return null;
  // A supplied registry that refuses the key (retired / misconfigured) means
  // no correction; the seed only stands in when no registry was handed in.
  const legacy = typeof legacyOf === "function" ? legacyOf(fixKey) : CAPS_BEANIES_LEGACY_SEED;
  if (!legacy) return null;
  // productType is NEVER changed by a rename: it has its own manager-gated
  // toggle (setProductType + typeLog). A one-size record whose type differs
  // from what Caps & Beanies writes is left for that toggle, not re-filed here.
  if ((product.productType ?? null) !== (legacy.productType ?? null)) return null;
  const patch = { categoryKey: fixKey, category: legacy.category };
  if (legacy.subcategory != null) patch.subcategory = legacy.subcategory;
  return patch;
}
