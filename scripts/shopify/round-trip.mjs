// ── One-product round trip: RTDB → Shopify product with one variant/size ─────
// Reads ONE product from RTDB, maps it to a Shopify productSet payload, and:
//
//   node scripts/shopify/round-trip.mjs <productId>            dry run —
//       prints the exact payload that WOULD be sent, and nothing else.
//   node scripts/shopify/round-trip.mjs <productId> --commit   creates the
//       product ONCE, reads it back, prints productId + every variantId and
//       inventoryItemId as a table, writes the ID map to
//       /shopify_sync/<productId> (idMap.mjs — idempotent, never clobbers),
//       then stops.
//
// Safety rails:
//   • Created as status DRAFT — never visible on the storefront.
//   • Refuses to --commit if a product with the identical title already
//     exists on the shop (guards against accidental duplicates on re-run).
//   • RTDB via ADC: reads /products, writes ONLY /shopify_sync (the sole RTDB
//     path this whole slice may touch). Never /products, /stock or /barcodes.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { encodeSizeKey } from "../../src/utils/sizeKey.js";
import { sortSizes, displaySizeName, findSizeCollisions } from "./sizeOrder.mjs";
import { shopifyTitle } from "./nameRewrite.mjs";
import { buildMapping, writeIdMap } from "./idMap.mjs";

const [productId, ...flags] = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
if (!productId || productId.startsWith("--")) {
  console.error("usage: node scripts/shopify/round-trip.mjs <productId> [--commit]");
  process.exit(2);
}

// firebase-admin lives in functions/node_modules, not the app root.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const product = (await admin.database().ref(`products/${productId}`).get()).val();
if (!product) {
  console.error(`No product at /products/${productId}`);
  process.exit(1);
}

// ── Map the record → productSet input ────────────────────────────────────────
const problems = [];
if (!product.id || !product.name) problems.push("record lacks inner id/name (invisible in the app)");
if (!(Number(product.retailPrice) > 0)) problems.push("no retailPrice > 0");
// Sorted for the storefront dropdown — Shopify renders productOptions in the
// order given, and raw catalogue order is tap order (see sizeOrder.mjs).
const sizes =
  Array.isArray(product.sizes) && product.sizes.length ? sortSizes(product.sizes) : null;
if (!sizes) problems.push("no sizes array");
// Colliding tokens must refuse BEFORE any Shopify call — after creation they
// would be indistinguishable in the ID map (see findSizeCollisions).
if (sizes) problems.push(...findSizeCollisions(sizes));
if (problems.length) {
  console.error(`Refusing to map ${productId}: ${problems.join("; ")}`);
  process.exit(1);
}

// "_" is the one-size sentinel; Shopify needs a human-readable option value.
const sizeName = displaySizeName;
const price = Number(product.retailPrice).toFixed(2);

// Listing title = brand-stripped name; a guard violation ships the ORIGINAL
// name and is called out loudly so the operator knows this one needs manual
// naming (see shopifyTitle in nameRewrite.mjs).
const named = shopifyTitle(product.name);
if (named.flagged) {
  console.error(
    `⚠ title guard: ${named.reason} — pushing the ORIGINAL name unchanged: "${named.title}"`
  );
}

const input = {
  title: named.title,
  status: "DRAFT", // never storefront-visible in this slice
  productOptions: [
    { name: "Size", position: 1, values: sizes.map((s) => ({ name: sizeName(s) })) },
  ],
  variants: sizes.map((s) => ({
    optionValues: [{ optionName: "Size", name: sizeName(s) }],
    price,
    ...(product.sku ? { sku: `${product.sku}-${encodeSizeKey(s)}` } : {}),
  })),
};

if (!COMMIT) {
  // Dry run: the exact payload and nothing else.
  console.log(JSON.stringify({ mutation: "productSet", synchronous: true, input }, null, 2));
  process.exit(0);
}

// ── --commit: map-first check, duplicate guard, create once, read back ───────
// Order of authority for "does this product already exist on the shop?":
//   1. /shopify_sync/{productId} — the durable record; if present, RECONCILE
//      that product (a title edit on either side must not cause a re-create).
//   2. exact-title search — catches the orphan state where a prior run created
//      the product but died before the ID map was written; ADOPT, don't create.
//   3. neither → create, and persist a pending {shopifyProductId} node BEFORE
//      the read-back, so even a crash right here leaves a durable pointer.
const db = admin.database();
const mapNode = (await db.ref(`shopify_sync/${productId}`).get()).val();
let shopifyProductId;
if (mapNode) {
  console.error(
    `/shopify_sync/${productId} already maps to ${mapNode.shopifyProductId} — ` +
      `reconciling that product (nothing will be created).`
  );
  shopifyProductId = mapNode.shopifyProductId;
} else {
  const dupe = await graphql(
    `query ($q: String!) { products(first: 25, query: $q) { nodes { id title } } }`,
    // Escape the Shopify search DSL's own metacharacters (backslash first).
    { q: `title:'${input.title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` }
  );
  const exact = dupe.products.nodes.filter((n) => n.title === input.title);
  if (exact.length === 1) {
    // A prior --commit died between productSet and the ID-map write — the
    // product exists with NO /shopify_sync node, which is exactly the
    // lost-mapping state that causes duplicate creation. ADOPT it.
    console.error(
      `Product with this exact title already exists (${exact[0].id}) and ` +
        `/shopify_sync/${productId} is empty — adopting it instead of creating.`
    );
    shopifyProductId = exact[0].id;
  } else if (exact.length > 1) {
    console.error(
      `Refusing to create: ${exact.length} products with this exact title already exist ` +
        `on the shop (${exact.map((n) => n.id).join(", ")}). Ambiguous — needs a human.`
    );
    process.exit(1);
  } else {
    const created = await graphql(
      `mutation ($input: ProductSetInput!) {
        productSet(synchronous: true, input: $input) {
          product { id }
          userErrors { field message }
        }
      }`,
      { input },
      { mutation: true } // a 5xx may have applied server-side — never blind-retry
    );
    const errs = created.productSet.userErrors;
    if (errs?.length) {
      console.error(`productSet userErrors: ${JSON.stringify(errs, null, 2)}`);
      process.exit(1);
    }
    shopifyProductId = created.productSet.product.id;
    // Surface the ID before anything else can fail — if every later step dies,
    // the operator still has the created product's handle in the output.
    console.error(`created: ${shopifyProductId}`);
    // Durable pointer FIRST: if the read-back below fails, a re-run finds this
    // pending node (map-first check) and reconciles instead of re-creating.
    await writeIdMap(db, productId, { shopifyProductId, variants: {} });
  }
}

const back = await graphql(
  `query ($id: ID!) {
    product(id: $id) {
      id title status
      variants(first: 100) {
        pageInfo { hasNextPage }
        nodes { id title sku inventoryItem { id } }
      }
    }
  }`,
  { id: shopifyProductId }
);

const p = back.product;
if (!p) {
  console.error(
    `Read-back returned no product for ${shopifyProductId}. Nothing written beyond ` +
      `the pending pointer; re-run to reconcile.`
  );
  process.exit(1);
}
console.log(`product on shop (status ${p.status}): ${p.title}`);
console.log(`productId: ${p.id}`);
console.log("");
// Variant titles are DISPLAY values ("One Size"); the ID map must key by the
// original catalogue size token, so map display → size before building it.
const sizeByDisplay = new Map(sizes.map((s) => [sizeName(s), s]));
const rows = p.variants.nodes.map((v) => ({
  size: sizeByDisplay.get(v.title) ?? v.title,
  variantId: v.id,
  inventoryItemId: v.inventoryItem?.id ?? "",
}));

// Completeness gate: the map is only written when EVERY expected size came
// back as exactly one variant with an inventory item. A partial map would
// silently starve the future inventory sync of IDs for the missing sizes.
const readBackProblems = [];
if (p.variants.pageInfo.hasNextPage) readBackProblems.push("more than 100 variants (unpaginated)");
const returnedTitles = new Set(p.variants.nodes.map((v) => v.title));
for (const s of sizes) {
  if (!returnedTitles.has(sizeName(s))) readBackProblems.push(`size "${sizeName(s)}" missing from read-back`);
}
if (p.variants.nodes.length !== sizes.length) {
  readBackProblems.push(`expected ${sizes.length} variants, read back ${p.variants.nodes.length}`);
}
for (const r of rows) {
  if (!r.inventoryItemId) readBackProblems.push(`variant "${r.size}" has no inventoryItemId`);
}
if (readBackProblems.length) {
  console.error(
    `Refusing to write the ID map — read-back incomplete: ${readBackProblems.join("; ")}. ` +
      `The pending pointer (if any) is preserved; re-run to reconcile.`
  );
  process.exit(1);
}
const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const cols = ["size", "variantId", "inventoryItemId"];
const line = (r) => cols.map((k) => String(r[k]).padEnd(w(k))).join("  ");
console.log(line(Object.fromEntries(cols.map((k) => [k, k]))));
console.log(cols.map((k) => "-".repeat(w(k))).join("  "));
for (const r of rows) console.log(line(r));

const mapping = buildMapping(shopifyProductId, rows);
const plan = await writeIdMap(admin.database(), productId, mapping);
console.log(`\n/shopify_sync/${productId} ← ID map (${plan.action})`);
console.log(JSON.stringify(mapping, null, 2));
process.exit(0);
