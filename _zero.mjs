import { graphql } from "./scripts/shopify/client.mjs";
import fs from "fs";
const Q = `query($cursor: String) { products(first: 100, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes { id handle status totalInventory
    featuredMedia { ... on MediaImage { image { url width height } } }
    variants(first: 60) { nodes { title inventoryQuantity sku } } } } }`;
let cursor = null, out = [];
do {
  const d = await graphql(Q, { cursor });
  out.push(...d.products.nodes);
  cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (cursor);
const active = out.filter(p => p.status === "ACTIVE");
const pidOf = (p) => {
  const u = p.featuredMedia?.image?.url || "";
  const m = u.match(/products_2F(p\d+)_2F/);
  return m ? m[1] : null;
};
const rows = active.map(p => ({
  handle: p.handle, pid: pidOf(p), total: p.totalInventory ?? 0,
  w: p.featuredMedia?.image?.width || 0, h: p.featuredMedia?.image?.height || 0,
  variants: p.variants.nodes.map(v => ({ t: v.title, q: v.inventoryQuantity })),
}));
fs.writeFileSync("/tmp/mc_rows.json", JSON.stringify(rows));
const zero = rows.filter(r => r.total === 0);
console.log("active:", rows.length, "| zero-inventory:", zero.length, "| pid resolved:", rows.filter(r=>r.pid).length);
console.log("zero with pid:", zero.filter(r=>r.pid).length);
console.log("sample zero variant titles:", JSON.stringify(zero.slice(0,3).map(z=>({h:z.handle,pid:z.pid,v:z.variants.slice(0,6)})), null, 1).slice(0,700));
