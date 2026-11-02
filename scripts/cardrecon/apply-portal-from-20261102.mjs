// ─── 2 NOV 2026 — WHEN THE SIMPLYBLU PORTAL BECAME EACH TILL'S RECORD ────────
// Junid: Concrete's two machines have traded through the SimplyBLU app since
// their first day, 30 Oct 2026 (the portal holds 0000OF2Y's batches from then);
// Marathon PE Till 2 and Trophy Till 2 only from 3 Nov 2026. Writes ONLY
// `portalFrom` on the four rows (lib/card-portal.cjs portalFromOf), each in a
// transaction that refuses a row not where it is expected, audited in
// /card_terminal_audit.
//
//   node scripts/cardrecon/apply-portal-from-20261102.mjs            # dry run
//   node scripts/cardrecon/apply-portal-from-20261102.mjs --execute  # write + read back
import { createRequire } from "node:module";

const admin = createRequire(new URL("../../functions/package.json", import.meta.url))("firebase-admin");
const EXECUTE = process.argv.includes("--execute");
const ROWS = [
  { tid: "00000F2Y", storeId: "concrete", tillId: "till-1", portalFrom: "2026-10-30" },
  { tid: "00000F1Y", storeId: "concrete", tillId: "till-2", portalFrom: "2026-10-30" },
  { tid: "0000HP1X", storeId: "pe", tillId: "till-2", portalFrom: "2026-11-03" },
  { tid: "0000Z4M6", storeId: "trophy", tillId: "till-2", portalFrom: "2026-11-03" },
];
admin.initializeApp({
  credential: admin.credential.applicationDefault(), projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
let bad = 0;
for (const r of ROWS) {
  const ref = db.ref(`config/cardTerminals/${r.tid}`);
  const cur = (await ref.once("value")).val();
  if (!cur || cur.storeId !== r.storeId || cur.tillId !== r.tillId || cur.bank !== "standard-bank") {
    console.error(`✗ ${r.tid} is not the Standard Bank ${r.storeId}/${r.tillId} row this expects — not touched`); bad++; continue;
  }
  if (cur.portalFrom === r.portalFrom) { console.log(`${r.tid}: portalFrom already ${r.portalFrom}`); continue; }
  console.log(`${r.tid} (${cur.label}): ${EXECUTE ? "SET" : "would set"} portalFrom = ${r.portalFrom} (was ${cur.portalFrom ?? "absent"})`);
  if (!EXECUTE) continue;
  const res = await ref.transaction((row) => {
    if (row === null) return null; // cold cache: the server answers with the real row
    if (row.storeId !== r.storeId || row.tillId !== r.tillId || row.bank !== "standard-bank") return undefined;
    return { ...row, portalFrom: r.portalFrom };
  });
  if (!res.committed) { console.error(`✗ ${r.tid}: not written`); bad++; continue; }
  await db.ref("card_terminal_audit").push({
    at: admin.database.ServerValue.TIMESTAMP, by: "script:apply-portal-from-20261102", action: "edit",
    tid: r.tid, before: { portalFrom: cur.portalFrom ?? null }, after: { portalFrom: r.portalFrom },
    note: "Junid, 2 Nov 2026: the SimplyBLU portal is this till's record from this day",
  });
  const back = (await ref.child("portalFrom").once("value")).val();
  console.log(`  ${back === r.portalFrom ? "✓" : "✗"} read back: ${back}`);
  if (back !== r.portalFrom) bad++;
}
if (!EXECUTE) console.log("\nDry run — nothing written. Re-run with --execute.");
process.exit(bad ? 1 : 0);
