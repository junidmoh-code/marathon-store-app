// ─── FOOTWEAR TARGETING — tests ───────────────────────────────────────────────
// Rule-based targets for shoes, gated on their OWN kill switch so clothing and
// footwear can each be killed without touching the other.
//
// Three properties carry this feature, and most of this file pins them rather
// than the happy path:
//
//   1. INERT UNTIL SWITCHED ON — with /config/refillEngine/footwearTargets absent
//      the engine must behave exactly as it did before this change. That is what
//      makes the deploy safe ahead of the config write (#277 pattern).
//   2. THE TWO SWITCHES ARE INDEPENDENT — footwear must keep working with
//      ruleBasedTargets false, and clothing must keep working with footwearTargets
//      false. resolveTarget early-returns on the clothing switch, so the footwear
//      branch sits BEFORE it; a "tidy-up" that merges the branches would couple
//      them silently and only this test would notice.
//   3. HALF SIZES RESOLVE — the run map is keyed by encodeSizeKey, because RTDB
//      cannot store "5.5" as a key. A raw lookup would miss 538 live cells.
//
// Run: cd functions && node --test test/footwear-targeting.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-07-30T09:00:00.000Z");

// Live shapes. The shoe has NO productType on purpose — 801 of 1,369 live
// footwear records are like this, which is exactly why isFootwear keys off
// category rather than productType.
const SHOE = { id: "sh1", name: "Nike Air Max 1", category: "Footwear", subcategory: "Sneakers", sizes: ["5.5", "6", "7"] };
const TEE = { id: "cl1", name: "Chelsea jersey", category: "Clothing", productType: "clothing", sizes: ["S", "M", "L"] };

const RUN = { hub1: { "5_5": 2, 6: 3, 7: 2 }, hub2: { "5_5": 2, 6: 3, 7: 2 } };

function cfg(over = {}) {
  return {
    routes: { hub1: "central", hub2: "central" },
    mode: { hub1: "live", hub2: "live" },
    footwearRunByLocation: RUN,
    defaultRunByStore: { hub2: { S: 2, M: 3, L: 3 } },
    maxUnitsPerIntent: 20,
    maxIntentsPerRun: 500,
    ...over,
  };
}

// hub1/hub2 carry the shoe (cells exist, some empty); central supplies.
function snap(over = {}) {
  return {
    nowMs: NOW,
    config: cfg(over.config),
    products: { sh1: SHOE, cl1: TEE },
    stock: {
      hub1: { sh1: { "5_5": { qty: 0 }, 6: { qty: 0 }, 7: { qty: 5 } } },
      hub2: { sh1: { "5_5": { qty: 0 }, 6: { qty: 1 } }, cl1: { S: { qty: 0 }, M: { qty: 0 } } },
      central: { sh1: { "5_5": { qty: 40 }, 6: { qty: 40 }, 7: { qty: 40 } }, cl1: { S: { qty: 40 }, M: { qty: 40 } } },
    },
    targets: {},
    openIndex: {},
    refillRequests: {},
    orders: {},
    movements: [],
    ...over.snap,
  };
}

const ctx = (config) => ({ targets: {}, config, products: { sh1: SHOE, cl1: TEE }, stock: snap().stock });

// ── 1. INERT UNTIL SWITCHED ON ───────────────────────────────────────────────
test("footwearTargets ABSENT → a shoe resolves NO target", () => {
  assert.equal(resolveTarget(ctx(cfg()), "hub1", "sh1", "6"), null);
});

test("footwearTargets false / garbage / array → still OFF (fail-safe)", () => {
  for (const v of [false, null, 0, "true", ["hub1"], 1]) {
    assert.equal(resolveTarget(ctx(cfg({ footwearTargets: v })), "hub1", "sh1", "6"), null,
      `footwearTargets=${JSON.stringify(v)} must not arm footwear`);
  }
});

test("switch absent → the whole plan contains NO footwear intent", () => {
  const plan = computeRefillPlan(snap());
  assert.equal(plan.intents.filter((i) => i.productId === "sh1").length, 0);
});

// ── 2. ARMED BEHAVIOUR ───────────────────────────────────────────────────────
test("footwearTargets true → the location's standard run applies", () => {
  const t = resolveTarget(ctx(cfg({ footwearTargets: true })), "hub1", "sh1", "6");
  assert.deepEqual(t, { target: 3, minQty: 2, reorderPoint: null, source: "footwear_default" });
});

test("per-destination map arms ONLY the listed location", () => {
  const c = cfg({ footwearTargets: { hub1: true } });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "6").target, 3);   // armed
  assert.equal(resolveTarget(ctx(c), "hub2", "sh1", "6"), null);        // absent from map → OFF
});

test("a location the shoe is NOT carried at gets no target (storeCarries gate)", () => {
  const c = cfg({ footwearTargets: true, routes: { hub1: "central", hub2: "central", hub3: "central" } });
  assert.equal(resolveTarget(ctx(c), "hub3", "sh1", "6"), null);
});

test("a CATALOG size absent from the run map gets no target", () => {
  // Must use a size the product actually comes in, else productSizes() rejects it
  // before the run map is ever consulted and the test proves nothing. "7" is a
  // catalog size; this run map deliberately omits it. (CodeRabbit #289.)
  const c = cfg({ footwearTargets: true, footwearRunByLocation: { hub1: { "5_5": 2, 6: 3 } } });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "6").target, 3);   // in the map
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "7"), null);        // catalog size, no standard
});

// ── 3. HALF SIZES — the encodeSizeKey contract ───────────────────────────────
test("5.5 resolves through the ENCODED run key \"5_5\"", () => {
  const t = resolveTarget(ctx(cfg({ footwearTargets: true })), "hub1", "sh1", "5.5");
  assert.equal(t?.target, 2, "half size must resolve — 538 live cells depend on it");
});

test("a run map keyed with a RAW \"5.5\" cannot resolve (proves why encoding is required)", () => {
  // This is the bug the encoding prevents. RTDB would reject the key outright,
  // but if such a map ever reached the engine it must fail closed, not half-work.
  const c = cfg({ footwearTargets: true, footwearRunByLocation: { hub1: { "5.5": 2 } } });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "5.5"), null);
});

// ── 4. reorderPoint FROM CONFIG (the launch throttle) ────────────────────────
test("footwearReorderPoint 0 → propose only at zero; absent → null", () => {
  const armed = cfg({ footwearTargets: true, footwearReorderPoint: { hub1: 0 } });
  assert.equal(resolveTarget(ctx(armed), "hub1", "sh1", "6").reorderPoint, 0);
  assert.equal(resolveTarget(ctx(cfg({ footwearTargets: true })), "hub1", "sh1", "6").reorderPoint, null);
});

test("a negative / garbage reorderPoint falls back to null, never starves the cell", () => {
  for (const rp of [-1, "0", NaN, {}]) {
    const c = cfg({ footwearTargets: true, footwearReorderPoint: { hub1: rp } });
    assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "6").reorderPoint, null,
      `reorderPoint=${JSON.stringify(rp)} must not arm the gate`);
  }
});

test("reorderPoint 0 suppresses a BELOW-TARGET cell that still holds stock", () => {
  // The cell must be below target (so it would otherwise propose) AND above the
  // reorder point — only then does the gate decide. Size 6 at qty 1 against target
  // 3 is exactly that; the earlier version used a size already above target, which
  // `deficit <= 0` skipped before the gate ran. (CodeRabbit #289.)
  const withStock = snap({ config: { footwearTargets: { hub1: true }, footwearReorderPoint: { hub1: 0 } } });
  withStock.stock.hub1.sh1["6"] = { qty: 1 };            // below target 3, above rp 0
  const gated = computeRefillPlan(withStock).intents.filter((i) => i.productId === "sh1" && i.dest === "hub1");
  assert.deepEqual(gated.map((i) => i.sizeKey).sort(), ["5_5"], "size 6 holds 1 — above reorderPoint 0, must stay quiet");

  // Same cell, gate OFF → it proposes. Proves the gate is what suppressed it.
  const ungated = snap({ config: { footwearTargets: { hub1: true } } });
  ungated.stock.hub1.sh1["6"] = { qty: 1 };
  const open = computeRefillPlan(ungated).intents.filter((i) => i.productId === "sh1" && i.dest === "hub1");
  // 7 is absent from BOTH lists — it holds 5 against target 2, so it is above
  // target and never proposes regardless of the gate. Only 6 moves between the
  // two lists, which is exactly the cell the gate decides.
  assert.deepEqual(open.map((i) => i.sizeKey).sort(), ["5_5", "6"]);
});

// ── 5. EXPLICIT ROWS STILL WIN ───────────────────────────────────────────────
test("an explicit /stock_targets row overrides the footwear rule", () => {
  const c = cfg({ footwearTargets: true });
  const t = resolveTarget(
    { targets: { hub1: { sh1: { 6: { target: 9, minQty: 4 } } } }, config: c, products: { sh1: SHOE }, stock: snap().stock },
    "hub1", "sh1", "6",
  );
  assert.equal(t.target, 9);
  assert.equal(t.source, "explicit");
});

// ── 6. THE TWO SWITCHES ARE INDEPENDENT (the load-bearing pair) ──────────────
test("ruleBasedTargets FALSE does not kill footwear", () => {
  // Regression guard for the early-return coupling: if the footwear branch were
  // moved below `if (!ruleTargetsEnabled(...)) return null`, this returns null.
  const c = cfg({ footwearTargets: true, ruleBasedTargets: false });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "6")?.target, 3,
    "footwear must survive the CLOTHING kill switch being off");
});

test("footwearTargets FALSE does not kill clothing", () => {
  const c = cfg({ footwearTargets: false, ruleBasedTargets: true });
  assert.equal(resolveTarget(ctx(c), "hub2", "cl1", "M")?.target, 3);
});

test("both switches on → each class resolves from its OWN run map", () => {
  const c = cfg({ footwearTargets: true, ruleBasedTargets: true });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "6").source, "footwear_default");
  assert.equal(resolveTarget(ctx(c), "hub2", "cl1", "M").source, "default");
});

// ── 7. CLOTHING IS UNPERTURBED — the byte-identical claim ────────────────────
test("turning footwear ON leaves every CLOTHING output identical", () => {
  const clothingOnly = (p) => ({
    intents: p.intents.filter((i) => i.productId === "cl1"),
    closes: p.closes.filter((c) => c.pid === "cl1"),
    resizes: p.resizes.filter((r) => r.pid === "cl1"),
    belowTarget: (p.exceptions?.belowTarget?.items || []).filter((b) => b.pid === "cl1"),
    excess: (p.exceptions?.excess?.items || []).filter((e) => e.pid === "cl1"),
  });
  const off = computeRefillPlan(snap({ config: { ruleBasedTargets: true } }));
  const on = computeRefillPlan(snap({ config: { ruleBasedTargets: true, footwearTargets: true } }));

  assert.deepEqual(clothingOnly(on), clothingOnly(off),
    "footwear targeting must not alter a single clothing intent, close, resize or exception");
  // ANTI-VACUITY. A deepEqual of two empty shapes passes for the wrong reason, so
  // pin that BOTH sides of the comparison carry real content: clothing must be
  // non-empty (else "identical" proves nothing) and footwear must actually have
  // changed (else the switch did nothing and the test is not exercising it).
  // Measured: clothing 2 intents in both runs; footwear 0 → 5.
  assert.equal(clothingOnly(off).intents.length, 2, "clothing side must be non-empty or the comparison is vacuous");
  assert.ok(on.intents.filter((i) => i.productId === "sh1").length > 0, "footwear intents must exist when armed");
  assert.equal(off.intents.filter((i) => i.productId === "sh1").length, 0);
});

test("a clothing product is never resolved by the footwear rule", () => {
  // TEE is category Clothing, so isFootwear is false even with the switch on.
  const c = cfg({ footwearTargets: true, ruleBasedTargets: false });
  assert.equal(resolveTarget(ctx(c), "hub2", "cl1", "M"), null,
    "clothing must not leak into footwear targeting when its own switch is off");
});

// ── 8. THE SHARED CAP MUST NOT DISPLACE CLOTHING (CodeRabbit #289, major) ────
// maxIntentsPerRun is dealt round-robin across destinations. Shared, footwear
// would take slots from clothing — inside hub2, which carries both classes, and
// by adding hub1 as another queue taking turns. With the live cap of 75 against a
// 578-993 footwear backlog that is a certainty, not a risk. The classes are
// therefore capped independently.
function capSnap(config = {}) {
  // 40 clothing sizes at hub2 and 40 footwear sizes at hub1, all empty, all
  // suppliable — enough to saturate a small cap from both classes at once.
  const sizes = Array.from({ length: 40 }, (_, i) => String(i + 1));
  const cl = { id: "clBig", name: "Tee", category: "Clothing", productType: "clothing", sizes };
  const sh = { id: "shBig", name: "Shoe", category: "Footwear", sizes };
  const zero = Object.fromEntries(sizes.map((s) => [s, { qty: 0 }]));
  const full = Object.fromEntries(sizes.map((s) => [s, { qty: 99 }]));
  const run = Object.fromEntries(sizes.map((s) => [s, 3]));
  return {
    nowMs: NOW,
    config: {
      routes: { hub1: "central", hub2: "central" },
      mode: { hub1: "live", hub2: "live" },
      ruleBasedTargets: true,
      defaultRunByStore: { hub2: run },
      footwearRunByLocation: { hub1: run },
      maxIntentsPerRun: 10,
      maxUnitsPerIntent: 20,
      ...config,
    },
    products: { clBig: cl, shBig: sh },
    stock: { hub2: { clBig: zero }, hub1: { shBig: zero }, central: { clBig: full, shBig: full } },
    targets: {}, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  };
}

test("a saturated cap gives clothing IDENTICAL intents with footwear on or off", () => {
  const off = computeRefillPlan(capSnap());
  const on = computeRefillPlan(capSnap({ footwearTargets: true, maxFootwearIntentsPerRun: 10 }));
  const clothing = (p) => p.intents.filter((i) => i.productId === "clBig").map((i) => i.sizeKey);

  assert.equal(off.intents.length, 10, "cap must actually bind, else this proves nothing");
  assert.deepEqual(clothing(on), clothing(off),
    "footwear must not take a single clothing slot when the cap is saturated");
  assert.equal(clothing(on).length, 10, "clothing keeps its FULL allocation");
  assert.equal(on.intents.filter((i) => i.productId === "shBig").length, 10, "footwear is additive, under its own cap");
});

test("the footwear cap is independent of maxIntentsPerRun", () => {
  const p = computeRefillPlan(capSnap({ footwearTargets: true, maxFootwearIntentsPerRun: 3 }));
  assert.equal(p.intents.filter((i) => i.productId === "shBig").length, 3);
  assert.equal(p.intents.filter((i) => i.productId === "clBig").length, 10);   // clothing untouched
  assert.equal(p.policy.footwearThrottled, true);
  assert.equal(p.policy.throttled, true);
});

test("run policy records footwear rollout state per destination", () => {
  const p = computeRefillPlan(capSnap({ footwearTargets: { hub1: true } }));
  assert.deepEqual(p.policy.footwearTargets, { hub1: true, hub2: false });
});

test("footwear stays OUT of the Health-score denominator", () => {
  // HealthView divides by stats.managedCells. Footwear adds ~6,445 managed cells
  // against clothing's ~8,400, so folding them in would move the clothing Health
  // score the moment the switch flips. (CodeRabbit #289.)
  const off = computeRefillPlan(capSnap());
  const on = computeRefillPlan(capSnap({ footwearTargets: true }));
  assert.ok(off.stats.managedCells > 0, "denominator must be non-empty or this proves nothing");
  assert.equal(on.stats.managedCells, off.stats.managedCells, "clothing denominator must not move");
  assert.ok(on.stats.footwearManagedCells > 0, "footwear must be counted, just separately");
  assert.equal(off.stats.footwearManagedCells, 0);
});
