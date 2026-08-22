// ─── THE MODEL vs THE ENGINE — a differential test ────────────────────────────
// Run: cd functions && node --test test/category-policy-differential.test.cjs
//
// The card's preview panel is only worth having if its numbers are the engine's
// numbers. Every hand-written test in this repo pins a case somebody thought
// of; this one generates worlds nobody thought of and holds the model to the
// real computeRefillPlan on each.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Both defects the reviews found in this model were of exactly the shape a
// differential test catches and a hand-written one does not:
//
//   • the model derived its size list from the map alone, so it never walked a
//     legacy letter row the engine was actively serving — it reported "asks for
//     nothing" while the engine issued requests;
//   • an absent maxUnitsPerIntent modelled as unlimited where the engine caps
//     at 20, overstating units by up to 10x.
//
// Neither showed up until somebody compared the two on real data. This makes
// that comparison cheap and repeatable.
//
// ── THE CONTRACT BEING TESTED ────────────────────────────────────────────────
// The model is a CEILING, not an equality: it walks the deficit arithmetic and
// the three gates that dominate in practice (in flight, nothing anywhere,
// source empty) but not the scan's remaining suppression passes — confirmed
// out, reject streaks, retry cooldown, the recount park, the global throttle.
// Every one of those can only REMOVE a request.
//
// So the invariant is one-directional and that is the whole point:
//
//     model.totalRequests >= engine intents for this category
//     model.totalUnits    >= engine units   for this category
//
// A model that under-reports is the dangerous direction — it tells the owner a
// change is free when it is not. Over-reporting is merely conservative. The
// generator deliberately produces NO rejections, retries or confirmed-outs, so
// on these worlds the two should agree EXACTLY; any divergence is a real
// mismatch rather than a suppression pass doing its job, and the test asserts
// the tighter equality for that reason. The >= assertion is kept as well so
// that adding a suppression case to the generator later weakens the test
// instead of breaking it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const { modelCategoryPolicy } = require("../lib/category-policy.cjs");

const NOW = Date.parse("2026-08-21T09:00:00.000Z");

// A tiny deterministic PRNG. Math.random() would make a failure impossible to
// reproduce, which is the one thing a fuzz test must never be.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const LETTERS = ["S", "M", "L", "XL"];

// Builds a small world with the shapes that actually bite: one-size and
// per-size maps, legacy letter rows in a one-size category, explicit rows on
// sizes the map does speak for, empty sources, empty networks, cells already in
// flight, and reorderPoints at, below and above on-hand.
function world(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (n) => Math.floor(r() * (n + 1));

  const perSize = r() < 0.4;
  const nProducts = 1 + int(4);
  const products = {};
  for (let i = 0; i < nProducts; i++) {
    const pid = `p${i}`;
    const sizes = perSize
      ? LETTERS.slice(0, 1 + int(3))
      : (r() < 0.5 ? ["_"] : ["_", ...LETTERS.slice(0, 1 + int(2))]);
    products[pid] = { name: `P${i}`, categoryKey: "cat", sizes, productType: "clothing" };
  }

  const locs = ["central", "hub2", "marathon-pe"];
  const stock = { central: {}, hub2: {}, "marathon-pe": {} };
  for (const pid of Object.keys(products)) {
    for (const loc of locs) {
      if (r() < 0.2) continue;                       // this location does not carry it
      const cells = {};
      for (const sz of products[pid].sizes) {
        if (r() < 0.25) continue;                    // no cell for this size
        cells[sz === "_" ? "_" : sz] = { qty: r() < 0.15 ? -int(3) : int(12) };
      }
      if (Object.keys(cells).length) stock[loc][pid] = cells;
    }
  }

  // Explicit rows — the thing the model used to miss. Deliberately biased
  // toward LETTER rows in a ONE-SIZE category, which is the live shape (188
  // such rows on caps-beanies).
  const targets = {};
  for (const pid of Object.keys(products)) {
    for (const loc of ["hub2", "marathon-pe"]) {
      if (r() < 0.55) continue;
      const sz = perSize ? pick(products[pid].sizes) : pick(products[pid].sizes.concat(LETTERS));
      const key = sz === "_" ? "_" : sz;
      const t = int(8);
      ((targets[loc] = targets[loc] || {})[pid] = targets[loc][pid] || {})[key] =
        r() < 0.15 ? { target: 0, minQty: 0 } : { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.4 ? { reorderPoint: int(3) } : {}) };
    }
  }

  // Cells already in flight.
  const openIndex = {};
  for (const pid of Object.keys(products)) {
    for (const loc of ["hub2", "marathon-pe"]) {
      if (r() < 0.85) continue;
      const sz = pick(products[pid].sizes);
      ((openIndex[loc] = openIndex[loc] || {})[pid] = openIndex[loc][pid] || {})[sz === "_" ? "_" : sz] =
        { qty: 1 + int(2), createdAt: new Date(NOW - 3600000).toISOString(), refillId: `r${pid}${loc}`, source: "central" };
    }
  }

  const entry = { perSize: perSize || undefined };
  for (const loc of ["hub2", "marathon-pe"]) {
    if (r() < 0.15) continue;                        // location not armed
    const t = 1 + int(9);
    entry[loc] = { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.5 ? { reorderPoint: int(4) } : {}) };
  }
  if (!entry.hub2 && !entry["marathon-pe"]) entry.hub2 = { target: 5, minQty: 3 };
  if (entry.perSize === undefined) delete entry.perSize;

  const config = {
    mode: { hub2: "live", "marathon-pe": "live" },
    routes: { hub2: "central", "marathon-pe": "hub2" },
    // Absent on some runs, so the engine-default mirrors are exercised.
    ...(r() < 0.7 ? { maxUnitsPerIntent: 1 + int(30) } : {}),
    ...(r() < 0.7 ? { maxIntentsPerRun: 5 + int(300) } : {}),
    ruleBasedTargets: false,          // isolate the map + explicit rows
    categoryPolicy: { cat: entry },
  };
  return { config, products, stock, targets, openIndex, perSize };
}

test("the model is never under the real engine, over 400 generated worlds", () => {
  let compared = 0, exact = 0;
  const divergences = [];

  for (let seed = 1; seed <= 400; seed++) {
    const { config, products, stock, targets, openIndex } = world(seed);

    const model = modelCategoryPolicy({
      config, products, stock, targets, openIndex, categoryKey: "cat",
      locations: ["central", "hub2", "marathon-pe"],
      maxIntentsPerRun: config.maxIntentsPerRun,
      maxUnitsPerIntent: config.maxUnitsPerIntent,
    });

    const plan = computeRefillPlan({
      nowMs: NOW, config, targets, stock, products, openIndex,
      refillRequests: {}, orders: {}, movements: [],
      targetDecisions: {}, rejectStreak: {}, retryState: {},
    });
    const mine = plan.intents.filter((i) => products[i.productId]?.categoryKey === "cat");
    const engineReq = mine.length;
    const engineUnits = mine.reduce((n, i) => n + i.qty, 0);

    compared += 1;
    // THE INVARIANT: the model may over-report, never under-report.
    if (model.totalRequests < engineReq || model.totalUnits < engineUnits) {
      divergences.push({ seed, model: [model.totalRequests, model.totalUnits], engine: [engineReq, engineUnits] });
      continue;
    }
    if (model.totalRequests === engineReq && model.totalUnits === engineUnits) exact += 1;
  }

  assert.equal(divergences.length, 0,
    `the model under-reported on ${divergences.length} world(s): ${JSON.stringify(divergences.slice(0, 5))}`);

  // With no rejections, retries or confirmed-outs in the generated worlds there
  // is nothing left for the unmodelled suppression passes to remove — so the
  // two agree EXACTLY on every one, and that is asserted rather than a
  // tolerance. It was not free: getting here needed the model to walk legs the
  // map does not arm (the engine manages any cell with an explicit row) and to
  // seed source reservations from open requests (a unit already promised to an
  // open lock cannot be sent twice). Both were found here and nowhere else.
  //
  // If a future change adds rejections or cooldowns to the generator, this is
  // the assertion to relax — deliberately, with the reason written down — not
  // the >= invariant above, which must always hold.
  assert.equal(exact, compared,
    `${compared - exact} of ${compared} worlds diverged from the engine — the model has drifted`);
});

test("the override / legacy-row split never miscounts against the engine's resolution", () => {
  // Every cell the model calls an OVERRIDE must be one resolveTarget answers
  // "explicit" for on a size the map speaks for; every LEGACY row must be
  // explicit on a size it does not. The two together must equal the total
  // number of explicit-resolved cells — nothing may be dropped between them,
  // which is how the original bug hid.
  const { resolveTarget, encodeSizeKey } = require("../lib/refill-engine.cjs");
  for (let seed = 1; seed <= 200; seed++) {
    const { config, products, stock, targets, openIndex } = world(seed);
    const model = modelCategoryPolicy({
      config, products, stock, targets, openIndex, categoryKey: "cat",
      locations: ["central", "hub2", "marathon-pe"],
      maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
    });

    for (const leg of model.legs) {
      let explicitCells = 0;
      for (const pid of Object.keys(products)) {
        const keys = new Set(Object.keys(targets?.[leg.loc]?.[pid] || {}));
        const entry = config.categoryPolicy.cat;
        if (entry.perSize) for (const s of products[pid].sizes) { if (s !== "_") keys.add(encodeSizeKey(s)); }
        else keys.add("_");
        for (const k of keys) {
          const declared = products[pid].sizes.map(String).find((sz) => encodeSizeKey(sz) === k);
          const t = resolveTarget({ targets, config, products, stock }, leg.loc, pid, declared === undefined ? k : declared);
          if (t && t.target > 0 && t.source === "explicit") explicitCells += 1;
        }
      }
      assert.equal(leg.overrides + leg.legacyRows, explicitCells,
        `seed ${seed} leg ${leg.loc}: ${leg.overrides} overrides + ${leg.legacyRows} legacy != ${explicitCells} explicit cells`);
    }
  }
});
