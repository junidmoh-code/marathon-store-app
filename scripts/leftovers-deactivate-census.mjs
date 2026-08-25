// ─── LEFTOVERS DEACTIVATE CENSUS — READ ONLY ─────────────────────────────────
// One-shot report for the deactivate-leftovers feature (2026-08-25): how many
// Leftovers cards each hub shows today, how many of those hold stock ONLY at
// that hub (zero at every other location — the "finished line" shape), how many
// hold zero stock EVERYWHERE (impossible by construction: buildLeftovers
// requires hubQty > 0 — the census proves that from live data rather than
// asserting it), and — the engine-facing number — how many UNREGISTERED
// footwear products hold zero-qty cells only: invisible in the Leftovers tab
// yet still arming the refill engine through cell existence.
//
// Built on the SAME pure functions the app uses (buildLeftovers, totalQty,
// buildIdentityMap) so the census can never drift from what the tab shows.
// Writes NOTHING.

import admin from "firebase-admin";
import { buildLeftovers, totalQty, CLEANUP_HUBS } from "../src/components/stock/hubCleanupCore.js";
import { isRegistered } from "../src/utils/labelIdentity.js";
import { isMergedAway } from "../src/utils/mergedProducts.js";
import { productIsFootwear } from "../src/utils/footwearLine.js";
import labelIdentity from "../functions/lib/label-identity.cjs";
import { readMapPaged, shallowKeys } from "./lib/rtdbPaged.mjs";

const { buildIdentityMap } = labelIdentity;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const val = async (path) => (await db.ref(path).once("value")).val();

const productsMap = await readMapPaged(db, "products", { pageSize: 400 });
const products = Object.entries(productsMap)
  .map(([id, p]) => (p && typeof p === "object" ? { ...p, id: p.id || id } : null))
  .filter((p) => p && p.id && p.name);

const [aliases, styleIndex] = await Promise.all([val("label_aliases"), val("style_code_index")]);
const identityMap = buildIdentityMap(aliases, styleIndex);

const locs = (await shallowKeys(admin.app(), "stock")).filter((l) => l !== "in_transit");
const allStock = {};
for (const loc of locs) allStock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 300 });
const inTransit = await readMapPaged(db, "stock/in_transit", { pageSize: 300 });

console.log(`products: ${products.length}, locations: ${locs.join(", ")}`);

for (const hub of CLEANUP_HUBS) {
  const registered = (await val(`settings/hubSneakerCount/register/${hub}`)) || {};
  const rows = buildLeftovers({
    hub, products, hubStock: allStock[hub] || {}, registered, allStock, identityMap,
  });
  let zeroEverywhere = 0, onlyThisHub = 0, totalUnits = 0;
  for (const { product, hubQty } of rows) {
    totalUnits += hubQty;
    let elsewhere = 0, everywhere = 0;
    for (const loc of locs) {
      const q = totalQty((allStock[loc] || {})[product.id]);
      everywhere += q;
      if (loc !== hub) elsewhere += q;
    }
    everywhere += totalQty(inTransit[product.id]);
    if (everywhere <= 0) zeroEverywhere += 1;
    if (elsewhere <= 0 && totalQty(inTransit[product.id]) <= 0) onlyThisHub += 1;
  }
  console.log(`\n${hub}: ${rows.length} leftovers holding ${totalUnits} units`);
  console.log(`  zero stock EVERYWHERE (incl. this hub): ${zeroEverywhere}`);
  console.log(`  stock ONLY at ${hub} (zero at every other location): ${onlyThisHub}`);
}

// Engine-armed ghosts: unregistered footwear, cells exist somewhere, zero (or
// negative) total quantity at EVERY location — never shown in the Leftovers tab.
let ghosts = 0;
const ghostByLoc = {};
for (const p of products) {
  if (isMergedAway(p) || !productIsFootwear(p)) continue;
  if (isRegistered(p, identityMap)) continue;
  let hasCell = false, total = 0;
  const cellLocs = [];
  for (const loc of locs) {
    const cells = (allStock[loc] || {})[p.id];
    if (!cells) continue;
    hasCell = true;
    cellLocs.push(loc);
    total += totalQty(cells);
  }
  total += totalQty(inTransit[p.id]);
  if (hasCell && total <= 0) {
    ghosts += 1;
    for (const loc of cellLocs) ghostByLoc[loc] = (ghostByLoc[loc] || 0) + 1;
  }
}
console.log(`\nUnregistered footwear with cells but ZERO total stock everywhere (invisible, engine-armed): ${ghosts}`);
console.log(`  cell presence by location: ${JSON.stringify(ghostByLoc)}`);

process.exit(0);
