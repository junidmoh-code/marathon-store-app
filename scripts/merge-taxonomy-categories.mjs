// ─── MERGE TAXONOMY CATEGORIES (owner, 2026-08-01) ────────────────────────────
//   jeans, cargo-pants            → pants
//   sweaters                      → hoodies, relabelled "Sweaters & Hoodies"
//   running-shoes, boots, loafers → sneakers
//   + NEW category: designer-shoes
//
// TWO WRITES, BOTH NARROW:
//   1. /settings/productTaxonomy/cats/{key}  — only the keys that actually change
//      (6 retirements, 1 relabel, 1 addition). Every other category, including
//      anything added in the console, is left exactly as it is. This is NOT
//      seed-product-taxonomy.mjs --refresh, which would rewrite all 31 and throw
//      away console edits.
//   2. /products/{id}/categoryKey            — for products on a retired key.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH: `category`, `subcategory`, `productType`.
// Those are the fields the refill engine (isClothing/isFootwear), Display Checks,
// the POS and Insights actually read, and the owner's condition for this change
// was that they stay untouched. Every merge pair already shares the same legacy
// `category` and `productType`, so re-pointing categoryKey cannot change any
// automation's behaviour.
//
// The one asymmetry: jeans carried subcategory "Jeans & Denim" while pants
// carries "Cargos & Pants". Re-pointed products KEEP "Jeans & Denim" — rewriting
// it would be exactly the historical-data change we promised not to make.
//
//   node scripts/merge-taxonomy-categories.mjs --dry-run   (default)
//   node scripts/merge-taxonomy-categories.mjs --commit
//
// Safe to re-run: it reads live state and reports "already applied" per item.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "functions", "package.json"));
const admin = require("firebase-admin");
const { TAXONOMY_SEED, RETIRED_CATEGORY_KEYS, MERGED_INTO } =
  await import(path.join(HERE, "..", "src", "utils", "productTaxonomy.js"));

const DRY = !process.argv.includes("--commit");
const NODE = "settings/productTaxonomy";

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const [live, products] = await Promise.all([
  db.ref(NODE).once("value").then((s) => s.val()),
  db.ref("products").once("value").then((s) => s.val() || {}),
]);
if (!live || !live.cats) { console.error("registry ABSENT — run seed-product-taxonomy.mjs first"); process.exit(1); }

console.log(`═══ MERGE CATEGORIES ═══ ${DRY ? "(DRY RUN)" : "(COMMIT)"}\n`);
console.log(`live registry: ${Object.keys(live.cats).length} categories, version ${live.version}\n`);

// ── 1. registry edits ────────────────────────────────────────────────────────
const updates = {};
console.log("REGISTRY:");

// new category
if (!live.cats["designer-shoes"]) {
  updates[`${NODE}/cats/designer-shoes`] = TAXONOMY_SEED.cats["designer-shoes"];
  console.log("  + designer-shoes            CREATE (Footwear / Sneakers / sneaker)");
} else {
  console.log("  = designer-shoes            already present");
}

// relabel survivor
const wantLabel = TAXONOMY_SEED.cats.hoodies.label;
if (live.cats.hoodies && live.cats.hoodies.label !== wantLabel) {
  updates[`${NODE}/cats/hoodies/label`] = wantLabel;
  console.log(`  ~ hoodies                   "${live.cats.hoodies.label}" -> "${wantLabel}"`);
} else {
  console.log(`  = hoodies                   label already "${wantLabel}"`);
}

// retirements — active:false only, the legacy triple is left alone
for (const key of RETIRED_CATEGORY_KEYS) {
  const c = live.cats[key];
  if (!c) { console.log(`  ! ${key.padEnd(26)} not in live registry — skipped`); continue; }
  if (c.active === false) { console.log(`  = ${key.padEnd(26)} already retired`); continue; }
  updates[`${NODE}/cats/${key}/active`] = false;
  console.log(`  - ${key.padEnd(26)} RETIRE (-> ${MERGED_INTO[key]}), legacy triple untouched`);
}

// ── 2. product re-points ─────────────────────────────────────────────────────
console.log("\nPRODUCTS (categoryKey only — no legacy field is written):");
const moves = [];
for (const [pid, p] of Object.entries(products)) {
  if (!p || !p.categoryKey) continue;
  const dest = MERGED_INTO[p.categoryKey];
  if (!dest) continue;
  moves.push({ pid, from: p.categoryKey, to: dest, name: p.name, sub: p.subcategory ?? null });
}
if (!moves.length) console.log("  (none — no product carries a retired key)");
for (const m of moves) {
  updates[`products/${m.pid}/categoryKey`] = m.to;
  console.log(`  ${m.from.padEnd(14)} -> ${m.to.padEnd(10)}  subcategory stays "${m.sub}"   ${m.name}`);
}

const byDest = moves.reduce((a, m) => { a[m.to] = (a[m.to] || 0) + 1; return a; }, {});
console.log(`\n${moves.length} product(s) re-pointed ${JSON.stringify(byDest)}`);
console.log(`${Object.keys(updates).length} write path(s) total.`);

if (DRY) { console.log("\n--dry-run: nothing written."); process.exit(0); }
if (!Object.keys(updates).length) { console.log("\nnothing to do — already applied."); process.exit(0); }

const backup = await db.ref("reports/stock_corrections").push();
await backup.set({
  at: new Date().toISOString(), op: "merge-taxonomy-categories",
  retired: [...RETIRED_CATEGORY_KEYS], moves,
  previousLabels: { hoodies: live.cats.hoodies?.label ?? null },
});
console.log(`\nbackup: /reports/stock_corrections/${backup.key}`);

updates[`${NODE}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;
updates[`${NODE}/updatedBy`] = "merge-taxonomy-categories";
await db.ref().update(updates);

// ── read-back proof ──────────────────────────────────────────────────────────
const back = await db.ref(NODE).once("value").then((s) => s.val());
const cats = back.cats || {};
console.log("\nread-back:");
console.log(`  categories: ${Object.keys(cats).length}  active: ${Object.values(cats).filter((c) => c.active !== false).length}`);
console.log(`  designer-shoes: ${cats["designer-shoes"] ? "present" : "MISSING"}`);
console.log(`  hoodies label: "${cats.hoodies?.label}"`);
for (const k of RETIRED_CATEGORY_KEYS) console.log(`  ${k.padEnd(14)} active=${cats[k]?.active}  legacy=${JSON.stringify(cats[k]?.legacy)}`);

const after = await db.ref("products").once("value").then((s) => s.val() || {});
const stragglers = Object.values(after).filter((p) => p && MERGED_INTO[p.categoryKey]);
console.log(`\n  products still on a retired key: ${stragglers.length} (want 0)`);
process.exit(0);
