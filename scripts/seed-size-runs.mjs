// ─── SEED THE SIZE-RUN REGISTRY ───────────────────────────────────────────────
// Writes /settings/productTaxonomy/sizeRuns from the constants in
// src/utils/sizeRuns.js (SIZE_RUN_SEED), and stamps `sizeRunKey` onto every
// category whose literal size list exactly matches a seeded run — so from then
// on those categories resolve their grid THROUGH the run, and a size added to
// the run in the admin Taxonomy tab reaches every one of them at once.
//
// IDEMPOTENT AND ADD-ONLY, safe to re-run:
//   • a run that does not exist live is created from the seed
//   • a run that DOES exist live is only ever APPENDED to — and only with the
//     seed sizes it is missing (today: XXXL / 4XL into the apparel run), each
//     inserted at its correct sort position via the same add-only append the
//     admin tab uses. Console-added sizes are never touched, nothing is ever
//     removed, renamed or reordered.
//   • sizeRunKey is only written where it is ABSENT, and only when the
//     category's literal sizes match the run exactly (base constant or seeded
//     form). A console-customised category (designer-shoes' 3–11 run) matches
//     nothing and keeps resolving from its own literal sizes.
//   • categories' literal `sizes` arrays are LEFT IN PLACE as the fallback —
//     resolution order is live run → seeded run → literal sizes, so a partial
//     write can never blank a grid.
//
//   node scripts/seed-size-runs.mjs --dry-run   # print the plan, write nothing
//   node scripts/seed-size-runs.mjs             # apply

import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "functions", "package.json"));
const admin = require("firebase-admin");

const { SIZE_RUN_SEED, runSizes, appendSizeToRun, canonicalSizeKey } =
  await import(pathToFileURL(path.join(HERE, "..", "src", "utils", "sizeRuns.js")).href);
const { SIZES_APPAREL, SIZES_FOOTWEAR, SIZES_KIDS, SIZES_FITTED_CAP, SIZES_GLOVES } =
  await import(pathToFileURL(path.join(HERE, "..", "src", "utils", "productTaxonomy.js")).href);

const DRY = process.argv.includes("--dry-run");
const NODE = "settings/productTaxonomy";

admin.initializeApp({
  databaseURL: process.env.FIREBASE_DATABASE_URL
    || "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const reg = await db.ref(NODE).once("value").then((s) => s.val());
if (!reg || !reg.cats) {
  console.error("live registry at /" + NODE + " is absent or empty — seed the taxonomy first (seed-product-taxonomy.mjs)");
  process.exit(1);
}

const liveRuns = reg.sizeRuns || {};
const updates = {};
const report = [];

// ── 1. Runs: create absent, append missing seed sizes to present ─────────────
for (const [rk, seed] of Object.entries(SIZE_RUN_SEED)) {
  const live = liveRuns[rk];
  if (!live) {
    updates[`${NODE}/sizeRuns/${rk}`] = { key: rk, label: seed.label, sizes: seed.sizes };
    report.push(`+ run ${rk}: created [${seed.sizes.join(", ")}]`);
    continue;
  }
  let sizes = runSizes(live);
  const before = sizes.join(",");
  for (const s of seed.sizes) {
    if (!sizes.some((x) => canonicalSizeKey(x) === canonicalSizeKey(s))) sizes = appendSizeToRun(sizes, s);
  }
  if (sizes.join(",") !== before) {
    updates[`${NODE}/sizeRuns/${rk}/sizes`] = sizes;
    report.push(`~ run ${rk}: [${before}] → [${sizes.join(", ")}]  (append-only)`);
  } else {
    report.push(`= run ${rk}: up to date [${before}]`);
  }
}

// ── 2. Categories: stamp sizeRunKey where the literal sizes match a run ──────
// A category matches a run when its literal sizes equal the run's BASE
// constant (what PR #280 seeded, e.g. S..XXXL) or the run's seeded/extended
// form — byte order included. Anything else is a deliberate console shape and
// keeps its literal resolution.
const MATCH_FORMS = {
  apparel:      [SIZES_APPAREL, SIZE_RUN_SEED.apparel.sizes],
  footwear:     [SIZES_FOOTWEAR, SIZE_RUN_SEED.footwear.sizes],
  kids:         [SIZES_KIDS, SIZE_RUN_SEED.kids.sizes],
  "fitted-cap": [SIZES_FITTED_CAP, SIZE_RUN_SEED["fitted-cap"].sizes],
  gloves:       [SIZES_GLOVES, SIZE_RUN_SEED.gloves.sizes],
};
const eq = (a, b) => a.length === b.length && a.every((s, i) => String(s) === String(b[i]));

for (const [ck, cat] of Object.entries(reg.cats)) {
  if (!cat || typeof cat !== "object") continue;
  if (cat.sizeRunKey) { report.push(`= cat ${ck}: already → ${cat.sizeRunKey}`); continue; }
  if (cat.sizeMode === "one") continue;
  const catSizes = runSizes(cat);
  const rk = Object.keys(MATCH_FORMS).find((k) => MATCH_FORMS[k].some((form) => eq(catSizes, form.map(String))));
  if (rk) {
    updates[`${NODE}/cats/${ck}/sizeRunKey`] = rk;
    report.push(`+ cat ${ck}: sizeRunKey → ${rk}`);
  } else {
    report.push(`  cat ${ck}: no exact run match [${catSizes.join(",")}] — keeps literal sizes`);
  }
}

console.log(report.join("\n"));
const writeCount = Object.keys(updates).length;
if (!writeCount) { console.log("\nnothing to write."); process.exit(0); }
if (DRY) { console.log(`\n--dry-run: ${writeCount} writes NOT applied.`); process.exit(0); }

updates[`${NODE}/updatedAt`] = admin.database.ServerValue.TIMESTAMP;
updates[`${NODE}/updatedBy`] = "seed-size-runs";
await db.ref().update(updates);
const back = await db.ref(`${NODE}/sizeRuns`).once("value").then((s) => s.val());
console.log(`\nwritten (${writeCount} paths). read-back runs: ${Object.keys(back).map((k) => `${k}[${runSizes(back[k]).join(",")}]`).join("  ")}`);
process.exit(0);
