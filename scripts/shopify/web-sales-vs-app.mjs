// ─── WEB SALES vs THE APP — did every website order reach /stock? ───────────
//
//   node scripts/shopify/web-sales-vs-app.mjs [YYYY-MM-DD]     (default 2026-10-01)
//
// READ-ONLY. There is no Shopify order webhook: a web sale leaves /stock only
// through a POS slip (before the 21 Oct 2026 go-live) or the pack (after it,
// docs/ONLINE-ORDERS.md — the pack writes ordinary `sold` movements).
//
// For every FULFILLED Shopify order line since the date (current quantity, so
// refunds and edits are out), this looks for an app `sold` movement that can
// account for it, each movement used once, most specific first:
//   1. same product, same size, from 7 days BEFORE the order on (a till sale
//      rung first and the web order raised afterwards still counts)
//   2. same product, another size            → "wrong size?"
//   3. a sibling record (same style code, or the same normalised name), any
//      size                                  → "sibling?"
// A line none of these explains is a web sale the app never learned of. Sizes
// come from the order's VARIANT id through /shopify_sync/{pid}/variants (the
// pusher's own map), never the variant title.
//
// Lines on products with no listed app product are counted and skipped.
// Post-go-live lines are joined to /online_orders/{orderId} to say which path
// failed (pack vs admin fulfilment).
//
// READS: Shopify orders; /shopify_publish by its state index; per pid on an
// order, /shopify_sync/{pid}; /stock_movements by its ts index from 7 days
// before the date (~0.5 MB/day); /products/{pid}/{name,styleCode} for the pids
// those sales and lines touch; /online_orders/{id}/status per post-go-live
// order; per unexplained line, that product's cells at the counted locations.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { networkTotals } from "./inventory.mjs";
import { locationNames } from "./inventorySync.mjs";
import { ONLINE_ORDERS_PATH } from "../../src/utils/onlineOrders.js";
import { matchWebLine, siblingKeys } from "./webSales.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const SINCE = process.argv[2] || "2026-10-01";
const GO_LIVE = Date.parse("2026-10-21T12:31:00Z");   // website orders live, 14:31 SAST
let bytes = 0;
const get = async (path, q = (r) => r) => { const v = (await q(db.ref(path)).get()).val(); bytes += Buffer.byteLength(JSON.stringify(v ?? null)); return v; };

const orders = [];
let after = null;
do {
  // Small pages: a nested connection is priced at first × first, and the
  // shop's single-query ceiling is 1,000 points.
  const d = await graphql(`query($a:String,$q:String!){orders(first:20,after:$a,query:$q,sortKey:CREATED_AT){pageInfo{hasNextPage endCursor}
    nodes{id name createdAt cancelledAt displayFulfillmentStatus lineItems(first:40){pageInfo{hasNextPage} nodes{currentQuantity variant{id} product{id}}}}}}`,
  { a: after, q: `created_at:>=${SINCE}` });
  for (const o of d.orders.nodes) if (o.lineItems.pageInfo.hasNextPage) throw new Error(`${o.name} has more than 40 lines — raise the page size before trusting the count`);
  orders.push(...d.orders.nodes);
  after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
} while (after);

const listed = (await get("shopify_publish", (r) => r.orderByChild("state").equalTo("live"))) || {};
const gidToPid = new Map();
await Promise.all(Object.keys(listed).map(async (p) => { const g = (await get(`shopify_sync/${p}/shopifyProductId`)); if (g) gidToPid.set(g, p); }));

// Variant gid → size key, from the id maps of the products on these orders.
const variantSize = new Map();
const orderPids = new Set();
for (const o of orders) for (const li of o.lineItems.nodes) { const p = gidToPid.get(li.product?.id); if (p) orderPids.add(p); }
await Promise.all([...orderPids].map(async (pid) => {
  const vars = (await get(`shopify_sync/${pid}/variants`)) || {};
  for (const [sizeKey, v] of Object.entries(vars)) if (v?.shopifyVariantId) variantSize.set(v.shopifyVariantId, sizeKey);
}));

const fromIso = new Date(Date.parse(SINCE) - 7 * 864e5).toISOString();
const sold = Object.values((await get("stock_movements", (r) => r.orderByChild("ts").startAt(fromIso))) || {})
  .filter((m) => m.type === "sold" && m.productId);

// Name + style code for every product the lines or the sales touch.
const meta = new Map();
await Promise.all([...new Set([...orderPids, ...sold.map((m) => m.productId)])].map(async (pid) => {
  const [name, styleCode] = await Promise.all([get(`products/${pid}/name`), get(`products/${pid}/styleCode`)]);
  meta.set(pid, siblingKeys({ name, styleCode }));
}));

const lines = [];
let unlisted = 0, unsized = 0, cancelled = 0;
for (const o of orders) {
  if (o.cancelledAt) { cancelled++; continue; }
  if (o.displayFulfillmentStatus !== "FULFILLED") continue;
  for (const li of o.lineItems.nodes) {
    if (!(li.currentQuantity > 0)) continue;
    const pid = gidToPid.get(li.product?.id);
    if (!pid) { unlisted++; continue; }
    const size = variantSize.get(li.variant?.id);
    if (size == null) { unsized++; continue; }
    lines.push({ order: o.name, orderGid: o.id, createdAt: Date.parse(o.createdAt), pid, size, qty: li.currentQuantity });
  }
}
// Oldest first, so an earlier order takes the earlier sale.
lines.sort((a, b) => a.createdAt - b.createdAt);
const result = matchWebLine(lines, sold, meta);

const tally = { exact: 0, wrongSize: 0, sibling: 0, none: 0 };
for (const r of result) tally[r.match]++;
const none = result.filter((r) => r.match === "none");
console.log(`orders since ${SINCE}: ${orders.length} (${cancelled} cancelled); fulfilled lines judged: ${lines.length}; skipped: ${unlisted} on unlisted products, ${unsized} with no id-map size`);
console.log(`explained: ${tally.exact} same product+size · ${tally.wrongSize} same product, other size (wrong size?) · ${tally.sibling} sibling record (style code / name)`);
console.log(`NOT explained by any app sale: ${none.length} line(s) — ${none.filter((r) => r.createdAt < GO_LIVE).length} before go-live (POS slip era), ${none.filter((r) => r.createdAt >= GO_LIVE).length} after`);

const locs = await locationNames(db);
let offered = 0, offeredUnits = 0;
for (const r of none) {
  let status = "";
  if (r.createdAt >= GO_LIVE) {
    const s = await get(`${ONLINE_ORDERS_PATH}/${String(r.orderGid).split("/").pop()}/status`);
    status = ` · app order: ${s ?? "NONE (admin-fulfilled, never ingested)"}`;
  }
  const tree = {};
  for (const l of locs) { const c = await get(`stock/${l}/${r.pid}`); if (c) tree[l] = { [r.pid]: c }; }
  const q = networkTotals(tree, r.pid, [r.size])[r.size] ?? 0;
  if (q > 0) { offered++; offeredUnits += q; }
  console.log(`  ${r.order} ${new Date(r.createdAt).toISOString().slice(0, 10)} ${r.pid} ${r.size} ×${r.qty} · app pool now ${q}${status}`);
}
console.log(`of those, ${offered} size(s) still have app stock online (${offeredUnits} unit(s)) — the website offers them`);
console.log(`rtdb read: ${bytes.toLocaleString()} B`);
process.exit(0);
