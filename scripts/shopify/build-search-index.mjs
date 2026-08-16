// ── Build the storefront search index ────────────────────────────────────────
// Shopify's own search cannot find these products. Every brand, sub-label and
// silhouette term is stripped before a product is pushed, so the words a
// shopper types are exactly the words the Shopify catalogue does not contain:
//
//   TRUE name in the app                    Shopify title on the storefront
//   "Lacoste Gripshot Lace Boot White Navy"  "Lace Boot White Navy"
//   "Adidas Samba White Core Black"          "Sneaker White Core Black"
//   "Nike Air Force 1 Shell Green"           "Boots Shell Green"
//
// This builds an index over the app's TRUE data and stores the Shopify handle
// beside it. The endpoint (functions/storefrontSearch) matches on the true
// words and answers with the handle — the brand is used to FIND the product and
// never travels back out.
//
//   node scripts/shopify/build-search-index.mjs            dry run — the plan
//   node scripts/shopify/build-search-index.mjs --commit   write /search_index
//   node scripts/shopify/build-search-index.mjs --commit --quiet   for cron
//
// REBUILDABLE FROM SCRATCH, which is the point: it never reads the existing
// index, so a corrupt or half-written one is cured by running this again.
//
// SCOPE: products CONFIRMED ON the storefront, and nothing else. A product that
// is off, blocked, awaiting, or merely mapped is not indexed — a search result
// leading to a 404 is worse than no result. Price records are excluded by
// isPriceRecord, ahead of everything, the same predicate the reconciler uses.
//
// WRITES: /search_index ONLY (`docs` and `meta`, both set() — a full replace, so
// a product that came off the storefront disappears rather than lingering).
// Never /products, never /shopify_publish, never /shopify_sync, never Shopify.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isPriceRecord } from "../../src/utils/productCategory.js";
import { resolveCollection, COLLECTION_BY_KEY } from "./collectionMap.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";
import { buildIndexDoc, SEARCH_INDEX_PATH } from "./searchIndexDoc.mjs";
import { SEARCH_IDENTITY_PATH } from "../../src/utils/searchIdentity.js";

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const QUIET = flags.includes("--quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const confirmedOn = (n) => n?.state === "live" && n?.liveState === "on";

const publishNodes = await readAllPublishNodes(db);
const livePids = Object.entries(publishNodes).filter(([, n]) => confirmedOn(n)).map(([pid]) => pid);
say(`${livePids.length} products confirmed ON the storefront`);

// One Shopify read per product, batched. `first: 100` on variants matches the
// reconciler's own cap; a product past it is skipped rather than indexed with a
// partial size list.
const CHUNK = 25;
const docs = {};
const skipped = [];

for (let i = 0; i < livePids.length; i += CHUNK) {
  const batch = livePids.slice(i, i + CHUNK);
  const gidByPid = {};
  for (const pid of batch) {
    assertSafeSegment(pid, "productId");
    const map = (await db.ref(`shopify_sync/${pid}`).get()).val();
    if (map?.shopifyProductId) gidByPid[pid] = map.shopifyProductId;
    else skipped.push({ pid, why: "confirmed live but no /shopify_sync mapping" });
  }
  const ids = Object.values(gidByPid);
  if (!ids.length) continue;

  const data = await graphql(
    `query ($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id handle title status
          onlineStoreUrl
          featuredMedia { preview { image { url(transform: { maxWidth: 600, maxHeight: 800 }) } } }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          variants(first: 100) {
            pageInfo { hasNextPage }
            nodes { id title availableForSale inventoryQuantity inventoryItem { tracked } }
          }
        }
      }
    }`,
    { ids }
  );

  const byGid = new Map((data.nodes || []).filter(Boolean).map((n) => [n.id, n]));
  for (const [pid, gid] of Object.entries(gidByPid)) {
    const sp = byGid.get(gid);
    if (!sp) { skipped.push({ pid, why: `${gid} not found on the shop` }); continue; }
    if (sp.status !== "ACTIVE") { skipped.push({ pid, why: `Shopify status is ${sp.status}, not ACTIVE` }); continue; }
    if (sp.variants.pageInfo.hasNextPage) { skipped.push({ pid, why: ">100 variants unpaginated" }); continue; }

    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) { skipped.push({ pid, why: "no /products record" }); continue; }
    // Not merchandise — the same predicate the reconciler refuses on. It should
    // be unreachable here (a price record cannot be confirmed live any more),
    // and it is checked anyway because an index is a second publication.
    if (isPriceRecord(product)) { skipped.push({ pid, why: "price record — not merchandise" }); continue; }

    const r = resolveCollection(product);
    const collection = r.status === "mapped" ? COLLECTION_BY_KEY.get(r.collectionKey)?.handle ?? null : null;
    // The searchable identity comes from its OWN node, not from product.name —
    // the name is being rewritten by the vision namer, the identity is not.
    const identity = (await db.ref(`${SEARCH_IDENTITY_PATH}/${pid}`).get()).val();
    docs[pid] = buildIndexDoc({ product, shopifyProduct: sp, collection, identity });
  }
  say(`  ${Object.keys(docs).length}/${livePids.length} indexed…`);
}

for (const s of skipped) console.error(`  ⚠ ${s.pid}: ${s.why} — NOT indexed`);

const count = Object.keys(docs).length;
const inStock = Object.values(docs).filter((d) => d.inStock).length;
say(`\nindex: ${count} documents · ${inStock} with stock · ${skipped.length} skipped`);

if (!COMMIT) {
  const sample = Object.values(docs).slice(0, 3);
  say("\nsample documents (the private matching fields are the last three):");
  for (const d of sample) say("  " + JSON.stringify(d));
  say("\ndry run — /search_index untouched. Re-run with --commit to write it.");
  process.exit(skipped.length ? 1 : 0);
}

// set(), not update(): a full replace is what makes this rebuildable. A product
// that came off the storefront must DISAPPEAR from the index, and a merge would
// leave it there answering searches with a link to an unpublished product.
const version = Date.now();
await db.ref(`${SEARCH_INDEX_PATH}/docs`).set(docs);
await db.ref(`${SEARCH_INDEX_PATH}/meta`).set({
  version,
  builtAt: new Date(version).toISOString(),
  count,
  inStock,
  skipped: skipped.length,
  builtBy: "script:build-search-index",
});
say(`written · version ${version}`);
process.exit(skipped.length ? 1 : 0);
