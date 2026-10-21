#!/usr/bin/env node
// ── Shopify orders smoke — READ ONLY ─────────────────────────────────────────
// Proves the app's token can do what the online-orders poller needs before any
// of it is trusted: list the last 3 orders and read each one's fulfilment
// orders (the object fulfillmentCreate closes when Yasmin packs).
//
// Scopes this needs (granted 2026-10-21, app version marathon-catalogue-sync-9,
// approved on the store through the managed-install URL — see
// docs/ONLINE-ORDERS.md):
//   read_orders                                (orders)
//   write_merchant_managed_fulfillment_orders  (fulfilment orders + fulfillmentCreate;
//                                               the write scope implies the read)
// A missing scope shows up here as "Access denied for fulfillmentOrders field".
//
// Prints the token's granted scopes (safe — never the token), then one block
// per order. Writes nothing anywhere.
//
//   node scripts/shopify/orders-smoke.mjs
import { graphql } from "./client.mjs";
import { getAccessToken, tokenInfo } from "./token.mjs";

const NEEDED = ["read_orders", "write_merchant_managed_fulfillment_orders"];

await getAccessToken();
const scopes = (tokenInfo()?.scope || "").split(",").filter(Boolean);
console.log(`token scopes: ${scopes.join(", ")}`);
const missing = NEEDED.filter((s) => !scopes.includes(s));
if (missing.length) {
  console.error(`✗ missing scope(s): ${missing.join(", ")} — add them on a new app version and approve it on the store`);
  process.exit(1);
}

const data = await graphql(`{
  orders(first: 3, reverse: true, sortKey: CREATED_AT) {
    nodes {
      legacyResourceId name number createdAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus
      lineItems(first: 10) { nodes { quantity variant { id } } }
      fulfillmentOrders(first: 5) {
        nodes { id status requestStatus assignedLocation { location { id name } }
                lineItems(first: 10) { nodes { remainingQuantity } } }
      }
    }
  }
}`);

for (const o of data.orders.nodes) {
  const units = o.lineItems.nodes.reduce((n, l) => n + l.quantity, 0);
  console.log(`\n${o.name} (#${o.number}, id ${o.legacyResourceId}) ${o.createdAt}` +
    `  ${o.displayFinancialStatus}/${o.displayFulfillmentStatus}${o.cancelledAt ? " CANCELLED" : ""}  ${units} unit(s)`);
  for (const fo of o.fulfillmentOrders.nodes) {
    const left = fo.lineItems.nodes.reduce((n, l) => n + l.remainingQuantity, 0);
    console.log(`  fulfilment order ${fo.id.split("/").pop()}: ${fo.status}/${fo.requestStatus} at ${fo.assignedLocation?.location?.name ?? "?"}, ${left} unit(s) remaining`);
  }
}
console.log("\n✓ orders and fulfilment orders are readable");
