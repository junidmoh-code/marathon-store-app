// READ-ONLY investigation for the Slow Movers feature.
// Confirms: product age field(s), product-id format, and insights_log sales shape.
// Auth: anonymous (mirrors scripts/seed-depleted-preview.mjs). Writes nothing.
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref } from "firebase/database";

const FB_CONFIG = {
  apiKey:            "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain:        "marathon-club.firebaseapp.com",
  databaseURL:       "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "marathon-club",
  storageBucket:     "marathon-club.firebasestorage.app",
  messagingSenderId: "306270814317",
  appId:             "1:306270814317:web:470395933121de7dbdbf64",
};

const app = initializeApp(FB_CONFIG);
await signInAnonymously(getAuth(app));
const db = getDatabase(app);

const ms2date = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── PRODUCTS ────────────────────────────────────────────────────────────
const psnap = await get(ref(db, "products"));
const pdata = psnap.val() || {};
const products = Object.entries(pdata).filter(([, p]) => p && p.id);
console.log(`\n=== PRODUCTS: ${products.length} total ===`);

// what fields exist across products?
const fieldCounts = {};
for (const [, p] of products) for (const k of Object.keys(p)) fieldCounts[k] = (fieldCounts[k] || 0) + 1;
console.log("\nField presence (field: count / total):");
for (const [k, c] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${c}/${products.length}`);
}

// any explicit timestamp/date fields?
const dateFields = ["createdAt", "created", "createdOn", "uploadedAt", "addedAt", "timestamp", "dateAdded"];
console.log("\nExplicit date-ish fields found:", dateFields.filter(f => fieldCounts[f]).join(", ") || "(none)");

// id format analysis: how many keys match p<digits> ?
let pNum = 0, other = 0;
const sampleKeys = [];
let minMs = Infinity, maxMs = -Infinity;
for (const [key] of products) {
  const m = /^p(\d{10,})$/.exec(key);
  if (m) {
    pNum++;
    const ms = Number(m[1]);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  } else {
    other++;
    if (sampleKeys.length < 15) sampleKeys.push(key);
  }
}
console.log(`\nID format: ${pNum} keys match /^p\\d{10,}$/ (Date.now-derived), ${other} do not.`);
if (pNum) console.log(`  Derived upload range: ${ms2date(minMs)} … ${ms2date(maxMs)}`);
if (other) console.log(`  Non-conforming sample keys:`, sampleKeys);

// sample 3 products fully
console.log("\nSample product records (first 3):");
for (const [key, p] of products.slice(0, 3)) {
  console.log(`  key=${key}`, JSON.stringify({ id: p.id, name: p.name, productType: p.productType, category: p.category, hubs: p.hubs || p.hub, createdAt: p.createdAt, photoUrl: p.photoUrl ? "(url)" : null }));
}

// ── INSIGHTS_LOG (sales) ────────────────────────────────────────────────
const lsnap = await get(ref(db, "insights_log"));
const ldata = lsnap.val() || {};
const logs = Object.values(ldata).filter(Boolean);
console.log(`\n=== INSIGHTS_LOG: ${logs.length} entries ===`);
const actionCounts = {};
for (const l of logs) actionCounts[l.action || "(none)"] = (actionCounts[l.action || "(none)"] || 0) + 1;
console.log("Action breakdown:", actionCounts);
const ready = logs.filter(l => l && l.action === "ready");
console.log(`\n"ready" (sale) events: ${ready.length}`);
if (ready.length) {
  const times = ready.map(r => Date.parse(r.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  Sale date range: ${ms2date(times[0])} … ${ms2date(times[times.length - 1])}`);
  console.log("  Sample ready event:", JSON.stringify(ready[0]));
  // distinct products with at least one sale
  const soldNames = new Set(ready.map(r => r.productName).filter(Boolean));
  console.log(`  Distinct productNames with >=1 sale: ${soldNames.size}`);
}

// ── ORDERS (ephemeral, but check) ───────────────────────────────────────
const osnap = await get(ref(db, "orders"));
const odata = osnap.val() || {};
const orders = Object.values(odata).filter(Boolean);
console.log(`\n=== ORDERS: ${orders.length} live entries ===`);
if (orders.length) console.log("  Sample order keys:", Object.keys(orders[0]).join(", "));

// ── COVERAGE: how many products have sales, and name-match rate ──────────
const productNames = new Set(products.map(([, p]) => p.name).filter(Boolean));
const soldNames = new Set(ready.map(r => r.productName).filter(Boolean));
let matched = 0, unmatched = 0;
for (const n of soldNames) (productNames.has(n) ? matched++ : unmatched++);
console.log(`\n=== COVERAGE ===`);
console.log(`  Sold productNames matching a current product: ${matched}`);
console.log(`  Sold productNames with NO current product:    ${unmatched}`);
const withSales = [...productNames].filter(n => soldNames.has(n)).length;
console.log(`  Current products with >=1 sale: ${withSales}/${productNames.size}`);
console.log(`  Current products with ZERO sales: ${productNames.size - withSales}/${productNames.size}`);

process.exit(0);
