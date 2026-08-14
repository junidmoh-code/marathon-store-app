// ── THE STOREFRONT COLLECTION MAP — data, not code ───────────────────────────
// Storefront collections are DELIBERATELY SEPARATE from the app's internal
// stock categories. The app's tree exists to run a warehouse (refill targets,
// display checks, POS browse, size runs); a shopper's tree exists to sell.
// Renaming the app's categories to match a storefront would break the refill
// engine, Display Checks and POS browse — so the two stay apart and THIS FILE
// is the join. Editing the storefront's shape is a data edit here; /products,
// /stock and /settings/productTaxonomy are never touched.
//
// TWO tables, both pure data:
//
//   COLLECTIONS  — every collection that may exist on the shop: its title,
//                  handle, customer-facing description, SEO, sort order, and
//                  whether Shopify evaluates its membership itself (kind
//                  "smart") or this map drives it (kind "manual").
//   CATEGORY_MAP — internal `${category}|${subcategory}` → exactly ONE manual
//                  collection key. Plus a `${category}|*` row per category so a
//                  record with no subcategory still lands somewhere.
//
// ONE INTERNAL CATEGORY LANDS IN EXACTLY ONE COLLECTION (owner spec). There is
// no multi-homing: a t-shirt is in "T-shirts" and NOT also in "Clothing".
// "Clothing" is therefore a SIBLING bucket holding the clothing that has no
// finer collection (jerseys, polos, underwear, uncategorised), not a superset
// of its six children. The menu still nests them; the collections do not.
//
// ── COMPLIANCE ───────────────────────────────────────────────────────────────
// Collection titles, handles, descriptions, SEO fields and menu labels are
// catalogue fields: the payment gateway keyword-flags brand terms wherever they
// appear. Every string in this file goes through the SAME brand-trigger
// validator the product push uses (src/utils/shopifyTriggers.js) before
// anything is created — see validateCollectionPayload below and the pinning
// test in collectionMap.test.mjs. No brand, sub-label, collab or silhouette may
// name a collection, and no brand is ever expressed as a Shopify tag,
// metafield, vendor or product type. The brand association lives in the app and
// never reaches Shopify.
//
// ── WHERE THE TAXONOMY UNDER-COVERS THE CATALOGUE (read this) ────────────────
// The agreed top level has ONE footwear lane, "Sneakers". The live catalogue
// also holds Boots (45), Soccer Boots (81) and Sandals & Slides (49). They map
// to "Sneakers" because it is the only footwear destination the agreed taxonomy
// provides — so a shopper clicking "Sneakers" sees boots too. If that should be
// split, it is a data edit and nothing else: add one COLLECTIONS entry
// (`boots-sandals`) and repoint the three CATEGORY_MAP rows at it. No Shopify
// call, no reconciler change, no stock change.
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

// The one currency the shop trades in. Money conditions must carry it.
export const CURRENCY = "ZAR";

// ── COLLECTIONS ──────────────────────────────────────────────────────────────
// key          stable identity used by CATEGORY_MAP and by the /shopify_sync
//              record of created collection ids. NEVER reuse a key for a
//              different collection: the id record is keyed by it.
// parent       menu nesting only. Collections themselves are flat on Shopify —
//              this drives the navigation in COMMIT 4 and nothing else.
// kind         "manual" — membership written by the reconciler from CATEGORY_MAP.
//              "smart"  — membership evaluated by SHOPIFY from `conditions`;
//                         the reconciler never touches these.
// sortOrder    a CollectionSortOrder enum value (API 2026-07).
// conditions   smart only. The 2026-07 shape: a conditions SOURCE carrying an
//              inclusion match. `ruleSet` is deprecated on this version.
export const COLLECTIONS = [
  // ── Top level ──────────────────────────────────────────────────────────────
  {
    key: "sneakers",
    title: "Sneakers",
    handle: "sneakers",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Shoes on the shelf right now — sneakers, boots, soccer boots and slides. " +
      "Every pair is checked by hand and graded before it is listed, and the grade " +
      "is written on the product page. Sizes are limited to what is actually in stock.",
    seoTitle: "Sneakers | Marathon Club",
    seoDescription:
      "Shoes in stock at Marathon Club — checked by hand, graded, and listed only in the sizes we hold.",
  },
  {
    key: "clothing",
    title: "Clothing",
    handle: "clothing",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Clothing that does not sit in one of the sections below it — jerseys, golf " +
      "and polo shirts, underwear and socks, and pieces still being sorted. " +
      "Each item carries a condition grade on its product page.",
    seoTitle: "Clothing | Marathon Club",
    seoDescription:
      "Jerseys, polo shirts, underwear and more at Marathon Club. Every piece graded by hand before listing.",
  },
  {
    key: "caps-hats",
    title: "Caps & Hats",
    handle: "caps-hats",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Caps, fitted caps, beanies and visors. Fitted caps are listed in head sizes; " +
      "everything else is one size. Condition is graded on each product page.",
    seoTitle: "Caps & Hats | Marathon Club",
    seoDescription:
      "Caps, fitted caps and beanies at Marathon Club — graded by hand, listed in the sizes we hold.",
  },
  {
    key: "bags",
    title: "Bags",
    handle: "bags",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Backpacks, holdalls, slings and totes. Most are one size. " +
      "Condition is graded on each product page — read it before you buy.",
    seoTitle: "Bags | Marathon Club",
    seoDescription:
      "Backpacks, holdalls and totes at Marathon Club. Hand-checked and graded before listing.",
  },
  {
    key: "fragrance",
    title: "Fragrance",
    handle: "fragrance",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Fragrance in stock. Bottles are sold as they are described — the condition " +
      "grade on the product page covers the box and the bottle, not the scent.",
    seoTitle: "Fragrance | Marathon Club",
    seoDescription: "Fragrance in stock at Marathon Club, graded and described by hand.",
  },
  {
    key: "accessories",
    title: "Accessories",
    handle: "accessories",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Watches, belts, eyewear, jewellery, gloves and balaclavas. Small pieces, " +
      "limited runs, each with its own condition grade on the product page.",
    seoTitle: "Accessories | Marathon Club",
    seoDescription:
      "Watches, belts, eyewear and more at Marathon Club — hand-checked and graded before listing.",
  },

  // ── Under Clothing ─────────────────────────────────────────────────────────
  {
    key: "t-shirts",
    title: "T-shirts",
    handle: "t-shirts",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "T-shirts in the sizes we hold. Condition is graded on each product page.",
    seoTitle: "T-shirts | Marathon Club",
    seoDescription: "T-shirts at Marathon Club — graded by hand, listed in the sizes we hold.",
  },
  {
    key: "hoodies-sweats",
    title: "Hoodies & Sweats",
    handle: "hoodies-sweats",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Hoodies, sweatshirts and pullovers. Condition is graded on each product page.",
    seoTitle: "Hoodies & Sweats | Marathon Club",
    seoDescription:
      "Hoodies and sweatshirts at Marathon Club — hand-checked and graded before listing.",
  },
  {
    key: "tracksuits",
    title: "Tracksuits",
    handle: "tracksuits",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Tracksuits and two-piece sets. Sold as a set unless the product page says " +
      "otherwise. Condition is graded on each product page.",
    seoTitle: "Tracksuits | Marathon Club",
    seoDescription: "Tracksuits and sets at Marathon Club, graded by hand before listing.",
  },
  {
    key: "jackets",
    title: "Jackets",
    handle: "jackets",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Jackets, coats, puffers and gilets. Condition is graded on each product page.",
    seoTitle: "Jackets | Marathon Club",
    seoDescription: "Jackets and coats at Marathon Club — hand-checked and graded before listing.",
  },
  {
    key: "shorts",
    title: "Shorts",
    handle: "shorts",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description: "Shorts and vests. Condition is graded on each product page.",
    seoTitle: "Shorts | Marathon Club",
    seoDescription: "Shorts and vests at Marathon Club, graded by hand before listing.",
  },
  {
    key: "pants",
    title: "Pants",
    handle: "pants",
    parent: "clothing",
    kind: "manual",
    sortOrder: "CREATED_DESC",
    description:
      "Pants, cargos, joggers and denim. Waist sizes are listed as we hold them. " +
      "Condition is graded on each product page.",
    seoTitle: "Pants | Marathon Club",
    seoDescription: "Pants, cargos and denim at Marathon Club — graded by hand before listing.",
  },

  // ── Cross-cutting, evaluated by Shopify ────────────────────────────────────
  // These carry NO membership writes. Shopify re-evaluates them on every
  // product change, so they can never drift out of step with the catalogue.
  {
    key: "new-in",
    title: "New In",
    handle: "new-in",
    parent: null,
    kind: "smart",
    // The whole point of the collection: newest first.
    sortOrder: "CREATED_DESC",
    // WHY NOT A DATE WINDOW: Shopify's collection conditions on API 2026-07
    // cover product tag / title / category / type / vendor / status, variant
    // title / price / compare-at price / inventory / weight, and metafields.
    // There is NO created-at condition, so "listed in the last N days" is not
    // something Shopify can evaluate for itself. A tag we stamp and sweep
    // would be OUR clock, not Shopify's, and would rot the moment a sweep is
    // missed. So New In is every listed product ordered newest-first — which
    // is both self-maintaining and exactly what the description promises. Note
    // it is also the safety net for an UNMAPPED product (see UNMAPPED below):
    // a product in no manual collection is still reachable from here.
    conditions: {
      matchType: "ALL",
      all: [{ productStatus: { relation: "EQUALS", values: ["ACTIVE"] } }],
    },
    description:
      "Everything on the store, newest first. What is listed here is what is in " +
      "stock — items come off the store as they sell out.",
    seoTitle: "New In | Marathon Club",
    seoDescription: "The newest listings at Marathon Club, most recent first.",
  },
  {
    key: "sale",
    title: "Sale",
    handle: "sale",
    parent: null,
    kind: "smart",
    sortOrder: "PRICE_ASC",
    // A "was" price set on the variant is Shopify's own definition of a
    // reduced item and the only cross-price comparison its conditions can do:
    // there is no "compare-at is greater than price" relation, only IS_SET.
    // Nothing sets a compare-at price today, so this collection is EMPTY until
    // the app's specials start propagating to Shopify (specials currently
    // overwrite retailPrice and park the old one at /specials/{pid}/wasPrice —
    // see docs/SHOPIFY-SYNC.md §3). The rule is right; the data isn't there yet.
    // ACTIVE is on every cross-cutting collection deliberately: the shop still
    // holds 2,452 ARCHIVED products from the old catalogue, and a price-only
    // condition sweeps every one of them into the collection. They are not
    // published so no shopper sees them — but the admin count then reads as a
    // number that means nothing, and a draft would qualify the moment it was
    // published. Status-first keeps the collection honest at both ends.
    conditions: {
      matchType: "ALL",
      all: [
        { productStatus: { relation: "EQUALS", values: ["ACTIVE"] } },
        { variantCompareAtPrice: { relation: "IS_SET" } },
      ],
    },
    description:
      "Items marked down from their earlier price. The previous price is shown " +
      "struck through on the product page.",
    seoTitle: "Sale | Marathon Club",
    seoDescription: "Marked-down items at Marathon Club, cheapest first.",
  },
  {
    key: "under-r500",
    title: "Under R500",
    handle: "under-r500",
    parent: null,
    kind: "smart",
    sortOrder: "PRICE_ASC",
    conditions: {
      matchType: "ALL",
      all: [
        { productStatus: { relation: "EQUALS", values: ["ACTIVE"] } },
        { variantPrice: { relation: "LESS_THAN", amount: "500.00" } },
      ],
    },
    description:
      "Everything priced under R500. Prices include VAT. A product appears here " +
      "as soon as any of its sizes is under R500.",
    seoTitle: "Under R500 | Marathon Club",
    seoDescription: "Everything under R500 at Marathon Club, cheapest first.",
  },
];

export const COLLECTION_BY_KEY = new Map(COLLECTIONS.map((c) => [c.key, c]));
export const MANUAL_KEYS = COLLECTIONS.filter((c) => c.kind === "manual").map((c) => c.key);
export const SMART_KEYS = COLLECTIONS.filter((c) => c.kind === "smart").map((c) => c.key);

// ── CATEGORY_MAP — internal category → ONE manual collection ─────────────────
// Key: `${category}|${subcategory}`, both verbatim from the /products record.
// `${category}|*` is the fallback for a record whose subcategory is absent or
// unrecognised. Counts are from the read-only census of 2026-08-15 (4,167
// visible records) and are documentation, not logic.
//
// `null` means DELIBERATELY UNMAPPED — see UNMAPPED below. It is a decision
// recorded here, not an omission: a category missing from this table entirely
// is a different thing and warns differently.
export const CATEGORY_MAP = {
  // Footwear — one lane, per the agreed taxonomy. See the header note.
  "Footwear|Sneakers": "sneakers",             // 1224
  "Footwear|Boots": "sneakers",                //   45  ← not sneakers; see header
  "Footwear|Soccer Boots": "sneakers",         //   81  ← not sneakers; see header
  "Footwear|Sandals & Slides": "sneakers",     //   49  ← not sneakers; see header
  "Footwear|*": "sneakers",                    //    3  (no subcategory on the record)

  // Clothing — six named children, then the parent bucket for the rest.
  "Clothing|T-Shirts": "t-shirts",             //  451
  "Clothing|Hoodies & Sweatshirts": "hoodies-sweats", //  72
  "Clothing|Tracksuits & Sets": "tracksuits",  //  291
  "Clothing|Jackets & Coats": "jackets",       //   69
  "Clothing|Shorts & Vests": "shorts",         //   32
  "Clothing|Cargos & Pants": "pants",          //   40
  "Clothing|Jeans & Denim": "pants",           //  157  denim is pants
  "Clothing|Caps & Hats": "caps-hats",         //  339  its own top-level lane
  // Deliberately NOT filed under T-shirts: a jersey and a polo shirt are not
  // t-shirts, and a collection titled "T-shirts" holding them would mislead.
  "Clothing|Jerseys": "clothing",              //  228
  "Clothing|Polos": "clothing",                //   61
  "Clothing|Underwear & Socks": "clothing",    //   27
  "Clothing|Clothing — Uncategorized": "clothing", // 472
  "Clothing|*": "clothing",                    //    1

  // Accessories — Bags gets its own lane, the rest share one.
  "Accessories|Bags": "bags",                  //  336
  "Accessories|Watches": "accessories",        //   47
  "Accessories|Belts": "accessories",          //   25
  "Accessories|Eyewear": "accessories",        //   14
  "Accessories|Jewellery": "accessories",      //    2
  "Accessories|Gloves": "accessories",         //    1
  "Accessories|Balaclavas & Masks": "accessories", //  2
  "Accessories|*": "accessories",

  "Perfume|Perfume": "fragrance",              //   63
  "Perfume|*": "fragrance",

  // "Price Products" are internal price-carrier records, not goods on a shelf.
  // They have no storefront home and must never get one.
  "Price Products|Price Products": null,       //   35
  "Price Products|*": null,
};

// ── WHAT HAPPENS TO ANYTHING UNMAPPED ────────────────────────────────────────
// Two distinct cases, and they are NOT the same:
//
//   "unmapped"  — the category IS in CATEGORY_MAP with the value null. A
//                 deliberate decision (Price Products). Logged as a decision.
//   "unknown"   — the category is not in CATEGORY_MAP at all. A category was
//                 added to the app and nobody updated this file. LOUD WARNING
//                 in the reconciler's run log — never a silent skip.
//
// The DESTINATION is the same for both and it is defined, not accidental: the
// product joins NO manual collection, so it appears under no menu heading —
// but it is still ACTIVE and published, so Shopify's "New In" smart collection
// picks it up (and "Under R500" / "Sale" if it qualifies). It is reachable from
// the home page via New In, and by its direct URL. Nothing is stranded; it just
// has no category home until this file gains a row.
export const UNMAPPED_DESTINATION =
  "no manual collection — reachable via the New In smart collection and its direct URL";

/**
 * The ONE resolver. product: a /products record (or { category, subcategory }).
 *
 * → { collectionKey, status, key, reason }
 *     status "mapped"   — collectionKey is the manual collection to join.
 *     status "unmapped" — a deliberate null in CATEGORY_MAP; collectionKey null.
 *     status "unknown"  — the category is missing from CATEGORY_MAP entirely;
 *                         collectionKey null. THIS is the loud one.
 *
 * Never throws and never invents a destination: a caller that ignores `status`
 * still gets a null collectionKey rather than a wrong collection.
 */
export function resolveCollection(product) {
  const category = typeof product?.category === "string" ? product.category.trim() : "";
  const subcategory = typeof product?.subcategory === "string" ? product.subcategory.trim() : "";
  const exact = `${category}|${subcategory}`;
  const wild = `${category}|*`;

  // An exact row wins; the category's own wildcard is the documented fallback.
  // `in` rather than a truthiness test — null is a real, meaningful value here.
  const key = subcategory && exact in CATEGORY_MAP ? exact : wild in CATEGORY_MAP ? wild : null;

  if (key === null) {
    return {
      collectionKey: null,
      status: "unknown",
      key: exact,
      reason: category
        ? `no CATEGORY_MAP row for category "${category}" (subcategory ${JSON.stringify(subcategory || null)}) — add one to scripts/shopify/collectionMap.mjs`
        : "record has no category — add one to the product record",
    };
  }
  const collectionKey = CATEGORY_MAP[key];
  if (collectionKey === null) {
    return {
      collectionKey: null,
      status: "unmapped",
      key,
      reason: `"${key}" is mapped to no storefront collection on purpose — ${UNMAPPED_DESTINATION}`,
    };
  }
  if (!COLLECTION_BY_KEY.has(collectionKey)) {
    // A typo in CATEGORY_MAP would otherwise send a product at a collection
    // that cannot exist. Treated as unknown so it warns loudly.
    return {
      collectionKey: null,
      status: "unknown",
      key,
      reason: `CATEGORY_MAP row "${key}" points at collection key "${collectionKey}", which is not in COLLECTIONS`,
    };
  }
  return { collectionKey, status: "mapped", key, reason: null };
}

// ── THE COMPLIANCE VALIDATOR FOR COLLECTIONS ─────────────────────────────────
// The sibling of compliance.mjs `validatePayload`, for the fields a collection
// pushes: title, handle, description, SEO title, SEO description — and, when a
// menu is built from this map, the menu label too (which is the title).
// Structural guards mirror the product validator: handle must be a clean
// lowercase-hyphen slug, title non-empty and inside Shopify's limits.
//
// Returns { ok, violations: [{ field, problem }] }. Callers MUST NOT create or
// update a collection unless ok.
export function validateCollectionPayload(collection) {
  const violations = [];
  const check = (field, value) => {
    if (value == null) return;
    const hits = triggersInText(value);
    if (hits.length) violations.push({ field, problem: `brand trigger(s): ${hits.join(", ")}` });
  };

  const title = collection?.title;
  if (!title || String(title).trim() === "") {
    violations.push({ field: "title", problem: "empty" });
  } else if (String(title).trim().length > 255) {
    violations.push({ field: "title", problem: "over 255 chars" });
  }
  check("title", title);

  if (!collection?.handle || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(collection.handle)) {
    violations.push({ field: "handle", problem: "not a clean lowercase-hyphen slug" });
  }
  check("handle", collection?.handle);

  if (!collection?.description || String(collection.description).trim() === "") {
    violations.push({ field: "description", problem: "empty — collections are customer-facing" });
  }
  check("description", collection?.description);
  check("seoTitle", collection?.seoTitle);
  check("seoDescription", collection?.seoDescription);

  // Smart-collection condition VALUES are pushed strings too — a tag or type
  // condition naming a brand would put the brand in the catalogue just as
  // surely as a title would. Walk every string in the condition tree.
  for (const [i, cond] of (collection?.conditions?.all ?? []).entries()) {
    for (const [name, body] of Object.entries(cond ?? {})) {
      for (const v of body?.values ?? []) check(`conditions[${i}].${name}.values`, v);
      check(`conditions[${i}].${name}.amount`, body?.amount);
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Validate every collection in COLLECTIONS. → [{ key, violations }] (empty = all clean). */
export function validateAllCollections() {
  return COLLECTIONS.map((c) => ({ key: c.key, ...validateCollectionPayload(c) })).filter((v) => !v.ok);
}
