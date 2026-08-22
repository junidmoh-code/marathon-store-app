// ─── THE MODEL vs THE ENGINE, WITH GROUPS AND PER-SIZE MAPS ───────────────────
// Run: cd functions && node --test test/policy-groups-differential.test.cjs
//
// category-policy-differential.test.cjs fuzzes the shapes that shipped. This
// file fuzzes the two this build adds, for exactly the reason that one exists:
// both defects the reviews found in the original model were of the shape a
// differential test catches and a hand-written one does not.
//
// The new shapes are worse in that respect, not better. A grouped category
// looks like an UNARMED one to anything reading config.categoryPolicy directly
// — armedLocations empty, no legs, "the next scan asks for nothing" — while the
// engine refills it. That is the under-report direction, the dangerous one, and
// it is precisely what a hand-written test written by the person who just wrote
// the resolver would not think to check.
//
// THE INVARIANT, unchanged:
//
//     model.totalRequests >= engine intents for this category
//     model.totalUnits    >= engine units   for this category
//
// and, because the generator produces no rejections, retries or confirmed-outs,
// the tighter EQUALITY is asserted too. A future generator that adds a
// suppression case relaxes the equality, never the >=.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const { modelCategoryPolicy } = require("../lib/category-policy.cjs");

const NOW = Date.parse("2026-08-22T09:00:00.000Z");

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const LETTERS = ["S", "M", "L", "XL"];
// Half sizes are in deliberately: 5.5 encodes to "5_5", and a policy keyed the
// other way would miss the second-largest size band in the live catalogue.
const NUMERIC = ["6", "7", "5.5", "8"];

// A world in which the category is governed by ONE of four arrangements, each
// generated with the same surrounding mess (legacy rows, empty sources, cells
// in flight, negative counted cells) so the arrangement is the only variable:
//
//   own-uniform    the shipped shape — its own entry, one number per location
//   own-persize    its own entry, a per-size MAP
//   group-uniform  no entry of its own; an ARMED group with one number
//   group-persize  no entry of its own; an ARMED group with a per-size MAP
//   group-disarmed the same group, armed:false — must resolve NOTHING
//   both           its own entry AND membership of an armed group — own wins
function world(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (n) => Math.floor(r() * (n + 1));

  const ARRANGEMENTS = ["own-uniform", "own-persize", "group-uniform", "group-persize", "group-disarmed", "both"];
  const arrangement = ARRANGEMENTS[seed % ARRANGEMENTS.length];
  const perSize = arrangement !== "own-uniform" || r() < 0.5;
  const numeric = r() < 0.5;
  const RUN = numeric ? NUMERIC : LETTERS;

  const nProducts = 1 + int(4);
  const products = {};
  for (let i = 0; i < nProducts; i++) {
    products[`p${i}`] = {
      name: `P${i}`, categoryKey: "cat", productType: "clothing",
      sizes: perSize ? RUN.slice(0, 1 + int(RUN.length - 1)) : (r() < 0.5 ? ["_"] : ["_", ...RUN.slice(0, 2)]),
    };
  }

  const enc = (s) => String(s).replace(/[.#$/[\]\s]/g, "_");
  const locs = ["central", "hub2", "marathon-pe"];
  const stock = { central: {}, hub2: {}, "marathon-pe": {} };
  for (const pid of Object.keys(products)) {
    for (const loc of locs) {
      if (r() < 0.2) continue;
      const cells = {};
      for (const sz of products[pid].sizes) {
        if (r() < 0.25) continue;
        cells[enc(sz)] = { qty: r() < 0.15 ? -int(3) : int(12) };
      }
      if (Object.keys(cells).length) stock[loc][pid] = cells;
    }
  }

  // Explicit rows — including rows on sizes the map does not speak for, which
  // the engine walks and the model must count.
  const targets = {};
  for (const pid of Object.keys(products)) {
    for (const loc of ["hub2", "marathon-pe"]) {
      if (r() < 0.55) continue;
      const sz = pick(products[pid].sizes.concat(perSize ? LETTERS : RUN));
      const t = int(8);
      ((targets[loc] = targets[loc] || {})[pid] = targets[loc][pid] || {})[enc(sz)] =
        r() < 0.15 ? { target: 0, minQty: 0 }
          : { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.4 ? { reorderPoint: int(3) } : {}) };
    }
  }

  const openIndex = {};
  for (const pid of Object.keys(products)) {
    for (const loc of ["hub2", "marathon-pe"]) {
      if (r() < 0.85) continue;
      const sz = pick(products[pid].sizes);
      ((openIndex[loc] = openIndex[loc] || {})[pid] = openIndex[loc][pid] || {})[enc(sz)] =
        { qty: 1 + int(2), createdAt: new Date(NOW - 3600000).toISOString(), refillId: `r${pid}${loc}`, source: "central" };
    }
  }

  // One policy object, built once, then placed either on the category or on a
  // group — so the two arrangements differ ONLY in where the numbers live.
  const buildPolicy = (usePerSizeMap) => {
    const entry = {};
    if (perSize) entry.perSize = true;
    for (const loc of ["hub2", "marathon-pe"]) {
      if (r() < 0.15) continue;
      if (usePerSizeMap) {
        const sizes = {};
        for (const sz of RUN) {
          if (r() < 0.35) continue;
          const t = 1 + int(9);
          sizes[enc(sz)] = { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.5 ? { reorderPoint: int(4) } : {}) };
        }
        if (Object.keys(sizes).length) entry[loc] = { sizes };
      } else {
        const t = 1 + int(9);
        entry[loc] = { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.5 ? { reorderPoint: int(4) } : {}) };
      }
    }
    if (!entry.hub2 && !entry["marathon-pe"]) {
      entry.hub2 = usePerSizeMap
        ? { sizes: { [enc(RUN[0])]: { target: 5, minQty: 3 } } }
        : { target: 5, minQty: 3 };
    }
    return entry;
  };

  const usePerSizeMap = perSize && (arrangement === "own-persize" || arrangement === "group-persize");
  const built = buildPolicy(usePerSizeMap);

  let categoryPolicy = {}, policyGroups;
  if (arrangement === "own-uniform" || arrangement === "own-persize") {
    categoryPolicy = { cat: built };
  } else {
    policyGroups = {
      "the-group": {
        label: "g", memberCategoryKeys: ["cat", "other"],
        armed: arrangement !== "group-disarmed",
        policy: built,
      },
    };
    if (arrangement === "both") categoryPolicy = { cat: buildPolicy(false) };
  }

  const config = {
    mode: { hub2: "live", "marathon-pe": "live" },
    routes: { hub2: "central", "marathon-pe": "hub2" },
    ...(r() < 0.7 ? { maxUnitsPerIntent: 1 + int(30) } : {}),
    ...(r() < 0.7 ? { maxIntentsPerRun: 5 + int(300) } : {}),
    ruleBasedTargets: false,          // isolate the map + explicit rows
    categoryPolicy,
    ...(policyGroups ? { policyGroups } : {}),
  };
  return { config, products, stock, targets, openIndex, arrangement };
}

const runBoth = (w) => {
  const { config, products, stock, targets, openIndex } = w;
  const model = modelCategoryPolicy({
    config, products, stock, targets, openIndex, categoryKey: "cat",
    locations: ["central", "hub2", "marathon-pe"],
    maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
  });
  const plan = computeRefillPlan({
    nowMs: NOW, config, targets, stock, products, openIndex,
    refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {},
  });
  const mine = plan.intents.filter((i) => products[i.productId]?.categoryKey === "cat");
  return { model, engineReq: mine.length, engineUnits: mine.reduce((n, i) => n + i.qty, 0) };
};

test("the model matches the engine across 600 worlds of groups and per-size maps", () => {
  const under = [], diverged = [];
  const byArrangement = {};
  for (let seed = 1; seed <= 600; seed++) {
    const w = world(seed);
    const { model, engineReq, engineUnits } = runBoth(w);
    const a = (byArrangement[w.arrangement] = byArrangement[w.arrangement] || { n: 0, req: 0 });
    a.n += 1; a.req += engineReq;
    if (model.totalRequests < engineReq || model.totalUnits < engineUnits) {
      under.push({ seed, arrangement: w.arrangement, model: [model.totalRequests, model.totalUnits], engine: [engineReq, engineUnits] });
    } else if (model.totalRequests !== engineReq || model.totalUnits !== engineUnits) {
      diverged.push({ seed, arrangement: w.arrangement, model: [model.totalRequests, model.totalUnits], engine: [engineReq, engineUnits] });
    }
  }
  assert.equal(under.length, 0,
    `the model UNDER-reported on ${under.length} world(s) — the dangerous direction: ${JSON.stringify(under.slice(0, 5))}`);
  assert.equal(diverged.length, 0,
    `${diverged.length} world(s) diverged: ${JSON.stringify(diverged.slice(0, 5))}`);

  // The generator must actually reach the interesting arrangements. Without
  // this the assertions above could be green because every world was empty.
  for (const [k, v] of Object.entries(byArrangement)) {
    assert.ok(v.n >= 50, `only ${v.n} ${k} worlds generated`);
    if (k !== "group-disarmed") {
      assert.ok(v.req > 0, `no ${k} world produced a single engine intent — the arrangement is untested`);
    }
  }
});

test("A DISARMED GROUP CONTRIBUTES ZERO IN EVERY GENERATED WORLD", () => {
  // The safety property, asserted over the fuzz rather than one hand-picked
  // case, and stated as a DIFFERENCE rather than an absolute: these worlds also
  // carry explicit /stock_targets rows, and those produce real intents whatever
  // any group says. What must be true is that deleting the disarmed group
  // changes nothing at all — writing it was a no-op.
  let checked = 0, withRows = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const w = world(seed);
    if (w.arrangement !== "group-disarmed") continue;
    checked += 1;
    const withGroup = runBoth(w);
    const withoutGroup = runBoth({ ...w, config: { ...w.config, policyGroups: undefined } });
    if (withGroup.engineReq > 0) withRows += 1;
    assert.equal(withGroup.engineReq, withoutGroup.engineReq,
      `seed ${seed}: a DISARMED group changed the engine's intent count`);
    assert.equal(withGroup.engineUnits, withoutGroup.engineUnits, `seed ${seed}: a disarmed group changed the units`);
    assert.equal(withGroup.model.totalRequests, withoutGroup.model.totalRequests,
      `seed ${seed}: a disarmed group changed the MODEL`);
    // The category itself resolves nothing through the map: every intent here
    // is an explicit row's, never the group's.
    assert.deepEqual(withGroup.model.armedLocations, [],
      `seed ${seed}: a disarmed group reported armed locations`);
  }
  assert.ok(checked >= 50, `only ${checked} disarmed worlds checked`);
  assert.ok(withRows > 0, "no disarmed world had explicit rows — the difference assertion is untested");
});

test("arming a group changes the outcome — so the test above is not green by accident", () => {
  let armedProducedSomething = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const w = world(seed);
    if (w.arrangement !== "group-disarmed") continue;
    w.config.policyGroups["the-group"].armed = true;
    if (runBoth(w).engineReq > 0) armedProducedSomething += 1;
  }
  assert.ok(armedProducedSomething > 10,
    `arming the group produced intents in only ${armedProducedSomething} worlds — the disarmed assertion may be vacuous`);
});

test("a category's own policy beats its group's in every generated world", () => {
  // In the "both" arrangement the category has its own entry AND is in an armed
  // group. Deleting the group must change NOTHING.
  let checked = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const w = world(seed);
    if (w.arrangement !== "both") continue;
    checked += 1;
    const withGroup = runBoth(w);
    const withoutGroup = runBoth({ ...w, config: { ...w.config, policyGroups: undefined } });
    assert.equal(withGroup.engineReq, withoutGroup.engineReq, `seed ${seed}: the group changed a category that has its own policy`);
    assert.equal(withGroup.engineUnits, withoutGroup.engineUnits, `seed ${seed}: units differed`);
    assert.equal(withGroup.model.totalRequests, withoutGroup.model.totalRequests);
  }
  assert.ok(checked >= 50, `only ${checked} "both" worlds checked`);
});
