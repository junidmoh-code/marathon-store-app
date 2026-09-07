// ─── CENSUS — where the display marker's two sources actually stand. READ ONLY.
// Answers PR "fix/display-marker-source" commit 1: which node feeds the marker,
// how many products carry 2+ markers, whether anything is still being written.
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const [legacy, slots, register, products] = await Promise.all([
  db.ref("settings/displayRegister").once("value").then(s => s.val()),
  db.ref("settings/displaySlots").once("value").then(s => s.val() || {}),
  db.ref("settings/hubSneakerCount/register/hub1").once("value").then(s => s.val() || {}),
  db.ref("products").once("value").then(s => s.val() || {}),
]);

const out = [];
const say = (...a) => { const l = a.join(" "); out.push(l); console.log(l); };

say("## legacy /settings/displayRegister");
say("present:", legacy ? "YES" : "null/absent");
if (legacy) say("stores:", Object.keys(legacy).length, JSON.stringify(Object.keys(legacy)).slice(0,300));

// register rows
const regRows = Object.entries(register);
say("");
say("## /settings/hubSneakerCount/register/hub1");
say("rows:", regRows.length);
const tsFields = new Set();
let newest = null, newestRow = null, after0806 = 0;
const AUG6 = Date.parse("2026-08-06T00:00:00Z");
const tsOf = (r) => {
  const cands = [];
  for (const [k,v] of Object.entries(r||{})) {
    if (/at$|At$|^ts$|time/i.test(k)) { tsFields.add(k);
      const n = typeof v === "number" ? v : Date.parse(String(v));
      if (Number.isFinite(n)) cands.push(n);
    }
  }
  return cands.length ? Math.max(...cands) : null;
};
for (const [k,r] of regRows) {
  const t = tsOf(r);
  if (t == null) continue;
  if (newest == null || t > newest) { newest = t; newestRow = [k, r]; }
  if (t > AUG6) after0806++;
}
say("timestamp fields seen:", [...tsFields].join(", ") || "(none)");
say("newest timestamp:", newest ? new Date(newest).toISOString() : "(none)");
say("newest row:", JSON.stringify(newestRow));
say("rows with a timestamp after 2026-08-06:", after0806);

// products carrying 2+ register rows with qty>0
const byPid = new Map();
for (const [k,r] of regRows) {
  const i = k.lastIndexOf("__");
  if (i <= 0) continue;
  const pid = k.slice(0,i), sizeKey = k.slice(i+2);
  if (!sizeKey || sizeKey === "_") continue;
  if ((Number(r?.qty)||0) <= 0) continue;
  if (!byPid.has(pid)) byPid.set(pid, []);
  byPid.get(pid).push({ key:k, sizeKey, row:r, ts: tsOf(r) });
}
const multi = [...byPid.entries()].filter(([,v]) => v.length > 1);
say("");
say("products with 2+ REGISTER rows (qty>0):", multi.length, "of", byPid.size);
say("total register rows qty>0:", [...byPid.values()].reduce((a,v)=>a+v.length,0));

// slots
let liveSlots = 0, slotByPid = new Map();
for (const [store, byP] of Object.entries(slots)) {
  for (const [pid, s] of Object.entries(byP||{})) {
    if (!s || typeof s.sizeKey !== "string" || !s.sizeKey || s.sizeKey === "_") continue;
    liveSlots++;
    if (!slotByPid.has(pid)) slotByPid.set(pid, []);
    slotByPid.get(pid).push({ store, ...s });
  }
}
const multiSlot = [...slotByPid.entries()].filter(([,v]) => new Set(v.map(x=>x.sizeKey)).size > 1);
say("");
say("## /settings/displaySlots");
say("live slots:", liveSlots, "products:", slotByPid.size);
say("products whose live slots span 2+ DIFFERENT sizes:", multiSlot.length);
let slotNewest = null;
for (const v of slotByPid.values()) for (const s of v) if (typeof s.at === "string" && (!slotNewest || s.at > slotNewest)) slotNewest = s.at;
say("newest slot .at:", slotNewest);

// combined marker map (mirror of displayUnitsByCell)
const cells = new Map();
for (const [pid, arr] of slotByPid.entries()) for (const s of arr) {
  if (s.bookedHub !== "hub1") continue;
  const k = `${pid}::${s.sizeKey}`;
  const c = cells.get(k) || { units:0, stores:0, unverified:0 }; c.units++; c.stores++; cells.set(k,c);
}
for (const [pid, arr] of byPid.entries()) for (const r of arr) {
  const k = `${pid}::${r.sizeKey}`;
  const c = cells.get(k) || { units:0, stores:0, unverified:0 };
  const un = Math.max(0, (Number(r.row.qty)||0) - c.stores);
  c.units += un; c.unverified += un; cells.set(k,c);
}
const markerByPid = new Map();
for (const [k,c] of cells) { if (c.units<=0) continue; const pid=k.split("::")[0];
  markerByPid.set(pid, (markerByPid.get(pid)||0)+1); }
const multiMarker = [...markerByPid.entries()].filter(([,n])=>n>1);
say("");
say("## COMBINED MARKER (what the grid draws)");
say("marked cells total:", cells.size);
say("products carrying 2+ display markers:", multiMarker.length, "of", markerByPid.size);

// Diesel Big D Green Orange + 20 others
const nameOf = (pid) => products[pid]?.name || products[pid]?.cleanName || "(unknown)";
const diesel = [...markerByPid.keys()].filter(pid => /diesel/i.test(nameOf(pid)) && /big d/i.test(nameOf(pid)));
say("");
say("## DIESEL BIG D matches:", JSON.stringify(diesel.map(p=>[p,nameOf(p)])));
const dump = (pid) => {
  say(`\n--- ${pid} — ${nameOf(pid)} (markers: ${markerByPid.get(pid)})`);
  for (const s of (slotByPid.get(pid)||[])) say("   SLOT", JSON.stringify(s));
  for (const r of (byPid.get(pid)||[])) say("   REG ", r.key, JSON.stringify(r.row));
};
for (const pid of diesel) dump(pid);
say("\n## 20 OTHER PRODUCTS WITH 2+ MARKERS");
for (const [pid] of multiMarker.filter(([p])=>!diesel.includes(p)).slice(0,20)) dump(pid);

const fs = await import("fs");
fs.writeFileSync(process.argv[2] || "/tmp/display-census.txt", out.join("\n"));
process.exit(0);
