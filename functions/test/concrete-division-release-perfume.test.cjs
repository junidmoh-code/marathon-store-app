// ─── FULL RELEASE + CONCRETE NEVER KEEPS PERFUME (Junid, 10 Nov 2026) ────────
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse(ISO);
const cfg = (extra = {}) => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 75, maxFootwearIntentsPerRun: 25, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true } } },
  categoryPolicy: { perfumes: { "marathon-pe": { target: 8, minQty: 4, reorderPoint: 3 } } },
  ...extra,
});
const counted = (qty) => ({ qty, v: 1, mv: "m", lastType: "count" });
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const seat = { via: "stock", at: ISO };
const PERF = { id: "pf", name: "Perfume", category: "Perfume", categoryKey: "perfumes", sizes: [] };

function bigWorld(n) {
  const products = { pf: PERF }, central = { pf: { _: counted(50) } }, concrete = {}, pine = {}, seats = { concrete: {}, "marathon-pine": {} };
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    products[id] = { id, name: `Tee ${i}`, category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] };
    central[id] = { M: counted(9) };
    const shop = i % 2 ? "marathon-pine" : "concrete";
    (shop === "concrete" ? concrete : pine)[id] = { M: shelf(0) };
    seats[shop][id] = seat;
  }
  return { products, stock: { central, hub3: {}, concrete, "marathon-pine": pine, hub2: {}, "marathon-pe": {}, trophy: {}, hub1: {} }, seats };
}
const plan = (w, config = cfg(), extra = {}) => computeRefillPlan({ nowMs: NOW, config, targets: {}, products: w.products, stock: w.stock, openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: reg.SEED_REGISTRY, seats: w.seats, ...extra });
const at = (p, d) => p.intents.filter((i) => i.dest === d).length;

test("every eligible Concrete/Pine line is released, past the 75 Marathon lever", () => {
  const p = plan(bigWorld(300));
  assert.equal(at(p, "concrete") + at(p, "marathon-pine"), 300);
  assert.equal(p.policy.divisionIntentsComputed, 300);
  assert.ok(!p.errors.some((e) => e.includes("Concrete division")));
});

test("past 500 the division is paced to its own ceiling, and says so", () => {
  const p = plan(bigWorld(620));
  assert.equal(at(p, "concrete") + at(p, "marathon-pine"), 500);
  assert.ok(p.errors.some((e) => e === "circuit breaker (Concrete division): 620 intents computed, paced to 500"));
  const q = plan(bigWorld(620), cfg({ maxDivisionIntentsPerRun: 700 }));
  assert.equal(at(q, "concrete") + at(q, "marathon-pine"), 620);
});

test("Marathon's slice is untouched by the division's release", () => {
  const w = bigWorld(300);
  w.products.mp = { id: "mp", name: "Hoodie", category: "Clothing", categoryKey: "hoodies", productType: "clothing", sizes: ["S", "M", "L"] };
  w.stock.central.mp = { S: counted(9), M: counted(9), L: counted(9) };
  w.stock.hub2.mp = { S: counted(0), M: counted(0), L: counted(0) };
  const slice = (p) => p.intents.filter((i) => ["hub1", "hub2", "marathon-pe", "trophy"].includes(i.dest)).map((i) => JSON.stringify(i)).sort();
  const without = plan({ ...w, stock: { ...w.stock, concrete: {}, "marathon-pine": {} }, seats: {} });
  assert.ok(slice(without).length > 0);
  assert.deepEqual(slice(plan(w)), slice(without));
});

test("Concrete never keeps perfume: no target from any branch, an explicit row included; Pine still does", () => {
  const w = bigWorld(0);
  w.stock.concrete.pf = { _: shelf(0) };
  w.stock["marathon-pine"].pf = { _: shelf(0) };
  w.seats.concrete.pf = seat;
  w.seats["marathon-pine"].pf = seat;
  const targets = { concrete: { pf: { _: { target: 4, minQty: 2 } } } };
  const p = plan(w, cfg(), { targets });
  assert.equal(at(p, "concrete"), 0);
  assert.deepEqual(p.intents.filter((i) => i.dest === "marathon-pine").map((i) => `${i.sizeKey}:${i.qty}`), ["_:5"]);
  assert.equal(resolveTarget({ targets, config: cfg(), products: w.products, stock: w.stock }, "concrete", "pf", ""), null);
  assert.equal(dv.divisionNeverKeeps("concrete", PERF), true);
  assert.equal(dv.divisionNeverKeeps("marathon-pine", PERF), false);
  assert.equal(dv.divisionNeverKeeps("concrete", { category: "Perfume" }), true, "by category name too");
});

test("Concrete never seats perfume, and an existing perfume seat is removed", () => {
  const products = { pf: PERF };
  const r = dv.planSeats({ rawStock: { concrete: { pf: { _: shelf(3) } } }, seats: { concrete: {} }, movements: [], products, nowIso: ISO });
  assert.equal(r.effective.concrete.pf, undefined);
  const s = dv.planSeats({ rawStock: { concrete: { pf: { _: shelf(3) } } }, seats: { concrete: { pf: seat } }, movements: [], products, nowIso: ISO });
  assert.equal(s.effective.concrete.pf, undefined);
  assert.equal(s.writes["concrete/pf"], null);
  const pine = dv.planSeats({ rawStock: { "marathon-pine": { pf: { _: shelf(3) } } }, seats: {}, movements: [], products, nowIso: ISO });
  assert.ok(pine.effective["marathon-pine"].pf, "Pine unchanged");
});

test("an open engine perfume request at Concrete is withdrawn by the next scan", () => {
  const w = bigWorld(0);
  w.stock.concrete.pf = { _: shelf(0) };
  const openIndex = { concrete: { pf: { _: { qty: 5, source: "central", refillId: "r1", createdAt: ISO, runId: "x" } } } };
  const refillRequests = { r1: { status: "open", productId: "pf", size: "", qty: 5, requestingLocation: "concrete", createdAt: ISO, source: "central", requestSource: "scan", createdFrom: { engine: true, source: "central" } } };
  const p = plan(w, cfg(), { openIndex, refillRequests });
  assert.ok(p.closes.some((c) => c.dest === "concrete" && c.pid === "pf" && c.refillId === "r1" && c.rrStatus === "cancelled"), JSON.stringify(p.closes));
});

test("with the shop's seats handed in, an UNSEATED counted cell arms nothing (the seat decides)", () => {
  const w = bigWorld(0);
  w.products.t1 = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] };
  w.stock.central.t1 = { M: counted(9) };
  w.stock.concrete.t1 = { M: { qty: 0, v: 1, trusted: true, trustedVia: "count", trustedAt: ISO } };
  assert.equal(at(plan(w), "concrete"), 0);
  w.seats.concrete.t1 = seat;
  assert.equal(at(plan(w), "concrete"), 1);
});

// ── the one-off division-only release ────────────────────────────────────────
const fs = require("node:fs");
const path = require("node:path");
const scan = require("../refill-scan.cjs");
const SCAN_SRC = fs.readFileSync(path.join(__dirname, "..", "refill-scan.cjs"), "utf8");

test("division-only: every list of work is cut to Hub 3 / Pine / Concrete — no Marathon line moves", () => {
  const plan = {};
  for (const k of ["intents", "closes", "resizes", "retryOps", "streakOps", "satisfiedClosures"]) {
    plan[k] = ["hub1", "hub2", "marathon-pe", "trophy", "hub3", "concrete", "marathon-pine"].map((dest) => ({ dest }));
  }
  plan.exceptions = { keep: true };
  scan._scopePlanToDivision(plan);
  for (const k of ["intents", "closes", "resizes", "retryOps", "streakOps", "satisfiedClosures"]) {
    assert.deepEqual(plan[k].map((x) => x.dest), ["hub3", "concrete", "marathon-pine"], k);
  }
  assert.deepEqual(plan.exceptions, { keep: true });
});

test("division-only: only the one-off entry point can switch it on, and it skips every Marathon-touching step", () => {
  assert.ok(SCAN_SRC.includes('const divisionOnly = !!(opts && opts.divisionOnly === true && opts.__oneOff === "division-release");'));
  assert.ok(SCAN_SRC.includes('exports._runDivisionRelease = () => runScan({ divisionOnly: true, __oneOff: "division-release" });'));
  assert.ok(SCAN_SRC.includes("  runScan\n);"), "the schedule calls runScan with its own event");
  for (const step of [
    "if (!divisionOnly) try {\n      const woSnap",
    'if (!divisionOnly) await safeSet(db, "refill_engine/shadow"',
    "if (!divisionOnly) {\n      const upd = shadowSyncUpdates(",
    'if (!divisionOnly) await safeSet(db, "stock_exceptions/latest"',
    "if (!divisionOnly) try {\n      const auditRes = await runStockAuditPass(",
    "if (!divisionOnly && new Date(nowMs).getUTCMinutes() < 15)",
    "scopePlanToDivision(plan);",
  ]) assert.ok(SCAN_SRC.includes(step), step);
  // Its run record never overwrites the hourly one.
  assert.ok(SCAN_SRC.includes('+ (divisionOnly ? "-division" : "")'));
});

// ── review fixes (PR #888) ───────────────────────────────────────────────────
test("a lock-less open Concrete perfume row (a Solve, a manual row) is withdrawn too; a moved one is left", () => {
  const w = bigWorld(0);
  const refillRequests = {
    s1: { status: "open", productId: "pf", size: "", qty: 2, requestingLocation: "concrete", createdAt: ISO, createdFrom: { source: "central", via: "missing_products_solve" } },
    s2: { status: "open", productId: "pf", size: "", qty: 1, requestingLocation: "concrete", createdAt: ISO, createdFrom: { source: "central", via: "missing_products_solve" } },
    p1: { status: "open", productId: "pf", size: "", qty: 2, requestingLocation: "marathon-pine", createdAt: ISO, createdFrom: { source: "central", via: "missing_products_solve" } },
  };
  const movements = [{ type: "transfer_out", from: "central", to: "concrete", productId: "pf", size: "", qty: 1, ts: ISO, link: { refillId: "s2" } }];
  const p = plan(w, cfg(), { refillRequests, movements });
  const got = p.satisfiedClosures.filter((s) => s.cancelReason === "never_kept_here").map((s) => s.refillId);
  assert.deepEqual(got, ["s1"], "s2 has a pick on the ledger; Pine's row is not touched");
  assert.ok(p.satisfiedClosures.find((s) => s.refillId === "s1").requireUntouched);
});

function fakeApplyDb(requests) {
  return { ref(path) { return {
    once: async () => ({ val: () => null }),
    transaction: async (fn) => { const id = path.split("/")[1]; let out = fn(null); if (out === undefined) return { committed: false, snapshot: { val: () => requests[id] ?? null } };
      const cur = requests[id] ?? null; out = fn(cur); if (out === undefined) return { committed: false, snapshot: { val: () => cur } };
      if (out !== null) requests[id] = out; return { committed: true, snapshot: { val: () => requests[id] ?? null } }; },
  }; } };
}
test("apply: a never-kept withdrawal cancels without a stock proof, stamps why, and never touches a claimed row", async () => {
  const requests = {
    s1: { status: "open", productId: "pf", size: "", qty: 2, requestingLocation: "concrete" },
    s3: { status: "open", productId: "pf", size: "", qty: 2, requestingLocation: "concrete", picking: { at: Date.now(), by: "u" } },
  };
  const mk = (id) => ({ refillId: id, dest: "concrete", pid: "pf", sizeKey: "_", size: "", qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "never_kept_here", neverKept: true, requireUntouched: true });
  const r = await scan._applySatisfied({ db: fakeApplyDb(requests), startedAt: ISO, closures: [mk("s1"), mk("s3")] });
  assert.equal(r.satisfied, 1);
  assert.equal(requests.s1.status, "cancelled");
  assert.equal(requests.s1.cancelReason, "never_kept_here");
  assert.equal(requests.s1.neverKeptAt, "concrete");
  assert.equal(requests.s1.deactivatedProduct, undefined);
  assert.equal(requests.s3.status, "open", "claimed by a picker: left alone");
});

test("a hand-made Seat for a perfume at Concrete is refused; Pine accepts it", async () => {
  const store = { users: { u: { stockRole: "admin" } }, products: { pf: PERF } };
  const db = { ref: (p) => ({ once: async () => ({ val: () => p.split("/").reduce((n, k) => (n == null ? null : n[k]), store) ?? null }), set: async () => {}, remove: async () => {} }) };
  await assert.rejects(dv.applyDivisionSeat({ db, callerUid: "u", data: { location: "concrete", pid: "pf" }, nowIso: ISO }), /never keeps/);
  const ok = await dv.applyDivisionSeat({ db, callerUid: "u", data: { location: "marathon-pine", pid: "pf" }, nowIso: ISO });
  assert.equal(ok.ok, true);
});

test("the division's released lines come AFTER every Marathon line, footwear included (apply order)", () => {
  const w = bigWorld(120);
  w.products.sh = { id: "sh", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["8"] };
  w.stock.central.sh = { 8: counted(9) };
  w.stock.hub1.sh = { 8: counted(0) };
  const c = cfg(); c.policyGroups["footwear-all"].policy.hub1 = { target: 2, minQty: 1, reorderPoint: 0 };
  const p = plan(w, c);
  const firstDivision = p.intents.findIndex((i) => ["concrete", "marathon-pine", "hub3"].includes(i.dest));
  const lastMarathon = p.intents.map((i) => ["hub1", "hub2", "marathon-pe", "trophy"].includes(i.dest)).lastIndexOf(true);
  assert.ok(lastMarathon > -1, "the world must raise a Marathon line");
  assert.ok(firstDivision > lastMarathon, `division at ${firstDivision}, Marathon last at ${lastMarathon}`);
});

test("Marathon over its 75-line lever: its dealt slice is the same with and without a 300-line division release", () => {
  const w = bigWorld(300);
  for (let i = 0; i < 90; i++) {
    const id = `m${i}`;
    w.products[id] = { id, name: `Hoodie ${i}`, category: "Clothing", categoryKey: "hoodies", productType: "clothing", sizes: ["M"] };
    w.stock.central[id] = { M: counted(9) };
    w.stock.hub2[id] = { M: counted(0) };
  }
  const targets = { hub2: Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`m${i}`, { M: { target: 2, minQty: 1 } }])) };
  const slice = (p) => p.intents.filter((i) => ["hub1", "hub2", "marathon-pe", "trophy"].includes(i.dest)).map((i) => JSON.stringify(i));
  const with_ = plan(w, cfg(), { targets });
  const without = plan({ ...w, stock: { ...w.stock, concrete: {}, "marathon-pine": {} }, seats: {} }, cfg(), { targets });
  assert.equal(slice(without).length, 75, "Marathon is capped at its lever");
  assert.deepEqual(slice(with_), slice(without), "same lines, same order");
  assert.equal(with_.intents.filter((i) => ["concrete", "marathon-pine"].includes(i.dest)).length, 300);
});
