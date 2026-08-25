// Scan every /stock location for negative cells. READ-ONLY.
// Paged per-location reads (never a whole-/stock read) via the shared pager.
// Output: JSON report of {location, productId, sizeKey, qty} rows to stdout
// plus a machine copy at the path given as argv[2].
import admin from "firebase-admin";
import { writeFileSync } from "fs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// in_transit is EXCLUDED on purpose: a negative transit cell is an unmatched
// relocation leg (a transfer_in whose transfer_out never landed), not a count
// artifact — zeroing it would fabricate units into the transit pool and erase
// the reconciliation signal. (2026-08-25 scan: in_transit held no negatives
// anyway.) Locations listed explicitly so a review reads the scope at a glance.
const LOCATIONS = ["hub3", "marathon-pe", "trophy", "studio", "central", "marathon-pine", "base", "hub2", "hub1"];

const rows = [];
for (const loc of LOCATIONS) {
  const map = await readMapPaged(db, `stock/${loc}`, { pageSize: 400 });
  for (const [pid, sizes] of Object.entries(map || {})) {
    if (sizes == null || typeof sizes !== "object") continue;
    for (const [sizeKey, cell] of Object.entries(sizes)) {
      const qty = typeof cell === "number" ? cell : (cell && typeof cell === "object" ? cell.qty : null);
      if (typeof qty === "number" && qty < 0) {
        rows.push({ location: loc, productId: pid, sizeKey, qty, cellShape: typeof cell });
      }
    }
  }
  console.error(`scanned ${loc}: ${Object.keys(map || {}).length} products`);
}
console.log(JSON.stringify(rows, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(rows, null, 2));
console.error(`TOTAL negative cells: ${rows.length}, total units below zero: ${rows.reduce((a, r) => a - r.qty, 0)}`);
