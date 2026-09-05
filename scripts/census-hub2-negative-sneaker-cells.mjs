// READ-ONLY census: Hub 2 sneaker cells with negative quantities.
// One bounded read of /stock/hub2 (the subtree the app already streams live)
// plus /products for the footwear classification. Reports only — no writes.
import { createRequire } from "module";
const require = createRequire(new URL("../../../../../Users/junidmohammed/Documents/marathon-store-app-hub2avail/functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
// Same predicate as src/components/stock/missingFootwearCore.js (inlined —
// that module imports through the bundler's extensionless resolution).
const isFootwearProduct = (p) => p?.category === "Footwear";

const prodSnap = await db.ref("products").once("value");
const products = prodSnap.val() || {};
const stockSnap = await db.ref("stock/hub2").once("value");
const stock = stockSnap.val() || {};

let negCells = 0, negUnits = 0, negProducts = new Set();
let totalCells = 0, sneakerCells = 0;
const worst = [];
for (const [pid, bySize] of Object.entries(stock)) {
  const p = products[pid];
  const isSneaker = p ? (isFootwearProduct(p) && (p.productType || "sneaker") !== "clothing") : false;
  for (const [k, cell] of Object.entries(bySize || {})) {
    const q = Number(cell?.qty);
    if (!Number.isFinite(q)) continue;
    totalCells++;
    if (!isSneaker) continue;
    sneakerCells++;
    if (q < 0) { negCells++; negUnits += q; negProducts.add(pid); worst.push({ pid, name: p?.name, size: k, qty: q }); }
  }
}
worst.sort((a,b)=>a.qty-b.qty);
const subcats = {};
for (const [pid] of Object.entries(stock)) { const p = products[pid]; if (p && isFootwearProduct(p)) subcats[p.subcategory || p.categoryKey || "(none)"] = (subcats[p.subcategory || p.categoryKey || "(none)"] || 0) + 1; }
console.log(JSON.stringify({ subcats,
  hub2TotalCells: totalCells, hub2SneakerCells: sneakerCells,
  negativeSneakerCells: negCells, negativeSneakerUnits: negUnits,
  distinctProducts: negProducts.size, worst10: worst.slice(0,10),
}, null, 2));
process.exit(0);
