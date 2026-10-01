// ─── SNEAKER SOURCING vs WHERE THE STOCK ACTUALLY IS — read-only census ──────
//
// The 2026-09-06 report: CHRISTINA LOUBOUTIN LOUIS PARIS black rendered ✕ on
// all six sizes on a shop order sheet headed "Hub 1", while the Counted Stock
// screen showed 11 units of it at HUB 2. The gate was RIGHT — Hub 1 held no
// cell at all for that product. What was wrong is upstream: computeHubForItem
// picks the sourcing hub from the product record's `hubs` TAG, and the tag
// still said hub1 after every unit had been transferred to Hub 2.
//
// This census measures the class: gated sneaker products whose ROUTED hub can
// supply nothing while the OTHER gated hub can. Reads /products, /stock/hub1,
// /stock/hub2 (subtree reads, one-off, report script — the app never does
// this) and /orders by key range, the kiosk's own bounded pattern.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

// The app's own predicates, mirrored exactly (same transcriptions as
// census-hub2-gate-blast-radius.mjs — checked against their sources).
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;
const encodeSizeKey = (s) => typeof s === "number" ? String(s)
  : typeof s !== "string" ? s : s.replace(ILLEGAL_RTDB_CHARS, "_");
const decodeSizeKey = (k) => typeof k !== "string" ? k : k.replace(/(\d)_(\d)/g, "$1.$2");
const stockSizeKey = (s) => (s == null || s === "" || s === "Free Size") ? "_" : encodeSizeKey(s);
const decodedCellKey = (s) => decodeSizeKey(stockSizeKey(s));
const isFootwearProduct = (p) => p?.category === "Footwear";
const isGatedSneaker = (p) => isFootwearProduct(p) && (p?.productType || "sneaker") !== "clothing";
const getProductHubs = (p) => p?.hubs || (p?.hub ? [p.hub] : []);
const routedHub = (p) => getProductHubs(p).find((h) => h === "hub1" || h === "hub2") || "hub1";
const sizesOf = (p) => {
  const s = (Array.isArray(p?.sizes) ? p.sizes : []).filter((x) => x && String(x).trim() && x !== "_");
  return s.length ? s : ["Free Size"];
};
const isDeactivated = (p) => p?.deactivated === true || !!p?.deactivatedAt;

const [prodSnap, h1Snap, h2Snap] = await Promise.all([
  db.ref("products").once("value"), db.ref("stock/hub1").once("value"), db.ref("stock/hub2").once("value"),
]);
const products = prodSnap.val() || {};
const stock = { hub1: h1Snap.val() || {}, hub2: h2Snap.val() || {} };

const decCache = new Map();
const decodedRows = (hub, pid) => {
  const k = `${hub}::${pid}`;
  if (decCache.has(k)) return decCache.get(k);
  const raw = stock[hub][pid];
  let dec = null;
  if (raw) { dec = {}; for (const kk of Object.keys(raw)) dec[decodeSizeKey(kk)] = raw[kk]; }
  decCache.set(k, dec);
  return dec;
};
const cellQty = (hub, pid, size) => {
  const rows = decodedRows(hub, pid);
  if (!rows) return null;
  const cell = rows[decodedCellKey(size)];
  if (cell === undefined) return null;
  const q = Number(cell?.qty);
  return Number.isFinite(q) ? q : 0;
};
const avail = (hub, pid, size) => Math.max(Number(cellQty(hub, pid, size)) || 0, 0);

let gated = 0, deact = 0;
const wholeProductMisroutes = [];   // routed hub can supply NOTHING, other hub can
let cellMisroutes = 0;              // per size: routed 0, other >0
let cellsChecked = 0;
const dualHub = [];

for (const [pid, p] of Object.entries(products)) {
  if (!p || typeof p !== "object") continue;
  if (!isGatedSneaker(p)) continue;
  if (isDeactivated(p)) { deact++; continue; }
  gated++;
  const hubs = getProductHubs(p).filter(h => h === "hub1" || h === "hub2");
  if (hubs.length > 1) dualHub.push({ pid, name: p.name, hubs });
  const routed = routedHub(p);
  const other = routed === "hub1" ? "hub2" : "hub1";
  const sizes = sizesOf(p);
  let routedTotal = 0, otherTotal = 0, misCells = 0;
  const per = [];
  for (const s of sizes) {
    cellsChecked++;
    const a = avail(routed, pid, s), b = avail(other, pid, s);
    routedTotal += a; otherTotal += b;
    if (a === 0 && b > 0) { misCells++; cellMisroutes++; }
    per.push({ size: s, routed: a, other: b });
  }
  if (routedTotal === 0 && otherTotal > 0)
    wholeProductMisroutes.push({ pid, name: p.name, routed, other, otherTotal, sizes: per, tag: getProductHubs(p) });
}

console.log(`Gated sneaker products (active): ${gated}   (deactivated skipped: ${deact})`);
console.log(`Product×size chips checked: ${cellsChecked}`);
console.log(`\nA) WHOLLY UNORDERABLE MISROUTES — routed hub has 0 across every declared size,`);
console.log(`   the other gated hub holds stock:  ${wholeProductMisroutes.length} products`);
const byDir = {};
for (const r of wholeProductMisroutes) byDir[`${r.routed}->${r.other}`] = (byDir[`${r.routed}->${r.other}`] || 0) + 1;
console.log(`   direction:`, JSON.stringify(byDir));
console.log(`   units stranded: ${wholeProductMisroutes.reduce((n, r) => n + r.otherTotal, 0)}`);
console.log(`\nB) PER-CHIP MISROUTES — routed hub 0, other hub >0: ${cellMisroutes} product×size chips`);
console.log(`\nC) DUAL-HUB products (tag order decides the gate): ${dualHub.length}`);
for (const d of dualHub.slice(0, 15)) console.log(`   ${d.pid} ${JSON.stringify(d.hubs)} ${d.name}`);

console.log(`\n--- the reported product ---`);
const rep = wholeProductMisroutes.find(r => r.pid === "p1788276348886");
console.log(rep ? JSON.stringify(rep, null, 2) : "not currently in the misroute set (tag now points at the stock)");

console.log(`\n--- top 25 wholly-unorderable misroutes ---`);
for (const r of wholeProductMisroutes.sort((a, b) => b.otherTotal - a.otherTotal).slice(0, 25))
  console.log(`   ${String(r.otherTotal).padStart(3)}u at ${r.other}  tag=${JSON.stringify(r.tag)} routed=${r.routed}  ${r.pid}  ${r.name}`);
process.exit(0);
