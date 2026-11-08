// Junid, 8 Nov 2026: where a till's day comes from is per terminal. Concrete
// Till 1/2 are the SimplyBLU portal, with no slip asked of staff; only Marathon
// PE Till 2 and Trophy Till 2 are photographed, until their merchant is linked
// in SimplyBLU — then `source` on their row becomes "portal", no code change.
// FNB rows are not written (no `source` reads as "email").
// This undoes apply-concrete-photo-primary-20261107.mjs. `record` is written
// beside `source` for Concrete so anything still reading it agrees.
// Dry run unless --execute. One transaction per row, read back.
import { adminRequire } from "../adminRequire.mjs";
const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
const PLAN = [
  { tid: "00000F2Y", storeId: "concrete", set: { source: "portal", record: "portal" } },
  { tid: "00000F1Y", storeId: "concrete", set: { source: "portal", record: "portal" } },
  { tid: "0000HP1X", storeId: "pe", set: { source: "photo" } },
  { tid: "0000Z4M6", storeId: "trophy", set: { source: "photo" } },
];
let bad = 0;
for (const { tid, storeId, set } of PLAN) {
  const path = `config/cardTerminals/${tid}`;
  const cur = (await db.ref(path).once("value")).val();
  if (!cur || cur.storeId !== storeId || cur.bank !== "standard-bank") { console.log(`${tid}: not the expected Standard Bank row — skipped`); bad++; continue; }
  console.log(`${tid} (${cur.label}): ${EXECUTE ? "SET" : "would set"} ${JSON.stringify(set)}`);
  if (!EXECUTE) continue;
  await db.ref(path).transaction((row) => (row === null ? null : row.storeId === storeId && row.bank === "standard-bank" ? { ...row, ...set } : undefined));
  const back = (await db.ref(path).once("value")).val();
  const ok = Object.entries(set).every(([k, v]) => back?.[k] === v);
  console.log(`  ${ok ? "✓" : "✗"} read back: source=${back?.source} record=${back?.record ?? "—"}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
