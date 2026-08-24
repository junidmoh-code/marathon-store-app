// Catalogue eligibility audit. READ ONLY — no mutations.
import { graphql } from "./scripts/shopify/client.mjs";

const Q = `query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status totalInventory
      featuredMedia { ... on MediaImage { image { url width height } mediaContentType status } }
      media(first: 1) { nodes { ... on MediaImage { image { url width height } status } } }
      variants(first: 50) { nodes { id inventoryQuantity inventoryPolicy availableForSale } }
    }
  }
}`;

let cursor = null, all = [];
do {
  const d = await graphql(Q, { cursor });
  const p = d.products;
  all.push(...p.nodes);
  cursor = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
  process.stderr.write(`fetched ${all.length}\r`);
} while (cursor);
process.stderr.write("\n");

const active = all.filter(p => p.status === "ACTIVE");
console.log("total products:", all.length, "| ACTIVE:", active.length);

let noImage = 0, tooSmall = 0, ok = 0, notReady = 0;
const smalls = [], missing = [];
for (const p of active) {
  const img = p.featuredMedia?.image || p.media?.nodes?.[0]?.image || null;
  const st = p.featuredMedia?.status || p.media?.nodes?.[0]?.status;
  if (!img || !img.url) { noImage++; missing.push(p.handle); continue; }
  if (st && st !== "READY") notReady++;
  const w = img.width || 0, h = img.height || 0;
  if (w < 500 || h < 500) { tooSmall++; smalls.push(`${p.handle} ${w}x${h}`); }
  else ok++;
}
console.log("\n── IMAGES (ACTIVE products) ──");
console.log("  no image at all      :", noImage);
console.log("  media not READY      :", notReady);
console.log("  smaller than 500x500 :", tooSmall);
console.log("  >=500x500            :", ok);
if (smalls.length) console.log("  examples too small   :", smalls.slice(0, 8).join(" | "));
if (missing.length) console.log("  examples no image    :", missing.slice(0, 8).join(" | "));

let zero = 0, negative = 0, positive = 0, deny = 0;
for (const p of active) {
  const q = p.totalInventory ?? 0;
  if (q > 0) positive++; else if (q < 0) negative++; else zero++;
  if (p.variants.nodes.some(v => v.inventoryPolicy === "DENY")) deny++;
}
console.log("\n── INVENTORY (ACTIVE products) ──");
console.log("  totalInventory > 0   :", positive);
console.log("  totalInventory = 0   :", zero, "  <- Meta marks these out of stock");
console.log("  totalInventory < 0   :", negative);
console.log("  any variant DENY     :", deny);

// sample image URLs for the unauthenticated fetch test
const sample = active.filter(p => (p.featuredMedia?.image || p.media?.nodes?.[0]?.image)).slice(0, 3)
  .map(p => (p.featuredMedia?.image || p.media.nodes[0].image).url);
console.log("\nSAMPLE_URLS:");
for (const u of sample) console.log(u);
