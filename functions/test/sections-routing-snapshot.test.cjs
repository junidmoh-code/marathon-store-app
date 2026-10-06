// ─── SECTION 2 ROUTES EXACTLY AS IT DID BEFORE SECTIONS EXISTED ──────────────
//
// The engine's plan for Marathon PE, Trophy, Hub 1 and Hub 2, computed over
// the SYNTHETIC routing fixture (fixtures/sections-routing-fixture.json —
// written by make-sections-routing-fixture.cjs; nothing in it comes from
// production), and compared to a golden
// file written by the code as it stood on main BEFORE any routing change.
//
// The golden file is the "before". It is never regenerated to make a test
// pass: a difference here means Section 2 routing changed, which is a
// stop-and-report condition for the sections work.
//
// Regenerating (only from an untouched checkout of the pre-sections commit):
//   SECTIONS_SNAPSHOT_WRITE=1 node --test test/sections-routing-snapshot.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sections-routing-fixture.json"), "utf8"));
const GOLDEN_PATH = path.join(__dirname, "fixtures/sections-routing-golden.engine.json");
const NOW_MS = Date.parse("2026-10-01T10:00:00.000Z");
const SECTION_1 = ["hub3", "marathon-pine", "concrete", "concrete-stockroom"];

const clone = (v) => JSON.parse(JSON.stringify(v));
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v === undefined ? null : v;
}
const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");

function drain(stock, locs) {
  const out = clone(stock);
  for (const loc of locs) for (const pid of Object.keys(out[loc] || {})) for (const k of Object.keys(out[loc][pid] || {})) {
    if (out[loc][pid][k] && typeof out[loc][pid][k] === "object") out[loc][pid][k].qty = 0;
  }
  return out;
}

const SCENARIOS = {
  as_captured: (f) => f.stock,
  shops_drained: (f) => drain(f.stock, ["marathon-pe", "trophy"]),
  hubs_drained: (f) => drain(f.stock, ["hub1", "hub2"]),
  shops_and_hubs_drained: (f) => drain(f.stock, ["marathon-pe", "trophy", "hub1", "hub2"]),
  central_empty_shops_drained: (f) => drain(f.stock, ["central", "marathon-pe", "trophy"]),
};

function planFor(stock, fixture = FIXTURE) {
  return computeRefillPlan({
    nowMs: NOW_MS, config: clone(fixture.config), targets: clone(fixture.targets), stock: clone(stock),
    products: clone(fixture.products), openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  });
}

function summarise(plan) {
  const intents = (plan.intents || []).map((i) => stable(i))
    .sort((a, b) => JSON.stringify([a.dest, a.productId, a.sizeKey]).localeCompare(JSON.stringify([b.dest, b.productId, b.sizeKey])));
  const lanes = {};
  for (const i of intents) lanes[`${i.source}→${i.dest}`] = (lanes[`${i.source}→${i.dest}`] || 0) + 1;
  return { intentCount: intents.length, lanes, intents, planSha256: sha(plan) };
}

function compute() {
  const out = {};
  for (const name of Object.keys(SCENARIOS)) out[name] = summarise(planFor(SCENARIOS[name](FIXTURE)));
  return out;
}

if (process.env.SECTIONS_SNAPSHOT_WRITE === "1") {
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(stable(compute()), null, 1) + "\n");
}
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

test("the fixture is real enough to mean something", () => {
  assert.equal(Object.keys(FIXTURE.products).length, 130);
  assert.deepEqual(FIXTURE.config.routes, { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" });
  const total = Object.values(GOLDEN).reduce((t, s) => t + s.intentCount, 0);
  assert.ok(total > 50, `only ${total} intents across the scenarios — the snapshot would prove nothing`);
  const lanes = new Set(Object.values(GOLDEN).flatMap((s) => Object.keys(s.lanes)));
  for (const lane of ["hub2→marathon-pe", "hub2→trophy", "central→hub2"]) assert.ok(lanes.has(lane), `no ${lane} intent in any scenario`);
});

for (const name of Object.keys(SCENARIOS)) {
  test(`Section 2 plan is unchanged: ${name}`, () => {
    const got = stable(summarise(planFor(SCENARIOS[name](FIXTURE))));
    assert.deepEqual(got.lanes, GOLDEN[name].lanes);
    assert.deepEqual(got.intents, GOLDEN[name].intents);
    assert.equal(got.planSha256, GOLDEN[name].planSha256, "the plan differs somewhere outside the intent list");
  });
}

test("no scenario routes anything to or from a Section 1 location", () => {
  for (const name of Object.keys(SCENARIOS)) {
    for (const i of planFor(SCENARIOS[name](FIXTURE)).intents || []) {
      assert.ok(!SECTION_1.includes(i.dest) && !SECTION_1.includes(i.source), `${name}: ${i.source}→${i.dest}`);
    }
  }
});

test("Section 1 stock being present or absent changes nothing in the Section 2 intents", () => {
  for (const name of Object.keys(SCENARIOS)) {
    const stock = clone(SCENARIOS[name](FIXTURE));
    for (const loc of SECTION_1) delete stock[loc];
    const without = stable(summarise(planFor(stock)));
    assert.deepEqual(without.intents, GOLDEN[name].intents, name);
  }
});
