// ─── REFILL CADENCE: HOW MANY LIVE ORDER KEYS A DAY'S DRAWS REWRITE ──────────
// WRITES NOTHING. Read-only census behind the hourly cadence change (PR for
// refillHealthScan, 2026-09-20) and the answer to the question PR #616 left
// open: does running fewer times a day overwrite MORE of the standing engine
// orders?
//
// THE MECHANISM. Store-leg orders live at `orders/${refillNum}-${lineIdx}`.
// refillNum comes from /refillCounter, which resets every SA day; lineIdx
// restarts at 1 per destination per run. So a day's writes occupy
// (R-number × line index) cells, and tomorrow's same-numbered draw writes over
// them. How much damage that does depends on how DEEP each draw goes, which is
// the thing the cadence changes — fewer runs means bigger batches per run.
//
// WHAT THIS MEASURES. For each recent SA day, reconstruct that day's actual
// draw table from /orders itself (every engine order carries its R-number in
// its key and its destination and createdAt in its body), then re-bucket the
// same day's lines into the draws an HOURLY cadence would have made, and into
// the one-run-a-day cadence PR #616 proposed. For each table, count how many of
// the CURRENTLY LIVE engine orders sit inside the keys those draws rewrite.
//
// The counterfactual is honest because all three tables carry the same day's
// real work: the same lines, re-grouped. Only the grouping changes.
//
// A CAVEAT THE NUMBERS CARRY. /orders holds survivors, so a day's reconstructed
// draw depth is a LOWER bound — lines already overwritten are invisible. The
// hourly and daily models scale each bucket by (depth observed ÷ lines
// surviving) for that day so all three tables are stretched by the same factor.
//
//   node scripts/audit/refill-cadence-key-reach.mjs [--days N]
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const DAYS = Number(opt("--days", 5));

// This file sits in scripts/audit/, so adminRequire's repo-relative base
// (../functions) misses; try THIS checkout's functions install first.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = (() => {
  try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; }
  catch { return adminRequire(import.meta.url); }
})();
const admin = req("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// SAST is UTC+2 year-round, no DST, so the shift is a constant.
const sa = (iso) => new Date(new Date(iso).getTime() + 2 * 3600e3);
const dayOf = (d) => d.toISOString().slice(0, 10);

const orders = (await db.ref("orders").once("value")).val() || {};
const live = [];
for (const [k, o] of Object.entries(orders)) {
  if (!o || typeof o !== "object" || !o.autoRefill) continue;
  const m = /^(R\d{3})-(\d+)$/.exec(k);
  if (!m) continue;                                   // not a store-leg refill line
  const t = sa(o.createdAt);
  live.push({ R: m[1], idx: Number(m[2]), day: dayOf(t), hour: t.getUTCHours(), dest: o.destShop });
}

// How many live orders sit inside the key set a draw table rewrites.
const reach = (draws) => {
  const keys = new Set();
  for (const { R, depth } of draws) for (let i = 1; i <= depth; i++) keys.add(`${R}-${i}`);
  return live.filter((o) => keys.has(`${o.R}-${o.idx}`)).length;
};
const rnum = (i) => "R" + String(i + 1).padStart(3, "0");

const days = [...new Set(live.map((o) => o.day))].sort().slice(-DAYS);
console.log(`live engine order lines: ${live.length}\n`);
console.log("day        | cadence      | draws | key reach | depths");
console.log("-".repeat(78));
for (const day of days) {
  const dayLines = live.filter((o) => o.day === day);
  if (!dayLines.length) continue;

  // ACTUAL: the draw table the live 15-minute cadence produced that day.
  const byR = new Map();
  for (const o of dayLines) byR.set(o.R, Math.max(byR.get(o.R) || 0, o.idx));
  const actual = [...byR.entries()].map(([R, depth]) => ({ R, depth }));
  const scale = actual.reduce((s, d) => s + d.depth, 0) / dayLines.length;

  // HOURLY: the same lines, one draw per (clock hour × destination).
  const buckets = new Map();
  for (const o of dayLines) {
    const k = `${o.hour}|${o.dest}`;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const hourly = [...buckets.keys()]
    .sort((a, b) => Number(a.split("|")[0]) - Number(b.split("|")[0]))
    .map((k, i) => ({ R: rnum(i), depth: Math.max(1, Math.round(buckets.get(k) * scale)) }));

  // ONCE A DAY (PR #616): one draw per destination, the whole day in one batch.
  const perDest = new Map();
  for (const o of dayLines) perDest.set(o.dest, (perDest.get(o.dest) || 0) + 1);
  const daily = [...perDest.values()].map((c, i) => ({ R: rnum(i), depth: Math.max(1, Math.round(c * scale)) }));

  for (const [name, table] of [["15-min (live)", actual], ["hourly", hourly], ["once-daily", daily]]) {
    console.log(`${day} | ${name.padEnd(12)} | ${String(table.length).padStart(5)} | ${String(reach(table)).padStart(9)} | [${table.map((d) => d.depth).join(",")}]`);
  }
  console.log("");
}
console.log("Reading the table: the cadence changes how the day's lines are GROUPED,");
console.log("not how many there are, so the key reach barely moves. What one run a day");
console.log("changes is not the reach — it is that the self-heal re-proposal comes round");
console.log("onto the same R-number a day later instead of a fresh one an hour later.");
process.exit(0);
