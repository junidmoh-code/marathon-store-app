// ─── CENSUS — the stale display RECORDS the cleanup tab offers ───────────────
// READ ONLY. Zero writes.
//
// RUNS THE SCREEN'S OWN CLASSIFIER (src/components/stock/displayRecordCleanup.js
// via the app-module loader), so this report and the tab can never disagree —
// the same mistake that would let a census say 140 while the screen showed
// something else.
//
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/census-display-record-cleanup.mjs [outfile]
//
// NO WHOLE-NODE READS beyond the two nodes that ARE the subject. /products is
// never pulled: name / merge / deactivation are read ONE CHILD AT A TIME, and
// only for the pids the register actually names.
import { createRequire } from "module";
import { writeFileSync } from "fs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { classifyDisplayRecords, splitRegisterKey, CLEANUP_CLASSES } =
  await import("../src/components/stock/displayRecordCleanup.js");

const out = [];
const say = (...a) => { const l = a.join(" "); out.push(l); console.log(l); };

const HUBS = ["hub1", "hub2"];
const [slots, ...registers] = await Promise.all([
  db.ref("settings/displaySlots").once("value").then((s) => s.val() || {}),
  ...HUBS.map((h) => db.ref(`settings/hubSneakerCount/register/${h}`).once("value").then((s) => s.val() || {})),
]);

// Every pid the registers name, once — then one child read each for the three
// fields the classifier actually consults.
const pids = new Set();
for (const register of registers) {
  for (const key of Object.keys(register)) {
    const s = splitRegisterKey(key);
    if (s) pids.add(s[0]);
  }
}
say("# Stale display-record census —", new Date().toISOString());
say(`Read-only. ${pids.size} product ids named by the registers; read by child path, never the /products node.`);

const productsById = new Map();
const list = [...pids];
for (let i = 0; i < list.length; i += 40) {
  await Promise.all(list.slice(i, i + 40).map(async (pid) => {
    const [name, deactivated, mergedInto] = await Promise.all([
      db.ref(`products/${pid}/name`).once("value").then((s) => s.val()),
      db.ref(`products/${pid}/deactivated`).once("value").then((s) => s.val()),
      db.ref(`products/${pid}/mergedInto`).once("value").then((s) => s.val()),
    ]);
    if (name != null || deactivated != null || mergedInto != null) {
      productsById.set(pid, { id: pid, name, deactivated, mergedInto });
    }
  }));
}
say(`${productsById.size} of them still have a product record.`);

const LABEL = {
  matched: "MATCHED     live slot, same size — the record is right",
  replaced: "REPLACED    live slot at a DIFFERENT size — the pair it replaced",
  sold: "SOLD        only a tombstone — the display left the floor",
  over: "OVER        claims more units than there are floors showing it",
  gone: "GONE        product deleted or merged away",
  unverified: "UNVERIFIED  no slot record at all — NEVER actionable",
};

let totalActionable = 0;
const results = {};
for (let i = 0; i < HUBS.length; i++) {
  const hub = HUBS[i];
  const r = classifyDisplayRecords({ register: registers[i], slots, hub, productsById, catalogueComplete: true });
  results[hub] = r;
  totalActionable += r.actionableCount;
  say("");
  say(`## ${hub}`);
  say(`live register rows: ${Object.values(r.counts).reduce((a, b) => a + b, 0)}`);
  for (const c of CLEANUP_CLASSES) say(`  ${String(r.counts[c]).padStart(4)}  ${LABEL[c]}`);
  say(`  → offered for retirement: ${r.actionableCount}`);
}
say("");
say(`## TOTAL OFFERED FOR RETIREMENT ACROSS BOTH HUBS: ${totalActionable}`);
say("Each one currently subtracts a unit from a hub cell's expected-on-shelf");
say("(offShelf.js), so each one hands a counter a discrepancy that is not real.");

for (const hub of HUBS) {
  const { byClass } = results[hub];
  for (const c of ["replaced", "sold", "over", "gone"]) {
    const rows = byClass[c];
    if (!rows.length) continue;
    say("");
    say(`### ${hub} — ${c.toUpperCase()} — showing ${Math.min(8, rows.length)} of ${rows.length}`);
    for (const row of rows.slice(0, 8)) {
      say(`  ${row.key}  qty ${row.qty}  retire ${row.retireQty}  registered ${row.at}`);
      say(`     ${row.productName}${row.deactivated ? "  [deactivated line]" : ""}`);
      say(`     WHY: ${row.why}`);
      for (const e of row.evidence) {
        say(`     ${e.kind === "live" ? "LIVE SLOT" : "TOMBSTONE"}  ${e.store}  ${e.kind === "live" ? `size ${e.size}` : `was ${e.size}`}  (${e.source})  ${e.at}`);
      }
    }
  }
}

const file = process.argv[2] || new URL("../docs/display-record-cleanup-census.txt", import.meta.url).pathname;
writeFileSync(file, out.join("\n") + "\n");
console.log("\nwritten to", file);
process.exit(0);
