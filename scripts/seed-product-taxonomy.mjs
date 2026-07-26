// ─── SEED THE PRODUCT TAXONOMY REGISTRY ───────────────────────────────────────
// Writes the 31-category registry to RTDB `/settings/productTaxonomy` from the
// single source of truth in src/utils/productTaxonomy.js.
//
// WHY /settings: it already carries `.read: auth != null` / `.write: non-anon`
// in the LIVE rules, so this needs NO rules change and no console edit. A fresh
// top-level node (e.g. /product_taxonomy) would be denied both read and write —
// the root cascade was removed in PR #57.
//
// SAFE TO RE-RUN. Idempotent: it writes the registry node and nothing else.
// It NEVER touches /products, /stock, /stock_targets or /config.
//
//   node scripts/seed-product-taxonomy.mjs --dry-run   # print the diff, write nothing
//   node scripts/seed-product-taxonomy.mjs             # write
//
// After a category is live you can add the next one straight in the console —
// this script exists to plant the first 31, not to own them forever.

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "functions", "package.json"));
const admin = require("firebase-admin");

const { TAXONOMY_SEED } = await import(path.join(HERE, "..", "src", "utils", "productTaxonomy.js"));

const DRY = process.argv.includes("--dry-run");
const NODE = "settings/productTaxonomy";

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

// serverTimestamp on the node, not a client clock — the 2026-07-17 order-counter
// incident is the standing reminder that till/laptop clocks lie.
const payload = { ...TAXONOMY_SEED, updatedAt: admin.database.ServerValue.TIMESTAMP, updatedBy: "seed-product-taxonomy" };

const existing = await db.ref(NODE).once("value").then((s) => s.val());
const seedKeys = Object.keys(TAXONOMY_SEED.cats).sort();
const liveKeys = Object.keys((existing && existing.cats) || {}).sort();

console.log(`node:        /${NODE}`);
console.log(`live:        ${existing ? `${liveKeys.length} categories (version ${existing.version})` : "ABSENT — first seed"}`);
console.log(`seed:        ${seedKeys.length} categories (version ${TAXONOMY_SEED.version})`);

if (existing) {
  const added = seedKeys.filter((k) => !liveKeys.includes(k));
  const removed = liveKeys.filter((k) => !seedKeys.includes(k));
  if (added.length) console.log(`  + ${added.join(", ")}`);
  if (removed.length) console.log(`  - ${removed.join(", ")}   ← THESE WOULD BE DROPPED`);
  if (!added.length && !removed.length) console.log("  (same category set — values refreshed)");
}

// Sanity: refuse to seed anything that would half-type a product.
for (const [k, c] of Object.entries(TAXONOMY_SEED.cats)) {
  if (!c.legacy || !c.legacy.category) throw new Error(`category "${k}" has no legacy.category — refusing to seed`);
  if (!Array.isArray(c.sizes) || !c.sizes.length) throw new Error(`category "${k}" has no sizes — refusing to seed`);
}

if (DRY) {
  console.log("\n--dry-run: nothing written.");
  console.log(JSON.stringify(TAXONOMY_SEED, null, 2).slice(0, 1200) + "\n…");
  process.exit(0);
}

await db.ref(NODE).set(payload);
const back = await db.ref(NODE).once("value").then((s) => s.val());
console.log(`\nwritten. read-back: ${Object.keys(back.cats).length} categories, version ${back.version}.`);
process.exit(0);
