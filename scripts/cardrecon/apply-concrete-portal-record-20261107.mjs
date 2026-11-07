// Junid, 7 Nov 2026: "Concrete is fine with SimplyBLU — only Marathon and
// Trophy." Sets `record: "portal"` on Concrete Till 1/2's registry rows, so
// they keep the SimplyBLU portal as their record (lib/card-terminals.cjs
// isPortalRecordTerminal). Dry run unless --execute. One row each, read back.
import { adminRequire } from "../adminRequire.mjs";
const req = adminRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
let bad = 0;
for (const tid of ["00000F2Y", "00000F1Y"]) {
  const path = `config/cardTerminals/${tid}`;
  const cur = (await db.ref(path).once("value")).val();
  if (!cur || cur.storeId !== "concrete" || cur.bank !== "standard-bank") { console.log(`${tid}: not Concrete's Standard Bank row — skipped`); bad++; continue; }
  if (cur.record === "portal") { console.log(`${tid}: already record=portal`); continue; }
  console.log(`${tid} (${cur.label}): ${EXECUTE ? "SET" : "would set"} record = "portal" (capture stays ${cur.capture})`);
  if (!EXECUTE) continue;
  await db.ref(path).transaction((row) => (row === null ? null : row.storeId === "concrete" && row.bank === "standard-bank" ? { ...row, record: "portal" } : undefined));
  const back = (await db.ref(`${path}/record`).once("value")).val();
  console.log(`  ${back === "portal" ? "✓" : "✗"} read back: ${back}`);
  if (back !== "portal") bad++;
}
process.exit(bad ? 1 : 0);
