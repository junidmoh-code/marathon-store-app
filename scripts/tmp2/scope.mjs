import { createRequire } from "module";
import { writeFileSync } from "fs";
const OUT=[]; const say=(...a)=>OUT.push(a.join(" "));
const req = createRequire("/Users/junidmohammed/Documents/marathon-store-app-hub2avail/functions/package.json");
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const engine = createRequire(import.meta.url)("../../functions/lib/refill-engine.cjs");
const v = async (p) => (await db.ref(p).once("value")).val();

// ── TAB A: sneaker orders told out-of-stock / coming-tomorrow, per hub ──
const orders = await v("orders") || {};
const now = Date.now();
const buckets = {};
for (const [id,o] of Object.entries(orders)) {
  if (o.productType !== "sneaker") continue;
  const at = o.outOfStockAt || o.comingTomorrowAt;
  if (!at) continue;
  const t = Date.parse(at); if (!Number.isFinite(t)) continue;
  const days = Math.floor((now - t)/864e5);
  const hub = o.placedAtHub || o.hub || "?";
  const kind = o.outOfStockAt ? "out_of_stock" : "coming_tomorrow";
  const resolved = !!(o.readyAt || o.collectedAt);
  const k = `${hub}`;
  buckets[k] = buckets[k] || {};
  const b = buckets[k];
  for (const w of [1,7,30]) if (days < w) {
    b[`${w}d`] = b[`${w}d`] || { total:0, out:0, tom:0, unresolved:0 };
    b[`${w}d`].total++; b[`${w}d`][kind==="out_of_stock"?"out":"tom"]++;
    if (!resolved) b[`${w}d`].unresolved++;
  }
}
say("TAB A — sneaker lines told unavailable, by hub:");
for (const [hub,b] of Object.entries(buckets)) say(" ", hub, JSON.stringify(b));

// clothing equivalents, for contrast (should NOT be in scope)
let clothOOS=0; for (const o of Object.values(orders)) if (o.productType!=="sneaker" && (o.outOfStockAt||o.comingTomorrowAt)) clothOOS++;
say("clothing lines with the same markers (out of scope):", clothOOS);

// ── TAB B: clothing held at PE/Trophy with NO sale in 21 days ──
const [products, pe, trophy] = await Promise.all([v("products"), v("stock/marathon-pe"), v("stock/trophy")]);
const since = new Date(now - 21*864e5).toISOString();
const mvSnap = await db.ref("stock_movements").orderByChild("ts").startAt(since).once("value");
const soldBy = { "marathon-pe": new Set(), trophy: new Set() };
mvSnap.forEach(c => { const m=c.val(); if (m && m.type==="sold" && soldBy[m.from]) soldBy[m.from].add(m.productId); });
say("movements in 21d slice:", mvSnap.numChildren());
for (const [store, st] of [["marathon-pe",pe],["trophy",trophy]]) {
  let held=0, noSale=0;
  for (const [pid,sizes] of Object.entries(st||{})) {
    if (!engine.isClothing(products[pid])) continue;
    if (!Object.values(sizes||{}).some(c => typeof c?.qty==="number" && c.qty>0)) continue;
    held++; if (!soldBy[store].has(pid)) noSale++;
  }
  say(`TAB B ${store}: clothing held=${held}, NOT sold in 21d=${noSale}, cycle at 90/wk = ${(noSale/90).toFixed(1)} weeks`);
}
writeFileSync("/tmp/scope-out.txt", OUT.join("\n")+"\n");
process.exit(0);
