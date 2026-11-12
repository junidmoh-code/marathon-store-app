// ─── CONCRETE / PINE — ELIGIBLE POPULATION, RELEASE, CATEGORIES, EFFECTIVE POLICY
// WRITES NOTHING (Junid, 10 Nov 2026). Replays a snapshot from
// concrete-division-dump.mjs through the real engine under the LIVE config and:
//   1. the eligible population: Concrete/Pine sizes below keep where Central
//      holds stock — and what happens to each (raised now / already on its way /
//      parked, why);
//   2. lines the next scan raises and releases per destination (live caps);
//   3. the categories Concrete is requesting (open now + this scan), line counts;
//   4. the live EFFECTIVE policy at Concrete by category and path (shop-only vs
//      Hub 3-owned): keep per size, keep for no-size items, ask-at, source,
//      product count — flagged against Junid's policy.
//   node scripts/audit/concrete-division-release.mjs <snapshot.json>
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const reg = require(join(ROOT, "functions/lib/network-registry.cjs"));
const dv = require(join(ROOT, "functions/lib/concrete-division.cjs"));
const { withPolicyTemplates } = require(join(ROOT, "functions/lib/policy-template.cjs"));

const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const network = reg.normalizeNetwork(d.network);
const nowMs = Date.parse(d.readAt);
const movements = Object.values(d.movements || {});
const SHOPS = ["concrete", "marathon-pine"];
const seatPlan = dv.planSeats({ rawStock: d.stock, seats: d.seats || {}, movements, releases: d.seatReleases || {}, products: d.products, nowIso: d.readAt });
const run = (config) => engine.computeRefillPlan({
  nowMs, config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open, refillRequests: d.recentRequests,
  orders: d.orders || {}, movements, heldLines: d.held || {}, rejectStreak: d.rejectStreak || {}, retryState: d.retryState || {},
  locations: d.locations, network, seats: seatPlan.effective, uncapped: true,
});
const live = run(d.config);
const cat = (pid) => { const p = d.products[pid] || {}; return p.categoryKey || p.category || "?"; };
const avail = (loc, pid, size) => Math.max(0, Number(d.stock?.[loc]?.[pid]?.[engine.encodeSizeKey(size)]?.qty) || 0);

// 1. Eligible population.
const ex = Object.fromEntries(Object.entries(live.exceptions).map(([k, v]) => [k, (v && v.items) || []]));
const raisedKeys = new Set(live.intents.map((i) => `${i.dest}|${i.productId}|${i.sizeKey}`));
// Central units promised to an OPEN request (a lock or a request row from
// Central, any destination) — as opposed to units claimed earlier in this same
// scan by a line the per-run caps may then drop.
const promisedCentral = new Set();
for (const [, byPid] of Object.entries(d.open || {})) for (const [pid, bySize] of Object.entries(byPid || {})) for (const [k, l] of Object.entries(bySize || {})) if (l && l.source === "central") promisedCentral.add(`${pid}|${k}`);
for (const r of Object.values(d.recentRequests || {})) if (r && r.status === "open" && !r.shadow && (r.source || r.createdFrom?.source) === "central") promisedCentral.add(`${r.productId}|${engine.encodeSizeKey(r.size)}`);
const parkOf = (loc, pid, size) => {
  for (const [k, label] of [["waitingForStock", "refused recently (cooldown)"], ["recountNeeded", "recount needed"], ["missingSizes", "reorder list"], ["awaitingSupplier", null], ["awaitingUpstream", "awaiting upstream"]]) {
    if (!ex[k].some((r) => r.loc === loc && r.pid === pid && String(r.size) === String(size))) continue;
    if (label) return label;
    return promisedCentral.has(`${pid}|${engine.encodeSizeKey(size)}`) ? "Central's units promised to an open request" : "Central's units claimed by another line planned this scan";
  }
  return "other";
};
const pop = {};
for (const b of ex.belowTarget) {
  if (!SHOPS.includes(b.loc) || avail("central", b.pid, b.size) <= 0) continue;
  const p = (pop[b.loc] ||= { sizes: 0, products: new Set(), raised: 0, inFlight: 0, parked: {} });
  p.sizes++; p.products.add(b.pid);
  const k = `${b.loc}|${b.pid}|${engine.encodeSizeKey(b.size)}`;
  if (raisedKeys.has(k)) p.raised++;
  else if (b.inbound > 0) p.inFlight++;
  else { const why = parkOf(b.loc, b.pid, b.size); p.parked[why] = (p.parked[why] || 0) + 1; }
}
console.log("1. ELIGIBLE POPULATION (below keep, Central holds the size):");
for (const [loc, p] of Object.entries(pop)) console.log(`   ${loc}: ${p.sizes} sizes / ${p.products.size} products — raised by this scan ${p.raised}, already on its way ${p.inFlight}, parked ${JSON.stringify(p.parked)}`);

// 2. Next scan under the LIVE caps (not uncapped).
const capped = engine.computeRefillPlan({ nowMs, config: d.config, targets: d.targets, stock: d.stock, products: d.products, openIndex: d.open, refillRequests: d.recentRequests,
  orders: d.orders || {}, movements, heldLines: d.held || {}, rejectStreak: d.rejectStreak || {}, retryState: d.retryState || {}, locations: d.locations, network, seats: seatPlan.effective });
const tally = (list) => list.reduce((o, i) => { const k = `${i.dest}←${i.source}`; (o[k] ||= { lines: 0, units: 0 }); o[k].lines++; o[k].units += i.qty; return o; }, {});
console.log("2. NEXT SCAN, live caps — computed:", JSON.stringify(tally(live.intents.filter((i) => [...SHOPS, "hub3"].includes(i.dest)))));
console.log("   released:", JSON.stringify(tally(capped.intents)), "\n   errors:", capped.errors.slice(0, 4));

// 3. Concrete's categories: open requests now + this scan's lines.
const cats = {};
for (const r of Object.values(d.recentRequests || {})) {
  if (r && r.status === "open" && !r.shadow && r.requestingLocation === "concrete") { const c = cat(r.productId); (cats[c] ||= { open: 0, thisScan: 0 }).open++; }
}
for (const i of capped.intents) if (i.dest === "concrete") { const c = cat(i.productId); (cats[c] ||= { open: 0, thisScan: 0 }).thisScan++; }
console.log("3. CONCRETE CATEGORIES (open now / this scan):");
for (const [c, v] of Object.entries(cats).sort((a, b) => (b[1].open + b[1].thisScan) - (a[1].open + a[1].thisScan))) console.log(`   ${c.padEnd(18)} open ${String(v.open).padStart(4)}   this scan ${String(v.thisScan).padStart(4)}`);
const perfPine = Object.values(d.recentRequests || {}).filter((r) => r && r.status === "open" && r.requestingLocation === "marathon-pine" && cat(r.productId) === "perfumes").length;
console.log(`   Pine perfume: seats ${Object.keys(seatPlan.effective["marathon-pine"] || {}).filter((p) => cat(p) === "perfumes").length}, open requests ${perfPine}, this scan ${capped.intents.filter((i) => i.dest === "marathon-pine" && cat(i.productId) === "perfumes").length} (unchanged by rule)`);

// 4. Effective policy at Concrete, by category and path.
const { stock: masked } = engine.maskUntrustedStock(d.stock, network);
const division = dv.divisionContext({ config: d.config, rawStock: d.stock, seats: seatPlan.effective, openIndex: d.open, heldLines: d.held, refillRequests: d.recentRequests, hub3View: masked.hub3, nowMs });
const routing = engine.networkRouting(d.config, network, division);
const ctx = { targets: d.targets, config: withPolicyTemplates(d.config, network), products: d.products, stock: masked, network, division,
  stockFor: (dest, pid) => (dv.isSeatedAtShop(division, dest, pid) && !dv.isDivisionFootwear(d.products[pid]) ? { ...masked, [dest]: { ...masked[dest], [pid]: d.stock[dest]?.[pid] } } : masked) };
const rows = new Map();
const seatedOrHeld = new Set([...Object.keys(seatPlan.effective.concrete || {}), ...Object.keys(d.stock.concrete || {})]);
for (const pid of seatedOrHeld) {
  const p = d.products[pid];
  if (!p || p.deactivated) continue;
  const fw = dv.isDivisionFootwear(p);
  const one = dv.isDivisionOneSize(p);
  const sizes = fw ? (p.sizes || []).map(String) : dv.divisionSizes(p);
  for (const s of sizes) {
    const size = s === "_" ? "" : s;
    const path = fw ? "sneaker" : dv.divisionNeverKeeps("concrete", p) ? "never kept" : !seatPlan.effective.concrete?.[pid] ? "not seated" : "shop-only";
    const t = engine.resolveTarget(ctx, "concrete", pid, size);
    const src = t && t.target > 0 ? (routing.sourceFor("concrete", p, pid, size) || "none") : "—";
    const key = `${cat(pid)}|${path}`;
    const r = rows.get(key) || { cat: cat(pid), path, products: new Set(), perSize: new Set(), oneSize: new Set(), askAt: new Set(), src: new Set(), unexplainedZero: 0, switchedOff: 0 };
    r.products.add(pid);
    const val = t && t.target > 0 ? t.target : 0;
    if (val === 0 && (path === "shop-only" || path === "Hub 3-owned")) {
      const row = d.targets?.concrete?.[pid]?.[engine.encodeSizeKey(size)];
      if (row && typeof row.target === "number" && row.target <= 0) r.switchedOff++; else r.unexplainedZero++;
    }
    (one ? r.oneSize : r.perSize).add(val);
    r.askAt.add(t && t.target > 0 ? (t.reorderPoint == null ? "–" : t.reorderPoint) : "–");
    r.src.add(src);
    rows.set(key, r);
  }
}
const WANT = { "shop-only": { perSize: 2, oneSize: 5, src: "central" }, "Hub 3-owned": { perSize: 1, oneSize: 5, src: "hub3" }, sneaker: { perSize: 0, oneSize: 0 }, "never kept": { perSize: 0, oneSize: 0 }, "not seated": { perSize: 0, oneSize: 0 } };
const fmt = (set) => [...set].sort().join("/") || "n/a";
console.log("4. EFFECTIVE POLICY AT CONCRETE (seated or holding a cell):");
console.log("   category           path          products  keep/size  keep/no-size  ask-at  source    flag");
for (const r of [...rows.values()].sort((a, b) => a.cat.localeCompare(b.cat) || a.path.localeCompare(b.path))) {
  const w = WANT[r.path];
  const bad = [];
  if (r.perSize.size && ![...r.perSize].every((v) => v === w.perSize || v === 0)) bad.push("keep/size");
  if (r.oneSize.size && ![...r.oneSize].every((v) => v === w.oneSize || v === 0)) bad.push("keep/no-size");
  // (a 0 in these sets is judged per size below: a Seating switch-off, or flagged)
  if (w.src && [...r.src].some((s) => s !== w.src && s !== "—")) bad.push("source");
  if (r.path === "Hub 3-owned" && [...r.askAt].some((a) => a !== 0 && a !== "–")) bad.push("ask-at");
  if (r.unexplainedZero) bad.push(`${r.unexplainedZero} sizes keep 0 with no switch-off`);
  const zeros = r.switchedOff ? ` (${r.switchedOff} sizes switched off in Seating)` : "";
  console.log(`   ${r.cat.padEnd(18)} ${r.path.padEnd(13)} ${String(r.products.size).padStart(8)}  ${fmt(r.perSize).padStart(9)}  ${fmt(r.oneSize).padStart(12)}  ${fmt(r.askAt).padStart(6)}  ${fmt(r.src).padEnd(9)} ${bad.length ? "⚠ " + bad.join(",") : "ok"}${zeros}`);
}
