// Junid, 7 Nov 2026 (evening): "If SimplyBlu only offers a portal (no email),
// say so plainly, and make the in-app photo/typed path the primary route for
// Concrete until an automated export exists." It does: no Standard Bank or
// SimplyBLU batch report has ever reached marathon6631@, and SimplyBLU offers
// no scheduled email. And the portal's list is not the till's money — on
// 7 Nov it held NO transaction for Concrete while the POS took R19,890.00 by
// card on Concrete Till 1 (3 Nov and 6 Nov fell short too).
//
// This takes `record: "portal"` off Concrete Till 1/2's registry rows (set this
// morning by apply-concrete-portal-record-20261107.mjs), so they are
// photo-primary like Marathon PE Till 2 and Trophy Till 2
// (lib/card-terminals.cjs isPhotoPrimary): the photographed end-of-day report
// is the record, a typed total beside it is a cross-check (and stands, flagged,
// when the photo cannot be read), and a portal pull is only a cross-check.
// Nothing already recorded is touched. Dry run unless --execute. One row each,
// in a transaction, read back.
import { adminRequire } from "../adminRequire.mjs";
const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
let bad = 0;
for (const tid of ["00000F2Y", "00000F1Y"]) {
  const path = `config/cardTerminals/${tid}`;
  const cur = (await db.ref(path).once("value")).val();
  if (!cur || cur.storeId !== "concrete" || cur.bank !== "standard-bank") { console.log(`${tid}: not Concrete's Standard Bank row — skipped`); bad++; continue; }
  if (cur.record !== "portal") { console.log(`${tid} (${cur.label}): already photo-primary (record=${cur.record ?? "—"})`); continue; }
  console.log(`${tid} (${cur.label}): ${EXECUTE ? "REMOVE" : "would remove"} record = "portal" → photo-primary (capture ${cur.capture} is ignored for photo-primary rows)`);
  if (!EXECUTE) continue;
  await db.ref(path).transaction((row) => {
    if (row === null) return null;
    if (row.storeId !== "concrete" || row.bank !== "standard-bank") return undefined;
    const { record, ...rest } = row;
    return rest;
  });
  const back = (await db.ref(`${path}/record`).once("value")).val();
  console.log(`  ${back === null ? "✓" : "✗"} read back: record=${back ?? "—"}`);
  if (back !== null) bad++;
}
process.exit(bad ? 1 : 0);
