// ── Smoke test: prove auth + list locations. ZERO writes. ────────────────────
// Mints a token via the client credentials grant, reads shop info and the
// location list, prints both. Prints expires_in but NEVER the token.
//
//   node scripts/shopify/smoke.mjs
import { graphql, API_VERSION } from "./client.mjs";
import { tokenInfo } from "./token.mjs";

const data = await graphql(`
  {
    shop { name myshopifyDomain currencyCode primaryDomain { url } }
    locations(first: 20) { nodes { id name isActive fulfillsOnlineOrders } }
  }
`);

const info = tokenInfo();
console.log(`token ok — expires_in: ${info?.expiresIn}s, scope: ${info?.scope}`);
console.log(`api version: ${API_VERSION}`);
console.log(`shop: ${data.shop.name} (${data.shop.myshopifyDomain})`);
console.log(`storefront: ${data.shop.primaryDomain?.url}  currency: ${data.shop.currencyCode}`);
console.log("locations:");
for (const l of data.locations.nodes) {
  console.log(
    `  ${l.id}  ${l.name}  active=${l.isActive}  fulfillsOnlineOrders=${l.fulfillsOnlineOrders}`
  );
}
