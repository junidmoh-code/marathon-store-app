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
//   node scripts/seed-product-taxonomy.mjs             # ADD MISSING ONLY (default)
//   node scripts/seed-product-taxonomy.mjs --refresh   # also overwrite the seeded 31
//   node scripts/seed-product-taxonomy.mjs --replace   # --refresh + prune extras
//
// THE DEFAULT IS DELIBERATELY THE TIMID ONE, because this feature's whole
// promise is that the registry is edited in the Firebase console with no code
// change — and a script that silently undoes those edits would break that
// promise every time someone re-ran it "just to be safe".
//
// Two distinct ways a re-run could destroy console work:
//   1. Deleting a category added in the console ("Scarves"), leaving every
//      product carrying categoryKey:"scarves" pointing at nothing. Only
//      --replace does this, and it refuses outright when it would.
//   2. Reverting an EDIT to one of the seeded 31 — retiring Loafers with
//      active:false, or correcting a legacy value — because the seed hardcodes
//      active:true and the original triple. Only --refresh does this, and the
//      default reports exactly which categories differ so the choice is
//      informed rather than accidental.

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "functions", "package.json"));
const admin = require("firebase-admin");

const { TAXONOMY_SEED } = await import(path.join(HERE, "..", "src", "utils", "productTaxonomy.js"));

const DRY = process.argv.includes("--dry-run");
const REPLACE = process.argv.includes("--replace");
const REFRESH = process.argv.includes("--refresh") || REPLACE;   // --replace implies --refresh
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

// Seeded categories whose LIVE value has drifted from the checked-in seed —
// i.e. someone edited them in the console. These are what --refresh overwrites.
// Key PRESENCE is checked separately from the value's truthiness. A console
// value of false / 0 / "" is still a present key, so it is neither "added" nor
// (under a truthiness test) "drifted" — the default run would report nothing to
// do while a seeded category sat there unusable. (CodeRabbit, PR #280.)
const liveCats = (existing && existing.cats) || {};
const drifted = seedKeys.filter((k) => {
  if (!Object.prototype.hasOwnProperty.call(liveCats, k)) return false;   // absent -> "added", not drift
  return JSON.stringify(canonical(liveCats[k])) !== JSON.stringify(canonical(TAXONOMY_SEED.cats[k]));
});

// Compare what RTDB can actually STORE, not what the seed object literally
// contains. RTDB deletes null children, so the seed's deliberate nulls
// (loafers/dresses have no legacy subcategory, perfumes no productType) are
// absent in the live node. Comparing raw would flag those three as
// "edited in the console" on every single run — a false alarm that would train
// the operator to ignore the one warning that matters.
function canonical(o) {
  if (Array.isArray(o)) return o.map(canonical);
  if (o === null || typeof o !== "object") return o;
  return Object.fromEntries(
    Object.keys(o).sort().filter((k) => o[k] !== null).map((k) => [k, canonical(o[k])]),
  );
}

const added = seedKeys.filter((k) => !liveKeys.includes(k));

console.log(`node:        /${NODE}`);
console.log(`live:        ${existing ? `${liveKeys.length} categories (version ${existing.version})` : "ABSENT — first seed"}`);
console.log(`seed:        ${seedKeys.length} categories (version ${TAXONOMY_SEED.version})`);
console.log(`mode:        ${REPLACE ? "REPLACE (overwrite seeded + prune extras)" : REFRESH ? "REFRESH (overwrite the seeded 31)" : "add-missing-only (default — console edits preserved)"}`);
console.log(`tops/version: ${!existing ? "written (first seed)" : REFRESH ? "OVERWRITTEN (--refresh)" : "left as-is"}`);

if (existing) {
  if (added.length) console.log(`  + ${added.join(", ")}   ← will be created`);
  if (foreign.length) console.log(`  ${REPLACE ? "-" : "="} ${foreign.join(", ")}   ← console-added, ${REPLACE ? "WILL BE DELETED" : "kept"}`);
  if (drifted.length) {
    console.log(`  ${REFRESH ? "!" : "="} ${drifted.join(", ")}   ← edited in the console, ${REFRESH ? "WILL BE OVERWRITTEN with the seed values" : "kept as-is"}`);
    if (!REFRESH) console.log("      (re-run with --refresh to force these back to the checked-in seed)");
  }
  if (!added.length && !foreign.length && !drifted.length) console.log("  (live registry already matches the seed — nothing to do)");
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

// Per-key writes (never a whole-node set), so a console-added sibling under
// /cats is untouched. serverTimestamp, not a client clock — the 2026-07-17
// order-counter incident is the standing reminder that till and laptop clocks
// lie.
// SEED-LEVEL METADATA (tops / version) IS NOT TOUCHED BY THE DEFAULT RUN.
// Writing it unconditionally would have reset console-edited `tops` — and
// advanced the reported version — the moment anyone added one absent category,
// flatly contradicting the "console edits preserved" guarantee in the header.
// It is written only on a FIRST seed (nothing live yet) or when explicitly
// forced. (CodeRabbit, PR #280 — Major.)
const seedMetaWrite = !existing || REFRESH;
const updates = {
  [`${NODE}/updatedAt`]: admin.database.ServerValue.TIMESTAMP,
  [`${NODE}/updatedBy`]: "seed-product-taxonomy",
};
if (seedMetaWrite) {
  updates[`${NODE}/version`] = TAXONOMY_SEED.version;
  updates[`${NODE}/tops`] = TAXONOMY_SEED.tops;
}
// Default writes ONLY categories that are absent live. --refresh also rewrites
// the ones that exist, discarding any console edit to them.
const toWrite = REFRESH ? seedKeys : added;
for (const k of toWrite) updates[`${NODE}/cats/${k}`] = TAXONOMY_SEED.cats[k];
if (REPLACE) for (const k of foreign) updates[`${NODE}/cats/${k}`] = null;

if (!toWrite.length && !REPLACE) {
  console.log("\nnothing to write — every seeded category already exists. (--refresh to force.)");
  process.exit(0);
}

await db.ref().update(updates);
const back = await db.ref(NODE).once("value").then((s) => s.val());
console.log(`\nwritten. read-back: ${Object.keys(back.cats).length} categories, version ${back.version}.`);
process.exit(0);
