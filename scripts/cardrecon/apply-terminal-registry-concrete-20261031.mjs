// ─── 31 OCT 2026 — CONCRETE'S TWO STANDARD BANK CARD MACHINES ────────────────
// Concrete (two tills) trades on two Standard Bank PAX A8900 machines, created
// on Standard Bank's side on 21 Sep 2026, as Junid photographed them:
//
//   Concrete Till 1  TID 00000F2Y  MID 0005377331  serial 3210628181
//   Concrete Till 2  TID 00000F1Y  MID 0005377331  serial 3210628183
//
// THE TIDs. The photo of the Till 2 machine reads "0000OF1Y"; the letter O in
// a run of leading zeros is a 0 on every TID this estate has (all eight
// characters, zero-padded), and its twin reads "00000F2Y". Both are registered
// with five zeros. The match is forgiving either way: a Standard Bank row
// resolves O/0, I/1 and leading zeros (lib/card-terminals.cjs →
// resolveRegisteredTid), so a report printing "0F1Y" or "0000OF1Y" still finds
// its row. No Standard Bank report has arrived yet to confirm them from.
//
// THE TILLS are as labelled on the machines. That labelling may be backwards;
// once both tills have card sales and slips, scripts/cardrecon/
// check-terminal-assignment.mjs says whether the evidence points to a swap —
// and a swap is then a "Moved" in Card machines → settings, never an edit here.
//
// IN USE FROM 30 Oct 2026 (the start of that SAST day): Concrete's first POS
// card leg is 30 Oct 11:50 SAST and there is none before it. 21 Sep is when
// Standard Bank created the machines, not when they began trading; dating
// them from 21 Sep would report forty evenings of "no slip submitted" for a
// shop that was not taking cards.
//
// CAPTURE "typed": no Standard Bank report reader exists yet, so the evening
// slip is a PHOTO + the TYPED TOTAL (the Card Slip screen asks for both); the
// typed total is the record and the photo is read in the background only to
// tell Junid when it says something else. Switch to "both" in Card machines →
// settings once a Standard Bank report reader ships.
//
// Planned by the SAME planner the settings sheet's "Add" calls (planAdd), so a
// script add and a screen add are the same row. Each row is written in its own
// transaction that only ever creates (an existing row is left exactly as it
// is), and is read back.
//
//   node scripts/cardrecon/apply-terminal-registry-concrete-20261031.mjs            # dry run
//   node scripts/cardrecon/apply-terminal-registry-concrete-20261031.mjs --execute  # write + read back

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const local = createRequire(import.meta.url);
const { planAdd } = local("../../functions/lib/card-terminal-admin.cjs");
const { posStores } = local("../../functions/lib/pos-tills.cjs");
const { loadNetwork } = local("../../functions/lib/network-load.cjs");
const { canonicalTid } = local("../../functions/lib/card-terminals.cjs");

const EXECUTE = process.argv.includes("--execute");
const ACTIVE_FROM = Date.parse("2026-10-30T00:00:00+02:00");
const MID = "0005377331";
const COMMON = { storeId: "concrete", mid: MID, capture: "typed", bank: "standard-bank" };
const ROWS = [
  { tid: "00000F2Y", tillId: "till-1", label: "Concrete Till 1", serial: "3210628181" },
  { tid: "00000F1Y", tillId: "till-2", label: "Concrete Till 2", serial: "3210628183" },
];
const NOTE = "Standard Bank PAX A8900, created by Standard Bank 21 Sep 2026; registered 31 Oct 2026 from Junid's photos";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const NOW = admin.database.ServerValue.TIMESTAMP;

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// The POS's own stores and tills, as the settings sheet reads them.
const network = await loadNetwork(db, { fresh: true });
const configured = { concrete: (await db.ref("pos/config/concrete/tills").once("value")).val() };
const stores = posStores(configured, network);

const plans = [];
for (const r of ROWS) {
  // One row per read, never the registry.
  const cur = (await db.ref(`config/cardTerminals/${r.tid}`).once("value")).val();
  if (cur) {
    const same = cur.storeId === COMMON.storeId && cur.tillId === r.tillId && cur.bank === COMMON.bank;
    if (!same) fail(`${r.tid} is already registered as ${cur.label || r.tid} (${cur.storeId}/${cur.tillId}) — not touching it.`);
    console.log(`${r.tid}: already registered as ${cur.label} — nothing to do`);
    continue;
  }
  // No other spelling of the same machine may already be registered.
  for (const alt of new Set([r.tid.replace(/0/g, "O"), r.tid.replace(/^0+/, ""), `0000O${r.tid.slice(5)}`])) {
    if (alt === r.tid || canonicalTid(alt) !== canonicalTid(r.tid)) continue;
    if ((await db.ref(`config/cardTerminals/${alt}`).once("value")).exists()) fail(`${alt} is registered — the same machine under another spelling. Not adding ${r.tid}.`);
  }
  const plan = planAdd({ ...COMMON, ...r }, null, { stores, now: NOW });
  if (!plan.ok) fail(`${r.tid}: ${plan.reason}`);
  const row = { ...plan.row, activeFrom: ACTIVE_FROM, serial: r.serial, model: "PAX A8900", note: NOTE };
  plans.push({ tid: plan.tid, row });
  console.log(`${plan.tid}: ${EXECUTE ? "ADD" : "would add"} ${JSON.stringify({ ...row, activeFrom: new Date(ACTIVE_FROM).toISOString() })}`);
}
if (!EXECUTE) { console.log("\nDry run — nothing written. Re-run with --execute."); process.exit(0); }

for (const p of plans) {
  const res = await db.ref(`config/cardTerminals/${p.tid}`).transaction((cur) => (cur === null ? p.row : undefined));
  if (!res.committed) fail(`${p.tid}: a row appeared while this ran — not overwritten.`);
}
console.log("\nRead back:");
let bad = 0;
for (const r of ROWS) {
  const row = (await db.ref(`config/cardTerminals/${r.tid}`).once("value")).val();
  const ok = row && row.storeId === "concrete" && row.tillId === r.tillId && row.bank === "standard-bank" && row.capture === "typed";
  console.log(`  ${ok ? "✓" : "✗"} ${r.tid}: ${row ? `${row.label} · ${row.storeId}/${row.tillId} · ${row.bank} · ${row.capture} · from ${new Date(row.activeFrom).toISOString()}` : "missing"}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
