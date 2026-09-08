import { createRequire } from "module";
import { writeFileSync } from "fs";
const OUT = [];
const say = (...a) => OUT.push(a.join(" "));
const req = createRequire("/Users/junidmohammed/Documents/marathon-store-app-hub2avail/functions/package.json");
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const engine = createRequire(import.meta.url)("../../functions/lib/refill-engine.cjs");
const v = async (p) => (await db.ref(p).once("value")).val();
const [rr, products, hub2, central, pe, trophy] = await Promise.all(
  ["refill_requests","products","stock/hub2","stock/central","stock/marathon-pe","stock/trophy"].map(v));
const stock = { hub2, central, "marathon-pe": pe, trophy };
let openEmpty = 0, openTotal = 0;
for (const r of Object.values(rr)) {
  if (r.status !== "open") continue;
  if (r.requestingLocation !== "marathon-pe" && r.requestingLocation !== "trophy") continue;
  if (!engine.isClothing(products[r.productId])) continue;
  openTotal++;
  const src = r.createdFrom?.source || "hub2";
  const q = stock[src]?.[r.productId]?.[engine.encodeSizeKey(r.size)]?.qty ?? 0;
  if (q <= 0) openEmpty++;
}
say(`open clothing requests at the 2 stores: ${openTotal}, of which source reads <=0: ${openEmpty}`);
// negative clothing cells per location
for (const [loc, m] of Object.entries(stock)) {
  let neg = 0;
  for (const [pid, sizes] of Object.entries(m||{})) {
    if (!engine.isClothing(products[pid])) continue;
    for (const c of Object.values(sizes||{})) if (typeof c?.qty === "number" && c.qty < 0) neg++;
  }
  say(`negative clothing cells at ${loc}: ${neg}`);
}
// size keys with whitespace / Free Size anywhere in stock
const odd = new Set();
for (const m of Object.values(stock)) for (const sizes of Object.values(m||{})) for (const k of Object.keys(sizes||{})) if (/^_|_$|Free/i.test(k)) odd.add(k);
say("odd size keys in stock:", [...odd].slice(0,20));
const oddReq = new Set();
for (const r of Object.values(rr)) if (typeof r.size === "string" && (r.size !== r.size.trim() || /free/i.test(r.size))) oddReq.add(JSON.stringify(r.size));
say("odd sizes on refill_requests:", [...oddReq].slice(0,20));
writeFileSync("/tmp/probe-out.txt", OUT.join("\n") + "\n");
process.exit(0);
