// ─── SEED THE DISPLAY ROW LEDGER FROM THE LIVE DISPLAY SLOTS ─────────────────
//
// ONE-TIME. Dry-run by default; pass --apply to write.
//
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/seed-display-rows.mjs
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/seed-display-rows.mjs --apply
//
// WHY IT EXISTS. /settings/displayRows is a new node and starts empty. Left
// empty, the two new screens would both lie on day one: the wall walk would
// list every shoe with hub stock as "not registered" (including the ~470 that
// demonstrably ARE on a wall), and the duplicate screen would say every wall is
// clean. Neither is true, and an operator who is sent to walk a wall against a
// list that is wrong stops trusting the list.
//
// WHAT IT CARRIES OVER, and it is exactly what exists. /settings/displaySlots
// holds one live record per product per store: the store, the product, the size
// on that floor now, the hub it is booked at, when it was last written and by
// what. Every one of those becomes ONE OPEN ROW, opened `via: "seed"`, with a
// timeline entry that says where it came from and claims nothing else. It does
// NOT claim somebody sent it today, and it does not invent a request.
//
// WHAT IT CANNOT CARRY OVER, stated rather than papered over:
//   • HISTORY. A slot keeps only its last transition, so a seeded row's
//     timeline starts at the seed. Everything after it is real.
//   • DUPLICATES. A slot is one record per product per store, so the seed
//     produces exactly one open row per wall per shoe and ZERO duplicates —
//     not because the walls are clean, but because the old record could not
//     hold a second one. That is the whole reason this ledger exists. The
//     duplicates that are physically standing on the walls today will surface
//     as the next send opens a second row beside a first that was already there
//     — and as the wall walk registers what is actually seen.
//   • THE TOMBSTONED SLOTS (~48). A cleared slot describes a display that has
//     already left; seeding it as an open row would assert a pair that is not
//     there. They are counted and skipped.
//   • HUB 3. Pine's 18 displays are booked at hub3, outside GATED_SNEAKER_HUBS.
//     Counted, skipped, and reported — not silently dropped.
//
// IT IS RE-RUNNABLE, AND THE EXISTENCE CHECK IS PART OF THE WRITE. A (store,
// product) that already has ANY row — open or closed — is skipped, so a second
// run adds nothing and a partial run is safe to finish.
//
// Each row is written as a TRANSACTION on `/settings/displayRows/{store}/{pid}`
// that aborts if the node is not empty, rather than as one bulk multi-path
// update built from a snapshot read at the start. A send landing between the
// read and the write would otherwise have added a second row beside it —
// creating, during the migration, exactly the duplicate this ledger exists to
// surface. (CodeRabbit.) ~460 small transactions, once.

import { createRequire } from "module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { openRowPlan, rowPath, rowSegment, slotIsLiveish } = await (async () => {
  const core = await import("../src/components/stock/displayRowCore.js");
  return { ...core, slotIsLiveish: (s) => !!s && typeof s.sizeKey === "string" && s.sizeKey && s.sizeKey !== "_" };
})();

const APPLY = process.argv.includes("--apply");
const HUBS = ["hub1", "hub2"];

const [slots, existing] = await Promise.all([
  db.ref("settings/displaySlots").once("value").then((s) => s.val() || {}),
  db.ref("settings/displayRows").once("value").then((s) => s.val() || {}),
]);

let live = 0, tombstoned = 0, offHub = 0, alreadySeeded = 0, seeded = 0;
const planned = [];          // [{ store, productId, rowId, row }]
const perStore = {};

for (const [store, byPid] of Object.entries(slots)) {
  for (const [productId, slot] of Object.entries(byPid || {})) {
    if (!slotIsLiveish(slot)) { tombstoned++; continue; }
    live++;
    if (!HUBS.includes(slot.bookedHub)) { offHub++; continue; }
    if (existing[store] && existing[store][productId]) { alreadySeeded++; continue; }
    const at = typeof slot.at === "string" && slot.at ? slot.at : new Date().toISOString();
    const plan = openRowPlan({
      rows: {}, store, productId,
      productName: slot.productName || "",
      size: slot.size, bookedHub: slot.bookedHub,
      rowId: `seed${String(at).replace(/[^0-9]/g, "")}`,
      at, by: slot.by || null, via: "seed",
    });
    if (!plan.ok) { console.warn(`skip ${store}/${productId}: ${plan.message}`); continue; }
    // Taken by its OWN path, not by position. `Object.values(plan.updates)[0]`
    // is correct only while the plan emits exactly one entry (rows: {} and no
    // orderId); the day it emits two, position would silently take a
    // close-field fragment and write it as a row.
    const rowId = `seed${String(at).replace(/[^0-9]/g, "")}`;
    const row = plan.updates[rowPath(store, productId, rowId)];
    if (!row) { console.warn(`skip ${store}/${productId}: the plan did not produce the expected row path`); continue; }
    planned.push({ store, productId, rowId, row });
    seeded++;
    perStore[store] = (perStore[store] || 0) + 1;
  }
}

console.log(`live slots            ${live}`);
console.log(`  tombstoned (skipped) ${tombstoned}`);
console.log(`  booked off hub1/hub2 ${offHub}   (Pine's wall — hub3, out of scope)`);
console.log(`  already have a row   ${alreadySeeded}`);
console.log(`ROWS TO OPEN          ${seeded}`, perStore);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

// ONE TRANSACTION PER (store, product). It writes only onto an EMPTY node, so a
// send that lands mid-migration wins and the seed steps aside rather than
// adding a second row beside it.
let wrote = 0, skipped = 0;
for (const { store, productId, rowId, row } of planned) {
  // SANITISED, like every other writer. The plan writes rowPath()'s segmented
  // path; building this ref from the raw ids would write somewhere else, or
  // throw out of db.ref() and abort the migration mid-run.
  const ref = db.ref(`settings/displayRows/${rowSegment(store)}/${rowSegment(productId)}`);
  // eslint-disable-next-line no-await-in-loop
  const res = await ref.transaction((cur) => (cur === null ? { [rowId]: row } : undefined));
  if (res.committed) wrote++; else skipped++;
  if ((wrote + skipped) % 50 === 0) console.log(`  ${wrote + skipped}/${planned.length} (wrote ${wrote}, skipped ${skipped})`);
}
console.log(`done. wrote ${wrote}, skipped ${skipped} (a skip means a real row appeared first — correct).`);
process.exit(0);
