// READ-ONLY: every /stock/hub3 product must be footwear (Junid, 12 Nov 2026).
//   node scripts/audit/hub3-footwear-only-check.mjs
import { createRequire } from "module";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
const require = createRequire(import.meta.url);
const req = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const dv = require("../../functions/lib/concrete-division.cjs");
const db = admin.database();
const hub3 = await readMapPaged(db, "stock/hub3");
let cells = 0, units = 0;
const bad = [];
for (const [pid, row] of Object.entries(hub3)) {
  const p = (await db.ref(`products/${pid}`).once("value")).val();
  const n = Object.values(row || {}).filter((c) => c && typeof c === "object");
  if (!dv.isDivisionFootwear(p)) bad.push({ pid, name: p?.name || "(no record)", cells: n.length, units: n.reduce((t, c) => t + (Number(c.qty) || 0), 0) });
  cells += n.length; units += n.reduce((t, c) => t + (Number(c.qty) > 0 ? c.qty : 0), 0);
}
const seats = (await db.ref("refill_engine/seats/hub3").once("value")).val() || {};
const badSeats = [];
for (const pid of Object.keys(seats)) { const p = (await db.ref(`products/${pid}`).once("value")).val(); if (p && !dv.isDivisionFootwear(p)) badSeats.push(pid); }
console.log(JSON.stringify({ products: Object.keys(hub3).length, cells, unitsAboveZero: units, nonFootwearProducts: bad.length, bad: bad.slice(0, 20), hub3Seats: Object.keys(seats).length, nonFootwearSeats: badSeats.length }));
process.exit(bad.length || badSeats.length ? 2 : 0);
