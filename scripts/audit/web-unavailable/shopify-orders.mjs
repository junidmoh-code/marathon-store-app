// ─── WEBSITE UNAVAILABLE LINES — Shopify's side of the failed orders (READ ONLY) ─
//
//   node scripts/audit/web-unavailable/shopify-orders.mjs <cacheDir> <outDir>
//
// For the orders that had a failed line (read from <outDir>/episodes.json): the
// order's note, whether it was cancelled, and its refunds per line item.
// Queries only (nodes(ids:)), 40 orders a call. No mutation exists in this file.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { graphql } from "../../shopify/client.mjs";

const [CACHE, OUT] = process.argv.slice(2);
if (!CACHE || !OUT) { console.error("usage: shopify-orders.mjs <cacheDir> <outDir>"); process.exit(2); }
const target = join(CACHE, "shopify_orders.json");
if (existsSync(target)) { console.log("already cached"); process.exit(0); }
const orders = JSON.parse(readFileSync(join(CACHE, "online_orders.json"), "utf8"));
const episodes = JSON.parse(readFileSync(join(OUT, "episodes.json"), "utf8"));
const gids = [...new Set(episodes.map((e) => orders[e.key.split(":")[0]]?.shopifyGid).filter(Boolean))];
const QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name note cancelledAt cancelReason displayFinancialStatus displayFulfillmentStatus
  totalRefundedSet { shopMoney { amount } }
  refunds { id createdAt note totalRefundedSet { shopMoney { amount } } refundLineItems(first: 30) { nodes { quantity subtotalSet { shopMoney { amount } } lineItem { id title } } } } } } }`;
const out = {};
for (let i = 0; i < gids.length; i += 40) {
  const data = await graphql(QUERY, { ids: gids.slice(i, i + 40) });
  for (const n of data.nodes || []) if (n?.id) out[n.id] = n;
}
writeFileSync(target, JSON.stringify(out));
console.log(`orders read from Shopify: ${Object.keys(out).length} of ${gids.length}`);
