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

test("a size outside the run map gets no target", () => {
  const c = cfg({ footwearTargets: true });
  assert.equal(resolveTarget(ctx(c), "hub1", "sh1", "13"), null);
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

test("reorderPoint 0 suppresses a cell that still holds stock, keeps the empty one", () => {
  const plan = computeRefillPlan(snap({
    config: { footwearTargets: { hub1: true }, footwearReorderPoint: { hub1: 0 } },
  }));
  const sizes = plan.intents.filter((i) => i.productId === "sh1" && i.dest === "hub1").map((i) => i.sizeKey).sort();
  assert.deepEqual(sizes, ["5_5", "6"], "size 7 holds 5 units — above reorderPoint 0, must stay quiet");
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
