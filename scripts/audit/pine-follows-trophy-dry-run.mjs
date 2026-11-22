// ─── PINE FOLLOWS TROPHY — FIRST-SCAN DRY RUN (Junid, 22 Nov 2026) — WRITES NOTHING ──
// Replays a concrete-division-dump snapshot through the scan's own planner:
//   BEFORE  the live config as it is;
//   AFTER   the same config with policyFollow = { "marathon-pine": "trophy" }.
// Reports how many Pine products gain a policy, how many change, the requests
// the next scan would raise for Pine (as the live pause leaves it, and with
// the pause lifted), and proves every other location's plan did not move.
//   node scripts/audit/concrete-division-dump.mjs <snapshot.json>
//   node scripts/audit/pine-follows-trophy-dry-run.mjs <snapshot.json> [--old <dir holding main's functions/lib>]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
if (!argv[0]) { console.error("usage: pine-follows-trophy-dry-run.mjs <snapshot.json> [--old <dir>]"); process.exit(2); }
const OLD = argv.includes("--old") ? argv[argv.indexOf("--old") + 1] : null;
const load = (root) => ({ engine: require(join(root, "functions/lib/refill-engine.cjs")), reg: require(join(root, "functions/lib/network-registry.cjs")), dv: require(join(root, "functions/lib/concrete-division.cjs")) });
const NEW = load(ROOT);
const OLDL = OLD ? load(OLD) : null;
const d = JSON.parse(readFileSync(argv[0], "utf8"));
const movements = Object.values(d.movements || {});
const PINE = "marathon-pine", LEADER = "trophy";
const OTHERS = ["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete"];
const clone = (v) => JSON.parse(JSON.stringify(v));

const linked = { ...clone(d.config), policyFollow: { [PINE]: LEADER } };
const run = (L, config, { uncap = false, unpause = false } = {}) => {
  const cfg = clone(config);
  if (unpause) delete cfg.pausedLocations;
  if (uncap) Object.assign(cfg, { maxIntentsPerRun: 1e6, maxFootwearIntentsPerRun: 1e6, maxDivisionIntentsPerRun: 1e6 });
  const network = L.reg.normalizeNetwork(d.network);
  const seatPlan = L.dv.planSeats({ rawStock: d.stock, seats: d.seats, movements, releases: d.seatReleases || {}, nowIso: d.readAt, products: d.products });
  const plan = L.engine.computeRefillPlan({ nowMs: Date.parse(d.readAt), config: cfg, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open,
    refillRequests: d.recentRequests, orders: d.orders || {}, movements, heldLines: d.held || {}, rejectStreak: d.rejectStreak || {}, retryState: d.retryState || {},
    locations: d.locations, network, seats: seatPlan.effective });
  return { plan, seats: seatPlan.effective, network };
};
const sliceOf = (p, locs) => JSON.stringify(["intents", "closes", "resizes", "satisfiedClosures"].map((k) => (p[k] || []).filter((x) => locs.includes(x.dest)).map((x) => JSON.stringify(x)).sort()));
const tally = (list, loc) => {
  const xs = list.filter((i) => i.dest === loc);
  return { requests: xs.length, units: xs.reduce((t, i) => t + i.qty, 0), products: new Set(xs.map((i) => i.productId)).size,
    bySource: xs.reduce((o, i) => ({ ...o, [i.source]: (o[i.source] || 0) + 1 }), {}) };
};

// ── THE POLICY, CELL BY CELL: every product seated at Pine, every size ──────
const before = run(NEW, d.config), after = run(NEW, linked);
const { stock: masked } = NEW.engine.maskUntrustedStock(d.stock, before.network);
const division = { policy: NEW.dv.concreteDivisionPolicy(d.config), seats: before.seats };
const ctxOf = (config) => ({ targets: d.targets, config, products: d.products, stock: masked, network: before.network, division });
const num = (t) => (t && t.target > 0 ? `${t.target}/${t.minQty ?? "-"}/${t.reorderPoint ?? "-"}` : null);
let gain = 0, change = 0, same = 0, lose = 0, switchedOff = 0, cellsChanged = 0, footwear = 0, notInCatalogue = 0;
const byCategory = {}, bySource = {}, examples = [];
for (const pid of Object.keys(before.seats[PINE] || {})) {
  const p = d.products[pid];
  if (!p) { notInCatalogue++; continue; }
  if (NEW.dv.isDivisionFootwear(p)) { footwear++; continue; }
  let hadAny = false, hasAny = false, differs = false, off = false;
  for (const s of NEW.dv.divisionSizes(p)) {
    const size = s === "_" ? "" : s;
    const row = d.targets[PINE]?.[pid]?.[NEW.engine.encodeSizeKey(size)];
    if (row && typeof row.target === "number" && row.target <= 0) off = true;
    const b = NEW.engine.resolveTarget(ctxOf(d.config), PINE, pid, size);
    const a = NEW.engine.resolveTarget(ctxOf(linked), PINE, pid, size);
    if (num(b)) hadAny = true;
    if (num(a)) hasAny = true;
    if (num(a) !== num(b)) {
      differs = true; cellsChanged++;
      if (a && a.source === "follows") bySource[a.followedSource] = (bySource[a.followedSource] || 0) + 1;
      if (examples.length < 12) examples.push({ pid, name: p.name, category: p.categoryKey || p.category, size: s, before: num(b), after: num(a), from: a?.followedSource || null });
    }
  }
  if (off) switchedOff++;
  const key = p.categoryKey || `(${p.category || "?"})`;
  const c = (byCategory[key] ||= { products: 0, gain: 0, change: 0, same: 0 });
  c.products++;
  if (!hadAny && hasAny) { gain++; c.gain++; } else if (hadAny && !hasAny) lose++; else if (differs) { change++; c.change++; } else { same++; c.same++; }
}

// ── THE NEXT SCAN ────────────────────────────────────────────────────────────
const bU = run(NEW, d.config, { unpause: true }), aU = run(NEW, linked, { unpause: true });
const bUU = run(NEW, d.config, { unpause: true, uncap: true }), aUU = run(NEW, linked, { unpause: true, uncap: true });
const paused = Object.keys(d.config.pausedLocations || {}).filter((l) => d.config.pausedLocations[l] === true);
const pineIntents = aUU.plan.intents.filter((i) => i.dest === PINE);
const seatedPine = new Set(Object.keys(aUU.seats[PINE] || {}));
const out = {
  snapshot: d.readAt,
  pausedLocations: paused,
  policy: { seatedAtPine: seatedPine.size, footwearLeftAlone: footwear, notInCatalogue, nonFootwear: gain + change + same + lose,
    gainAPolicy: gain, numbersChange: change, unchanged: same, losePolicy: lose, productsWithAPineSwitchOffRow: switchedOff, cellsChanged, changedCellsByTrophySource: bySource },
  byCategory: Object.fromEntries(Object.entries(byCategory).filter(([, v]) => v.gain || v.change).sort((x, y) => (y[1].gain + y[1].change) - (x[1].gain + x[1].change))),
  examples,
  nextScanForPine: {
    asLive: paused.includes(PINE) ? "0 — Pine is paused for its count (config/refillEngine/pausedLocations); the scan writes nothing for it" : { before: tally(before.plan.intents, PINE), after: tally(after.plan.intents, PINE) },
    pauseLifted: { before: tally(bU.plan.intents, PINE), after: tally(aU.plan.intents, PINE) },
    pauseLiftedNoCaps: { before: tally(bUU.plan.intents, PINE), after: tally(aUU.plan.intents, PINE) },
  },
  // Pine's requests already open, as the plan would re-size or close them
  // (held, like every write for Pine, while Pine is paused).
  pineOpenRequests: Object.fromEntries(["closes", "resizes", "satisfiedClosures"].map((k) => [k, {
    before: (before.plan[k] || []).filter((x) => x.dest === PINE).length, after: (after.plan[k] || []).filter((x) => x.dest === PINE).length }])),
  computedForAllLocations: { before: before.plan.policy?.intentsComputed ?? null, after: after.plan.policy?.intentsComputed ?? null, cap: before.plan.policy?.maxIntentsPerRun ?? null },
  hub2Requests: (() => {
    const key = (x) => `${x.productId}|${x.sizeKey}|${x.qty}`;
    const B = new Set(before.plan.intents.filter((x) => x.dest === "hub2").map(key)), A = new Set(after.plan.intents.filter((x) => x.dest === "hub2").map(key));
    return { before: B.size, after: A.size, onlyBefore: [...B].filter((x) => !A.has(x)), onlyAfter: [...A].filter((x) => !B.has(x)) };
  })(),
  checks: {
    pineRequestsForProductsNotSeated: pineIntents.filter((i) => !seatedPine.has(i.productId)).length,
    pineRequestsFromHub1OrHub2: pineIntents.filter((i) => i.source === "hub1" || i.source === "hub2").length,
    pineNonFootwearNotFromCentral: pineIntents.filter((i) => !NEW.dv.isDivisionFootwear(d.products[i.productId]) && i.source !== "central").length,
    pineFootwearNotFromHub3: pineIntents.filter((i) => NEW.dv.isDivisionFootwear(d.products[i.productId]) && i.source !== "hub3").length,
    // With the pause as it is live, the link moves nothing anywhere else.
    everyOtherLocationIdentical: Object.fromEntries(OTHERS.map((l) => [l, sliceOf(before.plan, [l]) === sliceOf(after.plan, [l])])),
    // With Pine's pause lifted Pine draws on Central, which the others share:
    // a different Pine keep can change who gets a scarce Central unit.
    everyOtherLocationIdenticalPauseLifted: Object.fromEntries(OTHERS.map((l) => [l, sliceOf(bU.plan, [l]) === sliceOf(aU.plan, [l])])),
    ...(OLDL ? { keyOffEqualsMainEngine: JSON.stringify(run(OLDL, d.config, { unpause: true }).plan.intents.map((x) => JSON.stringify(x)).sort()) === JSON.stringify(bU.plan.intents.map((x) => JSON.stringify(x)).sort()) } : {}),
  },
};
console.log(JSON.stringify(out, null, 2));
