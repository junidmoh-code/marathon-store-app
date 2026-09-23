// ─── PASS-THROUGH LEGS — a shop's demand never dead-ends at its hub ──────────
// Run: cd functions && node --test test/refill-pass-through.test.cjs
//
// SHORT-NOT-REQUESTED-INVESTIGATION.md (2026-09-23): a shop can only ask its
// hub. When the hub is empty and keeps none of the size (no_target), or its
// staff have rejected the ask N times while its count still shows stock
// (disputed), nothing ever asked Central — 43 live shop cells, including the
// owner's report (PE / M of Nike Tech Fleece Tracksuit Brown 2).
//
// These tests drive the real computeRefillPlan through the whole life of a
// pass-through leg: raised → kept open while the shop is still short (even
// though the hub's own target reads "met") → withdrawn when the shop no longer
// needs it → the arrival at the hub lifts the streak and the shop leg fires.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const iso = (hAgo = 0) => new Date(NOW - hAgo * 3600e3).toISOString();
const cell = (qty) => ({ qty, v: 1 });

// The live config's shape for the four routed destinations (2026-09-23).
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  defaultRunByStore: {
    hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
    "marathon-pe": { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  ruleBasedTargets: true,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 75,
  recheckCooldownMinutes: 1440,
  rejectStreakLimit: 4,
  staleIntentHours: 168,
};

const PID = "p1780382141061";
const PRODUCTS = {
  [PID]: { name: "Nike Tech Fleece Tracksuit Brown 2", productType: "clothing", category: "Clothing",
    categoryKey: "tracksuits", sizes: ["M", "L", "XL", "XXL"] },
};
// The explicit rows exactly as they sit live (introduce-existing 2026-07-13).
const TARGETS = {
  hub2: { [PID]: { L: { target: 3, minQty: 2 }, M: { target: 3, minQty: 2 }, XL: { target: 2, minQty: 1 }, XXL: { target: 2, minQty: 1 } } },
  "marathon-pe": { [PID]: { L: { target: 2, minQty: 1 }, M: { target: 2, minQty: 1 }, XL: { target: 1, minQty: 1 }, XXL: { target: 1, minQty: 1 } } },
};
const STOCK = () => ({
  "marathon-pe": { [PID]: { L: cell(2), M: cell(0), XL: cell(1), XXL: cell(1) } },
  hub2: { [PID]: { L: cell(3), M: cell(3), XL: cell(2), XXL: cell(2) } },
  central: { [PID]: { L: cell(56), M: cell(38), XL: cell(16), XXL: cell(17) } },
  trophy: {}, hub1: {},
});
// Hub 2's four "out of stock" answers — the last on 17 Sep, 14:15.
const STREAK = { "marathon-pe": { [PID]: { M: { count: 4, by: "hub2", lastTs: "2026-09-17T14:15:22.516Z" } } } };
const REJECTED_RR = {
  rrLast: { productId: PID, size: "M", qty: 2, requestingLocation: "marathon-pe", status: "cancelled",
    createdAt: "2026-09-17T10:15:16.579Z", resolvedAt: "2026-09-17T14:15:22.516Z", createdFrom: { engine: true, source: "hub2" } },
};

function live(over = {}) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: TARGETS, stock: STOCK(),
    openIndex: {}, refillRequests: { ...REJECTED_RR }, orders: {}, movements: [],
    rejectStreak: STREAK, retryState: {},
    ...over,
  };
}

test("THE OWNER'S CELL: PE / M parked by the loop guard now raises Central → Hub 2 × 2 for Marathon PE", () => {
  const plan = computeRefillPlan(live());
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0,
    "Hub 2 is not asked a fifth time for units its staff cannot find");
  const leg = plan.intents.find((i) => i.dest === "hub2" && i.productId === PID && i.sizeKey === "M");
  assert.ok(leg, "a leg exists for the shop's need");
  assert.deepEqual(
    { source: leg.source, qty: leg.qty, passThrough: leg.passThrough, forDests: leg.forDests, priority: leg.priority, mode: leg.mode },
    { source: "central", qty: 2, passThrough: "disputed", forDests: ["marathon-pe"], priority: "high", mode: "live" },
  );
  // Nothing else about the product moves: every other size is at keep.
  assert.equal(plan.intents.filter((i) => i.productId === PID).length, 1);
});

test("hub2's own target is untouched — the leg is sized by the SHOP's keep, never a new hub number", () => {
  const plan = computeRefillPlan(live({
    stock: { ...STOCK(), "marathon-pe": { [PID]: { L: cell(2), M: cell(1), XL: cell(1), XXL: cell(1) } } },
  }));
  // PE keeps 2, has 1 → 1, whatever hub2's target (3) or count (3) say.
  assert.equal(plan.intents.find((i) => i.dest === "hub2" && i.sizeKey === "M")?.qty, 1);
});

// ── reconcile ────────────────────────────────────────────────────────────────
const PT_LOCK = (kind, qty = 2) => ({
  hub2: { [PID]: { M: { qty, source: "central", createdAt: iso(1), runId: "r", refillId: "rrPT", orderId: null,
    orderCreatedAt: null, passThrough: kind, forDests: ["marathon-pe"] } } },
});
const PT_RR = { rrPT: { productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: iso(1),
  createdFrom: { engine: true, source: "central", passThrough: "disputed", forDests: ["marathon-pe"] } } };

test("an open DISPUTED leg survives the next scan even though hub2's own target reads 'met' (3 of 3)", () => {
  const plan = computeRefillPlan(live({ openIndex: PT_LOCK("disputed"), refillRequests: { ...REJECTED_RR, ...PT_RR } }));
  assert.equal(plan.closes.length, 0, "judged by hub2's target it would be withdrawn as no_longer_needed");
  assert.equal(plan.intents.filter((i) => i.productId === PID).length, 0, "one leg per cell — no second ask while it is in flight");
  const r = plan.exceptions.recountNeeded.items.find((x) => x.pid === PID);
  assert.equal(r.passThrough, "in_flight");
  assert.match(r.note, /on its way/);
});

test("the leg is withdrawn the moment the SHOP no longer needs it (stock reached PE another way)", () => {
  const stock = STOCK();
  stock["marathon-pe"][PID].M = cell(2);
  const plan = computeRefillPlan(live({ stock, openIndex: PT_LOCK("disputed"), refillRequests: { ...REJECTED_RR, ...PT_RR } }));
  const c = plan.closes.find((x) => x.dest === "hub2" && x.pid === PID);
  assert.ok(c, "withdrawn");
  assert.equal(c.reason, "no_longer_needed");
});

test("an oversized leg shrinks to the shop's real need (resize reads the shop, not the hub)", () => {
  const stock = STOCK();
  stock["marathon-pe"][PID].M = cell(1);
  const plan = computeRefillPlan(live({ stock, openIndex: PT_LOCK("disputed", 2), refillRequests: { ...REJECTED_RR, ...PT_RR } }));
  assert.deepEqual(plan.resizes.map((r) => [r.dest, r.from, r.to]), [["hub2", 2, 1]]);
});

test("a NO_TARGET leg counts what the hub can already hand over", () => {
  const products = { p9: { name: "Tee", productType: "clothing", sizes: ["M"] } };
  const base = {
    products, targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } } }, rejectStreak: {},
    openIndex: { hub2: { p9: { M: { qty: 2, source: "central", createdAt: iso(1), runId: "r", refillId: "rr9", passThrough: "no_target", forDests: ["marathon-pe"] } } } },
    refillRequests: { rr9: { productId: "p9", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: iso(1) } },
  };
  const keep = computeRefillPlan(live({ ...base, stock: { "marathon-pe": { p9: { M: cell(0) } }, hub2: {}, central: { p9: { M: cell(5) } }, trophy: {}, hub1: {} } }));
  assert.equal(keep.closes.length, 0, "shop still at 0 → the leg stays");
  const gone = computeRefillPlan(live({ ...base, stock: { "marathon-pe": { p9: { M: cell(0) } }, hub2: { p9: { M: cell(2) } }, central: { p9: { M: cell(5) } }, trophy: {}, hub1: {} } }));
  assert.equal(gone.closes.find((c) => c.dest === "hub2")?.reason, "no_longer_needed",
    "hub2 now holds the 2 the shop needs — the shop leg can be served from it");
});

// ── the cascade completes on its own ────────────────────────────────────────
test("when the leg LANDS at hub2 the streak lifts and PE is asked on the very next scan — no human step", () => {
  const stock = STOCK();
  stock.hub2[PID].M = cell(5);   // 3 disputed + 2 just transferred in
  const plan = computeRefillPlan(live({
    stock,
    movements: [{ type: "transfer_in", productId: PID, size: "M", from: "central", to: "hub2", qty: 2,
      ts: iso(0.5), after: { hub2: 5 } }],
  }));
  const pe = plan.intents.find((i) => i.dest === "marathon-pe" && i.sizeKey === "M");
  assert.ok(pe, "PE / M request raised");
  assert.deepEqual({ source: pe.source, qty: pe.qty }, { source: "hub2", qty: 2 });
  assert.ok(plan.streakOps.some((o) => o.dest === "marathon-pe" && o.pid === PID && o.op === "reset"),
    "the arrival clears the stale streak");
  assert.ok(!plan.exceptions.recountNeeded.items.some((x) => x.pid === PID), "no longer parked");
});

// ── gates ────────────────────────────────────────────────────────────────────
test("Central said no to hub2 recently → no pass-through (a person upstream has ruled)", () => {
  const plan = computeRefillPlan(live({
    refillRequests: { ...REJECTED_RR,
      rrC: { productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "cancelled",
        createdAt: iso(5), resolvedAt: iso(2), createdFrom: { engine: true, source: "central" } } },
  }));
  assert.equal(plan.intents.filter((i) => i.productId === PID).length, 0);
});

test("two shops short of the same hub-less size share ONE leg, capped by what Central has", () => {
  const products = { p9: { name: "Tee", productType: "clothing", sizes: ["M"] } };
  const plan = computeRefillPlan(live({
    products, rejectStreak: {}, refillRequests: {},
    targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } }, trophy: { p9: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p9: { M: cell(0) } }, trophy: { p9: { M: cell(0) } }, hub2: {}, central: { p9: { M: cell(3) } }, hub1: {} },
  }));
  const legs = plan.intents.filter((i) => i.productId === "p9");
  assert.equal(legs.length, 1);
  assert.equal(legs[0].qty, 3, "never more than Central physically has");
  assert.deepEqual(legs[0].forDests, ["marathon-pe", "trophy"]);
});

test("Central's units already promised to an open request are not promised again", () => {
  const products = { p9: { name: "Tee", productType: "clothing", sizes: ["M"] } };
  const plan = computeRefillPlan(live({
    products, rejectStreak: {},
    targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } }, hub1: { p9: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p9: { M: cell(0) } }, hub2: {}, central: { p9: { M: cell(1) } }, trophy: {}, hub1: { p9: { M: cell(0) } } },
    // hub1's open ask already holds Central's only unit.
    openIndex: { hub1: { p9: { M: { qty: 1, source: "central", createdAt: iso(1), runId: "r", refillId: "rrH1" } } } },
    refillRequests: { rrH1: { productId: "p9", size: "M", qty: 1, requestingLocation: "hub1", status: "open", createdAt: iso(1) } },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "hub2").length, 0);
});

// ── the scan writes what the next scan reads ───────────────────────────────────
test("the scan's lock + request for a pass-through leg carry passThrough/forDests; an ordinary leg carries neither", () => {
  const { _intentRecords } = require("../refill-scan.cjs");
  const { sanitizeUpdate } = require("../lib/refill-engine.cjs");
  const plan = computeRefillPlan(live());
  const leg = plan.intents.find((i) => i.dest === "hub2" && i.sizeKey === "M");
  const { rr, lock } = _intentRecords({ intent: leg, startedAt: iso(0), runId: "run", rrKey: "rrNew" });
  assert.equal(lock.passThrough, "disputed");
  assert.deepEqual(lock.forDests, ["marathon-pe"]);
  assert.equal(rr.requestingLocation, "hub2");
  assert.deepEqual(rr.forDests, ["marathon-pe"]);
  assert.equal(rr.createdFrom.passThrough, "disputed");
  assert.equal(sanitizeUpdate({ "refill_requests/rrNew": rr, "refill_engine/open/hub2/p/M": lock }).problems.length, 0,
    "no undefined anywhere — a strict intent write would abort on one");

  // Round trip: the lock as written makes the NEXT plan keep the leg open.
  const next = computeRefillPlan(live({
    openIndex: { hub2: { [PID]: { M: lock } } },
    refillRequests: { ...REJECTED_RR, rrNew: rr },
  }));
  assert.equal(next.closes.length, 0, "not withdrawn on the next scan");

  const ordinary = _intentRecords({ intent: { dest: "marathon-pe", productId: PID, size: "M", sizeKey: "M", qty: 1, source: "hub2" },
    startedAt: iso(0), runId: "run", rrKey: "rrO", orderId: "R001-1", orderCreatedAt: iso(0) });
  assert.ok(!("passThrough" in ordinary.lock) && !("forDests" in ordinary.rr) && !("passThrough" in ordinary.rr.createdFrom));
  assert.deepEqual(ordinary.lock, { qty: 1, source: "hub2", createdAt: iso(0), runId: "run", refillId: "rrO", orderId: "R001-1", orderCreatedAt: iso(0) },
    "an ordinary lock is byte-identical to what the scan wrote before this change");
});

// ── review round 1 (PR #641) ─────────────────────────────────────────────────
test("Sonnet #1 (pinned, not a defect): a hub with its OWN residual deficit on the disputed cell raises ONE leg — the pass-through — never a second", () => {
  const targets = { ...TARGETS, hub2: { [PID]: { ...TARGETS.hub2[PID], M: { target: 10, minQty: 5 } } } };
  const plan = computeRefillPlan(live({ targets }));
  const legs = plan.intents.filter((i) => i.dest === "hub2" && i.sizeKey === "M");
  assert.equal(legs.length, 1, "the planned pass-through is inbound to hub2, so its own deficit waits (one leg per cell)");
  assert.deepEqual({ passThrough: legs[0].passThrough, qty: legs[0].qty, forDests: legs[0].forDests }, { passThrough: "disputed", qty: 2, forDests: ["marathon-pe"] });
  const r = plan.exceptions.recountNeeded.items.find((x) => x.pid === PID);
  assert.equal(r.passThrough, "raised", "and the note that says so is true");
});

test("sneakers are SALES-ONLY at the hubs: no pass-through for footwear, whatever a shop row says", () => {
  const products = { sn: { name: "Runner", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] } };
  const plan = computeRefillPlan(live({
    products, rejectStreak: {}, refillRequests: {},
    targets: { "marathon-pe": { sn: { 8: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { sn: { 8: cell(0) } }, hub2: {}, central: { sn: { 8: cell(9) } }, trophy: {}, hub1: {} },
  }));
  assert.equal(plan.intents.filter((i) => i.productId === "sn").length, 0);
});

test("a DISPUTED leg that landed keeps a Recount Needed row for the hub until its count is touched", () => {
  const stock = STOCK();
  stock.hub2[PID].M = cell(3);          // PE has since pulled the 2 real units; the 3 phantom remain
  stock["marathon-pe"][PID].M = cell(2);
  const landed = { rrPT: { productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "fulfilled",
    createdAt: iso(30), resolvedAt: iso(20), forDests: ["marathon-pe"],
    createdFrom: { engine: true, source: "central", passThrough: "disputed", forDests: ["marathon-pe"] } } };
  const base = { stock, rejectStreak: {}, refillRequests: { ...REJECTED_RR, ...landed } };
  const row = computeRefillPlan(live(base)).exceptions.recountNeeded.items.find((x) => x.pid === PID);
  assert.ok(row, "the dispute outlives the streak");
  assert.deepEqual({ loc: row.loc, source: row.source, showing: row.showing, countDisputed: row.countDisputed, rejections: row.rejections },
    { loc: "marathon-pe", source: "hub2", showing: 3, countDisputed: true, rejections: null });
  // A count at the hub cell after the leg was raised clears it.
  const counted = computeRefillPlan(live({ ...base, movements: [{ type: "adjustment", productId: PID, size: "M", from: "hub2", to: null, qty: 3, ts: iso(1) }] }));
  assert.ok(!counted.exceptions.recountNeeded.items.some((x) => x.pid === PID), "recounted → gone");
  // And it lapses with the confirmed-out window.
  const old = { rrPT: { ...landed.rrPT, createdAt: iso(24 * 20), resolvedAt: iso(24 * 15) } };
  assert.ok(!computeRefillPlan(live({ ...base, refillRequests: old })).exceptions.recountNeeded.items.some((x) => x.pid === PID));
  // Not listed twice while the live streak row still stands.
  const both = computeRefillPlan(live({ ...base, rejectStreak: STREAK, stock: STOCK() }));
  assert.equal(both.exceptions.recountNeeded.items.filter((x) => x.pid === PID).length, 1);
});

test("units a no_target leg landed at hub2 are in transit to the shop — not a Decision Queue leftover", () => {
  const products = { p9: { name: "Tee", productType: "clothing", sizes: ["M"] } };
  // Explicit rows only: under the size rule, hub2 holding a cell would give
  // it a target of its own and both halves of this test would be vacuous.
  const config = { ...CONFIG, ruleBasedTargets: false };
  const plan = computeRefillPlan(live({
    config, products, rejectStreak: {}, refillRequests: {},
    targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p9: { M: cell(0) } }, hub2: { p9: { M: cell(2) } }, central: { p9: { M: cell(3) } }, trophy: {}, hub1: {} },
  }));
  assert.equal(plan.intents.find((i) => i.dest === "marathon-pe")?.qty, 2, "the shop leg picks them up");
  assert.ok(!plan.exceptions.noTarget.items.some((n) => n.loc === "hub2" && n.pid === "p9"), "hub2's 2 are spoken for");
  // With no shop asking, the same 2 units ARE a leftover decision.
  const idle = computeRefillPlan(live({
    config, products, rejectStreak: {}, refillRequests: {},
    targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p9: { M: cell(2) } }, hub2: { p9: { M: cell(2) } }, central: {}, trophy: {}, hub1: {} },
  }));
  assert.ok(idle.exceptions.noTarget.items.some((n) => n.loc === "hub2" && n.pid === "p9" && n.units === 2));
});

test("the Engine Policy preview model parks a shop that got no share of a capped leg (CodeRabbit, PR #641)", () => {
  const { modelCategoryPolicy } = require("../lib/category-policy.cjs");
  const products = { c1: { name: "Cap", productType: "clothing", categoryKey: "cat", sizes: ["_"] } };
  const config = {
    mode: { hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: false, maxUnitsPerIntent: 20,
    categoryPolicy: { cat: { "marathon-pe": { target: 2, minQty: 1 }, trophy: { target: 2, minQty: 1 } } },
  };
  const stock = { "marathon-pe": { c1: { _: cell(0) } }, trophy: { c1: { _: cell(0) } }, hub2: {}, central: { c1: { _: cell(1) } } };
  const m = modelCategoryPolicy({ config, products, stock, targets: {}, openIndex: {}, categoryKey: "cat",
    locations: ["marathon-pe", "trophy", "hub2", "central"], maxUnitsPerIntent: 20 });
  const eng = computeRefillPlan({ nowMs: NOW, config, products, stock, targets: {}, openIndex: {}, refillRequests: {}, orders: {}, movements: [] });
  assert.equal(m.passThroughRequests, 1);
  assert.equal(m.passThroughUnits, 1);
  const legs = Object.fromEntries(m.legs.map((l) => [l.loc, l]));
  assert.equal(legs["marathon-pe"].carriedThroughHub + legs.trophy.carriedThroughHub, 1, "only the shop that got the unit is carried");
  assert.equal(legs["marathon-pe"].parkedNoSource + legs.trophy.parkedNoSource, 1, "the other is parked, as the engine parks it");
  assert.deepEqual([m.totalRequests, m.totalUnits], [eng.intents.length, eng.intents.reduce((n, i) => n + i.qty, 0)]);
});

test("a disputed leg that carried TWO shops keeps a recount row for EACH (second-brain review)", () => {
  const stock = STOCK();
  stock["marathon-pe"][PID].M = cell(2);
  const rr = { rrPT: { productId: PID, size: "M", qty: 4, requestingLocation: "hub2", status: "fulfilled",
    createdAt: iso(30), resolvedAt: iso(20), forDests: ["marathon-pe", "trophy"],
    createdFrom: { engine: true, source: "central", passThrough: "disputed", forDests: ["marathon-pe", "trophy"] } } };
  const rows = computeRefillPlan(live({ stock, rejectStreak: {}, refillRequests: rr })).exceptions.recountNeeded.items.filter((x) => x.countDisputed);
  assert.deepEqual(rows.map((r) => r.loc).sort(), ["marathon-pe", "trophy"]);
});

test("shadow mode previews a pass-through as one, naming its shops", () => {
  const { _shadowSyncUpdates } = require("../refill-scan.cjs");
  const upd = _shadowSyncUpdates({ shadowNode: { hub2: { [PID]: { M: { qty: 2, source: "central", priority: "high", passThrough: "disputed", forDests: ["marathon-pe"] } } } },
    products: PRODUCTS, orders: {}, refillRequests: {}, runId: "r", startedAt: iso(0) });
  const row = upd[`refill_requests/SHDWrr-${PID}-M`];
  assert.deepEqual(row.forDests, ["marathon-pe"]);
  assert.equal(row.createdFrom.passThrough, "disputed");
});

test("a corrupt negative lock qty reserves and releases the SAME one unit (CodeRabbit, PR #641)", () => {
  const products = { p9: { name: "Tee", productType: "clothing", sizes: ["M"] } };
  const plan = computeRefillPlan(live({
    products, rejectStreak: {}, config: { ...CONFIG, ruleBasedTargets: false },
    targets: { "marathon-pe": { p9: { M: { target: 2, minQty: 1 } } } },
    stock: { "marathon-pe": { p9: { M: cell(0) } }, hub2: { p9: { M: cell(5) } }, central: {}, trophy: {}, hub1: {} },
    openIndex: { "marathon-pe": { p9: { M: { qty: -5, source: "hub2", createdAt: iso(3), runId: "r", refillId: "rrX" } } } },
    refillRequests: { rrX: { productId: "p9", size: "M", qty: 1, requestingLocation: "marathon-pe", status: "cancelled", cancelReason: "no_longer_needed", resolvedAt: iso(1), createdAt: iso(3) } },
  }));
  assert.ok(plan.closes.some((c) => c.dest === "marathon-pe"), "the dead lock closes");
  assert.equal(plan.intents.find((i) => i.dest === "marathon-pe")?.qty, 2, "and the shortfall re-asks in the same scan");
});
