// ─── CORRECT THE 111,111-UNIT RECEIVING TYPO ──────────────────────────────────
// On 2026-07-25T08:12:06.713Z a `received` movement of 111,111 units was written
// for Bs-9078 (p1784808220643), size M, at hub2 — one second after a legitimate
// qty=1 on the same size. Every other movement for this product is 1 or 2 units.
// It is a stuck-key typo (111111), and it inflated hub2 from ~7,700 units to
// ~118,800, i.e. 93.5% of that location's recorded stock.
//
// HOW THIS FIXES IT: with a ledger-paired `adjustment` movement, exactly the way
// the app would — NEVER a raw qty edit. /stock has one writer contract
// (src/components/stock/applyMovement.js) and this mirrors it field for field:
// the movement record with before/after, and the cell's qty + v + mv + lastType
// + updatedAt/updatedBy, in ONE multi-path update so the ledger and the cell can
// never disagree.
//
// It does NOT delete the bad `received` movement. The ledger is append-only
// history: the mistake happened, and the correction is a new entry that says so.
// Deleting it would leave the cell unexplainable.
//
//   node scripts/fix-bs9078-typo.mjs --dry-run   # show the plan, write nothing
//   node scripts/fix-bs9078-typo.mjs             # apply
//
// Safe to re-run: it re-reads the live cell and refuses if the quantity is not
// what it expects, so a second run after a successful fix is a no-op.

import { createRequire } from "module";
const require = createRequire("file:///Users/junidmohammed/Documents/marathon-store-app/functions/package.json");
const admin = require("firebase-admin");

const DRY = process.argv.includes("--dry-run");

const PID = "p1784808220643";
const LOC = "hub2";
const SIZE = "M";           // no illegal RTDB chars, so the cell key is "M"
const BOGUS_MOVEMENT = "-OyNKAMeLjtYeXY613XF";   // the 111,111 `received` entry
const BOGUS_QTY = 111111;
// Real receipts for hub2/M: 1 (2026-07-24T08:16:40) + 1 (2026-07-25T08:12:05).
const EXPECTED_NOW = 111113;
const CORRECT_TO = 2;

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const cellPath = `stock/${LOC}/${PID}/${SIZE}`;

(async () => {
  const [cell, bogus, product] = await Promise.all([
    db.ref(cellPath).once("value").then((s) => s.val()),
    db.ref(`stock_movements/${BOGUS_MOVEMENT}`).once("value").then((s) => s.val()),
    db.ref(`products/${PID}`).once("value").then((s) => s.val()),
  ]);

  console.log(`product : ${product && product.name} [${PID}]`);
  console.log(`cell    : ${cellPath}`);
  console.log(`current : qty=${cell && cell.qty}  v=${cell && cell.v}  lastType=${cell && cell.lastType}`);
  console.log(`target  : qty=${CORRECT_TO}`);
  console.log(`the typo: movement ${BOGUS_MOVEMENT} — ${bogus && bogus.type} ${bogus && bogus.qty} @ ${bogus && bogus.ts}`);

  if (!cell || typeof cell.qty !== "number") {
    console.error("\nREFUSING: cell not found or has no numeric qty.");
    process.exit(1);
  }
  if (cell.qty === CORRECT_TO) {
    console.log("\nAlready corrected — nothing to do.");
    process.exit(0);
  }
  // Guard: only proceed from the exact state we diagnosed. If someone has
  // counted or moved this cell since, the delta below would be wrong and a
  // blind correction would create a NEW error on top of the old one.
  if (cell.qty !== EXPECTED_NOW) {
    console.error(`\nREFUSING: expected qty ${EXPECTED_NOW}, found ${cell.qty}.`);
    console.error("The cell changed since this was diagnosed — re-check before correcting.");
    process.exit(1);
  }

  const delta = CORRECT_TO - cell.qty;          // -111111
  console.log(`\nadjustment: ${delta} units  (${cell.qty} -> ${CORRECT_TO})`);

  if (DRY) {
    console.log("\n--dry-run: nothing written.");
    process.exit(0);
  }

  // Back up the cell before touching it.
  const backup = { at: new Date().toISOString(), cellPath, cell, note: "pre-correction snapshot, Bs-9078 hub2/M 111,111 typo" };
  const backupRef = db.ref("reports/stock_corrections").push();
  await backupRef.set(backup);
  console.log(`backup  : /reports/stock_corrections/${backupRef.key}`);

  const mvId = db.ref("stock_movements").push().key;
  const now = new Date().toISOString();
  const mv = {
    type: "adjustment",
    productId: PID,
    size: SIZE,
    qty: Math.abs(delta),                 // movements carry a positive magnitude
    from: LOC,                            // removing stock -> `from` is the location
    to: null,
    before: { [LOC]: cell.qty },
    after: { [LOC]: CORRECT_TO },
    actor: "script:fix-bs9078-typo",
    actorRole: "admin",
    ts: now,
    appliedAt: now,
    reason: `Correcting data-entry error: movement ${BOGUS_MOVEMENT} received ${BOGUS_QTY} units of size M on 2026-07-25 (stuck-key typo, one second after a legitimate qty=1). Real receipts for this cell total ${CORRECT_TO}. Authorised by owner 2026-07-26.`,
    link: null,
  };

  const updates = {};
  updates[`stock_movements/${mvId}`] = mv;
  updates[`${cellPath}/qty`] = CORRECT_TO;
  updates[`${cellPath}/v`] = typeof cell.v === "number" ? cell.v + 1 : 0;
  updates[`${cellPath}/mv`] = mvId;
  updates[`${cellPath}/lastType`] = "adjustment";
  updates[`${cellPath}/updatedAt`] = now;
  updates[`${cellPath}/updatedBy`] = "script:fix-bs9078-typo";

  await db.ref().update(updates);
  console.log(`movement: /stock_movements/${mvId}`);

  const after = await db.ref(cellPath).once("value").then((s) => s.val());
  console.log(`\nread-back: qty=${after.qty}  v=${after.v}  lastType=${after.lastType}  mv=${after.mv}`);
  if (after.qty !== CORRECT_TO) { console.error("VERIFY FAILED"); process.exit(1); }

  // Confirm the location total is now sane.
  const hub = await db.ref(`stock/${LOC}`).once("value").then((s) => s.val() || {});
  let total = 0;
  for (const bySize of Object.values(hub)) {
    for (const c of Object.values(bySize || {})) { const q = Number(c && c.qty) || 0; if (q > 0) total += q; }
  }
  console.log(`${LOC} total units now: ${total.toLocaleString()}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
