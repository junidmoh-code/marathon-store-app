// ── WHAT THE EXTENDED LEXICON NOW REFUSES ───────────────────────────────────
// The 2026-08-22 extension added classes the list never had. This answers the
// only question that matters operationally: how much of the catalogue would now
// be refused that previously sailed through — i.e. what would have leaked next.
//
//   node scripts/shopify/lexicon-impact.mjs
//
// READ-ONLY. Reads /products (paged by key, never a whole-node get) and reports.
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

// The trigger labels added on 2026-08-22. A product "newly refused" is one that
// is clean under the OLD list and dirty only because of these.
const ADDED = new Set(["ferrari","mclaren","mercedes","nascar","porsche","lamborghini","maserati","bugatti","aston martin","alfa romeo","scuderia","petronas","fly emirates","emirates","jvc","sharp","carlsberg","bwin","parmalat","vodafone","aig","autoglass","crown paints","standard chartered","teka","candy","o2","holsten","sanyo","chevrolet","etihad","central cee","drake","bad bunny","benito","kaws","wales bonner","a ma maniere","liberty london","hello kitty","sanrio","snorlax","pokemon","pikachu","disney","marvel","star wars","dolce gabbana","gabbana","barrow","acqua di gio","gio","gentleman","invictus","sauvage","bleu de chanel","goodyear","vibram","gore tex","cordura","primaloft","flightposite","fuelcell","tasman","fontanka","mayze","osweego","adistar","adios","sl72","spinor","ukiyo","athene","glenclyffe","cragstone","verto","phatty","northstar","maddsen","lerond","audysol","roam","karpri","cabo rojo","evo sl","seattle mariners","atlanta braves","red sox","sox","yankees","dodgers","lakers","clemson","nba","mlb","nfl","manchester united","manchester city","liverpool","chelsea","arsenal","tottenham","newcastle","real madrid","barcelona","ac milan","inter milan","juventus","lazio","ajax","bayern munich","sporting cp","paris saint germain"]);

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

// Paged by key — /products is thousands of records and a single get() is the
// whole-node read this codebase does not do.
const PAGE = 500;
let cursor = null, scanned = 0;
const rows = [];
for (;;) {
  let q = db.ref("products").orderByKey().limitToFirst(PAGE + (cursor ? 1 : 0));
  if (cursor) q = q.startAt(cursor);
  const val = (await q.once("value")).val() || {};
  const keys = Object.keys(val).sort();
  if (cursor) { const i = keys.indexOf(cursor); if (i >= 0) keys.splice(i, 1); }
  if (!keys.length) break;
  for (const k of keys) {
    const p = val[k];
    if (!p || typeof p !== "object") continue;
    scanned++;
    const name = p.name ?? p.productName ?? "";
    if (!name) continue;
    const hits = triggersInText(name);
    if (!hits.length) continue;
    const onlyNew = hits.every((h) => ADDED.has(h));
    rows.push({ id: k, name, hits, onlyNew });
  }
  cursor = keys[keys.length - 1];
  if (keys.length < PAGE) break;
}

const newlyRefused = rows.filter((r) => r.onlyNew);
console.log(`/products records scanned: ${scanned}`);
console.log(`carrying ANY trigger:      ${rows.length}`);
console.log(`NEWLY refused (clean under the old list, dirty only because of the 2026-08-22 classes): ${newlyRefused.length}`);
console.log(`\nthat is ${(100 * newlyRefused.length / scanned).toFixed(1)}% of the catalogue that previously passed and would have leaked on its next push.\n`);

const byLabel = {};
for (const r of newlyRefused) for (const h of r.hits) byLabel[h] = (byLabel[h] || 0) + 1;
console.log("newly-refused records by trigger:");
for (const [k, v] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
  console.log(String(v).padStart(6), k);
}
console.log("\nfirst 25 newly-refused names:");
for (const r of newlyRefused.slice(0, 25)) console.log("  ", r.hits.join(", ").padEnd(30), r.name.slice(0, 60));

writeFileSync("LEXICON-IMPACT.json", JSON.stringify({
  scannedAt: new Date().toISOString(), scanned,
  anyTrigger: rows.length, newlyRefused: newlyRefused.length,
  byLabel, records: newlyRefused.map((r) => ({ id: r.id, name: r.name, hits: r.hits })),
}, null, 2));
console.log("\nwrote LEXICON-IMPACT.json");
process.exit(0);
