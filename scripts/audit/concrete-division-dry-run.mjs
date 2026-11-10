// ─── CONCRETE DIVISION — NEXT-SCAN DRY RUN (Junid, 10 Nov 2026) ──────────────
// WRITES NOTHING. Replays a snapshot from concrete-division-dump.mjs through
// main's engine (--old <dir holding functions/lib>) and this branch's, each with
// its own seat pass, under the LIVE caps. Proves the Marathon slice did not move
// and reports what the first scan raises for Concrete, Pine and Hub 3, plus the
// uncapped backlog.
//   node scripts/audit/concrete-division-dry-run.mjs <snapshot.json> --old <dir>
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const OLD = argv[argv.indexOf("--old") + 1];
const load = (root) => ({ engine: require(join(root, "functions/lib/refill-engine.cjs")), reg: require(join(root, "functions/lib/network-registry.cjs")), dv: require(join(root, "functions/lib/concrete-division.cjs")) });
const NEW = load(ROOT), OLDL = load(OLD);
const d = JSON.parse(readFileSync(argv[0], "utf8"));
const movements = Object.values(d.movements || {});
const MARATHON = ["hub1", "hub2", "marathon-pe", "trophy"];
const S1 = ["concrete", "marathon-pine", "hub3"];
const run = (L, config) => {
  const seatPlan = L.dv.planSeats({ rawStock: d.stock, seats: d.seats || {}, movements, releases: d.seatReleases || {}, nowIso: d.readAt });
  return L.engine.computeRefillPlan({ nowMs: Date.parse(d.readAt), config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open,
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
const before = run(OLDL, d.config), after = run(NEW, d.config);
const a = slice(before), b = slice(after);
console.log("Live caps:", { maxIntentsPerRun: d.config.maxIntentsPerRun, maxFootwearIntentsPerRun: d.config.maxFootwearIntentsPerRun });
console.log("Marathon slice identical (intents, closes, resizes, satisfied):", JSON.stringify(a) === JSON.stringify(b), `intents ${a.i.length}→${b.i.length}`);
const uncap = { ...d.config, maxIntentsPerRun: 100000, maxFootwearIntentsPerRun: 100000 };
const ua = slice(run(OLDL, uncap)), ub = slice(run(NEW, uncap));
console.log("Marathon slice identical UNCAPPED:", JSON.stringify(ua) === JSON.stringify(ub), `intents ${ua.i.length}→${ub.i.length}`);
console.log("First scan, main's engine:", JSON.stringify(tally(before.intents)));
console.log("First scan, this branch :", JSON.stringify(tally(after.intents)));
console.log("Backlog uncapped, branch:", JSON.stringify(tally(run(NEW, uncap).intents)));
console.log("Section 1 closes (branch):", (after.closes || []).filter((c) => S1.includes(c.dest)).length, "satisfied:", (after.satisfiedClosures || []).filter((c) => S1.includes(c.dest)).length);
console.log("Errors (branch):", after.errors.slice(0, 5));
