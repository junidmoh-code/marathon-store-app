// READ-ONLY census (Junid, 22 Nov 2026): products that hold stock or a seat at
// BOTH Pine and Concrete today, and seats that exist with no stock cell (does a
// seat ever say something the cells do not?). Per-shop reads of /stock and
// /refill_engine/seats — the two shops only.
//   node scripts/diag/both-shops-census.mjs [out.json]
import { writeFileSync } from "fs";
import { restGet } from "./rest-read.mjs";
const shops = ["marathon-pine", "concrete"];
const stock = {}, seats = {};
for (const s of shops) { stock[s] = (await restGet(`stock/${s}`)) || {}; seats[s] = (await restGet(`refill_engine/seats/${s}`)) || {}; }
const units = (loc, pid) => Object.values(stock[loc][pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);
const at = (loc, pid) => ({ cells: Object.keys(stock[loc][pid] || {}).length, units: units(loc, pid), seat: !!seats[loc][pid] });
const pids = new Set(shops.flatMap((s) => [...Object.keys(stock[s]), ...Object.keys(seats[s])]));
const both = [], seatNoCell = [];
for (const pid of pids) {
  const a = at("marathon-pine", pid), b = at("concrete", pid);
  if ((a.cells || a.seat) && (b.cells || b.seat)) both.push({ pid, pine: a, concrete: b });
  for (const [s, x] of [["marathon-pine", a], ["concrete", b]]) if (x.seat && !x.cells) seatNoCell.push({ pid, shop: s });
}
const names = {};
for (const r of both) names[r.pid] = (await restGet(`products/${r.pid}/name`)) || r.pid;
const out = { readAt: new Date().toISOString(), products: pids.size, both: both.map((r) => ({ ...r, name: names[r.pid] })), seatNoCell };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(JSON.stringify({ readAt: out.readAt, productsAtEither: pids.size, atBoth: both.length, bothWithUnitsAtBoth: both.filter((r) => r.pine.units > 0 && r.concrete.units > 0).length, seatWithNoCell: seatNoCell.length }));
