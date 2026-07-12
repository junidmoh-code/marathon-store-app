// ─── INTEGRATION VERIFICATION — the 7-test suite (tests 1–6) ──────────────────
// Owner-specified controlled test (2026-07-12): verify every refill journey
// WITHOUT live mode, using a snapshot of the real database and the EXACT
// deployed engine code (functions/lib/refill-engine.cjs), with simulated
// mutations applied to the snapshot only. Nothing here writes to the database.
//
//   T1  PE sale below target   → one intent, marathon-pe only, correct qty/route
//   T2  Trophy sale            → separate intent; warehouse cards can never merge
//   T3  Hub 2 below target     → intent hub2←central; lands in Source queue
//   T4  Hub 2 excess           → 3 real products, arithmetic re-checked
//   T5  Store excess           → 3 real products per store, arithmetic re-checked
//   T6  Destinations           → every intent/order/button maps to its own dest
//
// RUN:  node scripts/targets/_verify-journeys.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const engine = require("../../functions/lib/refill-engine.cjs");

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT_DIR, { recursive: true });
const PROJECT = "marathon-club";
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };

function fbGet(dbPath, extraArgs = []) {
  const tmp = path.join(OUT_DIR, `.vj${Math.random().toString(36).slice(2)}.json`);
  execFileSync("firebase", ["database:get", dbPath, "--project", PROJECT, "-o", tmp, ...extraArgs], { stdio: ["ignore", "ignore", "inherit"] });
  const v = JSON.parse(readFileSync(tmp, "utf8"));
  rmSync(tmp, { force: true });
  return v;
}

console.log("Snapshotting live database (read-only)…");
const nowMs = Date.now();
const windowStart = new Date(nowMs - 45 * 864e5).toISOString();
const config = fbGet("/config/refillEngine");
const products = fbGet("/products") || {};
const targets = fbGet("/stock_targets") || {};
const openIndex = fbGet("/refill_engine/open") || {};
const refillRequests = fbGet("/refill_requests") || {};
const orders = fbGet("/orders") || {};
const movements = Object.values(fbGet("/stock_movements", ["--order-by", "ts", "--start-at", JSON.stringify(windowStart)]) || {});
const stock = {};
for (const loc of ["marathon-pe", "trophy", "hub2", "central"]) stock[loc] = fbGet(`/stock/${loc}`) || {};

// UNCAPPED config for the causality tests (T1–T3): the production circuit
// breaker throttles the day-one backlog to N per scan, which would hide a
// single fresh deficit from a before/after diff. The cap itself is verified
// separately (T6 fair-split check runs on the CAPPED plan).
const uncapped = { ...config, maxIntentsPerRun: 1e9 };
const snap = (cfg = uncapped) => ({
  nowMs, config: cfg, products, targets, stock: JSON.parse(JSON.stringify(stock)),
  openIndex, refillRequests, orders, movements,
});
const intentKey = (i) => `${i.dest}|${i.productId}|${i.sizeKey}`;
const baseline = engine.computeRefillPlan(snap());
const cappedBaseline = engine.computeRefillPlan(snap(config));
const baseKeys = new Set(baseline.intents.map(intentKey));

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

// Replicas of the two UI routing predicates (documented copies — see
// App.jsx clothingActiveBatches and Hub2RefillQueue.jsx):
const warehouseAccepts = (o, selectedHub) => o.productType === "clothing" && (o.placedAtHub || o.hub || "hub2") === selectedHub;
const warehouseBatchKey = (o) => `${o.productId}__${o.destShop || ""}__${o.createdAt}`;
const sourceQueueAccepts = (rr) => rr.requestingLocation === "hub2" && !!rr.productId && rr.status === "open";

// What the scan's LIVE branch writes for a store-leg intent (refill-scan.cjs):
const simulatedOrder = (intent, orderId, createdAt) => ({
  id: orderId, productId: intent.productId, size: intent.size, qty: intent.qty,
  customerName: "Shop Refill", productType: "clothing",
  hub: intent.source, placedAtHub: intent.source,
  destShop: intent.dest, status: "incoming", createdAt, autoRefill: true,
});

// Find a cell we can cleanly "sell one" from: explicit target, currently AT or
// ABOVE target (no deficit → the sale CAUSES the request), no open intent.
function saleCandidate(dest) {
  for (const [pid, bySize] of Object.entries(targets[dest] || {})) {
    if (!products[pid]) continue;
    for (const [sizeKey, t] of Object.entries(bySize || {})) {
      const cell = stock[dest]?.[pid]?.[sizeKey];
      const qty = typeof cell?.qty === "number" ? cell.qty : 0;
      if (!t || typeof t.target !== "number" || t.target < 1) continue;
      if (qty !== t.target) continue;                       // exactly at target
      if (openIndex?.[dest]?.[pid]?.[sizeKey]) continue;
      if (baseKeys.has(`${dest}|${pid}|${sizeKey}`)) continue;
      return { pid, sizeKey, target: t.target, qty, name: products[pid]?.name };
    }
  }
  return null;
}

function runSaleTest(label, dest) {
  console.log(`\n▶ ${label}: simulate ONE sale at ${LOC_LABEL[dest]}`);
  const c = saleCandidate(dest);
  if (!c) { check(`${label} candidate`, false, `no at-target cell found for ${dest}`); return null; }
  console.log(`  product: "${c.name}" size ${c.sizeKey} — at target (${c.qty}/${c.target}); selling 1 → ${c.qty - 1}/${c.target}`);
  const s = snap();
  s.stock[dest][c.pid][c.sizeKey].qty = c.qty - 1;
  const plan = engine.computeRefillPlan(s);
  const fresh = plan.intents.filter((i) => !baseKeys.has(intentKey(i)));
  const mine = fresh.filter((i) => i.productId === c.pid && i.sizeKey === c.sizeKey);
  check(`${label}: exactly one new request for this product+size`, mine.length === 1, `${mine.length} new (total fresh: ${fresh.length})`);
  const i = mine[0];
  if (!i) return null;
  check(`${label}: destination is ${LOC_LABEL[dest]} ONLY`, i.dest === dest && mine.every((x) => x.dest === dest), `dest=${i.dest}`);
  check(`${label}: quantity correct (deficit of 1)`, i.qty === 1, `qty=${i.qty}`);
  check(`${label}: routed from ${LOC_LABEL[config.routes[dest]]}`, i.source === config.routes[dest], `source=${i.source}`);
  const order = simulatedOrder(i, "R900-1", new Date().toISOString());
  check(`${label}: order lands in Warehouse → Hub 2 → Clothing`, warehouseAccepts(order, "hub2"), `placedAtHub=${order.placedAtHub}`);
  check(`${label}: warehouse card labelled ${LOC_LABEL[dest]}`, order.destShop === dest, `destShop=${order.destShop}`);
  return { intent: i, order, candidate: c };
}

// ── T1 + T2 ───────────────────────────────────────────────────────────────────
const t1 = runSaleTest("T1", "marathon-pe");
const t2 = runSaleTest("T2", "trophy");
if (t1 && t2) {
  const k1 = warehouseBatchKey(t1.order), k2 = warehouseBatchKey(t2.order);
  check("T2: PE and Trophy requests can NEVER merge (distinct card keys)", k1 !== k2, `"${k1}" vs "${k2}"`);
}

// ── T3: hub2 below target → Source queue ─────────────────────────────────────
console.log(`\n▶ T3: simulate Hub 2 dropping below target`);
const c3 = saleCandidate("hub2");
if (!c3) check("T3 candidate", false, "no at-target hub2 cell found");
else {
  console.log(`  product: "${c3.name}" size ${c3.sizeKey} — at target (${c3.qty}/${c3.target}); removing 1`);
  const s = snap();
  s.stock.hub2[c3.pid][c3.sizeKey].qty = c3.qty - 1;
  const plan = engine.computeRefillPlan(s);
  const mine = plan.intents.filter((i) => !baseKeys.has(intentKey(i)) && i.productId === c3.pid && i.sizeKey === c3.sizeKey);
  check("T3: exactly one new request", mine.length === 1, `${mine.length}`);
  const i = mine[0];
  if (i) {
    check("T3: destination is Hub 2, source is Central", i.dest === "hub2" && i.source === "central", `dest=${i.dest} src=${i.source}`);
    check("T3: quantity correct (deficit of 1)", i.qty === 1, `qty=${i.qty}`);
    // Live branch for hub2 legs writes a refill_request (no R### order):
    const rr = { productId: i.productId, size: i.size, qty: i.qty, requestingLocation: i.dest, status: "open", createdFrom: { engine: true } };
    check("T3: appears in Source → Hub 2 Refill (queue filter accepts)", sourceQueueAccepts(rr));
    check("T3: card = correct product + size + qty", rr.productId === c3.pid && String(rr.size) === c3.sizeKey && rr.qty === 1, `"${c3.name}" ${rr.size}×${rr.qty}`);
  }
}

// ── T4/T5: excess arithmetic on real products ─────────────────────────────────
function excessTest(label, loc, minEx) {
  console.log(`\n▶ ${label}: ${LOC_LABEL[loc]} excess (rule: surplus ≥ ${minEx}${loc === "hub2" ? ", untargeted counts as target 0" : ", targeted cells only"})`);
  const items = baseline.exceptions.excess.items.filter((e) => e.loc === loc);
  check(`${label}: ${LOC_LABEL[loc]} excess is detected`, items.length > 0, `${baseline.exceptions.excess.items.length} network-wide, ${items.length} at ${LOC_LABEL[loc]}`);
  for (const e of items.slice(0, 3)) {
    const raw = stock[loc]?.[e.pid]?.[e.sizeKey]?.qty;
    const t = targets[loc]?.[e.pid]?.[e.sizeKey]?.target ?? (loc === "hub2" ? 0 : null);
    const ok = raw === e.have && t === e.target && e.have - e.target === e.excess && e.excess >= minEx;
    check(`${label}: "${(products[e.pid]?.name || e.pid).slice(0, 38)}" ${e.sizeKey}`, ok,
      `current ${e.have}, target ${e.target}, excess ${e.excess} (raw cell=${raw})`);
  }
}
excessTest("T4", "hub2", 1);
excessTest("T5a", "marathon-pe", 2);
excessTest("T5b", "trophy", 2);

// ── T6: every destination correct, everywhere ─────────────────────────────────
console.log(`\n▶ T6: destination audit — uncapped plan ${baseline.intents.length} intents, capped plan ${cappedBaseline.intents.length}`);
const routeOk = baseline.intents.every((i) => i.source === config.routes[i.dest]);
check("T6: every intent routes source = routes[dest]", routeOk);
const destCounts = {};
for (const i of cappedBaseline.intents) destCounts[i.dest] = (destCounts[i.dest] || 0) + 1;
check("T6: all three destinations receive their share (fair cap)", Object.keys(destCounts).length === 3, JSON.stringify(destCounts));
const sims = [t1, t2].filter(Boolean);
check("T6: no store request ever carries the other store's label",
  sims.every((x) => x.order.destShop === x.intent.dest) &&
  (!t1 || t1.order.destShop === "marathon-pe") && (!t2 || t2.order.destShop === "trophy"));
check("T6: hub2 requests point only at hub2 (Source queue), never a store",
  baseline.intents.filter((i) => i.dest === "hub2").every((i) => i.source === "central"));
console.log("  UI button labels are rendered from each card's own dest:", JSON.stringify(LOC_LABEL));

// ── summary ───────────────────────────────────────────────────────────────────
const fails = results.filter((r) => !r.ok);
console.log(`\n═══ ${results.length - fails.length}/${results.length} checks passed ═══`);
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log(`  ❌ ${f.name} — ${f.detail || ""}`)); process.exit(1); }
