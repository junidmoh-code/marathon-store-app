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

// THE MISMATCH, both worlds (CodeRabbit, PR #545): the FRESH map is what the
// app now subtracts (aged through promiseFresh — the census must agree with
// the resolver, so the classification calls promiseFresh itself rather than
// re-deriving a threshold); the ALL map is the pre-fix counterfactual, so the
// ghost measurement is "cells the bound freed", never a mislabelled blocker.
const promisedFresh = mergePromised(
  readyPromisedByCell(orders, "hub1", productsById, now),
  pendingDisplayPullsByCell(orders, productsById, now),
);
// A nowMs EVERY dated promise is fresh against: promiseFresh tests
// nowMs − t <= window, so the unbounded counterfactual needs a far-PAST
// clock (a far-future one ages everything out — CodeRabbit, PR #545).
const FAR_PAST = now - 1000 * 86400000;
const promisedAll = mergePromised(
  readyPromisedByCell(orders, "hub1", productsById, FAR_PAST),
  pendingDisplayPullsByCell(orders, productsById, FAR_PAST),
);
const readyHub1 = orders.filter((o) => o.status === "ready" && (o.hub || "hub1") === "hub1");
const pulls = orders.filter((o) => ["incoming", "coming_tomorrow"].includes(o.status) && o.displayPairRequest === true);
const { promiseFresh } = await import("../src/components/stock/availabilityCore.js");
const promiseAges = {};
for (const o of [...readyHub1, ...pulls]) {
  if (!o.productId) continue;
  const key = promisedKey(o.productId, o.sentSize ?? o.size ?? "");
  const d = ageDays(o);
  (promiseAges[key] ||= []).push({ id: o.id, status: o.status, fresh: promiseFresh(o, now), days: d == null ? null : Math.round(d * 10) / 10 });
}
// Attribution per cell lists only the orders that CONTRIBUTE to that map —
// fresh orders for a live blocker, every order for the counterfactual.
const contributors = (key, freshOnly) =>
  (promiseAges[key] || []).filter((a) => !freshOnly || a.fresh);
let cellsWithStock = 0;
const blocked = [];       // blocked TODAY, by fresh promises — by design
const freedGhosts = [];   // blocked pre-fix only — the population the bound freed
for (const [pid, bySize] of Object.entries(hub1Snap.val() || {})) {
  const p = productsById[pid];
  if (!p || !isFootwearProduct(p)) continue;
  for (const [k, cell] of Object.entries(bySize || {})) {
    const qty = typeof cell?.qty === "number" ? cell.qty : 0;
    if (qty <= 0) continue;
    cellsWithStock++;
    const raw = decodeSizeKey(k);
    const key = `${pid}::${stockSizeKey(raw)}`;
    if (qty - (promisedFresh[key] || 0) <= 0)
      blocked.push({ pid, name: p.name, size: raw, qty, promised: promisedFresh[key] || 0, orders: contributors(key, true) });
    else if (qty - (promisedAll[key] || 0) <= 0)
      freedGhosts.push({ pid, name: p.name, size: raw, qty, promised: promisedAll[key] || 0, orders: contributors(key, false) });
  }
}
console.log(`\nhub1 footwear cells with qty>0: ${cellsWithStock}`);
console.log(`✕ today, by FRESH promises (by design): ${blocked.length} cells / ${new Set(blocked.map((b) => b.pid)).size} products`);
console.log(`✕ only WITHOUT the freshness bound (ghosts the bound frees): ${freedGhosts.length} cells / ${new Set(freedGhosts.map((b) => b.pid)).size} products`);
for (const b of blocked) console.log(` [blocked] ${b.name} [${b.size}] qty=${b.qty} promised=${b.promised} ← ${JSON.stringify(b.orders)}`);
for (const b of freedGhosts) console.log(` [freed]   ${b.name} [${b.size}] qty=${b.qty} promised=${b.promised} ← ${JSON.stringify(b.orders)}`);
writeFileSync("picker-promise-mismatch.json", JSON.stringify({ ranAt: new Date().toISOString(), byStatus, blocked, freedGhosts }, null, 1));
console.log("\nwrote picker-promise-mismatch.json");
process.exit(0);
