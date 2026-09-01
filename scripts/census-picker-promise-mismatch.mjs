// ─── READ-ONLY CENSUS: picker ✕ vs real hub1 stock — the ghost-promise scan ──
//
// The question (owner report, 2026-09-01, "Lacoste Powercourt size 8"): how
// many hub1 product/size cells hold real quantity in /stock while the
// assistant order picker's availability resolver (availabilityCore.js) reads
// them as unavailable (✕)? And how much of that subtraction comes from STALE
// ready orders — records in /orders whose daily-scoped numeric key was never
// reused, so a month-old "ready" order still books a cell today?
//
// Reads (one-off census, run by hand):
//   /orders          — whole node (~2.5 MB; the app itself streams it whole)
//   /stock/hub1      — one hub subtree (~500 KB, same as the app)
//   /products        — whole node (the engine's own pattern; needed for the
//                      footwear predicate on every order + cell)
//
// Writes: NOTHING. Output: console summary + blocked-cells JSON next to cwd.
//
// Run: node --experimental-vm-modules? no — run via vite-node (extensionless
// src imports): ../node_modules/.bin/vite-node scripts/census-picker-promise-mismatch.mjs
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
import { writeFileSync } from "fs";
import { readyPromisedByCell, promisedKey, isFootwearProduct } from "../src/components/stock/availabilityCore.js";
import { pendingDisplayPullsByCell, mergePromised } from "../src/components/stock/displayPairCore.js";
import { decodeSizeKey, stockSizeKey } from "../src/utils/sizeKey.js";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const [ordersSnap, hub1Snap, productsSnap] = await Promise.all([
  db.ref("orders").once("value"),
  db.ref("stock/hub1").once("value"),
  db.ref("products").once("value"),
]);
const orders = Object.entries(ordersSnap.val() || {})
  .map(([id, o]) => (o && typeof o === "object" ? { id, ...o } : null))
  .filter(Boolean);
const productsById = {};
for (const [pid, p] of Object.entries(productsSnap.val() || {}))
  if (p && typeof p === "object") productsById[pid] = { id: pid, ...p };

const now = Date.now();
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const ageDays = (o) => { const t = ts(o.readyAt) ?? ts(o.createdAt); return t == null ? null : (now - t) / 86400000; };

// Age distribution of every status — how "ephemeral" /orders actually is.
const byStatus = {};
for (const o of orders) {
  const d = ageDays(o);
  const b = (byStatus[o.status || "?"] ||= { n: 0, over7d: 0, over30d: 0 });
  b.n++;
  if (d != null && d > 7) b.over7d++;
  if (d != null && d > 30) b.over30d++;
}
console.log("orders:", orders.length, JSON.stringify(byStatus, null, 1));

// THE MISMATCH: hub1 footwear cells with qty > 0 that the resolver reads ✕.
const promised = mergePromised(
  readyPromisedByCell(orders, "hub1", productsById),
  pendingDisplayPullsByCell(orders, productsById),
);
const readyHub1 = orders.filter((o) => o.status === "ready" && (o.hub || "hub1") === "hub1");
const pulls = orders.filter((o) => ["incoming", "coming_tomorrow"].includes(o.status) && o.displayPairRequest === true);
const promiseAges = {};
for (const o of [...readyHub1, ...pulls]) {
  if (!o.productId) continue;
  const key = promisedKey(o.productId, o.sentSize ?? o.size ?? "");
  const d = ageDays(o);
  (promiseAges[key] ||= []).push({ id: o.id, status: o.status, days: d == null ? null : Math.round(d * 10) / 10 });
}
let cellsWithStock = 0;
const blocked = [];
for (const [pid, bySize] of Object.entries(hub1Snap.val() || {})) {
  const p = productsById[pid];
  if (!p || !isFootwearProduct(p)) continue;
  for (const [k, cell] of Object.entries(bySize || {})) {
    const qty = typeof cell?.qty === "number" ? cell.qty : 0;
    if (qty <= 0) continue;
    cellsWithStock++;
    const raw = decodeSizeKey(k);
    const key = `${pid}::${stockSizeKey(raw)}`;
    const prom = promised[key] || 0;
    if (qty - prom <= 0) blocked.push({ pid, name: p.name, size: raw, qty, promised: prom, orders: promiseAges[key] || [] });
  }
}
const stale = blocked.filter((b) => b.orders.some((a) => (a.days ?? 0) > 7));
console.log(`\nhub1 footwear cells with qty>0: ${cellsWithStock}`);
console.log(`reading ✕ despite stock: ${blocked.length} cells / ${new Set(blocked.map((b) => b.pid)).size} products`);
console.log(`of those, blocked by a promise OLDER than 7 days (certain ghosts): ${stale.length}`);
for (const b of blocked) console.log(` ${b.name} [${b.size}] qty=${b.qty} promised=${b.promised} ← ${JSON.stringify(b.orders)}`);
writeFileSync("picker-promise-mismatch.json", JSON.stringify({ ranAt: new Date().toISOString(), byStatus, blocked }, null, 1));
console.log("\nwrote picker-promise-mismatch.json");
process.exit(0);
