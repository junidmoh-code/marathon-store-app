// ─── PAPER BAGS: ONE CATEGORY POLICY, ONE FULL TOP-UP ────────────────────────
//
// Junid, 16 Oct 2026: paper bags keep 50 and ask at 10. Nothing is requested
// while a location holds more than 10; at 10 or below ONE request tops it back
// to 50 (10 on hand → 40, 0 → 50). The 15:00 scan that day raised Hub 2
// requests of x1–x4 instead, because:
//
//   • the new "Paper bag <BRAND> <colour> <size>" records were filed under the
//     Bags category, so they followed the HANDBAG policy (Hub 2 keep 4, ask at
//     0) — not the 50/10 Junid had typed per product on the older bags; and
//   • every request was capped at min(gap, the source's free stock,
//     maxUnitsPerIntent 20), and an open request was later shrunk to the
//     source's stock again, or withdrawn outright once the source ran dry.
//
// Every test asserts a QUANTITY or a resolved target, never that a list exists.
//
// Run: cd functions && node --test test/paper-bag-bulk.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, policyCategoryKey } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-10-16T13:00:00.000Z");
const iso = (minsAgo) => new Date(NOW - minsAgo * 60e3).toISOString();
const cell = (qty) => ({ qty });

// The live shapes. `fresh` is p1792153215900 as staff created it on 16 Oct:
// Bags category, one size. `keyed` is a paper bag after the re-key. `handbag`
// is a real bag in the same Bags category — it must keep the handbag numbers.
const BAG = { category: "Accessories", subcategory: "Bags", productType: "clothing", sizes: ["_"] };
const PRODUCTS = {
  fresh: { id: "fresh", name: "Paper bag boss white medium", categoryKey: "bags", ...BAG },
  keyed: { id: "keyed", name: "Paper bag DIOR white large", categoryKey: "paper-bags", ...BAG },
  legacy: { id: "legacy", name: "Brunello cucinelli paperbag ( small size)", categoryKey: "bags", ...BAG },
  sized: { id: "sized", name: "Timberland paperbag", categoryKey: "packaging", category: "Accessories", subcategory: "Bags", productType: "clothing", sizes: ["L"] },
  handbag: { id: "handbag", name: "Louis Vuitton Keepall bag black", categoryKey: "bags", ...BAG },
};
// Live /config/refillEngine/categoryPolicy/bags (the handbag policy), plus the
// paper-bag entry this change arms: Hub 2 for every paper bag, the two shops
// for the paper bags they carry.
const PAPER = { target: 50, reorderPoint: 10, minQty: 25 };
const POLICY = {
  bags: { hub2: { target: 4, reorderPoint: 0, minQty: 2 }, trophy: { target: 2, reorderPoint: 0, minQty: 1 } },
  "paper-bags": { hub2: { ...PAPER }, "marathon-pe": { ...PAPER, carriedOnly: true }, trophy: { ...PAPER, carriedOnly: true } },
};
function cfg(over = {}) {
  return {
    enabled: true,
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: true, maxIntentsPerRun: 75, maxFootwearIntentsPerRun: 75, maxUnitsPerIntent: 20,
    defaultRunByStore: { hub2: { L: 3 }, "marathon-pe": { L: 2 }, trophy: { L: 2 } },
    categoryPolicy: POLICY,
    ...over,
  };
}
function snap(over = {}) {
  return {
    nowMs: NOW, config: cfg(over.config), products: over.products || PRODUCTS,
    targets: over.targets || {}, stock: over.stock,
    openIndex: over.openIndex || {}, refillRequests: over.refillRequests || {}, orders: over.orders || {},
    movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {},
  };
}
const hub2Stock = (pid, hub2, central) => ({
  hub2: hub2 === null ? {} : { [pid]: { _: cell(hub2) } },
  central: { [pid]: { _: cell(central) } },
  "marathon-pe": {}, trophy: {},
});
const intentsFor = (plan, pid, dest) => plan.intents.filter((i) => i.productId === pid && i.dest === dest);
const qtyFor = (plan, pid, dest) => intentsFor(plan, pid, dest).map((i) => i.qty);

// ── 1. THE ASK-AT LINE ───────────────────────────────────────────────────────
test("keep 50 ask at 10: at 12 and 11 on hand Hub 2 asks for nothing", () => {
  for (const have of [12, 11]) {
    const plan = computeRefillPlan(snap({ stock: hub2Stock("keyed", have, 200) }));
    assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [], `${have} on hand is above ask-at 10`);
  }
});

test("keep 50 ask at 10: at 10 on hand ONE request for 40", () => {
  const plan = computeRefillPlan(snap({ stock: hub2Stock("keyed", 10, 200) }));
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [40]);
  assert.equal(intentsFor(plan, "keyed", "hub2")[0].source, "central");
});

test("keep 50 ask at 10: at 0 on hand ONE request for 50 (above maxUnitsPerIntent 20)", () => {
  const plan = computeRefillPlan(snap({ stock: hub2Stock("keyed", 0, 200) }));
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [50]);
});

test("a source short of the gap still gets the FULL top-up: Central holds 33, Hub 2 asks for 50", () => {
  const plan = computeRefillPlan(snap({ stock: hub2Stock("keyed", 0, 33) }));
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [50], "never shrunk to the 33 Central holds");
});

test("on hand + inbound is what the ask-at line reads: 4 on hand + 8 coming = 12 → nothing new", () => {
  const plan = computeRefillPlan(snap({
    stock: hub2Stock("keyed", 4, 200),
    openIndex: { hub2: { keyed: { _: { refillId: "rr1", qty: 8, source: "central", createdAt: iso(30) } } } },
    refillRequests: { rr1: { status: "open", productId: "keyed", size: "_", qty: 8, requestingLocation: "hub2", createdAt: iso(30), createdFrom: { engine: true, source: "central" } } },
  }));
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), []);
});

// ── 2. PARTIAL FULFILMENT: the remainder stays open ──────────────────────────
// Central had 33, Hub 2 asked for 50, Central sent 33 (RefillQueue's partial
// send: qty → 17, sentQty 33; the engine lock still says 50). Central is now
// EMPTY and Hub 2 holds 33 — above ask-at. The 17 must stay open.
test("fulfil sends 33 of 50: the request is NOT withdrawn and its 17 stays open", () => {
  const plan = computeRefillPlan(snap({
    stock: { hub2: { keyed: { _: cell(33) } }, central: { keyed: { _: cell(0) } }, "marathon-pe": {}, trophy: {} },
    openIndex: { hub2: { keyed: { _: { refillId: "rr1", qty: 50, source: "central", createdAt: iso(90) } } } },
    refillRequests: { rr1: { status: "open", productId: "keyed", size: "_", qty: 17, sentQty: 33, requestingLocation: "hub2", createdAt: iso(90), createdFrom: { engine: true, source: "central" } } },
  }));
  assert.deepEqual(plan.closes.filter((c) => c.refillId === "rr1"), [], "not withdrawn as awaiting_upstream / unfillable");
  const rz = plan.resizes.filter((r) => r.refillId === "rr1").map((r) => [r.from, r.to]);
  assert.deepEqual(rz, [[50, 17]], "the lock is trued to the open 17, never to Central's 0");
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [], "and nothing new is raised beside it");
});

test("an open paper-bag request is never shrunk to the source's stock", () => {
  // Raised for 50 at 0 on hand; Central has since dropped to 6.
  const plan = computeRefillPlan(snap({
    stock: { hub2: { keyed: { _: cell(0) } }, central: { keyed: { _: cell(6) } }, "marathon-pe": {}, trophy: {} },
    openIndex: { hub2: { keyed: { _: { refillId: "rr1", qty: 50, source: "central", createdAt: iso(90) } } } },
    refillRequests: { rr1: { status: "open", productId: "keyed", size: "_", qty: 50, requestingLocation: "hub2", createdAt: iso(90), createdFrom: { engine: true, source: "central" } } },
  }));
  assert.deepEqual(plan.resizes.filter((r) => r.refillId === "rr1"), [], "50 stays 50");
  assert.deepEqual(plan.closes.filter((c) => c.refillId === "rr1"), []);
});

// ── 3. ONE CATEGORY: new paper bags inherit, handbags do not ─────────────────
test("a NEW paper bag filed under Bags resolves the paper-bag policy, not the handbag one", () => {
  assert.equal(policyCategoryKey(PRODUCTS.fresh), "paper-bags");
  assert.equal(policyCategoryKey(PRODUCTS.legacy), "paper-bags");
  assert.equal(policyCategoryKey(PRODUCTS.sized), "paper-bags", "the Packaging-keyed paper bags too");
  const t = resolveTarget({ config: cfg(), products: PRODUCTS, stock: hub2Stock("fresh", null, 3), targets: {} }, "hub2", "fresh", "_");
  assert.deepEqual(t && [t.target, t.reorderPoint, t.source], [50, 10, "category_policy"]);
});

test("the 16 Oct 15:00 case: Paper bag omega red small, Hub 2 holds none, Central 3 → ONE request for 50, not 3", () => {
  const products = { omega: { id: "omega", name: "Paper bag omega red small", categoryKey: "bags", ...BAG } };
  const plan = computeRefillPlan(snap({ products, stock: hub2Stock("omega", null, 3) }));
  assert.deepEqual(qtyFor(plan, "omega", "hub2"), [50]);
});

test("a handbag in the same Bags category keeps the handbag numbers and the source cap", () => {
  assert.equal(policyCategoryKey(PRODUCTS.handbag), "bags");
  const plan = computeRefillPlan(snap({ stock: hub2Stock("handbag", 0, 3) }));
  assert.deepEqual(qtyFor(plan, "handbag", "hub2"), [3], "keep 4, capped at Central's 3 — unchanged");
});

// ── 4. EVERY LOCATION THAT CARRIES PAPER BAGS ────────────────────────────────
test("a shop that carries the bag asks for its full top-up; a shop that does not asks for nothing", () => {
  const stock = {
    hub2: { keyed: { _: cell(20) } }, central: { keyed: { _: cell(0) } },
    trophy: { keyed: { _: cell(0) } },          // carries it, empty
    "marathon-pe": {},                           // never carried it
  };
  const plan = computeRefillPlan(snap({ stock }));
  assert.deepEqual(qtyFor(plan, "keyed", "trophy"), [50], "full 50 from Hub 2 even though Hub 2 holds 20");
  assert.deepEqual(qtyFor(plan, "keyed", "marathon-pe"), []);
});

// ── 5. A PRODUCT ROW ON A PAPER BAG GETS THE SAME QUANTITY RULE ──────────────
// The 7 legacy paper bags whose only size is "L" or "3" cannot be governed by a
// one-size entry (it speaks for "_"); they keep a product row with the category
// numbers. Brunello (live): Hub 2 row 50/10, Hub 2 holds 5, Central 1 → was x1.
test("a paper bag on a product row (50 / ask 10) asks for the full gap: Hub 2 5 on hand, Central 1 → 45", () => {
  const targets = { hub2: { legacy: { _: { target: 50, minQty: 25, reorderPoint: 10, source: "policy_target" } } } };
  const plan = computeRefillPlan(snap({ targets, stock: hub2Stock("legacy", 5, 1) }));
  assert.deepEqual(qtyFor(plan, "legacy", "hub2"), [45]);
});

test("a sized legacy paper bag on an L row: Hub 2 holds 0 L, Central 234 → 50", () => {
  const targets = { hub2: { sized: { L: { target: 50, minQty: 25, reorderPoint: 10, source: "paper_bag_policy" } } } };
  const stock = { hub2: { sized: { L: cell(0) } }, central: { sized: { L: cell(234) } }, "marathon-pe": {}, trophy: {} };
  const plan = computeRefillPlan(snap({ targets, stock }));
  assert.deepEqual(qtyFor(plan, "sized", "hub2"), [50]);
});

test("a paper bag on a number with NO ask-at is not a bulk cell: ordinary top-up, capped at the source", () => {
  // A product row of keep 5 with no ask-at (an eager row) — the full-top-up
  // rule is about the min/max policy, not about every paper-bag number.
  const targets = { hub2: { keyed: { _: { target: 5, minQty: 3, source: "policy_target" } } } };
  const plan = computeRefillPlan(snap({ targets, stock: hub2Stock("keyed", 0, 2) }));
  assert.deepEqual(qtyFor(plan, "keyed", "hub2"), [2]);
});
