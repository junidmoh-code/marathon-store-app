import { graphql } from "./scripts/shopify/client.mjs";
const Q = `query($cursor: String) { products(first: 100, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes { handle status totalInventory
    variants(first: 60) { nodes { inventoryQuantity inventoryPolicy inventoryItem { tracked } } } } } }`;
let cursor = null, all = [];
do { const d = await graphql(Q, { cursor }); all.push(...d.products.nodes);
     cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null; } while (cursor);
const active = all.filter(p => p.status === "ACTIVE");
let allTracked = 0, someUntracked = 0, zeroInv = 0, posInv = 0;
for (const p of active) {
  const vs = p.variants.nodes;
  if (vs.every(v => v.inventoryItem?.tracked)) allTracked++; else someUntracked++;
  if ((p.totalInventory ?? 0) > 0) posInv++; else zeroInv++;
}
console.log("ACTIVE products      :", active.length);
console.log("all variants tracked :", allTracked);
console.log("some UNTRACKED       :", someUntracked);
console.log("totalInventory > 0   :", posInv);
console.log("totalInventory = 0   :", zeroInv);
