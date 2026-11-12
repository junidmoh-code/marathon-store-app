// ─── CONCRETE DIVISION — WHY NOTHING IS RAISED (Junid, 10 Nov 2026) ──────────
// WRITES NOTHING. Replays a snapshot from concrete-division-dump.mjs through the
// real computeRefillPlan (uncapped) exactly as refillHealthScan would plan it,
// then gives every product at Concrete, Pine and Hub 3 ONE reason it raises
// nothing (or "raised"). A product is examined when it has any stock cell at
// the location, or any sold/received/return movement there since the dump's
// `since`. Reasons come from the plan's own exception lists, never a re-derived
// guess, except the trust-gate label (an older engine records no reason there).
//   node scripts/audit/concrete-division-diagnose.mjs <snapshot.json> [--json out.json] [--lib <dir>]
// --lib replays another functions/lib (main's, from git archive) for a before/after.
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const LIB = argv.includes("--lib") ? argv[argv.indexOf("--lib") + 1] : join(ROOT, "functions/lib");
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const engine = require(join(LIB, "refill-engine.cjs"));
const reg = require(join(LIB, "network-registry.cjs"));
const dv = require(join(LIB, "concrete-division.cjs"));
const trust = require(join(LIB, "stock-trust.cjs"));
// Does this engine let a seat arm a shop cell past the trust mask?
const seatLift = typeof dv.isSeatedAtShop === "function";

const LOCS_ALL = ["concrete", "marathon-pine", "hub3"];
const d = JSON.parse(readFileSync(argv[0], "utf8"));
const network = reg.normalizeNetwork(d.network);
const nowMs = Date.parse(d.readAt);
const movements = Object.values(d.movements || {});
const config = { ...d.config, maxIntentsPerRun: 100000, maxFootwearIntentsPerRun: 100000 };
const seatPlan = dv.planSeats({ rawStock: d.stock, seats: d.seats || {}, movements, releases: d.seatReleases || {}, nowIso: d.readAt });
const seatAdds = Object.fromEntries(LOCS_ALL.map((l) => [l, Object.keys(seatPlan.writes).filter((k) => k.startsWith(`${l}/`) && seatPlan.writes[k]).length]));
const plan = engine.computeRefillPlan({
  nowMs, config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open,
  refillRequests: d.recentRequests, orders: d.orders || {}, movements, heldLines: d.held || {},
  rejectStreak: d.rejectStreak || {}, retryState: d.retryState || {}, locations: d.locations, network,
  seats: seatPlan.effective, uncapped: true,
});
const division = dv.divisionContext({ config: d.config, rawStock: d.stock, seats: seatPlan.effective, openIndex: d.open, heldLines: d.held, refillRequests: d.recentRequests });
const LOCS = ["concrete", "marathon-pine", "hub3"];
const intentsBy = new Map();
for (const i of plan.intents) intentsBy.set(`${i.dest}|${i.productId}`, [...(intentsBy.get(`${i.dest}|${i.productId}`) || []), i]);
const ex = Object.fromEntries(Object.entries(plan.exceptions).map(([k, v]) => [k, (v && v.items) || []]));
const belowBy = new Map();
for (const r of ex.belowTarget) belowBy.set(`${r.loc}|${r.pid}`, [...(belowBy.get(`${r.loc}|${r.pid}`) || []), r]);
const openBy = new Set();
for (const [loc, byPid] of Object.entries(d.open || {})) for (const pid of Object.keys(byPid || {})) openBy.add(`${loc}|${pid}`);
const sumAt = (loc, pid) => Object.values(d.stock?.[loc]?.[pid] || {}).reduce((t, c) => t + (c && typeof c === "object" ? Math.max(0, Number(c.qty) || 0) : 0), 0);
const maskedView = engine.maskUntrustedStock(d.stock, network).stock;

function examined(loc) {
  const set = new Set(Object.keys(d.stock?.[loc] || {}).filter((p) => p !== "_meta"));
  for (const m of movements) {
    if (!m || !m.productId) continue;
    if ((m.type === "sold" && m.from === loc) || (m.type === "received" && m.to === loc) || (m.type === "return" && m.to === loc)) set.add(m.productId);
  }
  return [...set];
}

function reasonFor(loc, pid) {
  const p = d.products?.[pid];
  if (!p) return "other: product record gone";
  if (p.deactivated) return "other: deactivated";
  const raised = intentsBy.get(`${loc}|${pid}`);
  if (raised?.length) return "raised";
  const footwear = dv.isDivisionFootwear(p);
  if (loc !== "hub3" && footwear) return "footwear: kept at Hub 3, never the shop (correct)";
  if (!seatPlan.effective?.[loc]?.[pid]) return "not seated";
  const rows = d.targets?.[loc]?.[pid];
  if (rows && Object.values(rows).length && Object.values(rows).every((r) => r && Number(r.target) <= 0)) return "switched off in Seating (target 0 rows — correct)";
  if (loc === "hub3" && !footwear) return "Hub 3 holds footwear only (correct, Junid 12 Nov 2026)";
  const below = belowBy.get(`${loc}|${pid}`) || [];
  if (below.length) {
    const mine = (list) => list.filter((r) => r.loc === loc && r.pid === pid);
    const sup = [...mine(ex.awaitingSupplier), ...mine(ex.awaitingUpstream)];
    if (loc !== "hub3" && sup.some((r) => r.source === "hub3")) return "routed to Hub 3 by the exists-at-Hub-3 rule, Hub 3 cannot supply";
    if (mine(ex.missingSizes).length || sup.length) return "Central has none (source gate, correct)";
    if (mine(ex.waitingForStock).length) return "parked: refused recently, cooldown";
    if (mine(ex.recountNeeded).length) return "parked: recount needed";
    if (below.every((b) => b.inbound > 0) || openBy.has(`${loc}|${pid}`)) return "already requested (open request in flight)";
    return "other: below keep, no request and no reason recorded";
  }
  const cells = d.stock?.[loc]?.[pid] || {};
  const trustedAny = Object.values(cells).some((c) => trust.cellTrusted(c));
  if (!seatLift && loc !== "hub3" && !trustedAny) return "seated, but trust gate excluded it (no counted cell)";
  if (openBy.has(`${loc}|${pid}`)) return "already requested (open request in flight)";
  if (!footwear) {
    const t = dv.divisionSizes(p).map((s) => dv.divisionTarget(division, loc, pid, s, d.products, maskedView));
    if (t.every((x) => !x)) return "seated but no keep resolves (no division target)";
  }
  return "at or above keep (correct)";
}

const report = {};
const examples = {};
for (const loc of LOCS) {
  const tally = {};
  for (const pid of examined(loc)) {
    const reason = reasonFor(loc, pid);
    tally[reason] = (tally[reason] || 0) + 1;
    const eg = ((examples[loc] ||= {})[reason] ||= []);
    if (eg.length < 4) eg.push(`${pid} ${String(d.products?.[pid]?.name || "").slice(0, 40)} (${sumAt(loc, pid)}u)`);
  }
  report[loc] = Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]));
}
const lines = (loc) => plan.intents.filter((i) => i.dest === loc);
const summary = {
  seats: Object.fromEntries(LOCS.map((l) => [l, Object.keys(seatPlan.effective[l] || {}).length])), newSeats: seatPlan.seated, seatAdds,
  report,
  intents: Object.fromEntries(LOCS.map((l) => [l, { lines: lines(l).length, units: lines(l).reduce((t, i) => t + i.qty, 0), bySource: lines(l).reduce((o, i) => ({ ...o, [i.source]: (o[i.source] || 0) + 1 }), {}) }])),
};
console.log(JSON.stringify(summary, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...summary, examples }, null, 2));
