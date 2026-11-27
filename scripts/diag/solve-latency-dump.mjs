// ─── DIAG (read-only): snapshot the inputs Missing Products renders from ─────
// For the Solve latency harness (src/components/stock/solveLatency.harness.test.jsx).
// Reads /products in pages, /stock and /stock_targets ONE LOCATION AT A TIME,
// config/refillEngine and /network, and writes them to the file given. Never
// writes to the database.
//   node scripts/diag/solve-latency-dump.mjs OUT.json
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const out = process.argv[2];
const products = [];
let last = null;
for (;;) {
  let q = db.ref("products").orderByKey().limitToFirst(401);
  if (last) q = q.startAt(last);
  const page = (await q.get()).val() || {};
  const keys = Object.keys(page).sort().filter((k) => k !== last);
  if (!keys.length) break;
  for (const k of keys) products.push({ ...page[k], id: k });
  last = keys.at(-1);
  if (keys.length < 400) break;
}
const network = (await db.ref("network").get()).val();
const config = (await db.ref("config/refillEngine").get()).val();
const locs = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete", ...Object.keys(network?.locations || {})];
const stock = {}, targets = {};
for (const l of [...new Set(locs)]) {
  stock[l] = (await db.ref(`stock/${l}`).get()).val() || undefined;
  targets[l] = (await db.ref(`stock_targets/${l}`).get()).val() || undefined;
}
writeFileSync(out, JSON.stringify({ at: Date.now(), products, network, config, stock, targets }));
console.log(`products ${products.length}, locations ${Object.keys(stock).filter((l) => stock[l]).length}`);
process.exit(0);
