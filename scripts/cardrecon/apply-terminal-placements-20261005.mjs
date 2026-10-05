// ─── 5 OCT 2026, 12:46 SAST — THE PE TILL 1 ↔ TROPHY TILL 1 SPEEDPOINT SWAP ───
// Junid swapped two FNB speedpoints at 12:46 SAST (10:46Z):
//
//   67325636  was Marathon PE Till 1  → now Trophy Till 1
//   67377843  was Trophy Till 1       → now Marathon PE Till 1
//
// (TIDs read off the live registry and their own batch records — 67325636's
// #67/#68 filed under pe/till-1, 67377843's #38/#39 under trophy/till-1.)
//
// This script SEEDS the placement history (lib/card-terminal-placements.cjs)
// with the layout every terminal has had since its last recorded move, then
// enters the swap as two placements at 10:46Z — through the SAME planner the
// settings sheet's "Moved" action calls (planMove), so a script-entered move
// and a screen-entered one are the same write.
//
// WHAT IT WRITES — only these paths, as ONE multi-path update:
//   config/cardTerminals/{tid}/placements/{key}   (new keys only)
//   config/cardTerminals/{tid}/label              (the two swapped machines)
// Never a set() of a row or of the registry, never storeId (the filing key),
// never a delete.
//
//   node scripts/cardrecon/apply-terminal-placements-20261005.mjs            # dry run
//   node scripts/cardrecon/apply-terminal-placements-20261005.mjs --execute  # write + verify
//
// Idempotent: a second run finds the placements present and writes nothing.

import { createRequire } from "module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { planMove } = require("./lib/card-terminal-admin.cjs");
const { placementKey, seedPlacement, terminalPlacements, placementAt } = require("./lib/card-terminal-placements.cjs");
const { posStores, POS_STORES } = require("./lib/pos-tills.cjs");

const EXECUTE = process.argv.includes("--execute");
const SWAP_MS = Date.parse("2026-10-05T10:46:00Z");
const TIDS = ["67325636", "0000HP1X", "67365901", "67377843", "0000Z4M6", "67364485"];
const MOVES = [
  { tid: "67325636", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" },
  { tid: "67377843", storeId: "pe", tillId: "till-1", label: "Marathon Till 1" },
];
const NOTE = "PE Till 1 ↔ Trophy Till 1 speedpoint swap, 5 Oct 2026 12:46 SAST (Junid)";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const NOW = admin.database.ServerValue.TIMESTAMP;

// The server's clock, not this machine's.
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = Date.now() + offset;

// Per-row reads — six small rows, never the whole registry.
const rows = {};
for (const tid of TIDS) rows[tid] = (await db.ref(`config/cardTerminals/${tid}`).once("value")).val();
const configured = {};
for (const s of POS_STORES) configured[s.storeId] = (await db.ref(`pos/config/${s.storeId}/tills`).once("value")).val();
const stores = posStores(configured);

const updates = {};
let bad = 0;
for (const tid of TIDS) {
  const row = rows[tid];
  if (!row) { console.error(`SURPRISE: ${tid} is not registered`); bad++; continue; }
  const move = MOVES.find((m) => m.tid === tid);
  if (!move) {
    // Seed only: where it stands today, from its last recorded move.
    if (terminalPlacements(row).length) { console.log(`${tid}: placements already present — nothing to seed`); continue; }
    const seed = seedPlacement(row);
    updates[`${tid}/placements/${placementKey(seed.effectiveFrom)}`] = { ...seed, setAt: NOW };
    console.log(`${tid}: seed ${seed.storeId}/${seed.tillId} from ${new Date(seed.effectiveFrom).toISOString()}`);
    continue;
  }
  const done = placementAt(row, SWAP_MS);
  if (done && done.storeId === move.storeId && done.tillId === move.tillId && done.effectiveFrom === SWAP_MS) {
    console.log(`${tid}: the swap is already entered — nothing to do`);
    continue;
  }
  const plan = planMove({ ...move, effectiveFrom: SWAP_MS, note: NOTE }, row, { stores, now: NOW, nowMs, by: "apply-terminal-placements-20261005" });
  if (!plan.ok) { console.error(`REFUSED ${tid}: ${plan.reason}`); bad++; continue; }
  if (plan.row.storeId !== row.storeId) { console.error(`SURPRISE: ${tid} filing store would change`); bad++; continue; }
  for (const [k, p] of Object.entries(plan.row.placements)) {
    if (!row.placements || !row.placements[k]) updates[`${tid}/placements/${k}`] = p;
  }
  for (const f of ["label", "tillId", "tillChangedAt"]) {
    if (plan.row[f] !== row[f]) updates[`${tid}/${f}`] = plan.row[f];
  }
  console.log(`${tid}: ${plan.from.storeId}/${plan.from.tillId} → ${move.storeId}/${move.tillId} from ${new Date(SWAP_MS).toISOString()}; label "${row.label}" → "${plan.row.label}"`);
}

console.log("\nupdate on /config/cardTerminals:");
console.log(JSON.stringify(updates, (k, v) => (v === NOW ? "<server time>" : v), 2));
if (bad) { console.error(`\n${bad} problem(s) — nothing written.`); process.exit(1); }
if (!Object.keys(updates).length) { console.log("\nNothing to write."); process.exit(0); }
if (!EXECUTE) { console.log("\nDry run. --execute to write."); process.exit(0); }

// Every touched key must still be absent (or unchanged, for labels) at write time.
for (const tid of TIDS) {
  const again = (await db.ref(`config/cardTerminals/${tid}`).once("value")).val();
  if (JSON.stringify(again) !== JSON.stringify(rows[tid])) { console.error(`SURPRISE: ${tid} changed since it was read — nothing written. Re-run.`); process.exit(1); }
}
await db.ref("config/cardTerminals").update(updates);

// Verify: read every row back and check the placement in force either side of the swap.
let wrong = 0;
for (const tid of TIDS) {
  const after = (await db.ref(`config/cardTerminals/${tid}`).once("value")).val();
  if (after.storeId !== rows[tid].storeId) { console.error(`WRONG: ${tid} filing store moved`); wrong++; }
  const before = placementAt(after, SWAP_MS - 1), then = placementAt(after, SWAP_MS);
  const move = MOVES.find((m) => m.tid === tid);
  const want = move ? `${move.storeId}/${move.tillId}` : `${rows[tid].storeId}/${rows[tid].tillId}`;
  const was = `${rows[tid].storeId}/${rows[tid].tillId}`;
  if (!then || `${then.storeId}/${then.tillId}` !== want) { console.error(`WRONG: ${tid} at the swap is ${then && then.storeId}/${then && then.tillId}, want ${want}`); wrong++; }
  if (!before || `${before.storeId}/${before.tillId}` !== was) { console.error(`WRONG: ${tid} before the swap is ${before && before.storeId}/${before && before.tillId}, want ${was}`); wrong++; }
  console.log(`${tid}: before ${before && `${before.storeId}/${before.tillId}`} · from 12:46 ${then && `${then.storeId}/${then.tillId}`} · label "${after.label}"`);
}
if (wrong) { console.error(`\n${wrong} check(s) failed.`); process.exit(1); }
console.log("\nApplied and verified.");
process.exit(0);
