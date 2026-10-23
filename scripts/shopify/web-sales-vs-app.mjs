// ─── WEB SALES vs THE APP — did every website order reach /stock? ───────────
//
//   node scripts/shopify/web-sales-vs-app.mjs [YYYY-MM-DD]     (default 2026-10-01)
//
// READ-ONLY. There is no Shopify order webhook: a web sale leaves /stock only
// through a POS slip (before the 21 Oct 2026 go-live) or the pack (after it).
// For every Shopify order line since the date, this looks for an app `sold`
// movement of the same product and size at or after the order (6 h slack),
// each movement used once. A FULFILLED line with none is a sale the app never
// learned of, and the nightly sweep re-offers its unit. The match is generous
// (any sale of that product+size counts), so the gap it reports is a floor.
//
// READS: Shopify orders; /shopify_publish by its state index; one
// /shopify_sync/{pid}/shopifyProductId per listed pid; /stock_movements by its
// ts index from the date; /online_orders by its status index; and, per
// unmatched fulfilled line, that product's cells at the counted locations.
import { createRequire } from "module";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { graphql } = await import(R+"/scripts/shopify/client.mjs");
const { stockSizeKey } = await import(R+"/src/utils/sizeKey.js");
const require = createRequire(R+"/functions/package.json");
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const SINCE = process.argv[2] || "2026-10-01";
// orders
const orders = []; let after = null;
do { const d = await graphql(`query($a:String,$q:String!){orders(first:100,after:$a,query:$q,sortKey:CREATED_AT){pageInfo{hasNextPage endCursor} nodes{id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus fulfillments{createdAt} lineItems(first:50){nodes{quantity variantTitle product{id}}}}}}`, { a: after, q: `created_at:>=${SINCE}` });
  orders.push(...d.orders.nodes); after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null; } while (after);
// gid -> pid via listed pids
const listed = (await db.ref("shopify_publish").orderByChild("state").equalTo("live").get()).val() || {};
const gidToPid = new Map();
await Promise.all(Object.keys(listed).map(async (p) => { const g = (await db.ref(`shopify_sync/${p}/shopifyProductId`).get()).val(); if (g) gidToPid.set(g, p); }));
// movements since
const mv = Object.values((await db.ref("stock_movements").orderByChild("ts").startAt(SINCE).get()).val() || {});
const sold = mv.filter((m) => m.type === "sold");
const online = (await db.ref("online_orders").orderByChild("status").equalTo("packed").get()).val() || {};
const onlineNames = new Set(Object.values(online).map((o) => o.name || o.orderName || o.shopifyName));
const used = new Set();
const out = { matched: 0, unmatched: [], cancelled: 0, unmappedLines: 0, lines: 0 };
for (const o of orders) {
  if (o.cancelledAt) { out.cancelled++; continue; }
  for (const li of o.lineItems.nodes) {
    const pid = gidToPid.get(li.product?.id);
    out.lines++;
    if (!pid) { out.unmappedLines++; continue; }
    const size = stockSizeKey(li.variantTitle === "One Size" ? "_" : li.variantTitle);
    const t = Date.parse(o.createdAt) - 6 * 3600e3;
    let need = li.quantity;
    for (const m of sold) {
      if (need <= 0) break;
      const k = m.ts + m.productId + m.size + (m.link?.saleId || "");
      if (used.has(k) || m.productId !== pid || stockSizeKey(m.size) !== size || Date.parse(m.ts) < t) continue;
      used.add(k); need -= Number(m.qty) || 1;
    }
    const anySize = sold.some((m) => m.productId === pid && Date.parse(m.ts) >= t);
    const anyMove = mv.some((m) => m.productId === pid && Date.parse(m.ts) >= t && m.type !== "sold");
    if (need <= 0) out.matched++; else out.unmatched.push((o.displayFulfillmentStatus === "FULFILLED" ? "F " : "U ") + (anySize ? "[other size sold] " : "") + (anyMove ? "[other movement] " : "") + `${o.name} ${o.createdAt.slice(0,16)} ${o.displayFulfillmentStatus} fulfilled ${o.fulfillments?.[0]?.createdAt?.slice(0,16) || "-"} ${pid} ${size} ×${li.quantity}`);
  }
}
console.log(`orders since ${SINCE}: ${orders.length} (${out.cancelled} cancelled); lines ${out.lines}, ${out.unmappedLines} with no listed app product`);
console.log(`lines with a matching app 'sold' movement: ${out.matched}; WITHOUT: ${out.unmatched.length}`);
for (const u of out.unmatched) console.log("  " + u);
const F = out.unmatched.filter((u) => u.startsWith("F "));
console.log(`FULFILLED with no matching sale: ${F.length} line(s) (${F.filter((u) => /other size sold/.test(u)).length} where the same product sold in another size)`);
const fulfilledLines = orders.filter((o) => !o.cancelledAt && o.displayFulfillmentStatus === "FULFILLED").reduce((n, o) => n + o.lineItems.nodes.length, 0);
console.log(`fulfilled lines total: ${fulfilledLines}`);
const { networkTotals } = await import(R+"/scripts/shopify/inventory.mjs");
const { locationNames } = await import(R+"/scripts/shopify/inventorySync.mjs");
const locs = await locationNames(db);
let live = 0, units = 0;
for (const u of F) {
  const [, pid, size] = u.match(/ (p\d+) (\S+) ×/);
  const tree = {};
  for (const l of locs) { const c = (await db.ref(`stock/${l}/${pid}`).get()).val(); if (c) tree[l] = { [pid]: c }; }
  const q = networkTotals(tree, pid, [size])[size] ?? 0;
  if (q > 0) { live++; units += q; console.log(`  still offered: ${u.replace(/^F (\[[^\]]+\] )*/, "")} — app pool now ${q}`); }
}
console.log(`of the ${F.length}: ${live} size(s) still have app stock online (${units} unit(s)) — the website offers them`);
console.log("packed online orders in app:", Object.keys(online).length);
process.exit(0);
