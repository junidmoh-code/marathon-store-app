// ─── REORDER-POINT GATE — tests ───────────────────────────────────────────────
// The gate turns an explicit target row from a TOP-UP row (ask the moment
// on-hand dips below target) into a MIN/MAX row (stay quiet above the point,
// then ask for the whole gap at once).
//
// The load-bearing property is that it is OPT-IN AND INERT: absent reorderPoint
// must reproduce today's behaviour byte-for-byte, because it is absent on all
// 8,419 live clothing cells. Most of this file is spent pinning that, not the
// new behaviour.
//
// Run: cd functions && node --test test/refill-reorder-point.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan: _rawComputeRefillPlan, resolveTarget: _rawResolveTarget } = require("../lib/refill-engine.cjs");
// storeCarries() now reads the derived provenance index, not cell existence
// (2026-08-17 — a customer-collection husk was arming whole size runs). The
// fixtures below write a /stock cell to mean "this shop stocks this line", which
// was true of the old predicate, so withProvenance() states that in the index's own
// terms and leaves every assertion in this file measuring what it always did.
// It never overrides a `provenance`/`provenanceMeta` a test sets itself.
const { withProvenance } = require("./helpers/provenance.cjs");
const computeRefillPlan = (snap) => _rawComputeRefillPlan(withProvenance(snap, Object.keys(snap?.config?.routes || {})));
// Same for the direct resolveTarget probes: ctx now carries the provenance index.
const resolveTarget = (ctx, ...rest) => _rawResolveTarget(withProvenance(ctx, Object.keys(ctx?.config?.routes || {})), ...rest);

const NOW = Date.parse("2026-07-27T09:00:00.000Z");

// A perfume: one-size "_", category Perfume, NO productType — the exact live
// shape, so these tests also pin that a one-size product reaches the deficit
// loop at all (it does, via its explicit target row).
const PERFUME = { id: "pf1", name: "Queen of Fire", category: "Perfume", subcategory: "Perfume", sizes: ["_"] };

// PE ← hub2 ← central, with plenty upstream so nothing parks as unfillable.
function snap({ peTarget = {}, hubTarget = {}, peHave = 0, hubHave = 50, centralHave = 500 } = {}) {
  return {
    nowMs: NOW,
    config: {
      routes: { "marathon-pe": "hub2", hub2: "central" },
      mode: { "marathon-pe": "live", hub2: "live" },
      ruleBasedTargets: false,          // explicit rows only — isolates the gate
      maxUnitsPerIntent: 20,
    },
    products: { pf1: PERFUME },
    stock: {
      "marathon-pe": { pf1: { _: { qty: peHave } } },
      hub2: { pf1: { _: { qty: hubHave } } },
      central: { pf1: { _: { qty: centralHave } } },
    },
    targets: {
      "marathon-pe": { pf1: { _: peTarget } },
      hub2: { pf1: { _: hubTarget } },
    },
  };
}

const intentFor = (plan, dest) => (plan.intents || []).find((i) => i.dest === dest && i.productId === "pf1");
// The reporting queues live under plan.exceptions, each capped as
// { count, items } — not a bare array, and not on the plan root.
const exc = (plan, key) => (plan.exceptions && plan.exceptions[key] && plan.exceptions[key].items) || [];
const belowFor = (plan, dest) => exc(plan, "belowTarget").find((b) => b.loc === dest && b.pid === "pf1");

// ── 1. ABSENT reorderPoint === today's behaviour ─────────────────────────────

test("no reorderPoint: proposes as soon as on-hand dips below target (unchanged)", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4 },          // no reorderPoint — the live shape
    hubTarget: { target: 10, minQty: 5 },
    peHave: 7,
  }));
  const pe = intentFor(plan, "marathon-pe");
  assert.ok(pe, "a single unit below target must still create a request");
  assert.equal(pe.qty, 1, "qty is target - on-hand, exactly as before");
  assert.ok(belowFor(plan, "marathon-pe"), "and it still reports as below target");
});

test("explicit reorderPoint:null is indistinguishable from the field being absent", () => {
  const withNull = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: null }, hubTarget: { target: 10, minQty: 5 }, peHave: 7,
  }));
  const without = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4 }, hubTarget: { target: 10, minQty: 5 }, peHave: 7,
  }));
  assert.deepEqual(withNull.intents, without.intents, "null must not arm the gate");
  assert.deepEqual(withNull.exceptions, without.exceptions, "and every reporting queue matches too");
});

test("rule-based (clothing) targets carry no reorder point and are untouched", () => {
  const ctx = {
    targets: {},
    config: { ruleBasedTargets: true, defaultRunByStore: { "marathon-pe": { M: 2 } } },
    products: { c1: { productType: "clothing", sizes: ["M"] } },
    stock: { "marathon-pe": { c1: { M: { qty: 1 } } } },
  };
  const t = resolveTarget(ctx, "marathon-pe", "c1", "M");
  assert.equal(t.target, 2);
  assert.equal(t.source, "default");
  assert.equal(t.reorderPoint, null, "the standard run must never invent a reorder point");
});

// ── 2. GARBAGE is fail-safe — falls back to eager top-up, never to silence ───
// A negative point would make `have > rp` true for every non-negative on-hand,
// i.e. permanent silent starvation. These pin that garbage disarms the gate.

for (const [label, rp] of [
  ["negative", -1],
  ["string", "3"],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["boolean", true],
  ["object", { v: 3 }],
]) {
  test(`reorderPoint ${label} disarms the gate (fail-safe: over-order, never starve)`, () => {
    const plan = computeRefillPlan(snap({
      peTarget: { target: 8, minQty: 4, reorderPoint: rp }, hubTarget: { target: 10, minQty: 5 }, peHave: 7,
    }));
    const pe = intentFor(plan, "marathon-pe");
    assert.ok(pe, `reorderPoint ${label} must fall back to today's behaviour, not suppress the cell`);
    assert.equal(pe.qty, 1);
  });
}

// ── 3. THE GATE ITSELF ───────────────────────────────────────────────────────

test("above the point: no request, and the cell stays out of every queue", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 }, hubTarget: { target: 10, minQty: 5 }, peHave: 7,
  }));
  assert.equal(intentFor(plan, "marathon-pe"), undefined, "7 is above the point — no request");
  assert.equal(belowFor(plan, "marathon-pe"), undefined, "must not leak into belowTarget");
  for (const q of ["missingSizes", "awaitingSupplier", "awaitingUpstream", "waitingForStock", "recountNeeded"]) {
    assert.equal(exc(plan, q).some((r) => r.pid === "pf1" && r.loc === "marathon-pe"), false,
      `a healthy above-point shelf must not surface in ${q}`);
  }
});

test("AT the point: fires, and asks for the FULL gap (target - on-hand), not a fixed step", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 }, hubTarget: { target: 10, minQty: 5 }, peHave: 3,
  }));
  const pe = intentFor(plan, "marathon-pe");
  assert.ok(pe, "on-hand == reorderPoint must fire (at or below, not strictly below)");
  assert.equal(pe.qty, 5, "8 - 3 = 5");
});

test("below the point: still the full gap, so a missed trigger self-corrects", () => {
  // The case a fixed step gets wrong: a second store's request already pulled
  // this shelf past its point, so the ask must be 7, not 5.
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 }, hubTarget: { target: 10, minQty: 5 }, peHave: 1,
  }));
  assert.equal(intentFor(plan, "marathon-pe").qty, 7, "8 - 1 = 7");
});

test("reorderPoint 0 is a real row (ask only when empty), not treated as absent", () => {
  const quiet = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 0 }, hubTarget: { target: 10, minQty: 5 }, peHave: 1,
  }));
  assert.equal(intentFor(quiet, "marathon-pe"), undefined, "1 unit left is still above a point of 0");

  const fires = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 0 }, hubTarget: { target: 10, minQty: 5 }, peHave: 0,
  }));
  assert.equal(intentFor(fires, "marathon-pe").qty, 8, "empty shelf fires for the whole target");
});

test("inbound is honoured by the deficit, so an in-flight delivery is never re-asked", () => {
  const s = snap({ peTarget: { target: 8, minQty: 4, reorderPoint: 3 }, hubTarget: { target: 10, minQty: 5 }, peHave: 2 });
  s.openIndex = { "marathon-pe": { pf1: { _: { qty: 6, refillId: "-Oexisting", createdAt: new Date(NOW).toISOString() } } } };
  const plan = computeRefillPlan(s);
  assert.equal(intentFor(plan, "marathon-pe"), undefined,
    "2 on hand + 6 inbound meets the target of 8 — no second ask while stock is in flight");
});

test("minQty still drives priority only, and is unaffected by the gate", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 }, hubTarget: { target: 10, minQty: 5 }, peHave: 3,
  }));
  assert.equal(intentFor(plan, "marathon-pe").priority, "high", "3 < minQty 4 → high, exactly as before");
});

// ── 4. THE HUB2 CASCADE — one request per level per cycle ────────────────────
// The owner's stability question: hub2 at 10 serving one shop drops to 5, its
// own point, so does every shop refill instantly cascade into a hub refill —
// and can that become a loop?

test("cycle 1: shop fires, hub2 stays quiet — units are only RESERVED, not yet gone", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 },
    hubTarget: { target: 10, minQty: 5, reorderPoint: 5 },
    peHave: 3, hubHave: 10,
  }));
  const pe = intentFor(plan, "marathon-pe");
  assert.equal(pe.qty, 5, "shop asks hub2 for its full gap");
  assert.equal(pe.source, "hub2");
  assert.equal(intentFor(plan, "hub2"), undefined,
    "hub2 still physically holds 10 — its cell only drops when the stock actually moves");
  assert.equal((plan.intents || []).length, 1, "exactly ONE request this cycle");
});

test("cycle 2: stock has moved, now hub2 fires — one level per cycle, no loop", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 },
    hubTarget: { target: 10, minQty: 5, reorderPoint: 5 },
    peHave: 8, hubHave: 5,               // the transfer landed: PE topped up, hub2 down to its point
  }));
  assert.equal(intentFor(plan, "marathon-pe"), undefined, "PE is at target — quiet");
  const hub = intentFor(plan, "hub2");
  assert.ok(hub, "hub2 at its own reorder point must now pull from Central");
  assert.equal(hub.qty, 5, "10 - 5 = 5");
  assert.equal(hub.source, "central");
  assert.equal((plan.intents || []).length, 1, "still exactly ONE request this cycle");
});

test("an open lock suppresses re-proposal — the cascade cannot become a request loop", () => {
  const s = snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 },
    hubTarget: { target: 10, minQty: 5, reorderPoint: 5 },
    peHave: 8, hubHave: 5,
  });
  s.openIndex = { hub2: { pf1: { _: { qty: 5, refillId: "-Ohub", createdAt: new Date(NOW).toISOString() } } } };
  const plan = computeRefillPlan(s);
  assert.equal(intentFor(plan, "hub2"), undefined,
    "hub2 already has an open request for this cell — the next scan must not stack a second one");
});

test("hub2 above its point does not pull, even while a shop leg is being served", () => {
  const plan = computeRefillPlan(snap({
    peTarget: { target: 8, minQty: 4, reorderPoint: 3 },
    hubTarget: { target: 10, minQty: 5, reorderPoint: 5 },
    peHave: 3, hubHave: 8,               // hub2 below target (10) but above its point (5)
  }));
  assert.ok(intentFor(plan, "marathon-pe"), "shop still served from hub2's 8 units");
  assert.equal(intentFor(plan, "hub2"), undefined,
    "without the gate hub2 would have asked for 2 here — that churn is what the point removes");
});
