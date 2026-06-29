// Backfill category/subcategory/brand on every existing /products record using the
// SHARED classifier (src/utils/productCategory.js — same code the app's Add Product
// path uses). IDEMPOTENT + SAFE TO RE-RUN. Dry-run by default; --commit writes.
//   node scripts/backfill-categories.mjs           (dry-run)
//   node scripts/backfill-categories.mjs --commit  (writes)
import { createRequire } from "module";
import { categorize, TOP_CATEGORIES, UNCATEGORIZED } from "../src/utils/productCategory.js";
// firebase-admin lives in functions/node_modules (not the app root) — resolve it there.
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const COMMIT = process.argv.includes("--commit");

function targetFor(p) {
  // Respect an existing VALID top-level category (e.g. the 39 perfumes already
  // "Perfume"); empty / garbage categories get (re)classified from name + sizes.
  const existing = (p.category || "").trim();
  if (existing === "Perfume") return { category: "Perfume", subcategory: "Perfume", brand: null };
  if (TOP_CATEGORIES.includes(existing) && p.subcategory) {
    return { category: existing, subcategory: p.subcategory, brand: p.brand ?? categorize(p.name, p.sizes).brand };
  }
  return categorize(p.name, p.sizes);
}

(async () => {
  const products = (await db.ref("products").once("value")).val() || {};
  const ids = Object.keys(products);
  const byCat = {}, bySub = {}, changes = [];
  let withBrand = 0, perfumeTypeFix = 0, unchanged = 0;

  for (const id of ids) {
    const p = products[id]; if (!p) continue;
    const t = targetFor(p);
    byCat[t.category] = (byCat[t.category] || 0) + 1;
    bySub[t.category + " › " + t.subcategory] = (bySub[t.category + " › " + t.subcategory] || 0) + 1;
    if (t.brand) withBrand++;

    const patch = {};
    if (p.category !== t.category) patch.category = t.category;
    if (p.subcategory !== t.subcategory) patch.subcategory = t.subcategory;
    if ((p.brand ?? null) !== (t.brand ?? null)) patch.brand = t.brand ?? null;
    // Fix perfumes mis-typed as "sneaker" → clear productType (perfume is neither
    // sneaker nor clothing; leaving "sneaker" wrongly offers a shoebox on the POS).
    if (t.category === "Perfume" && p.productType && p.productType !== null) patch.productType = null, perfumeTypeFix++;

    if (Object.keys(patch).length) changes.push({ id, name: p.name, patch });
    else unchanged++;
  }

  // ---- Report ----
  console.log("\n=== CATEGORY BACKFILL — " + (COMMIT ? "COMMIT" : "DRY-RUN (no writes)") + " ===");
  console.log("total products: " + ids.length + "\n");
  console.log("TOP-LEVEL:");
  for (const c of TOP_CATEGORIES) console.log("  " + c.padEnd(13) + (byCat[c] || 0));
  console.log("\nSUBCATEGORY:");
  Object.entries(bySub).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + String(v).padStart(4) + "  " + k));
  const uncat = bySub["Clothing › " + UNCATEGORIZED] || 0;
  console.log("\nbrand derived on: " + withBrand + "/" + ids.length);
  console.log('"Clothing — Uncategorized" (need manual review): ' + uncat);
  console.log("records to write: " + changes.length + "  |  already correct: " + unchanged + "  |  perfume productType fixes: " + perfumeTypeFix);

  if (!COMMIT) { console.log("\nDRY-RUN only — nothing written. Re-run with --commit to apply."); process.exit(0); }

  console.log("\nWriting in batches...");
  let written = 0;
  for (let i = 0; i < changes.length; i += 200) {
    const batch = changes.slice(i, i + 200);
    const updates = {};
    for (const c of batch) for (const [k, v] of Object.entries(c.patch)) updates["products/" + c.id + "/" + k] = v;
    await db.ref().update(updates);
    written += batch.length;
    console.log("  wrote " + written + "/" + changes.length);
  }
  console.log("DONE: updated " + written + " products.");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
