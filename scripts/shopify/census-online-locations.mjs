// ── CENSUS: which locations feed the storefront's quantity, and what would
//    excluding the untrusted ones cost? ────────────────────────────────────────
//
// READ-ONLY. No RTDB writes, no Shopify calls at all. It answers the three
// questions that must be answered BEFORE narrowing the pool that feeds the
// Shopify inventory push:
//
//   1. which locations contribute units to the storefront today, and how many
//   2. how many LIVE products would fall to zero — go unavailable — if the
//      untrusted locations stopped counting
//   3. the same, per size, so "the product survives" is not mistaken for
//      "every size survives"
//
// It deliberately re-uses networkTotals — the SAME function the reconciler
// pushes with — rather than re-implementing the sum. A census that measured a
// different arithmetic than the pusher applies would be worse than no census.
//
//   node scripts/shopify/census-online-locations.mjs
//   node scripts/shopify/census-online-locations.mjs --exclude hub3,marathon-pine
//
// ── IT MEASURES TWO POLICIES, AND NEITHER OF THEM IS "WHATEVER IS COMPILED" ──
// The first version called networkTotals with its default pool for BOTH sides
// of the comparison. That default is the policy in force, so the moment the
// exclusion shipped the census answered its own question with itself: Pine was
// already gone from the "before" column, its per-location contribution printed
// as zero, and the whole report said the change costs nothing. A measuring
// tool that silently reads zero once the thing it measures is switched on is
// worse than no tool, because the zero looks like an answer.
//
// So BASELINE and PROPOSED are both explicit. Baseline is the only exclusion
// that is a property of the system rather than a policy (in_transit); proposed
// is baseline plus whatever is being argued about. Both go through the real
// networkTotals, which now takes the pool as a parameter — one arithmetic, two
// questions.
//
// READS: /shopify_publish (paged), /locations (shallow), and per live product
// /products/{pid} + /stock/{loc}/{pid} as POINT reads. Never /stock whole —
// that node is ~5.36 MB and this must be runnable without a bandwidth event.
import { createRequire } from "module";
import {
  networkTotals, UNSELLABLE_LOCATIONS, UNTRUSTED_LOCATIONS,
} from "./inventory.mjs";
import { isOn } from "../../src/components/shopify/publishState.js";
import { readMapPaged, shallowKeys } from "../lib/rtdbPaged.mjs";

const flags = process.argv.slice(2);
const exIdx = flags.indexOf("--exclude");
// What is being ARGUED about. Defaults to the untrusted set the code ships
// with, imported rather than hand-copied — this script was a fourth place the
// two ids were spelled out by hand.
const EXCLUDE = new Set(
  exIdx !== -1 && flags[exIdx + 1] && !flags[exIdx + 1].startsWith("--")
    ? flags[exIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : [...UNTRUSTED_LOCATIONS]
);
// What the storefront would show if NOTHING were excluded on policy grounds.
// in_transit is not a policy — it is stock that physically cannot be picked.
const BASELINE = new Set(UNSELLABLE_LOCATIONS);
const PROPOSED = new Set([...BASELINE, ...EXCLUDE]);

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const app = admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const rawSizesOf = (product) =>
  Array.isArray(product?.sizes) ? product.sizes
    : product?.sizes && typeof product.sizes === "object" ? Object.values(product.sizes) : [];

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

console.log("reading /shopify_publish (paged)…");
const nodes = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const livePids = Object.entries(nodes).filter(([, n]) => isOn(n)).map(([pid]) => pid);
console.log(`publish nodes: ${Object.keys(nodes).length}   LIVE (on the storefront): ${livePids.length}`);

const locations = await shallowKeys(app, "locations");
console.log(`locations registered: ${locations.join(", ")}\n`);

// Per-location contribution, measured the way the pusher measures it: a
// location's contribution is the units it adds to a live product's sellable
// total for a size that product actually sells. Cells for sizes the record
// does not carry are NOT counted — they are never pushed either.
const contrib = Object.fromEntries(locations.map((l) => [l, { units: 0, products: 0 }]));
let noRecord = 0, noSizes = 0;
const rows = [];

const BATCH = 12;
for (let i = 0; i < livePids.length; i += BATCH) {
  const slice = livePids.slice(i, i + BATCH);
  await Promise.all(slice.map(async (pid) => {
    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!product) { noRecord++; return; }
    const sizes = rawSizesOf(product);
    if (!sizes.length) { noSizes++; return; }

    const perLoc = await Promise.all(
      locations.map((loc) => db.ref(`stock/${loc}/${pid}`).get().then((s) => [loc, s.val()]))
    );
    const tree = {};
    for (const [loc, cells] of perLoc) if (cells) tree[loc] = { [pid]: cells };

    // ONE location at a time, through the real summer, so the per-location
    // figure is exactly the share that location contributes to the push.
    for (const [loc, cells] of perLoc) {
      if (!cells) continue;
      // BASELINE, so a location under discussion still reports what it holds.
      // Measured through the real summer, so the figure is exactly the share
      // that location would contribute to the push.
      const only = networkTotals({ [loc]: { [pid]: cells } }, pid, sizes, BASELINE);
      const u = sum(only);
      if (u > 0) { contrib[loc].units += u; contrib[loc].products += 1; }
    }

    const before = networkTotals(tree, pid, sizes, BASELINE);
    const after = networkTotals(tree, pid, sizes, PROPOSED);
    rows.push({
      pid,
      name: product.cleanName || product.name || pid,
      before: sum(before),
      after: sum(after),
      sizesBefore: Object.values(before).filter((q) => q > 0).length,
      sizesAfter: Object.values(after).filter((q) => q > 0).length,
      sizeCount: sizes.length,
    });
  }));
  if ((i / BATCH) % 10 === 0) process.stdout.write(`  …${Math.min(i + BATCH, livePids.length)}/${livePids.length}\r`);
}
console.log(`  …${livePids.length}/${livePids.length} scanned      \n`);

console.log("── 1. WHAT EACH LOCATION CONTRIBUTES TO THE STOREFRONT TODAY ──────────");
const totalUnits = sum(Object.fromEntries(Object.entries(contrib).map(([k, v]) => [k, v.units])));
const order = Object.entries(contrib).sort((a, b) => b[1].units - a[1].units);
for (const [loc, v] of order) {
  const counted = BASELINE.has(loc) ? "  (never counted — transit)"
    : EXCLUDE.has(loc) ? "  ← PROPOSED FOR EXCLUSION" : "";
  const pct = totalUnits ? ((v.units / totalUnits) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${loc.padEnd(16)} ${String(v.units).padStart(7)} units  ${String(v.products).padStart(5)} live products  ${pct.padStart(5)}%${counted}`
  );
}
const baselineUnits = order.reduce((a, [loc, v]) => a + (BASELINE.has(loc) ? 0 : v.units), 0);
console.log(`  ${"TOTAL (counted)".padEnd(16)} ${String(baselineUnits).padStart(7)} units`);

console.log(`\n── 2. IF ${[...EXCLUDE].join(" + ")} STOP COUNTING ─────────────────`);
const hadStock = rows.filter((r) => r.before > 0);
const goesZero = hadStock.filter((r) => r.after === 0);
const reduced = hadStock.filter((r) => r.after > 0 && r.after < r.before);
const untouched = hadStock.filter((r) => r.after === r.before);
const alreadyZero = rows.filter((r) => r.before === 0);
console.log(`  live products scanned              ${rows.length}`);
console.log(`  already showing 0 (no change)      ${alreadyZero.length}`);
console.log(`  had stock, KEEP stock              ${untouched.length + reduced.length}   (${untouched.length} unchanged, ${reduced.length} reduced)`);
console.log(`  had stock, DROP TO ZERO            ${goesZero.length}   ← go unavailable`);
const pctCat = rows.length ? ((goesZero.length / rows.length) * 100).toFixed(1) : "0.0";
const pctSellable = hadStock.length ? ((goesZero.length / hadStock.length) * 100).toFixed(1) : "0.0";
console.log(`  → ${pctCat}% of the live catalogue, ${pctSellable}% of what is currently sellable`);

const unitsBefore = rows.reduce((a, r) => a + r.before, 0);
const unitsAfter = rows.reduce((a, r) => a + r.after, 0);
console.log(`  sellable units  ${unitsBefore} → ${unitsAfter}  (−${unitsBefore - unitsAfter}, −${unitsBefore ? (((unitsBefore - unitsAfter) / unitsBefore) * 100).toFixed(1) : 0}%)`);

const sizesBefore = rows.reduce((a, r) => a + r.sizesBefore, 0);
const sizesAfter = rows.reduce((a, r) => a + r.sizesAfter, 0);
console.log(`  buyable SIZES   ${sizesBefore} → ${sizesAfter}  (−${sizesBefore - sizesAfter})`);

console.log("\n  first 25 products that would go unavailable:");
for (const r of goesZero.slice(0, 25)) {
  console.log(`    ${r.pid.padEnd(22)} ${String(r.before).padStart(4)} → 0   ${String(r.name).slice(0, 52)}`);
}
if (noRecord || noSizes) console.log(`\n  skipped: ${noRecord} live node(s) with no /products record, ${noSizes} with no sizes`);

await app.delete();
