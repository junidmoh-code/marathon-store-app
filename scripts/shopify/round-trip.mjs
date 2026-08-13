// ── One-product round trip: RTDB → Shopify product with one variant/size ─────
// Reads ONE product from RTDB (READ-ONLY — this script never writes RTDB),
// maps it to a Shopify productSet payload, and:
//
//   node scripts/shopify/round-trip.mjs <productId>            dry run —
//       prints the exact payload that WOULD be sent, and nothing else.
//   node scripts/shopify/round-trip.mjs <productId> --commit   creates the
//       product ONCE, reads it back, prints productId + every variantId and
//       inventoryItemId as a table, then stops.
//
// The returned IDs are printed only — persisting them into RTDB is a later
// slice, blocked on the ID-map naming decision in docs/SHOPIFY-SYNC.md §5.
//
// Safety rails:
//   • Created as status DRAFT — never visible on the storefront.
//   • Refuses to --commit if a product with the identical title already
//     exists on the shop (guards against accidental duplicates on re-run).
//   • RTDB access is read-only via ADC (same pattern as scripts/*.mjs).
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { encodeSizeKey } from "../../src/utils/sizeKey.js";

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
const sizes = Array.isArray(product.sizes) && product.sizes.length ? product.sizes : null;
if (!sizes) problems.push("no sizes array");
if (problems.length) {
  console.error(`Refusing to map ${productId}: ${problems.join("; ")}`);
  process.exit(1);
}

// "_" is the one-size sentinel; Shopify needs a human-readable option value.
const sizeName = (s) => (s === "_" ? "One Size" : String(s));
const price = Number(product.retailPrice).toFixed(2);

const input = {
  title: String(product.name).trim(),
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

// ── --commit: duplicate guard, create once, read back ────────────────────────
const dupe = await graphql(
  `query ($q: String!) { products(first: 3, query: $q) { nodes { id title } } }`,
  { q: `title:'${input.title.replace(/'/g, "\\'")}'` }
);
const exact = dupe.products.nodes.filter((n) => n.title === input.title);
if (exact.length) {
  console.error(
    `Refusing to create: ${exact.length} product(s) with this exact title already exist ` +
      `on the shop (${exact.map((n) => n.id).join(", ")}). This script creates a product ` +
      `at most once.`
  );
  process.exit(1);
}

const created = await graphql(
  `mutation ($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product { id }
      userErrors { field message }
    }
  }`,
  { input }
);
const errs = created.productSet.userErrors;
if (errs?.length) {
  console.error(`productSet userErrors: ${JSON.stringify(errs, null, 2)}`);
  process.exit(1);
}
const shopifyProductId = created.productSet.product.id;

const back = await graphql(
  `query ($id: ID!) {
    product(id: $id) {
      id title status
      variants(first: 100) {
        nodes { id title sku inventoryItem { id } }
      }
    }
  }`,
  { id: shopifyProductId }
);

const p = back.product;
console.log(`created (status ${p.status}): ${p.title}`);
console.log(`productId: ${p.id}`);
console.log("");
const rows = p.variants.nodes.map((v) => ({
  size: v.title,
  variantId: v.id,
  inventoryItemId: v.inventoryItem?.id ?? "",
}));
const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const cols = ["size", "variantId", "inventoryItemId"];
const line = (r) => cols.map((k) => String(r[k]).padEnd(w(k))).join("  ");
console.log(line(Object.fromEntries(cols.map((k) => [k, k]))));
console.log(cols.map((k) => "-".repeat(w(k))).join("  "));
for (const r of rows) console.log(line(r));
console.log(
  "\nIDs printed only — NOT written to RTDB (naming decision pending, docs/SHOPIFY-SYNC.md §5)."
);
process.exit(0);
