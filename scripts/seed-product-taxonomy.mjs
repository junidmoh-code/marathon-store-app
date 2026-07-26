// ─── SEED THE PRODUCT TAXONOMY REGISTRY ───────────────────────────────────────
// Writes the 31-category registry to RTDB `/settings/productTaxonomy` from the
// single source of truth in src/utils/productTaxonomy.js.
//
// WHY /settings: it already carries `.read: auth != null` / `.write: non-anon`
// in the LIVE rules, so this needs NO rules change and no console edit. A fresh
// top-level node (e.g. /product_taxonomy) would be denied both read and write —
// the root cascade was removed in PR #57.
//
// SAFE TO RE-RUN. It writes the registry node and nothing else, and NEVER
// touches /products, /stock, /stock_targets or /config.
//
//   node scripts/seed-product-taxonomy.mjs --dry-run   # print the diff, write nothing
//   node scripts/seed-product-taxonomy.mjs             # MERGE (default)
//   node scripts/seed-product-taxonomy.mjs --replace   # destructive, prunes extras
//
// MERGE IS THE DEFAULT, AND THAT MATTERS. The whole design promise is that a
// category can be added in the Firebase console with no code change — so a
// re-run of this script must not delete the categories someone added that way.
// A blind set() would: it would drop "Scarves" and leave every product carrying
// categoryKey:"scarves" pointing at nothing. Merge refreshes the seeded 31 and
// leaves anything else alone. --replace prunes, and says exactly what it will
// destroy first.

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "functions", "package.json"));
const admin = require("firebase-admin");

const { TAXONOMY_SEED } = await import(path.join(HERE, "..", "src", "utils", "productTaxonomy.js"));

const DRY = process.argv.includes("--dry-run");
const REPLACE = process.argv.includes("--replace");
const NODE = "settings/productTaxonomy";

// Uses Application Default Credentials — a local run needs either
// GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key, or
// `gcloud auth application-default login`. Same setup every other script in
// this repo expects.
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const existing = await db.ref(NODE).once("value").then((s) => s.val());
const seedKeys = Object.keys(TAXONOMY_SEED.cats).sort();
const liveKeys = Object.keys((existing && existing.cats) || {}).sort();
const foreign = liveKeys.filter((k) => !seedKeys.includes(k));   // console-added categories

console.log(`node:        /${NODE}`);
console.log(`live:        ${existing ? `${liveKeys.length} categories (version ${existing.version})` : "ABSENT — first seed"}`);
console.log(`seed:        ${seedKeys.length} categories (version ${TAXONOMY_SEED.version})`);
console.log(`mode:        ${REPLACE ? "REPLACE (prunes anything not in the seed)" : "merge (leaves console-added categories alone)"}`);

if (existing) {
  const added = seedKeys.filter((k) => !liveKeys.includes(k));
  if (added.length) console.log(`  + ${added.join(", ")}`);
  if (foreign.length) {
    console.log(`  ${REPLACE ? "-" : "="} ${foreign.join(", ")}   ← console-added, ${REPLACE ? "WILL BE DELETED" : "kept"}`);
  }
  if (!added.length && !foreign.length) console.log("  (same category set — seeded values refreshed)");
}

// Sanity: refuse to seed anything that would half-type a product.
for (const [k, c] of Object.entries(TAXONOMY_SEED.cats)) {
  if (!c.legacy || !c.legacy.category) throw new Error(`category "${k}" has no legacy.category — refusing to seed`);
  if (!Array.isArray(c.sizes) || !c.sizes.length) throw new Error(`category "${k}" has no sizes — refusing to seed`);
}

// Deleting a category that products already point at leaves those products with
// an unresolvable categoryKey. Never do it as a side effect of a routine re-run.
if (REPLACE && foreign.length && !DRY) {
  console.error(`\nREFUSING: --replace would delete ${foreign.length} console-added categor${foreign.length === 1 ? "y" : "ies"}:`);
  console.error(`  ${foreign.join(", ")}`);
  console.error("Products carrying those keys would be left pointing at nothing.");
  console.error("Re-run without --replace to merge, or delete them in the console first if you really mean it.");
  process.exit(1);
}

if (DRY) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

// MERGE: write each seeded category individually plus the tops/version, so any
// console-added sibling under /cats is untouched. serverTimestamp, not a client
// clock — the 2026-07-17 order-counter incident is the standing reminder that
// till and laptop clocks lie.
const updates = {
  [`${NODE}/version`]: TAXONOMY_SEED.version,
  [`${NODE}/tops`]: TAXONOMY_SEED.tops,
  [`${NODE}/updatedAt`]: admin.database.ServerValue.TIMESTAMP,
  [`${NODE}/updatedBy`]: "seed-product-taxonomy",
};
for (const [k, c] of Object.entries(TAXONOMY_SEED.cats)) updates[`${NODE}/cats/${k}`] = c;
if (REPLACE) for (const k of foreign) updates[`${NODE}/cats/${k}`] = null;

await db.ref().update(updates);
const back = await db.ref(NODE).once("value").then((s) => s.val());
console.log(`\nwritten. read-back: ${Object.keys(back.cats).length} categories, version ${back.version}.`);
process.exit(0);
