// ─── PRODUCT TAXONOMY — the new category system ───────────────────────────────
// ONE flat list of 31 real categories ("what the product actually is"), each
// carrying its own size breakdown, replacing the old Category-dropdown +
// Product-Type-row pair in the Add Product form.
//
// WHERE IT LIVES: the live registry is RTDB `/settings/productTaxonomy`. The app
// READS it at runtime (useTaxonomy), so ADDING A CATEGORY LATER IS A DATA EDIT —
// no code change, no deploy. The SEED below is what `scripts/seed-product-
// taxonomy.mjs` writes on first run, and doubles as the offline fallback if the
// registry read fails (so the Add Product form can never be bricked by a bad
// read). It is NOT the runtime source of truth.
//
// ── THE CRITICAL PART: LEGACY DERIVATION ─────────────────────────────────────
// Every category carries a `legacy` triple. On save, the form writes the new
// `categoryKey` AND these legacy `category` / `subcategory` / `productType`
// values, because EVERY existing automation still keys off the legacy fields and
// none of them know `categoryKey` exists:
//
//   • refill engine   — functions/lib/refill-engine.cjs isClothing(): explicit
//                       `productType` wins, else a letter-size heuristic.
//   • Display Checks  — functions/displayChecks/lib.cjs isClothingSale():
//                       `category === "Perfume"` OR `productType === "clothing"`.
//   • POS browse      — marathon-pos-app ProductSearchScreen reads `category` /
//                       `subcategory` / `brand`.
//   • POS shoebox     — keys off the SIZE STRING only, never the category.
//
// So a product created through the new form is indistinguishable, to every one
// of those readers, from one created through the old form. Change a `legacy`
// value here and you change live automation behaviour — read the table in the
// PR before touching it.
//
// `flags` are DELIBERATELY EMPTY, UNUSED slots for future per-category behaviour
// (refill-managed / display-checks / one-size overrides). Nothing reads them in
// this build; they exist so the follow-up work is a data edit too.

// ── Size sets ────────────────────────────────────────────────────────────────
// APPAREL: S..XXXL, matching the refill engine's standard run EXACTLY
// (config.defaultRunByStore covers S,M,L,XL,XXL,XXXL). XS was specced but the
// live-data check found ZERO products and ZERO /stock cells using it, so it is
// deliberately left out — adding it would have created No-Target-queue entries
// for a size nobody stocks.
export const SIZES_APPAREL = ["S", "M", "L", "XL", "XXL", "XXXL"];

// FOOTWEAR: includes 5.5 — the live-data check found 460 products and 504 stock
// cells (325 non-zero, 800 units) on that size. Dropping it would have made the
// third-most-common shoe size unreceivable.
export const SIZES_FOOTWEAR = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"];

export const SIZES_KIDS = ["26", "27", "28", "29", "30", "31", "32", "33"];
export const SIZES_FITTED_CAP = ["55", "56", "57", "58", "59", "60", "61", "62", "63"];
export const SIZES_GLOVES = ["M", "L"];

// One-size products carry the single "_" sentinel — the same sentinel /stock,
// the barcode catalog and the POS size handling already use for size-less lines.
export const ONE_SIZE_SENTINEL = "_";
export const SIZES_ONE = [ONE_SIZE_SENTINEL];

// Empty behaviour-flag slots. Cloned onto every seeded category. UNUSED.
const EMPTY_FLAGS = { refillManaged: null, displayChecks: null, oneSize: null };

// ── The top-level groups (the dropdown's optgroups) ──────────────────────────
// FOOTWEAR is its own group (owner call 2026-07-26): Sneakers, Boots, Soccer
// Boots, Slides, Loafers, Running Shoes and Kids Shoes are shoes, and a picker
// that files them under a heading reading "CLOTHING" contradicts the whole point
// of this rebuild. Grouping is PRESENTATION ONLY — `top` never reaches a product
// record, and no predicate or derivation reads it (see groupedCategories, and
// the "grouping is display-only" tests).
export const TAXONOMY_TOPS = {
  footwear: { key: "footwear", label: "Footwear", order: 1 },
  clothing: { key: "clothing", label: "Clothing", order: 2 },
};

// ── The 31 categories ────────────────────────────────────────────────────────
// [key, label, top, sizes, legacyCategory, legacySubcategory, legacyProductType]
// legacySubcategory === null → the field is OMITTED on save (no legacy leaf
// exists for it). We never write "Clothing — Uncategorized": that string is the
// old Categories review backlog, and using it would dump every new Dress into a
// queue it does not belong in.
const SEED_ROWS = [
  // ── Footwear-sized ─────────────────────────────────────────────────────────
  ["sneakers",          "Sneakers",           "footwear", SIZES_FOOTWEAR,   "Footwear",    "Sneakers",              "sneaker"],
  ["running-shoes",     "Running Shoes",      "footwear", SIZES_FOOTWEAR,   "Footwear",    "Sneakers",              "sneaker"],
  ["boots",             "Boots",              "footwear", SIZES_FOOTWEAR,   "Footwear",    "Boots",                 "sneaker"],
  ["soccer-boots",      "Soccer Boots",       "footwear", SIZES_FOOTWEAR,   "Footwear",    "Soccer Boots",          "sneaker"],
  ["slides",            "Slides",             "footwear", SIZES_FOOTWEAR,   "Footwear",    "Sandals & Slides",      "sneaker"],
  ["loafers",           "Loafers",            "footwear", SIZES_FOOTWEAR,   "Footwear",    null,                    "sneaker"],
  // Kids shoe sizes 26–33 read as pants WAISTS to the shared size classifier,
  // so Footwear is pinned here exactly as the old form's kids override did.
  ["kids-shoes",        "Kids Shoes",         "footwear", SIZES_KIDS,       "Footwear",    "Sneakers",              "sneaker"],

  // ── Apparel (S..XXXL) ──────────────────────────────────────────────────────
  ["t-shirts",          "T-Shirts",           "clothing", SIZES_APPAREL,    "Clothing",    "T-Shirts",              "clothing"],
  ["golf-t-shirts",     "Golf T-Shirts",      "clothing", SIZES_APPAREL,    "Clothing",    "Polos",                 "clothing"],
  ["hoodies",           "Hoodies",            "clothing", SIZES_APPAREL,    "Clothing",    "Hoodies & Sweatshirts", "clothing"],
  ["sweaters",          "Sweaters",           "clothing", SIZES_APPAREL,    "Clothing",    "Hoodies & Sweatshirts", "clothing"],
  ["jackets",           "Jackets",            "clothing", SIZES_APPAREL,    "Clothing",    "Jackets & Coats",       "clothing"],
  ["tracksuits",        "Tracksuits",         "clothing", SIZES_APPAREL,    "Clothing",    "Tracksuits & Sets",     "clothing"],
  ["pants",             "Pants",              "clothing", SIZES_APPAREL,    "Clothing",    "Cargos & Pants",        "clothing"],
  ["jeans",             "Jeans",              "clothing", SIZES_APPAREL,    "Clothing",    "Jeans & Denim",         "clothing"],
  ["shorts",            "Shorts",             "clothing", SIZES_APPAREL,    "Clothing",    "Shorts & Vests",        "clothing"],
  ["cargo-pants",       "Cargo Pants",        "clothing", SIZES_APPAREL,    "Clothing",    "Cargos & Pants",        "clothing"],
  ["basketball-vests",  "Basketball Vests",   "clothing", SIZES_APPAREL,    "Clothing",    "Shorts & Vests",        "clothing"],
  ["baseball-shirts",   "Baseball Shirts",    "clothing", SIZES_APPAREL,    "Clothing",    "Jerseys",               "clothing"],
  ["soccer-jerseys",    "Soccer Jerseys",     "clothing", SIZES_APPAREL,    "Clothing",    "Jerseys",               "clothing"],
  ["dresses",           "Dresses",            "clothing", SIZES_APPAREL,    "Clothing",    null,                    "clothing"],
  ["underwear",         "Underwear",          "clothing", SIZES_APPAREL,    "Clothing",    "Underwear & Socks",     "clothing"],

  // ── Own size sets ──────────────────────────────────────────────────────────
  ["fitted-caps",       "Fitted Caps",        "clothing", SIZES_FITTED_CAP, "Clothing",    "Caps & Hats",           "clothing"],
  // Gloves are M/L — REAL standard-run sizes, so the engine resolves targets for
  // them wherever a store already carries them. Verified 2026-07-26 as the
  // existing, intended behaviour: the one live glove product already holds
  // seed-script targets (hub2 M:3 L:3, marathon-pe M:2 L:2), and 552 accessory ×
  // destination pairs are already in the rule lane. Keeping productType
  // "clothing" therefore preserves today's behaviour AND Display Checks.
  ["gloves",            "Gloves",             "clothing", SIZES_GLOVES,     "Accessories", "Gloves",                "clothing"],

  // ── One-size ("_") ─────────────────────────────────────────────────────────
  // productType "clothing" matches the 333 live accessories, so Display Checks
  // keep firing on a sale (owner decision — these are the high-value display
  // items). The engine sees them but can never resolve a target for "_", so they
  // surface in the No-Target queue as dismissible entries. Accepted noise.
  ["bags",              "Bags",               "clothing", SIZES_ONE,        "Accessories", "Bags",                  "clothing"],
  ["belts",             "Belts",              "clothing", SIZES_ONE,        "Accessories", "Belts",                 "clothing"],
  ["watches",           "Watches",            "clothing", SIZES_ONE,        "Accessories", "Watches",               "clothing"],
  ["chains-bracelets",  "Chains & Bracelets", "clothing", SIZES_ONE,        "Accessories", "Jewellery",             "clothing"],
  ["sunglasses",        "Sunglasses",         "clothing", SIZES_ONE,        "Accessories", "Eyewear",               "clothing"],
  ["caps-beanies",      "Caps & Beanies",     "clothing", SIZES_ONE,        "Clothing",    "Caps & Hats",           "clothing"],
  // Perfume is the ONE category that omits productType — matching the 53 live
  // perfume records byte-for-byte. It stays OUT of the refill lane (no
  // productType → the size heuristic sees only "_") while Display Checks still
  // fire, because that trigger identifies perfume by CATEGORY, not productType.
  ["perfumes",          "Perfumes",           "clothing", SIZES_ONE,        "Perfume",     "Perfume",               null],
];

/** The registry object seeded into RTDB, and the offline fallback. */
export const TAXONOMY_SEED = {
  version: 1,
  tops: TAXONOMY_TOPS,
  cats: Object.fromEntries(SEED_ROWS.map(([key, label, top, sizes, lCat, lSub, lType], i) => [
    key,
    {
      key,
      label,
      top,
      order: i + 1,
      sizeMode: sizes === SIZES_ONE ? "one" : "list",
      sizes: [...sizes],
      legacy: { category: lCat, subcategory: lSub, productType: lType },
      flags: { ...EMPTY_FLAGS },
      active: true,
    },
  ])),
};

// ── Runtime readers ──────────────────────────────────────────────────────────
// Everything below takes a REGISTRY (the live RTDB node, or the seed fallback)
// so nothing in the UI reads the hardcoded seed directly.

/** A category record by key, or null. Tolerates a missing/garbled registry. */
export function catByKey(registry, key) {
  if (!registry || !key) return null;
  const c = registry.cats && registry.cats[key];
  return c && typeof c === "object" ? c : null;
}

/** True when this category is a single-quantity, one-size product. */
export function isOneSize(cat) {
  if (!cat) return false;
  if (cat.sizeMode === "one") return true;
  const s = sizesOf(cat);
  return s.length === 1 && s[0] === ONE_SIZE_SENTINEL;
}

/** The category's size list, normalised to an array of non-empty strings. */
export function sizesOf(cat) {
  const raw = cat && cat.sizes;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * THE DERIVATION. categoryKey → the legacy fields to write alongside it.
 * Returns { category, subcategory, productType } where a null means "omit this
 * field entirely" (never write the string "null"). Returns null for an unknown
 * key so callers can refuse to save rather than write a half-typed product.
 */
export function legacyFor(registry, key) {
  const cat = catByKey(registry, key);
  if (!cat || !cat.legacy) return null;
  const { category, subcategory, productType } = cat.legacy;
  if (!category) return null;
  return {
    category: String(category),
    subcategory: subcategory == null || subcategory === "" ? null : String(subcategory),
    productType: productType == null || productType === "" ? null : String(productType),
  };
}

/**
 * The dropdown model: [{ top, label, options:[cat, …] }, …], groups in `order`,
 * options in `order` then label. Inactive categories are hidden (so a category
 * can be retired by data edit without breaking products already using it).
 *
 * GROUPING IS PRESENTATION ONLY. `top` decides which optgroup a category is
 * listed under and nothing else — it is never written to a product and no
 * predicate or derivation reads it. Regrouping is a safe data edit.
 *
 * NEVER SILENTLY DROPS A CATEGORY: an active category whose `top` matches no
 * known group is collected into a trailing "Other" group rather than vanishing
 * from the picker. A typo'd `top` in the console must be visible, not invisible
 * — a category you cannot see is a category you cannot assign.
 */
export const UNGROUPED_TOP = "__ungrouped__";

export function groupedCategories(registry) {
  const cats = Object.values((registry && registry.cats) || {})
    .filter((c) => c && typeof c === "object" && c.key && c.active !== false);
  const rawTops = (registry && registry.tops) || TAXONOMY_TOPS;
  const tops = Object.values(rawTops).filter((t) => t && typeof t === "object" && t.key);
  const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.label).localeCompare(String(b.label));

  const known = new Set(tops.map((t) => t.key));
  const groups = tops
    .sort(byOrder)
    .map((t) => ({ top: t.key, label: String(t.label ?? t.key), options: cats.filter((c) => c.top === t.key).sort(byOrder) }))
    .filter((g) => g.options.length > 0);

  const orphans = cats.filter((c) => !known.has(c.top)).sort(byOrder);
  if (orphans.length) groups.push({ top: UNGROUPED_TOP, label: "Other", options: orphans });
  return groups;
}

/** Flat lookup of every active category, in dropdown order. */
export function allCategories(registry) {
  return groupedCategories(registry).flatMap((g) => g.options);
}

/** Human label for a key ("t-shirts" → "T-Shirts"), falling back to the key. */
export function labelForKey(registry, key) {
  const c = catByKey(registry, key);
  return c ? c.label : (key || "");
}

// ── Assignment-queue predicates ──────────────────────────────────────────────
// A product is ASSIGNED once it carries a non-empty categoryKey.
export function isAssigned(product) {
  return !!(product && typeof product.categoryKey === "string" && product.categoryKey.trim());
}

// "Currently typed as a sneaker" — the legacy Sneakers LEAF, not the whole
// Footwear top-level. Boots / Soccer Boots / Sandals & Slides are their own
// categories now, so folding them into Sneakers would throw away exactly the
// information this rebuild exists to capture.
export function isLegacySneaker(product) {
  return !!(product && product.category === "Footwear" && product.subcategory === "Sneakers");
}

/** Products the assignment queue should show: unassigned, and not a legacy sneaker. */
export function needsAssignment(product) {
  return !!(product && product.id) && !isAssigned(product) && !isLegacySneaker(product);
}

/** The effective category key for a product, applying the legacy-sneaker rule. */
export function effectiveCategoryKey(product) {
  if (isAssigned(product)) return product.categoryKey.trim();
  if (isLegacySneaker(product)) return "sneakers";
  return null;
}
