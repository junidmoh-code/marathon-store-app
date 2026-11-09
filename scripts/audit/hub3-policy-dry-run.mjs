// ─── HUB 3 POLICY — NEXT-SCAN DRY RUN (Junid, 9 Nov 2026) ────────────────────
// WRITES NOTHING. Replays a snapshot from hub3-policy-dump.mjs through the real
// computeRefillPlan twice: today's config, and today's config plus the proposed
// Hub 3 leg and division key. Reports Section 1 lines/units and proves the
// Marathon slice did not move.
//   node scripts/audit/hub3-policy-dry-run.mjs <snapshot.json> [--old <dir of an older functions/lib>]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const oldAt = argv.includes("--old") ? argv[argv.indexOf("--old") + 1] : null;
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const reg = require(join(ROOT, "functions/lib/network-registry.cjs"));
const dv = require(join(ROOT, "functions/lib/concrete-division.cjs"));
const baseEngine = oldAt ? require(join(oldAt, "refill-engine.cjs")) : engine;

const d = JSON.parse(readFileSync(argv[0], "utf8"));
const network = reg.normalizeNetwork(d.network);
const nowMs = Date.parse(d.readAt);
const MARATHON = ["hub1", "hub2", "marathon-pe", "trophy"];
const S1 = ["hub3", "marathon-pine", "concrete"];
const proposed = JSON.parse(JSON.stringify(d.config));
proposed.concreteDivision = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } };
proposed.policyGroups["footwear-all"].policy.hub3 = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };

const seatPlan = dv.planSeats({ rawStock: d.stock, seats: {}, movements: [], nowIso: d.readAt });
const snap = (config, extra = {}) => ({ nowMs, config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open, refillRequests: d.recentRequests, orders: {}, movements: [], heldLines: {}, locations: d.locations, network, ...extra });
const before = baseEngine.computeRefillPlan(snap(d.config));
const after = engine.computeRefillPlan(snap(proposed, { seats: seatPlan.effective }));
const uncapped = engine.computeRefillPlan(snap({ ...proposed, maxFootwearIntentsPerRun: 100000, maxIntentsPerRun: 100000 }, { seats: seatPlan.effective }));

const slice = (p) => ({
  i: p.intents.filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
  c: (p.closes || []).filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
  r: (p.resizes || []).filter((x) => MARATHON.includes(x.dest)).map((x) => JSON.stringify(x)).sort(),
});
const a = slice(before), b = slice(after);
const same = JSON.stringify(a) === JSON.stringify(b);
console.log("Marathon slice identical:", same, `intents ${a.i.length}→${b.i.length} closes ${a.c.length}→${b.c.length} resizes ${a.r.length}→${b.r.length}`);
if (!same) {
  const onlyA = a.i.filter((x) => !b.i.includes(x)), onlyB = b.i.filter((x) => !a.i.includes(x));
  console.log("  only before:", onlyA.slice(0, 5), onlyA.length, "\n  only after:", onlyB.slice(0, 5), onlyB.length);
}
const tally = (list) => {
  const out = {};
  for (const i of list) { const k = `${i.dest}←${i.source}`; (out[k] ||= { lines: 0, units: 0, products: new Set() }); out[k].lines++; out[k].units += i.qty; out[k].products.add(i.productId); }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { lines: v.lines, units: v.units, products: v.products.size }]));
};
console.log("Seats:", Object.fromEntries(S1.map((l) => [l, Object.keys(seatPlan.effective[l]).length])), "new", seatPlan.seated);
console.log("Section 1 this scan (capped):", tally(after.intents.filter((i) => S1.includes(i.dest))));
console.log("Section 1 total backlog (uncapped):", tally(uncapped.intents.filter((i) => S1.includes(i.dest))));
console.log("Section 1 before (today):", tally(before.intents.filter((i) => S1.includes(i.dest))));
const fw = uncapped.intents.filter((i) => i.dest === "hub3");
console.log("Hub 3 lines uncapped:", fw.length, "seated-only check:", fw.every((i) => seatPlan.effective.hub3[i.productId]), "footwear-only:", fw.every((i) => dv.isDivisionFootwear(d.products[i.productId])));
const keys = {}; for (const i of fw) { const k = d.products[i.productId]?.categoryKey || "?"; keys[k] = (keys[k] || 0) + 1; } console.log("Hub 3 by category:", keys);
const s1closes = (after.closes || []).filter((c) => S1.includes(c.dest)); const why = {}; for (const c of s1closes) why[`${c.dest}:${c.reason}`] = (why[`${c.dest}:${c.reason}`] || 0) + 1; console.log("Section 1 closes:", why);
console.log("Errors:", after.errors.slice(0, 5), after.errors.length);
