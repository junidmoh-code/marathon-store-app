// ─── THE INTRODUCE ROW'S SHAPE — WHAT `{ introduce: true }` ALONE DOES ────────
//
// scripts/stage-introduce-set.mjs writes rows carrying `introduce: true` and NO
// `target`. That omission is the whole design of the row, and it is the kind of
// design that is invisible until it is wrong: the row looks harmless either way in
// /stock_targets, and the difference only shows up months later as a shop stuck on a
// number nobody remembers writing.
//
// So the claims the script's header makes are pinned here against the REAL engine:
//
//   1. an introduce-only row arms the location and lets the SIZE RUN decide the
//      numbers — source "default", not "explicit";
//   2. adding a numeric `target` to that same row changes the answer to a pinned
//      explicit one that outranks the run. This is the contrast that justifies the
//      omission, and it is asserted rather than described;
//   3. the opt-in works while the provenance index is UNREADY, because it is owner
//      intent read straight off the row rather than derived from the index;
//   4. it is bounded — the same product at another location, and another product at
//      the same location, stay dark.
//
// Every fixture states `provenance`/`provenanceMeta` literally. The withProvenance()
// helper maps cell-existence → carries, which is the bug this whole area removed.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-18T09:00:00.000Z");
const V = 1;
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-18T06:00:00.000Z", pairs: 1, version: V }]));
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: "2026-08-03T21:05:09.017Z" });

// The real pid from the Option B decision. Named by pid — the catalogue holds twin
// names and a name here would be the bug PR #307 fixed.
const NOCTA = "p1784206551366";       // "Nike NOCTA Golf T-Shirt White"
const OTHER = "p1783424090385";       // "Diesel T-Shirt Black" — also seed-only, NOT introduced

const PRODUCTS = {
  [NOCTA]: { name: "Nike NOCTA Golf T-Shirt White", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L", "XL", "XXL"] },
  [OTHER]: { name: "Diesel T-Shirt Black", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L", "XL", "XXL"] },
};

// Live config, trimmed. hub2's run is the one the introduction hands the decision to.
const CONFIG = {
  routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: true,
  defaultRunByStore: {
    hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
    "marathon-pe": { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  // hub2 is `live` in production, so the fixture says so — an intent's `mode` is
  // the difference between a request the warehouse sees and one it does not.
  mode: { hub2: "live", "marathon-pe": "live", trophy: "live", hub1: "shadow" },
  maxIntentsPerRun: 75,
};

// The row the script writes: the flag and its provenance metadata, no numbers.
const INTRODUCE_ROW = {
  introduce: true,
  introducedAt: "2026-08-18T09:00:00.000Z",
  introducedBy: "scripts/stage-introduce-set.mjs",
  note: "Option B introduce set, owner decision 2026-08-18",
};
const introduceRows = () => ({
  S: { ...INTRODUCE_ROW }, M: { ...INTRODUCE_ROW }, L: { ...INTRODUCE_ROW },
  XL: { ...INTRODUCE_ROW }, XXL: { ...INTRODUCE_ROW },
});

const ctx = (over = {}) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {},
  stock: { hub2: { [NOCTA]: { S: seed(), M: seed(), L: seed(), XL: seed(), XXL: seed() } } },
  provenance: {}, provenanceMeta: ready("hub2", "marathon-pe", "trophy"),
  ...over,
});

// ═══ 1. THE RUN DECIDES, NOT THE ROW ═════════════════════════════════════════
test("introduce-only row arms the location and leaves the numbers to the size run", () => {
  const c = ctx({ targets: { hub2: { [NOCTA]: introduceRows() } } });
  // hub2's run: S2 M3 L3 XL2 XXL2. Every one must come back as the RULE's answer.
  for (const [size, want] of [["S", 2], ["M", 3], ["L", 3], ["XL", 2], ["XXL", 2]]) {
    const t = resolveTarget(c, "hub2", NOCTA, size);
    assert.ok(t, `expected a target for ${size}`);
    assert.strictEqual(t.target, want, `${size} should take hub2's run value`);
    assert.strictEqual(t.source, "default", `${size} must resolve through the size run, not as an explicit pin`);
    // The rule-based branch carries no reorder point — pinning one from a row here
    // would change clothing behaviour network-wide from a row nobody reviewed.
    assert.strictEqual(t.reorderPoint, null);
  }
});

test("a change to the size run FOLLOWS THROUGH — which is the point of omitting target", () => {
  const raised = { ...CONFIG, defaultRunByStore: { ...CONFIG.defaultRunByStore, hub2: { ...CONFIG.defaultRunByStore.hub2, M: 6 } } };
  const c = ctx({ config: raised, targets: { hub2: { [NOCTA]: introduceRows() } } });
  assert.strictEqual(resolveTarget(c, "hub2", NOCTA, "M").target, 6);
});

// ═══ 2. THE CONTRAST THAT JUSTIFIES THE OMISSION ═════════════════════════════
test("adding a numeric target to the SAME row pins it and outranks the run", () => {
  const pinned = { hub2: { [NOCTA]: { ...introduceRows(), M: { ...INTRODUCE_ROW, target: 1, minQty: 1 } } } };
  const c = ctx({ targets: pinned });
  const t = resolveTarget(c, "hub2", NOCTA, "M");
  assert.strictEqual(t.source, "explicit", "a numeric target makes it an explicit row");
  assert.strictEqual(t.target, 1, "…and the run's 3 is overruled");
  // Its neighbours, still introduce-only, still take the run.
  assert.strictEqual(resolveTarget(c, "hub2", NOCTA, "L").target, 3);
  assert.strictEqual(resolveTarget(c, "hub2", NOCTA, "L").source, "default");
});

test("target: 0 on an introduce row is still the documented off switch", () => {
  // Belt-and-braces: the introduce flag must not defeat a deliberate exclusion.
  const c = ctx({ targets: { hub2: { [NOCTA]: { ...introduceRows(), XXL: { ...INTRODUCE_ROW, target: 0, minQty: 0 } } } } });
  const t = resolveTarget(c, "hub2", NOCTA, "XXL");
  assert.strictEqual(t.source, "explicit");
  assert.strictEqual(t.target, 0);
});

// ═══ 3. IT WORKS WHILE THE INDEX IS UNREADY ══════════════════════════════════
test("the opt-in survives an unready provenance index", () => {
  // No sentinel at all — the state the network is in until the backfill claims
  // authority. Everything else at hub2 goes dark; this row does not.
  const c = ctx({ targets: { hub2: { [NOCTA]: introduceRows() } }, provenanceMeta: {} });
  assert.strictEqual(resolveTarget(c, "hub2", NOCTA, "M").target, 3);
  assert.strictEqual(resolveTarget(c, "hub2", OTHER, "M"), null);
});

test("without the row, a seed-only location resolves nothing even with a ready index", () => {
  // The predicate's whole purpose, restated as the baseline this row departs from.
  const c = ctx();
  for (const size of ["S", "M", "L", "XL", "XXL"]) {
    assert.strictEqual(resolveTarget(c, "hub2", NOCTA, size), null);
  }
});

// ═══ 4. BOUNDED TO THE PAIR IT NAMES ═════════════════════════════════════════
test("the introduction is bounded to (location, product) and leaks to neither axis", () => {
  const c = ctx({
    targets: { hub2: { [NOCTA]: introduceRows() } },
    stock: {
      hub2: { [NOCTA]: { M: seed() }, [OTHER]: { M: seed() } },
      "marathon-pe": { [NOCTA]: { M: seed() } },
    },
  });
  assert.strictEqual(resolveTarget(c, "hub2", NOCTA, "M").target, 3, "the named pair arms");
  assert.strictEqual(resolveTarget(c, "hub2", OTHER, "M"), null, "another product at the same shop stays dark");
  assert.strictEqual(resolveTarget(c, "marathon-pe", NOCTA, "M"), null, "the same product at another shop stays dark");
});

// ═══ 5. END TO END — WHAT THE NEXT SCAN ACTUALLY RAISES ══════════════════════
test("the plan raises hub2's full run and nothing else", () => {
  const plan = computeRefillPlan({
    nowMs: NOW, config: CONFIG, products: PRODUCTS,
    targets: { hub2: { [NOCTA]: introduceRows() } },
    stock: {
      central: { [NOCTA]: { S: { qty: 2, v: 0 }, M: { qty: 5, v: 0 }, L: { qty: 4, v: 0 }, XL: { qty: 2, v: 0 }, XXL: { qty: 2, v: 0 } } },
      hub2: { [NOCTA]: { S: seed(), M: seed(), L: seed(), XL: seed(), XXL: seed() }, [OTHER]: { M: seed() } },
    },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    provenance: {}, provenanceMeta: ready("hub2", "marathon-pe", "trophy"),
  });
  const mine = plan.intents.filter((i) => i.productId === NOCTA && i.dest === "hub2");
  const bySize = Object.fromEntries(mine.map((i) => [i.size, i.qty]));
  assert.deepStrictEqual(bySize, { S: 2, M: 3, L: 3, XL: 2, XXL: 2 }, "hub2's full run, against an on-hand of zero");
  assert.strictEqual(mine.reduce((n, i) => n + i.qty, 0), 12);
  // Every one is a REAL request, not a shadow — hub2 is live.
  assert.ok(mine.every((i) => i.mode === "live"), "hub2 is live, so these reach the warehouse");
  assert.ok(mine.every((i) => i.source === "central"), "hub2's route is central");
  assert.strictEqual(plan.intents.filter((i) => i.productId === OTHER).length, 0, "the un-introduced product raises nothing");
  // And nothing is provoked at the shops that source FROM hub2 — the introduction
  // does not cascade to marathon-pe or trophy, which still have no provenance here.
  assert.strictEqual(plan.intents.filter((i) => i.productId === NOCTA && i.dest !== "hub2").length, 0);
  assert.deepStrictEqual(plan.errors, [], "no errors");
});
