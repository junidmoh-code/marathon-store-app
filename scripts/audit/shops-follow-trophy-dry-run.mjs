// ─── POLICIES ARE UNIVERSAL — FIRST-SCAN DRY RUN (Junid, 24 Nov 2026) — WRITES NOTHING ──
// Replays a concrete-division-dump snapshot through the scan's own planner:
//   BEFORE  main's engine (--old <dir holding main's functions/lib>) on the live config;
//   AFTER   this branch's engine on the live config plus policyFollow.concrete = "trophy"
//           (Trophy first, Marathon PE where Trophy has no policy — for Pine too).
// Reports, per shop: categories whose numbers change, products that gain a
// policy, products newly offered, and the requests the next scan would raise;
// and proves the hubs, Marathon PE and Trophy did not move.
//   node scripts/audit/concrete-division-dump.mjs <snapshot.json>
//   node scripts/audit/shops-follow-trophy-dry-run.mjs <snapshot.json> --old <dir>
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const OLD = argv.includes("--old") ? argv[argv.indexOf("--old") + 1] : null;
if (!argv[0] || !OLD) { console.error("usage: shops-follow-trophy-dry-run.mjs <snapshot.json> --old <dir>"); process.exit(2); }
const load = (root) => ({ engine: require(join(root, "functions/lib/refill-engine.cjs")), reg: require(join(root, "functions/lib/network-registry.cjs")), dv: require(join(root, "functions/lib/concrete-division.cjs")) });
const NEW = load(ROOT), OLDL = load(OLD);
const d = JSON.parse(readFileSync(argv[0], "utf8"));
const movements = Object.values(d.movements || {});
const SHOPS = ["marathon-pine", "concrete"];
const OTHERS = ["hub1", "hub2", "hub3", "marathon-pe", "trophy"];
const clone = (v) => JSON.parse(JSON.stringify(v));
const linked = { ...clone(d.config), policyFollow: { ...(d.config.policyFollow || {}), concrete: "trophy" } };

const run = (L, config, { uncap = false } = {}) => {
  const cfg = clone(config);
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
  return { requests: xs.length, units: xs.reduce((t, i) => t + i.qty, 0), products: new Set(xs.map((i) => i.productId)).size };
};
const byCat = (list, loc) => list.filter((i) => i.dest === loc).reduce((o, i) => { const k = d.products[i.productId]?.categoryKey || "?"; o[k] = (o[k] || 0) + i.qty; return o; }, {});

const before = run(OLDL, d.config), after = run(NEW, linked);
const num = (t) => (t && t.target > 0 ? `${t.target}/${t.minQty ?? "-"}/${t.reorderPoint ?? "-"}` : null);
const policy = {};
for (const shop of SHOPS) {
  const ctx = (L, config, plan) => {
    const { stock: masked } = L.engine.maskUntrustedStock(d.stock, plan.network);
    return { targets: d.targets, config, products: d.products, stock: masked, network: plan.network, division: { policy: L.dv.concreteDivisionPolicy(config), seats: plan.seats, owners: d.config.divisionOwner } };
  };
  const cb = ctx(OLDL, d.config, before), ca = ctx(NEW, linked, after);
  let gain = 0, change = 0, same = 0, lose = 0, cellsChanged = 0;
  const cats = {}, examples = [];
  for (const pid of Object.keys(after.seats[shop] || {})) {
    const p = d.products[pid];
    if (!p || NEW.dv.isDivisionFootwear(p)) continue;
    let hadAny = false, hasAny = false, differs = false;
    for (const s of NEW.dv.divisionSizes(p)) {
      const size = s === "_" ? "" : s;
      const b = OLDL.engine.resolveTarget(cb, shop, pid, size);
      const a = NEW.engine.resolveTarget(ca, shop, pid, size);
      if (num(b)) hadAny = true;
      if (num(a)) hasAny = true;
      if (num(a) !== num(b)) {
        differs = true; cellsChanged++;
        const k = p.categoryKey || "?";
        const c = (cats[k] ||= { cells: 0, transitions: {} });
        c.cells++;
        const tr = `${num(b) || "none"} → ${num(a) || "none"}${a?.follows ? ` (${a.follows})` : ""}`;
        c.transitions[tr] = (c.transitions[tr] || 0) + 1;
        if (examples.length < 6) examples.push({ pid, name: p.name, size: s, before: num(b), after: num(a), from: a?.follows || null });
      }
    }
    if (!hadAny && hasAny) gain++; else if (hadAny && !hasAny) lose++; else if (differs) change++; else same++;
  }
  policy[shop] = { seated: Object.keys(after.seats[shop] || {}).length, gainAPolicy: gain, numbersChange: change, losePolicy: lose, unchanged: same, cellsChanged, byCategory: cats, examples };
}
const bU = run(OLDL, d.config, { uncap: true }), aU = run(NEW, linked, { uncap: true });
const out = {
  snapshot: d.readAt,
  pausedLocations: Object.keys(d.config.pausedLocations || {}),
  policy,
  nextScan: Object.fromEntries(SHOPS.map((s) => [s, {
    asLive: { before: tally(before.plan.intents, s), after: tally(after.plan.intents, s) },
    noCaps: { before: tally(bU.plan.intents, s), after: tally(aU.plan.intents, s), unitsByCategoryBefore: byCat(bU.plan.intents, s), unitsByCategoryAfter: byCat(aU.plan.intents, s) },
    openRequests: Object.fromEntries(["closes", "resizes", "satisfiedClosures"].map((k) => [k, { before: (before.plan[k] || []).filter((x) => x.dest === s).length, after: (after.plan[k] || []).filter((x) => x.dest === s).length }])),
  }])),
  checks: {
    requestsForProductsNotSeated: Object.fromEntries(SHOPS.map((s) => [s, aU.plan.intents.filter((i) => i.dest === s && !(aU.seats[s] || {})[i.productId]).length])),
    concretePerfumeRequests: aU.plan.intents.filter((i) => i.dest === "concrete" && d.products[i.productId]?.categoryKey === "perfumes").length,
    shopNonFootwearNotFromCentral: aU.plan.intents.filter((i) => SHOPS.includes(i.dest) && !NEW.dv.isDivisionFootwear(d.products[i.productId]) && i.source !== "central").length,
    otherLocationsIdentical: Object.fromEntries(OTHERS.map((l) => [l, sliceOf(before.plan, [l]) === sliceOf(after.plan, [l])])),
    keyOffEqualsMain: (() => {
      const off = clone(d.config); // Pine link alone, no Concrete: only the Trophy→PE fallback differs from main
      return JSON.stringify(run(NEW, off).plan.intents.filter((x) => x.dest !== "marathon-pine").map((x) => JSON.stringify(x)).sort()) === JSON.stringify(before.plan.intents.filter((x) => x.dest !== "marathon-pine").map((x) => JSON.stringify(x)).sort());
    })(),
  },
};
console.log(JSON.stringify(out, null, 2));
