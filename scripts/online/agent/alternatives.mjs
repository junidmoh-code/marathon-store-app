// ── Up to four alternatives a customer can actually get ──────────────────────
// "Live on the storefront" is asked of Shopify itself: ACTIVE, published to
// the online store, the customer's size available for sale. Same category =
// the same Shopify product type as the unavailable item. Nearest price first.
// Every candidate is then checked against the APP's stock with exact cell
// reads — free units (live qty minus other website orders' holds) at ONE
// place the line could be routed to — so an offer is never a unit that is not
// there. No whole-node read anywhere.
import { stockSizeKey } from "../../../src/utils/sizeKey.js";
import { availableAt, routeFor } from "../../shopify/onlineOrders/routing.mjs";
import { MAX_OFFERS, productUrl } from "./core.mjs";

const tail = (gid) => String(gid ?? "").split("/").pop();
const cents = (amount) => Math.round(Number(amount) * 100);
const sizeMatches = (variantTitle, size) => {
  const want = size == null || size === "" || size === "_" ? "_" : stockSizeKey(size);
  const got = variantTitle == null || /^default title$/i.test(String(variantTitle)) ? "_" : stockSizeKey(variantTitle);
  return want === got;
};

async function productTypeOf(graphql, productGid) {
  if (!productGid) return null;
  const d = await graphql(`query ($id: ID!) { product(id: $id) { id productType } }`, { id: productGid });
  return d.product?.productType || null;
}

/**
 * → [{ pid, title, handle, url, priceCents, size, locationId, status }] (≤ 4).
 * `get(path)` is an exact RTDB read; `orderId` is the order being served (its
 * own holds never count against it).
 */
export async function findAlternatives({ graphql, get, line, orderId }) {
  const type = await productTypeOf(graphql, line.productGid);
  if (!type) return [];
  const q = `product_type:'${type.replace(/'/g, "\\'")}' AND status:active AND published_status:published`;
  const data = await graphql(
    `query ($q: String!) {
      products(first: 100, query: $q) {
        nodes { id handle title variants(first: 50) { nodes { id title availableForSale price } } }
      }
    }`,
    { q },
  );
  const target = Number(line.unitPriceCents) || 0;
  const qty = Number(line.qty) || 1;
  const pool = [];
  for (const p of data.products?.nodes ?? []) {
    if (tail(p.id) === tail(line.productGid)) continue;
    const v = (p.variants?.nodes ?? []).find((x) => x.availableForSale && sizeMatches(x.title, line.size));
    if (!v || !p.handle) continue;
    pool.push({ gid: p.id, title: p.title, handle: p.handle, priceCents: cents(v.price), variantTitle: v.title });
  }
  // Never offer what the code would refuse: nothing dearer than was paid
  // per unit (a swapped line's ceiling is its original price).
  const ceiling = Number.isInteger(line.originalUnitPriceCents) ? line.originalUnitPriceCents : target;
  for (let k = pool.length - 1; k >= 0; k--) if (pool[k].priceCents > ceiling) pool.splice(k, 1);
  pool.sort((a, b) => Math.abs(a.priceCents - target) - Math.abs(b.priceCents - target) || a.priceCents - b.priceCents);
  const out = [];
  for (const c of pool) {
    if (out.length >= MAX_OFFERS) break;
    const pid = await get(`shopify_sync/_claims/${tail(c.gid)}`);
    if (typeof pid !== "string" || !pid) continue;
    const product = await get(`products/${pid}`);
    if (!product) continue;
    const sizes = Array.isArray(product.sizes) ? product.sizes : Object.values(product.sizes || {});
    const size = sizes.find((s) => sizeMatches(c.variantTitle, s)) ?? (line.size ?? "_");
    const sizeKey = stockSizeKey(size);
    const isFootwear = line.isFootwear === true;
    const stockQty = {};
    for (const step of routeFor(isFootwear)) stockQty[step.locationId] = Number(await get(`stock/${step.locationId}/${pid}/${sizeKey}/qty`)) || 0;
    const holdsCell = await get(`online_reservations/${pid}/${sizeKey}`);
    const free = availableAt({ stockQty, holdsCell, orderId });
    const where = routeFor(isFootwear).find((s) => (free[s.locationId] || 0) >= qty);
    if (!where) continue;
    out.push({
      pid, size, sizeKey, title: c.title, handle: c.handle, url: productUrl(c.handle), priceCents: c.priceCents,
      locationId: where.locationId, status: where.status, photoUrl: product.photoUrl ?? null,
      category: product.category ?? null, productGid: c.gid,
    });
  }
  return out;
}

/**
 * The storefront LISTING name of the line's product (Shopify's title — the
 * compliance-cleaned public name, no brand added). Messages may be forwarded,
 * so the app's own product name (which can carry a brand) is never used.
 */
export async function listingTitle(graphql, line) {
  if (!line?.productGid) return null;
  const d = await graphql(`query ($id: ID!) { product(id: $id) { title } }`, { id: line.productGid });
  return d.product?.title || null;
}

/** Is the offered unit still free at the place the offer found it? Exact reads. */
export async function offerStillAvailable({ get, offer, line, orderId }) {
  const qty = Number(line.qty) || 1;
  const stockQty = { [offer.locationId]: Number(await get(`stock/${offer.locationId}/${offer.pid}/${offer.sizeKey}/qty`)) || 0 };
  const free = availableAt({ stockQty, holdsCell: await get(`online_reservations/${offer.pid}/${offer.sizeKey}`), orderId });
  return (free[offer.locationId] || 0) >= qty;
}
