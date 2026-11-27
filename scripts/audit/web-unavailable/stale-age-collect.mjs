// ─── WEBSITE UNAVAILABLE LINES — older ledger rows for shelf ages (READ ONLY) ─
//
//   node scripts/audit/web-unavailable/stale-age-collect.mjs <need.json> <out.json> [--before 2026-10-18]
//
// ONE BOUNDED PASS over /stock_movements by its `ts` index, one day per query,
// walking BACKWARDS from the day the five-week cache starts. Only the rows of
// the sizes named in <need.json> (stale-age.mjs writes it) are kept. A cell is
// done the moment a row touching it is seen (walking backwards, that row is its
// last touch) or once the walk is 90 days before its order. The walk stops when
// every cell is done. The bytes downloaded are printed.
import { readFileSync, writeFileSync } from "fs";
import { adminRequire } from "../../adminRequire.mjs";

const [NEED, OUT] = process.argv.slice(2);
if (!NEED || !OUT) { console.error("usage: stale-age-collect.mjs <need.json> <out.json> [--before YYYY-MM-DD]"); process.exit(2); }
const bi = process.argv.indexOf("--before");
const BEFORE = bi > 0 ? process.argv[bi + 1] : "2026-10-18";
const HORIZON_DAYS = 90;
const sk = (s) => { const v = String(s ?? "").trim(); return v === "" ? "_" : v.replace(/\./g, "_"); };
const need = JSON.parse(readFileSync(NEED, "utf8"));
const open = new Map(); // "pid|size|loc" → earliest day still wanted (ms)
for (const n of need) { const k = `${n.pid}|${n.size}|${n.loc}`; open.set(k, Math.min(open.get(k) ?? Infinity, n.T - HORIZON_DAYS * 864e5)); }
const sizes = new Set(need.map((n) => `${n.pid}|${n.size}`));

const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const keep = {};
let bytes = 0, read = 0, days = 0;
for (let day = Date.parse(`${BEFORE}T00:00:00Z`) - 864e5; open.size; day -= 864e5) {
  const d = new Date(day).toISOString().slice(0, 10);
  const rows = (await db.ref("stock_movements").orderByChild("ts").startAt(`${d}T00:00:00.000Z`).endAt(`${d}T23:59:59.999Z`).get()).val() || {};
  bytes += Buffer.byteLength(JSON.stringify(rows)); days += 1;
  for (const [id, m] of Object.entries(rows)) {
    read += 1;
    const key = `${m.productId}|${sk(m.size)}`;
    if (!sizes.has(key)) continue;
    keep[id] = m;
    for (const loc of new Set([m.from, m.to, ...Object.keys(m.after || {})].filter(Boolean))) open.delete(`${key}|${loc}`);
  }
  for (const [k, until] of open) if (day <= until) open.delete(k);
  if (days % 10 === 0) console.log(`  ${d}: ${open.size} cells still open, ${(bytes / 1e6).toFixed(1)} MB so far`);
}
writeFileSync(OUT, JSON.stringify(keep));
console.log(`days read ${days} (back to ${new Date(Date.parse(`${BEFORE}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10)}), rows read ${read}, kept ${Object.keys(keep).length}, downloaded ${(bytes / 1e6).toFixed(1)} MB`);
process.exit(0);
