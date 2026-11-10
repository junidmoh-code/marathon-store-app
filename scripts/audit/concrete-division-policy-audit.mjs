// ─── CONCRETE DIVISION POLICY AUDIT — offline replay (Junid, 10 Nov 2026) ────
// WRITES NOTHING. Replays a snapshot from concrete-division-dump.mjs through the
// real computeRefillPlan and prints exceptions.divisionPolicy — the same audit
// the hourly scan writes for the Health card "Concrete Division Policy".
//   node scripts/audit/concrete-division-policy-audit.mjs <snapshot.json> [repo root]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ROOT = process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const reg = require(join(ROOT, "functions/lib/network-registry.cjs"));
const dv = require(join(ROOT, "functions/lib/concrete-division.cjs"));
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const movements = Object.values(d.movements || {});
const seatPlan = dv.planSeats({ rawStock: d.stock, seats: d.seats || {}, movements, releases: d.seatReleases || {}, nowIso: d.readAt });
const plan = engine.computeRefillPlan({
  nowMs: Date.parse(d.readAt), config: d.config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open,
  refillRequests: d.recentRequests, orders: d.orders || {}, movements, heldLines: d.held || {}, rejectStreak: d.rejectStreak || {},
  retryState: d.retryState || {}, locations: d.locations, network: reg.normalizeNetwork(d.network), seats: seatPlan.effective, uncapped: true,
});
const a = plan.exceptions.divisionPolicy;
if (!a) { console.log("division key off — no audit"); process.exit(0); }
console.log(JSON.stringify({ mismatchedCells: a.count, byReason: a.byReason, perLoc: a.perLoc }, null, 1));
const eg = {};
for (const m of a.items) {
  const k = `${m.loc}:${m.reason}`;
  (eg[k] ||= []);
  if (eg[k].length < 3) eg[k].push(`${m.pid} ${String(d.products[m.pid]?.name || "").slice(0, 30)} ${m.size || "one size"} policy=${JSON.stringify(m.expected)} armed=${JSON.stringify(m.effective)}`);
}
console.log(eg);
