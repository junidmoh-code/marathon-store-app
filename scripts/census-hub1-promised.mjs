// READ-ONLY census: what is booked at Hub 1 but already promised out, right now.
// Feeds the Piece 2 availability decision. Also measures warehouse volumes from
// insights_log for the Tomorrow-gate cost decision (Refinement A).
//
// Reads (all bounded, no whole-node reads):
//   /orders            — key-range "0".."9" (the kiosk's own bounded pattern; /orders is ephemeral)
//   /laybyPulls        — whole node is small (pull summaries only)
//   /settings/stockHold/held/hub1
//   /refill_requests   — orderByChild(status) equalTo "open" and "fulfilled" (indexed)
//   /stock/hub1/{pid}  — only for pids named by ready orders (cell-level)
//   /insights_log      — orderByChild("ts") window, last 14 days
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
import { writeFileSync } from "fs";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null));

// ── ready-but-uncollected orders, hub1 ──────────────────────────────────────
const ordersSnap = await db.ref("orders").orderByKey().startAt("0").endAt("9").once("value");
const orders = ordersSnap.val() || {};
const orderRows = [];
let ordersBytes = bytes(orders);
for (const [id, o] of Object.entries(orders)) {
  if (!o || typeof o !== "object") continue;
  const hub = o.placedAtHub || o.hub || "hub1";
  orderRows.push({ id, hub, status: o.status, productId: o.productId || null,
    size: o.sentSize ?? o.size ?? null, qty: Number(o.qty) || 1, readyAt: o.readyAt || null });
}
const hub1Ready = orderRows.filter((r) => r.hub === "hub1" && r.status === "ready");
const hub1All = orderRows.filter((r) => r.hub === "hub1");

// resolve ready orders to hub1 cells
const { stockSizeKey } = await import("../src/utils/sizeKey.js");
const pidSet = [...new Set(hub1Ready.map((r) => r.productId).filter(Boolean))];
const cellReads = {};
for (const pid of pidSet) {
  const s = await db.ref(`stock/hub1/${pid}`).once("value");
  cellReads[pid] = s.val() || {};
}
const readyDetail = hub1Ready.map((r) => {
  const key = r.productId && r.size != null ? stockSizeKey(String(r.size)) : null;
  const cell = key && key !== "_" ? cellReads[r.productId]?.[key] : null;
  return { ...r, sizeKey: key, cellQty: cell ? Number(cell.qty) : null, resolvable: !!(cell || (key && key !== "_")) };
});

// ── layby pulls at hub1 ─────────────────────────────────────────────────────
const pullsSnap = await db.ref("laybyPulls").once("value");
const pulls = Object.values(pullsSnap.val() || {});
const hub1Pulls = pulls.filter((p) => p && p.storageHub === "hub1");
const pullsByStatus = {};
for (const p of hub1Pulls) pullsByStatus[p.status] = (pullsByStatus[p.status] || 0) + (Number(p.itemCount) || 0);

// ── held shipment lines to hub1 ─────────────────────────────────────────────
const heldSnap = await db.ref("settings/stockHold/held/hub1").once("value");
const held = Object.values(heldSnap.val() || {});

// ── refill requests touching hub1 ───────────────────────────────────────────
const openSnap = await db.ref("refill_requests").orderByChild("status").equalTo("open").once("value");
const open = Object.entries(openSnap.val() || {}).filter(([, r]) => r.requestingLocation === "hub1");

// ── insights_log volumes, last 14 days ──────────────────────────────────────
const since = new Date(Date.now() - 14 * 864e5).toISOString();
const logSnap = await db.ref("insights_log").orderByChild("ts").startAt(since).once("value");
const log = Object.values(logSnap.val() || {});
const byAction = {};
const byActionHub1 = {};
for (const e of log) {
  if (!e || !e.action) continue;
  byAction[e.action] = (byAction[e.action] || 0) + 1;
  if ((e.placedAtHub || "hub1") === "hub1") byActionHub1[e.action] = (byActionHub1[e.action] || 0) + 1;
}

const report = {
  now: new Date().toISOString(),
  orders: {
    totalNumericKeyed: orderRows.length, nodeBytes: ordersBytes,
    hub1: { all: hub1All.length, byStatus: hub1All.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}) },
  },
  hub1ReadyUncollected: {
    count: hub1Ready.length,
    units: hub1Ready.reduce((n, r) => n + r.qty, 0),
    resolvableToCell: readyDetail.filter((r) => r.resolvable).length,
    withLiveCell: readyDetail.filter((r) => r.cellQty != null).length,
    detail: readyDetail,
  },
  hub1LaybyPulls: { pulls: hub1Pulls.length, itemsByStatus: pullsByStatus },
  hub1HeldLines: { count: held.length, units: held.reduce((n, l) => n + (Number(l.qty) || 0), 0) },
  hub1OpenRefills: { count: open.length, units: open.reduce((n, [, r]) => n + (Number(r.qty) || 1), 0) },
  insightsLast14d: { total: log.length, byAction, byActionHub1 },
};
console.log(JSON.stringify(report, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
