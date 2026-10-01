// ─── ZERO-STOCK LEFTOVERS × LIKELY TWIN — READ ONLY ──────────────────────────
// Answers the owner's question for BUILD 2: of the zero-stock rows the
// Leftovers tab now offers MERGE on, how many already have a twin the card can
// pre-pick? Built on the SAME pure builders the screen uses (buildFinishedLines,
// buildUnregisteredElsewhere, buildTwinIndex/suggestTwin) so the number cannot
// drift from what the operator sees. WRITES NOTHING.
//
// Reads are PAGED per node and per location — never a whole-node read of
// /products or /stock (live bandwidth is a real cost).
//
//   gcloud auth application-default login   # once
//   node scripts/zero-stock-twin-census.mjs

import admin from "firebase-admin";
import { readMapPaged, shallowKeys } from "./lib/rtdbPaged.mjs";
import { buildFinishedLines, buildUnregisteredElsewhere, buildLeftovers } from "../src/components/stock/hubCleanupCore.js";
import { buildTwinIndex, suggestTwin } from "../src/components/stock/duplicateGroups.js";
import labelIdentity from "../functions/lib/label-identity.cjs";
const { buildIdentityMap } = labelIdentity;

const app = admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val();

const productsMap = await readMapPaged(db, "products", { pageSize: 400 });
const products = Object.entries(productsMap)
  .map(([id, p]) => (p && typeof p === "object" ? { ...p, id: p.id || id } : null))
  .filter((p) => p && p.id && p.name);

const [aliases, styleIndex] = await Promise.all([val("label_aliases"), val("style_code_index")]);
const identityMap = buildIdentityMap(aliases, styleIndex);

const locations = await shallowKeys(app, "stock");
const allStock = {};
for (const loc of locations) allStock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 300 });

const index = buildTwinIndex({ products, identityMap });
const report = (label, rows) => {
  let withTwin = 0;
  const examples = [];
  for (const { product } of rows) {
    const t = suggestTwin(product, { index, allStock, identityMap });
    if (!t) continue;
    withTwin += 1;
    if (examples.length < 12) examples.push(`    ${product.name}  →  ${t.product.name}  (${t.via}: ${t.reason})`);
  }
  console.log(`\n${label}: ${rows.length} rows, ${withTwin} with a likely twin (${rows.length ? Math.round((withTwin / rows.length) * 100) : 0}%)`);
  for (const e of examples) console.log(e);
  return { total: rows.length, withTwin };
};

let grand = { total: 0, withTwin: 0 };
for (const hub of ["hub1", "hub2"]) {
  const hubStock = allStock[hub] || {};
  const registered = (await val(`settings/hubSneakerCount/register/${hub}`)) || {};
  const args = { hub, products, hubStock, registered, allStock, identityMap };
  const zeroStock = [...buildFinishedLines(args), ...buildUnregisteredElsewhere(args).filter((r) => r.net <= 0)];
  const held = buildLeftovers(args);
  const a = report(`${hub} · ZERO-STOCK leftovers (finished lines + unregistered-elsewhere holding nothing)`, zeroStock);
  const b = report(`${hub} · leftovers HOLDING stock (already had merge)`, held);
  grand = { total: grand.total + a.total + b.total, withTwin: grand.withTwin + a.withTwin + b.withTwin };
}

const deactivated = products.filter((p) => p.deactivated).length;
console.log(`\nAll leftovers rows across hub1+hub2: ${grand.total}, ${grand.withTwin} with a likely twin.`);
console.log(`Products currently deactivated: ${deactivated}`);
await app.delete();
