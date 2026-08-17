// ── ONE search-index document, built ONE way ─────────────────────────────────
// Shared by the full rebuild (build-search-index.mjs) and the reconciler's
// per-product upsert, so an index entry written by either is byte-identical.
// Two builders would drift, and a drifted index is one where a product's
// searchability depends on which code path last touched it.
//
// ── THE TWO HALVES OF A DOCUMENT, AND THE LINE BETWEEN THEM ──────────────────
// PUBLIC — may be returned by the endpoint:
//   handle, title, price, currency, image, sizes[{size, available}],
//   inStock, collection
// PRIVATE — used ONLY to match, never returned:
//   name      the TRUE brand-carrying identity ("Lacoste Gripshot Lace Boot").
//             Read from /product_identity, NOT from /products.name — the name
//             is being rewritten by the vision namer and the identity is the
//             copy renaming cannot reach (src/utils/searchIdentity.js).
//   extras    brand / model / colourway a vision pass read off the photo, when
//             they are not already inside the identity text
//   aliases   the CANONICAL spelling of every brand/model term the identity
//             contains. The trigger lexicon was built from a census of how
//             this catalogue actually misspells brands ("Timbalend",
//             "Guccie", "Kelvin Klein", "Lacoster"), and it folds each onto
//             one label. Indexing that label means a shopper who types the
//             CORRECT spelling finds a record that carries the wrong one —
//             a real live case: "timberland" vs "Timbalend motion creem",
//             three edits apart and beyond any typo budget worth having.
//   colour    dominant colours read off the photo
//   category  "Footwear", "Boots"
//
// The private half is the whole reason this index exists: it is what a shopper
// types. It lives in /search_index, which is Admin-SDK-only, and the endpoint's
// `publicResult` is an ALLOW-LIST that rebuilds a response field by field — so
// adding a field here can never accidentally publish it.
//
// WHAT IS DELIBERATELY NOT IN A DOCUMENT AT ALL, in either half:
//   stockPrice / retailPrice   the price shown is Shopify's own variant price,
//                              read back from the shop. stockPrice is a B2B
//                              wholesale selling price and has no business here.
//   sku / barcode / barcodes   internal codes. The app's own search matches on
//                              them; a public storefront must not, or the
//                              endpoint becomes a barcode-to-product oracle.
//   productId                  the pid is the key to every other RTDB node.
//                              The index is KEYED by it, so it is a path
//                              segment — it is never a FIELD, and never
//                              serialised into a response.
//   per-location quantities    where stock physically sits. Only a boolean
//                              per size leaves this file.

import { identityTextFor, identityExtras } from "../../src/utils/searchIdentity.js";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

/** The RTDB node. Admin-SDK-only — see the rule to paste in the PR. */
export const SEARCH_INDEX_PATH = "search_index";


// Colour words carried on the record by the photo analyser, plus any colour
// words already in the true name. Both are things a shopper types ("brown
// slide"), and neither is a brand term.
function colourText(product) {
  const dom = product?.dominantColours;
  const names = Array.isArray(dom)
    ? dom.map((c) => (typeof c === "string" ? c : c?.name)).filter(Boolean)
    : dom && typeof dom === "object"
      ? Object.values(dom).map((c) => (typeof c === "string" ? c : c?.name)).filter(Boolean)
      : [];
  return [...new Set(names.map((s) => String(s).trim()).filter(Boolean))].join(" ");
}

/**
 * Build the document for one product.
 *   product         the /products record (the TRUE data)
 *   shopifyProduct  the read-back Shopify product (handle, title, price, variants)
 *   collection      the storefront lane's HANDLE, or null
 *
 * Availability comes from Shopify's own `availableForSale`, not from /stock:
 * what a shopper can buy is what Shopify will sell, and after the inventory
 * -tracking fix those are the same thing. Reading it from the shop means the
 * index cannot disagree with the Add to cart button.
 */
export function buildIndexDoc({ product, shopifyProduct, collection = null, identity = null }) {
  const sp = shopifyProduct;
  const variants = sp?.variants?.nodes ?? [];
  const sizes = variants.map((v) => ({
    size: String(v.title),
    available: v.availableForSale === true,
  }));
  const money = sp?.priceRangeV2?.minVariantPrice;
  // Minor units, integer — a float price in JSON is a rounding argument waiting
  // to happen, and the theme formats it anyway.
  const price = money?.amount != null ? Math.round(Number(money.amount) * 100) : null;
  return {
    // ── public ──
    handle: String(sp?.handle ?? ""),
    title: String(sp?.title ?? ""),
    price,
    currency: String(money?.currencyCode ?? "ZAR"),
    image: sp?.featuredMedia?.preview?.image?.url ?? null,
    sizes,
    inStock: sizes.some((s) => s.available),
    collection,
    // ── private: matched on, never returned ──
    // identityTextFor falls back to the record's name while the migration is
    // incomplete, so search is never worse than it is today — but once an
    // identity exists it WINS, because by then `name` may be a rewritten
    // public name with no brand left in it.
    name: identityTextFor(identity, product),
    extras: identityExtras(identity),
    // Canonical spellings, from the same lexicon the compliance strip uses. Not
    // a second guess at what the product is: a trigger only fires on a term the
    // census actually found in this catalogue.
    aliases: triggersInText(identityTextFor(identity, product)).join(" "),
    colour: colourText(product),
    category: [product?.category, product?.subcategory].filter(Boolean).join(" "),
  };
}
