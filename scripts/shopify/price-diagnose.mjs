// ── One product's price, end to end: app record → Shopify → reconciler log ───
// Read-only. Answers "why does the website show a different price from the
// app?" for the products whose Shopify title matches a phrase.
//
//   node scripts/shopify/price-diagnose.mjs "travis scott"
//
// How it finds the records WITHOUT a whole-node read:
//   1. Shopify title search → product gids, variant prices, updatedAt, events.
//   2. /shopify_publish ordered by `state` == "live" (the indexed query the
//      reconciler already uses) → each live node's adminUrl carries the
//      numeric Shopify id, so gid → productId with no scan of /products.
//   3. /products/{pid} by id, /shopify_sync/{pid} by id.
//   4. The reconciler's own log lines ("variant prices set to …") on this
//      machine, if logs/ exists here (the Mac mini).
import { createRequire } from "module";
import { readdirSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { graphql } from "./client.mjs";

const phrase = process.argv.slice(2).join(" ").trim();
if (!phrase) { console.error('usage: price-diagnose.mjs "<title phrase>"'); process.exit(2); }

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const PRICE_FIELD = /price|cost|trade|retail|rrp|special|sale/i;

function priceFields(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object") {
      if (PRICE_FIELD.test(k)) out.push(...priceFields(v, `${prefix}${k}.`));
      continue;
    }
    if (PRICE_FIELD.test(k)) out.push([`${prefix}${k}`, v]);
  }
  return out;
}

const words = phrase.split(/\s+/).map((w) => `title:*${w.replace(/[^a-z0-9]/gi, "")}*`).join(" AND ");
const found = await graphql(
  `query ($q: String!) { products(first: 25, query: $q) { nodes {
     id title handle status updatedAt createdAt
     variants(first: 100) { nodes { id title price compareAtPrice updatedAt } }
     events(first: 20, sortKey: CREATED_AT, reverse: true) { nodes { createdAt message appTitle } }
   } } }`,
  { q: words }
);
const products = found.products.nodes;
if (!products.length) { console.log(`no Shopify product title matches ${JSON.stringify(phrase)}`); process.exit(0); }

const liveSnap = await db.ref("shopify_publish").orderByChild("state").equalTo("live").get();
const byNumeric = new Map();
for (const [pid, n] of Object.entries(liveSnap.val() || {})) {
  const num = String(n?.adminUrl || "").split("/").pop();
  if (num) byNumeric.set(num, [pid, n]);
}

const logDir = fileURLToPath(new URL("../../logs/", import.meta.url));
const logFiles = existsSync(logDir)
  ? readdirSync(logDir).filter((f) => f.startsWith("shopify-reconcile.log")).sort().reverse()
  : [];

for (const sp of products) {
  const num = sp.id.split("/").pop();
  console.log(`\n══ ${sp.title}  [${sp.status}]  ${sp.id}`);
  console.log(`   handle ${sp.handle} · created ${sp.createdAt} · updated ${sp.updatedAt}`);
  const prices = [...new Set(sp.variants.nodes.map((v) => v.price))];
  console.log(`   Shopify variant prices: ${prices.join(", ")} (${sp.variants.nodes.length} variants)`);
  for (const v of sp.variants.nodes) console.log(`     ${v.title.padEnd(10)} R${v.price}${v.compareAtPrice ? ` (compare-at R${v.compareAtPrice})` : ""}  variant updated ${v.updatedAt}`);
  console.log(`   Shopify events (newest first):`);
  for (const e of sp.events.nodes) console.log(`     ${e.createdAt}  ${e.appTitle || "(admin / no app)"}: ${e.message.replace(/<[^>]+>/g, "")}`);

  const hit = byNumeric.get(num);
  if (!hit) { console.log(`   no /shopify_publish live node points at this product (legacy or off)`); continue; }
  const [pid, node] = hit;
  const product = (await db.ref(`products/${pid}`).get()).val() || {};
  const sync = (await db.ref(`shopify_sync/${pid}`).get()).val() || {};
  console.log(`   app productId ${pid} · name ${JSON.stringify(product.name)}`);
  console.log(`   app price fields:`);
  for (const [k, v] of priceFields(product)) console.log(`     ${k.padEnd(28)} ${JSON.stringify(v)}`);
  console.log(`   publish node: liveState ${node.liveState} · liveAt ${node.liveAt ? new Date(node.liveAt).toISOString() : "-"} · updatedAt ${node.updatedAt ? new Date(node.updatedAt).toISOString() : "-"} by ${node.updatedBy}`);
  const syncPrices = priceFields(sync);
  if (syncPrices.length) for (const [k, v] of syncPrices) console.log(`     shopify_sync.${k} ${JSON.stringify(v)}`);

  // The reconciler opens each product's block with "▶ <pid> → ON" and prints
  // "variant prices set to X" inside it (the mapped path; the create path
  // prices at creation and says "created").
  let pushes = 0;
  for (const f of logFiles) {
    let cur = null;
    for (const l of readFileSync(logDir + f, "utf8").split("\n")) {
      const open = l.match(/▶ (\S+) → /);
      if (open) cur = open[1];
      if (cur === pid && /variant prices set to|created gid|→ ON|→ OFF/.test(l)) { console.log(`   log ${f}: ${l.trim()}`); pushes += 1; }
    }
  }
  if (logFiles.length && !pushes) console.log(`   reconciler logs on this machine hold no push for ${pid} (they rotate at 5 × 5 MB)`);
}
process.exit(0);
