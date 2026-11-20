// ─── DIAG: real RTDB round trips for the reads and the write a Solve makes ───
// Times, against the live database from this machine:
//   • a scoped one-shot read of the kinds a Solve does (refill_engine/open/{loc}/{pid},
//     stock/{loc}/{pid}, settings/stockHold/held/{hub})
//   • ONE multi-path update of a Solve's shape (N paths) to a SCRATCH node,
//     /settings/_solveLatencyProbe/{run}, deleted again straight after.
//   node scripts/diag/solve-latency-rtt.mjs <pid> [samples]
import { createRequire } from "node:module";
const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const pid = process.argv[2];
const N = Number(process.argv[3] || 8);
const t = async (fn) => { const s = performance.now(); await fn(); return performance.now() - s; };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: Math.round(s[Math.floor(s.length / 2)]), p90: Math.round(s[Math.floor(s.length * 0.9)] ?? s.at(-1)), min: Math.round(s[0]) }; };
await db.ref(".info/serverTimeOffset").once("value");   // open the socket first
const reads = { lock: [], stock: [], held: [] };
for (let i = 0; i < N; i++) {
  reads.lock.push(await t(() => db.ref(`refill_engine/open/marathon-pe/${pid}`).get()));
  reads.stock.push(await t(() => db.ref(`stock/hub2/${pid}`).get()));
  reads.held.push(await t(() => db.ref(`settings/stockHold/held/hub2`).get()));
}
const writes = [];
for (let i = 0; i < Math.min(N, 5); i++) {
  const run = `r${Date.now()}_${i}`;
  const u = {};
  for (let k = 0; k < 14; k++) u[`settings/_solveLatencyProbe/${run}/cell${k}`] = { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: new Date().toISOString() };
  writes.push(await t(() => db.ref().update(u)));
  await db.ref(`settings/_solveLatencyProbe/${run}`).remove();
}
console.log(JSON.stringify({ pid, readMs: { lock: stats(reads.lock), stock: stats(reads.stock), held: stats(reads.held) }, writeMs: stats(writes) }));
process.exit(0);
