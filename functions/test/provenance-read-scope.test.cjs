// ─── THE PROVENANCE READ IS DESTINATION-SCOPED — AND MUST STAY THAT WAY ───────
//
// refill-scan.cjs reads /stock (both ends of every route: the destination's need and
// the source's ability to supply) and /stock_provenance (destinations only). The two
// are NOT the same set, and the natural mistake — reusing the `locs` list that /stock
// already needs — costs real money on the biggest line of the bill.
//
// MEASURED 2026-08-18 against the live index:
//   whole `locs` set (hub1, hub2, marathon-pe, trophy, central) : 217,030 B/run
//   destinations only (hub1, hub2, marathon-pe, trophy)         : 176,706 B/run
//   difference                                                   :  40,324 B/run
//                                                                =  57 MB/month
//
// The first test below is the one that matters. It does not read the source file or
// count requests — it proves the source subtree is UNUSED by running the real planner
// twice, once with the source's provenance supplied and once with it stripped, and
// asserting the plans are identical. If a future change ever consults a source's
// carriage, this fails and the read scope has to be revisited deliberately rather
// than discovered on an invoice.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-18T09:00:00.000Z");
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-18T06:00:00.000Z", pairs: 3, version: 1 }]));
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_out" });

const TEE = "p_tee";
const PRODUCTS = { [TEE]: { name: "A tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L"] } };

// The live routes, verbatim: two shops fed by hub2, two hubs fed by central.
const CONFIG = {
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: true,
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  defaultRunByStore: {
    hub1: { S: 2, M: 2, L: 2 }, hub2: { S: 2, M: 3, L: 3 },
    "marathon-pe": { S: 2, M: 2, L: 2 }, trophy: { S: 2, M: 2, L: 2 },
  },
  maxIntentsPerRun: 75,
};

const STOCK = {
  central: { [TEE]: { S: cell(20), M: cell(20), L: cell(20) } },
  hub2: { [TEE]: { S: cell(0), M: cell(0), L: cell(0) } },
  "marathon-pe": { [TEE]: { S: cell(0), M: cell(0), L: cell(0) } },
};

// The source's sentinel is a SEPARATE axis from the source's data, and both have to
// vary. A planner that read source provenance only when the SOURCE INDEX WAS READY
// would slip past a fixture that never makes it ready — both variants would take the
// same branch and the comparison would prove nothing. (CodeRabbit, PR #382.)
const snap = (provenance, { sourceReady = false } = {}) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {}, stock: STOCK,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  provenance,
  provenanceMeta: sourceReady
    ? ready("hub1", "hub2", "marathon-pe", "trophy", "central")
    : ready("hub1", "hub2", "marathon-pe", "trophy"),
});

// Carriage at every DESTINATION, plus the source. `central` is a source only.
const WITH_SOURCE = {
  hub2: { [TEE]: { k: 40 } },
  "marathon-pe": { [TEE]: { s: 9 } },
  central: { [TEE]: { k: 500 } },
};
const WITHOUT_SOURCE = { hub2: { [TEE]: { k: 40 } }, "marathon-pe": { [TEE]: { s: 9 } } };

// THE WHOLE plan object, not a chosen handful of fields. Listing fields by hand is
// how `resizes`, `satisfiedClosures`, `streakOps`, `retryOps`, `exceptions` and
// `policy` went uncompared in the first version of this test — and any one of them
// could carry a source-derived value. (CodeRabbit, PR #382.)
const wholePlan = (p) => JSON.stringify(p, Object.keys(p).sort());

test("the plan is IDENTICAL with and without the source's provenance — so reading it is pure cost", () => {
  const withIt = computeRefillPlan(snap(WITH_SOURCE));
  const without = computeRefillPlan(snap(WITHOUT_SOURCE));
  assert.strictEqual(wholePlan(without), wholePlan(withIt));
  // Not vacuous — the fixture really does plan work.
  assert.ok(withIt.intents.length > 0, "fixture must produce intents or it proves nothing");
  // And the comparison really does cover the fields that were missing before.
  for (const k of ["intents", "closes", "resizes", "satisfiedClosures", "streakOps", "retryOps", "errors", "policy", "stats", "exceptions"]) {
    assert.ok(k in withIt, `the plan must expose ${k} for this comparison to be complete`);
  }
});

test("…and STILL identical when the source's index is READY — the sentinel axis", () => {
  // The gap CodeRabbit found. With `central` absent from the meta in both variants,
  // a planner that consulted source provenance only behind an indexReady(source)
  // check would take the same branch either way and this suite would stay green
  // while the source read had quietly become load-bearing.
  const withIt = computeRefillPlan(snap(WITH_SOURCE, { sourceReady: true }));
  const without = computeRefillPlan(snap(WITHOUT_SOURCE, { sourceReady: true }));
  assert.strictEqual(wholePlan(without), wholePlan(withIt));
  assert.ok(withIt.intents.length > 0);
});

test("making the source READY changes nothing at all — the sentinel is not consulted either", () => {
  // Stronger still: not merely "the two agree with each other", but "the source's
  // readiness is invisible to the plan". If that ever stops being true, the read
  // scope has to be revisited deliberately.
  const unready = computeRefillPlan(snap(WITH_SOURCE, { sourceReady: false }));
  const readySrc = computeRefillPlan(snap(WITH_SOURCE, { sourceReady: true }));
  assert.strictEqual(wholePlan(readySrc), wholePlan(unready));
});

test("a source with NO sentinel changes nothing either — readiness is asked only of destinations", () => {
  // central is deliberately absent from the meta in every fixture above. If the
  // engine ever demanded a sentinel for a source, this is where it would surface:
  // the run would go quiet and the errors list would name central.
  const plan = computeRefillPlan(snap(WITH_SOURCE));
  assert.ok(!plan.errors.some((e) => /central/i.test(e)), `no error should mention the source: ${plan.errors.join(" | ")}`);
  assert.ok(plan.intents.some((i) => i.source === "central"), "central still SOURCES intents — it just is not asked about carriage");
});

test("destination carriage still decides — the control for the two tests above", () => {
  // Strip hub2's carriage (a DESTINATION) and its demand must vanish, proving the
  // deep-equality above is comparing something that can actually move.
  const stripped = { "marathon-pe": { [TEE]: { s: 9 } }, central: { [TEE]: { k: 500 } } };
  const plan = computeRefillPlan(snap(stripped));
  assert.strictEqual(plan.intents.filter((i) => i.dest === "hub2").length, 0);
  assert.ok(computeRefillPlan(snap(WITH_SOURCE)).intents.filter((i) => i.dest === "hub2").length > 0);
});

test("refill-scan reads provenance for Object.keys(routes), NOT the wider `locs` set", () => {
  // Source-pinned, because the read itself is wiring: the behavioural tests above
  // prove the source's data is unused, and this one proves we do not FETCH it.
  // Both are needed — unused-but-downloaded is exactly the bug being fixed.
  const src = readFileSync(join(__dirname, "..", "refill-scan.cjs"), "utf8");
  assert.match(src, /const provLocs = Object\.keys\(config\.routes \|\| \{\}\);/);
  assert.match(src, /provLocs\.map\(\(l\) => db\.ref\(`stock_provenance\/\$\{l\}`\)/);
  // The /stock read still uses the wider set — both ends of a route are needed there.
  assert.match(src, /locs\.map\(\(l\) => db\.ref\(`stock\/\$\{l\}`\)/);
  // And provenance must not be fetched with `locs` anywhere.
  assert.ok(!/locs\.map\(\(l\) => db\.ref\(`stock_provenance/.test(src),
    "provenance must not be fetched over the destinations-plus-sources set");
});
