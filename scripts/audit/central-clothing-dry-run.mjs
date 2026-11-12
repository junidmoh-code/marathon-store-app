// ─── 12 NOV MODEL — FIRST-SCAN DRY RUN (Junid, 12 Nov 2026) — WRITES NOTHING ──
// Replays a concrete-division-dump snapshot twice:
//   BEFORE  main's engine (--old <dir>), the live config, the live stock;
//   AFTER   this branch's engine, the new config (apply-central-clothing-policy's
//           plan), and the stock as the Hub 3 → Concrete transfer leaves it
//           (simulated in memory with the transfer's own plan).
// Proves the Marathon slice did not move, and reports the first scan's
// Concrete / Pine / Hub 3 lines under the live caps (and uncapped).
//   node scripts/audit/central-clothing-dry-run.mjs <snapshot.json> --old <dir holding functions/lib> [--hold-hub3-leg]
// --hold-hub3-leg: the Hub 3 sneaker leg stays at its live value (the division
// key and the transfer only) — the state shipped while Junid decides the leg.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { planHub3ClothingTransfer } from "../lib/hub3ClothingTransfer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const OLD = argv[argv.indexOf("--old") + 1];
if (!argv[0] || !OLD) { console.error("usage: central-clothing-dry-run.mjs <snapshot.json> --old <dir>"); process.exit(2); }
const load = (root) => ({ engine: require(join(root, "functions/lib/refill-engine.cjs")), reg: require(join(root, "functions/lib/network-registry.cjs")), dv: require(join(root, "functions/lib/concrete-division.cjs")) });
const NEW = load(ROOT), OLDL = load(OLD);
const { planCentralClothingPolicy } = require(join(ROOT, "scripts/lib/centralClothingPolicy.cjs"));
const d = JSON.parse(readFileSync(argv[0], "utf8"));
const movements = Object.values(d.movements || {});
const MARATHON = ["hub1", "hub2", "marathon-pe", "trophy"];
const S1 = ["concrete", "marathon-pine", "hub3"];
const clone = (v) => JSON.parse(JSON.stringify(v));

// The new config.
const pol = planCentralClothingPolicy({ liveGroup: d.config.policyGroups["footwear-all"], liveDivision: d.config.concreteDivision });
const newConfig = clone(d.config);
const HOLD_LEG = argv.includes("--hold-hub3-leg");
if (!HOLD_LEG) newConfig.policyGroups["footwear-all"] = pol.group;
newConfig.concreteDivision = pol.division;

// The stock and seats after the transfer.
const tp = planHub3ClothingTransfer({ hub3Stock: d.stock.hub3, products: d.products, seats: d.seats, requests: d.recentRequests, locks: d.open, runId: "dry" });
const stockAfter = clone(d.stock);
for (const t of tp.transfers) {
  const row = (stockAfter.concrete[t.pid] ||= {});
  const cur = row[t.sizeKey] || { qty: 0, v: 0, mv: "seed", lastType: "transfer_in" };
  row[t.sizeKey] = { ...cur, qty: Math.max(cur.qty || 0, 0) + t.qty, lastType: "transfer_in" };
}
for (const pid of Object.keys(stockAfter.hub3)) if (!NEW.dv.isDivisionFootwear(d.products[pid])) delete stockAfter.hub3[pid];
const seatsAfter = clone(d.seats);
for (const pid of tp.seatOn) seatsAfter.concrete[pid] ||= { via: "hub3_transfer", at: d.readAt };
for (const pid of tp.seatsOff) delete seatsAfter.hub3[pid];

const run = (L, config, stock, seats, uncap = false) => {
  const cfg = uncap ? { ...config, maxIntentsPerRun: 1e6, maxFootwearIntentsPerRun: 1e6, maxDivisionIntentsPerRun: 1e6 } : config;
  const seatPlan = L.dv.planSeats({ rawStock: stock, seats, movements, releases: d.seatReleases || {}, nowIso: d.readAt, products: d.products });
  return L.engine.computeRefillPlan({ nowMs: Date.parse(d.readAt), config: cfg, targets: d.targets, stock, products: d.products, openIndex: d.open,
    refillRequests: d.recentRequests, orders: d.orders || {}, movements, heldLines: d.held || {}, rejectStreak: d.rejectStreak || {}, retryState: d.retryState || {},
    locations: d.locations, network: L.reg.normalizeNetwork(d.network), seats: seatPlan.effective });
};
const slice = (p) => ({
  i: p.intents.filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
  c: (p.closes || []).filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
  r: (p.resizes || []).filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
  s: (p.satisfiedClosures || []).filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
});
const tally = (list) => Object.fromEntries(S1.map((l) => {
  const xs = list.filter((i) => i.dest === l);
  return [l, { lines: xs.length, units: xs.reduce((t, i) => t + i.qty, 0), products: new Set(xs.map((i) => i.productId)).size, bySource: xs.reduce((o, i) => ({ ...o, [i.source]: (o[i.source] || 0) + 1 }), {}) }];
}));

const before = run(OLDL, d.config, d.stock, d.seats);
const after = run(NEW, newConfig, stockAfter, seatsAfter);
const afterUncapped = run(NEW, newConfig, stockAfter, seatsAfter, true);
const sameMarathon = JSON.stringify(slice(before)) === JSON.stringify(slice(after));
const dp = after.exceptions?.divisionPolicy;
const out = {
  snapshot: d.readAt,
  hub3Leg: newConfig.policyGroups["footwear-all"].policy.hub3,
  pausedLocations: d.config.pausedLocations || null,
  marathonUnchanged: sameMarathon,
  marathonCounts: { before: slice(before).i.length, after: slice(after).i.length },
  before: tally(before.intents),
  after: tally(after.intents),
  afterUncapped: tally(afterUncapped.intents),
  divisionIntentsComputed: after.counts?.divisionIntentsComputed ?? after.divisionIntentsComputed ?? null,
  hub3NonFootwearIntents: after.intents.filter((i) => i.dest === "hub3" && !NEW.dv.isDivisionFootwear(d.products[i.productId])).length,
  shopFromHub3Intents: after.intents.filter((i) => ["concrete", "marathon-pine"].includes(i.dest) && i.source === "hub3").length,
  closesS1: (after.closes || []).filter((c) => S1.includes(c.dest)).length,
  divisionPolicyAudit: dp ? { count: dp.count, byReason: dp.byReason, perLoc: dp.perLoc } : null,
  errors: after.errors,
};
if (!sameMarathon) {
  const a = slice(before), b = slice(after);
  for (const k of ["i", "c", "r", "s"]) {
    const A = new Set(a[k]), B = new Set(b[k]);
    out[`marathonDiff_${k}`] = { onlyBefore: [...A].filter((x) => !B.has(x)).slice(0, 10), onlyAfter: [...B].filter((x) => !A.has(x)).slice(0, 10) };
  }
}
console.log(JSON.stringify(out, null, 2));
