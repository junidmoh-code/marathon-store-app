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
//                  handle, SEO, sort order, and whether Shopify evaluates its
//                  membership itself (kind "smart") or this map drives it
//                  (kind "manual").
//                  NO DESCRIPTION. Junid does not want a paragraph on his
//                  category pages (owner decision 2026-08-19): the shop's
//                  headings say what the section is, and prose underneath them
//                  is copy nobody asked for and nobody maintains. The field is
//                  gone from every entry, the reconciler pushes an empty
//                  descriptionHtml so the copy already on the shop is CLEARED,
//                  and the validator refuses a description if one reappears.
//                  SEO title and description stay — those are search-engine
//                  metadata, not page copy.
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
// Collection titles, handles, SEO fields and menu labels are
// catalogue fields: the payment gateway keyword-flags brand terms wherever they
// appear. Every string in this file goes through the SAME brand-trigger
// validator the product push uses (src/utils/shopifyTriggers.js) before
// anything is created — see validateCollectionPayload below and the pinning
// test in collectionMap.test.mjs. No brand, sub-label, collab or silhouette may
// name a collection, and no brand is ever expressed as a Shopify tag,
// metafield, vendor or product type. The brand association lives in the app and
// never reaches Shopify.
//
// ── FOOTWEAR HAS FOUR LANES, NOT ONE (2026-08-16) ────────────────────────────
// Slice 1 shipped ONE footwear lane, "Sneakers", and pointed Boots, Soccer
// Boots and Sandals & Slides at it because no other destination existed. The
// consequence was visible on the live storefront: of the products live on
// 2026-08-16, 23 were boots and 15 were slides — every one of them filed under
// a heading reading "Sneakers", and not a single actual sneaker was live.
//
// This is the split. It is a data edit exactly as the old note promised: three
// new COLLECTIONS entries and three repointed CATEGORY_MAP rows. No reconciler
// change, no handle change, no stock change — a product MOVES by collection
// membership only, which sync-collections.mjs re-plans from Shopify every run.
//
// THE REAL FOOTWEAR SUBCATEGORY LIST, from a read-only census of all 4,183
// visible /products records on 2026-08-16 — mapped as it IS, not as it was
// named in the brief:
//
//   legacy `category|subcategory`      count   lane
//   Footwear|Sneakers                   1224   sneakers
//   Footwear|Soccer Boots                 81   soccer-boots   (new)
//   Footwear|Sandals & Slides             49   sandals-slides (new)
//   Footwear|Boots                        45   boots          (new)
//   Footwear|(no subcategory)              3   sneakers (the `|*` fallback)
//
// The NEW taxonomy registry (/settings/productTaxonomy) carries four more
// footwear categories, and they get NO lane of their own — deliberately,
// because a collection with nothing in it is the exact complaint this change
// exists to answer:
//
//   categoryKey     products   registry state   why no lane
//   designer-shoes         4   active           4 records, all filed
//                                               legacy Footwear|Boots → Boots
//   kids-shoes             0   active           nothing to show
//   boots                  0   INACTIVE         legacy subcategory already
//                                               carries the 45 real boots
//   running-shoes          0   INACTIVE         nothing to show
//   loafers                0   INACTIVE         nothing to show
//
// WHY THIS MAP STILL KEYS ON THE LEGACY PAIR AND NOT ON categoryKey. The
// census cross-tab says categoryKey is the WRONG signal for exactly the split
// this change makes: 41 of the 45 records whose legacy subcategory is "Boots"
// carry categoryKey "sneakers", and 1 legacy "Sandals & Slides" record does
// too. Keying the storefront lane on categoryKey would put 42 boots and slides
// straight back into Sneakers — the bug. The legacy subcategory is the field
// that is right about what the shoe is, so it stays the join.
import { isPriceRecord } from "../../src/utils/productCategory.js";
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
    seoTitle: "Sneakers | Marathon Club",
    seoDescription:
      "Sneakers in stock at Marathon Club — checked by hand, graded, and listed only in the sizes we hold.",
  },
  {
    key: "boots",
    title: "Boots",
    handle: "boots",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    seoTitle: "Boots | Marathon Club",
    seoDescription:
      "Boots in stock at Marathon Club — hand-checked, graded, and listed only in the sizes we hold.",
  },
  {
    key: "soccer-boots",
    title: "Soccer Boots",
    handle: "soccer-boots",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    seoTitle: "Soccer Boots | Marathon Club",
    seoDescription:
      "Soccer boots in stock at Marathon Club — hand-checked and graded before listing.",
  },
  {
    key: "sandals-slides",
    title: "Sandals & Slides",
    handle: "sandals-slides",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
    seoTitle: "Sandals & Slides | Marathon Club",
    seoDescription:
      "Slides and sandals in stock at Marathon Club — hand-checked, graded, and listed in the sizes we hold.",
  },
  {
    key: "clothing",
    title: "Clothing",
    handle: "clothing",
    parent: null,
    kind: "manual",
    sortOrder: "CREATED_DESC",
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
    // is both self-maintaining and exactly what the heading promises. Note
    // it is also the safety net for an UNMAPPED product (see UNMAPPED below):
    // a product in no manual collection is still reachable from here.
    conditions: {
      matchType: "ALL",
      all: [{ productStatus: { relation: "EQUALS", values: ["ACTIVE"] } }],
    },
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
  // Footwear — FOUR lanes as of 2026-08-16. See the header census.
  "Footwear|Sneakers": "sneakers",             // 1224
  "Footwear|Boots": "boots",                   //   45
  "Footwear|Soccer Boots": "soccer-boots",     //   81
  "Footwear|Sandals & Slides": "sandals-slides", // 49
  // 3 records with no subcategory at all ("Soccerboot kit", "Labubu", "Kids
  // soccerboot "). Sneakers is the dominant footwear lane and the least
  // surprising home for a shoe nobody has filed; giving them their own lane
  // would create a collection of three oddments.
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
  // These rows are documentation only — isPriceRecord() short-circuits
  // resolveCollection() long before the table is consulted, and answers
  // "excluded", not "unmapped". The distinction matters: an unmapped product
  // still goes live and shows up in New In (that is what Junid saw), an
  // excluded one is refused publication outright.
  "Price Products|Price Products": null,       //   35
  "Price Products|*": null,
};

// ── WHAT HAPPENS TO ANYTHING UNMAPPED ────────────────────────────────────────
// Three distinct cases, and they are NOT the same:
//
//   "excluded"  — not merchandise (isPriceRecord). The product does not go to
//                 Shopify AT ALL: the publishing page will not offer it, the
//                 batch selector skips it, and the reconciler refuses it at
//                 apply time even if an intent somehow exists. This is the only
//                 status that blocks publication.
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
 *     status "excluded" — NOT MERCHANDISE. The product may not be published at
 *                         all, in any state. collectionKey null.
 *     status "unmapped" — a deliberate null in CATEGORY_MAP; collectionKey null.
 *                         The product IS published, it just joins no manual
 *                         collection.
 *     status "unknown"  — the category is missing from CATEGORY_MAP entirely;
 *                         collectionKey null. THIS is the loud one.
 *
 * Never throws and never invents a destination: a caller that ignores `status`
 * still gets a null collectionKey rather than a wrong collection.
 */
// ── THE HOME-PAGE RAIL TABLE ─────────────────────────────────────────────────
// The storefront home page shows one rail per category. A rail needs THREE
// strings and they are all different from each other:
//
//   label   what the shopper reads
//   tag     the Shopify TAG, which is what /collections/all/{tag} filters on
//           and therefore the only address that reaches every product in the
//           category regardless of collection membership
//   key     the COLLECTION the rail is filled from
//
// They cannot be derived from one another. `"Tracksuits & Sets" | handleize` is
// "tracksuits-sets" but the collection is "tracksuits"; "Perfume" lives in
// "fragrance"; "Jeans & Denim" lives in "pants". Getting this wrong renders an
// empty home page, silently — which is exactly what happened when
// sell-through.mjs printed bare collection keys and the theme setting wanted
// full rows.
//
// So the table lives HERE, once, as data, and BOTH sides read it: the theme
// setting's default is generated from it, and sell-through.mjs prints a
// paste-ready setting value rather than something that merely looks like one.
//
// Jerseys and Polos have no row: both map to the "clothing" collection, and two
// rails drawn from one collection would show the same photographs twice under
// two headings. "Clothing" is the single row that covers them.
//
// "Accessories" has no row for the same reason, one level up. The only products
// carrying the Accessories tag are the 34 bags (census 2026-08-21), so an
// Accessories rail and a Bags rail would be the same 34 photographs under two
// headings, and /collections/all/accessories and /collections/all/bags would be
// the same page. Give it a row again if Accessories ever holds something that
// is not a bag — watches, belts and eyewear all have CATEGORY_MAP rows already
// and simply have no live products yet.
export const HOME_RAILS = [
  { key: "sneakers",       tag: "Sneakers",              label: "Sneakers" },
  { key: "tracksuits",     tag: "Tracksuits & Sets",     label: "Tracksuits & Sets" },
  { key: "soccer-boots",   tag: "Soccer Boots",          label: "Soccer Boots" },
  { key: "clothing",       tag: "Clothing",              label: "Clothing" },
  { key: "caps-hats",      tag: "Caps & Hats",           label: "Caps & Hats" },
  { key: "t-shirts",       tag: "T-Shirts",              label: "T-Shirts" },
  { key: "pants",          tag: "Jeans & Denim",         label: "Jeans & Denim" },
  { key: "bags",           tag: "Bags",                  label: "Bags" },
  { key: "fragrance",      tag: "Perfume",               label: "Perfume" },
  { key: "sandals-slides", tag: "Sandals & Slides",      label: "Sandals & Slides" },
  { key: "boots",          tag: "Boots",                 label: "Boots" },
  { key: "jackets",        tag: "Jackets & Coats",       label: "Jackets & Coats" },
  { key: "hoodies-sweats", tag: "Hoodies & Sweatshirts", label: "Hoodies & Sweatshirts" },
  { key: "shorts",         tag: "Shorts & Vests",        label: "Shorts & Vests" },
];

export const HOME_RAIL_BY_KEY = Object.fromEntries(HOME_RAILS.map((r) => [r.key, r]));

/**
 * The exact string to paste into the theme's "Rail order" setting, ordered by
 * the collection keys given (best-selling first). Keys with no rail row are
 * skipped rather than emitted as something the theme cannot parse.
 * @param {string[]} orderedKeys collection keys, best first
 * @returns {string} `Label~tag~key;Label~tag~key;…`
 */
export function buildRailOrderSetting(orderedKeys) {
  const seen = new Set();
  const rows = [];
  for (const key of orderedKeys) {
    const r = HOME_RAIL_BY_KEY[key];
    if (!r || seen.has(key)) continue;
    seen.add(key);
    rows.push(`${r.label}~${r.tag}~${r.key}`);
  }
  // Anything measured but unranked still belongs on the page, at the back.
  for (const r of HOME_RAILS) {
    if (!seen.has(r.key)) rows.push(`${r.label}~${r.tag}~${r.key}`);
  }
  return rows.join(";");
}

export function resolveCollection(product) {
  // FIRST, before any category lookup: is this merchandise at all? Price
  // records are not, and the answer must not depend on which of their three
  // identifying signals survived an edit (see isPriceRecord).
  if (isPriceRecord(product)) {
    return {
      collectionKey: null,
      status: "excluded",
      key: "Price Products",
      reason:
        "internal price-carrier record, not merchandise — excluded from Shopify entirely " +
        "(no collection, no product, no publication)",
    };
  }
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
// pushes: title, handle, SEO title, SEO description — and, when a
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

  // NO DESCRIPTION IS CHECKED, because none is pushed. Junid does not want a
  // paragraph on his category pages (owner decision 2026-08-19), so COLLECTIONS
  // carries no `description` and the reconciler pushes an EMPTY descriptionHtml
  // — which also clears the copy already on the shop. A collection that somehow
  // arrives here carrying one is a mistake, and it is refused rather than
  // quietly pushed.
  if (collection?.description != null && String(collection.description).trim() !== "") {
    violations.push({ field: "description", problem: "collections carry no description — it is not pushed and must not be set" });
  }
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
