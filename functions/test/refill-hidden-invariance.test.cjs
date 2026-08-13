// ─── HIDDEN MISSING PRODUCTS — ENGINE INVARIANCE ─────────────────────────────
// Run: cd functions && node --test
//
// The store app can hide a stranded card from the Missing Products list
// (/settings/missingProductsHidden — a VIEW filter, hiddenProductsCore.js).
// The owner's contract for that feature is absolute: a hidden product still
// refills, still raises intents, still counts everywhere else. This suite is
// that contract, pinned from the engine's side:
//
//   1. BYTE-FOR-BYTE — computeRefillPlan on identical state, with and without
//      the hidden node riding along in the snapshot, produces the identical
//      plan. If anyone ever teaches the engine to read the hidden set (skip
//      hidden pids, dampen their priority, anything), this fails.
//   2. SOURCE PIN — neither the engine nor the scan that feeds it references
//      the hidden path at all. The scan builds the engine's snapshot from
//      named node reads; the only /settings read it makes is
//      settings/stockHold/held. Adding a read of the hidden node fails here.
//
// Source-pin idiom follows refill-cadence.test.cjs: requiring refill-scan.cjs
// would initialise firebase-admin, so the source is the artefact under test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const SCAN_SRC = readFileSync(join(__dirname, "..", "refill-scan.cjs"), "utf8");
const ENGINE_SRC = readFileSync(join(__dirname, "..", "lib", "refill-engine.cjs"), "utf8");

const CONFIG = {
  enabled: true,
  routes: { "marathon-pe": "hub2", hub2: "central" },
  mode: { "marathon-pe": "live", hub2: "live" },
  productTypes: { clothing: true },
  defaultRunByStore: { "marathon-pe": { M: 2, L: 2 }, hub2: { M: 3, L: 3 } },
  maxIntentsPerRun: 75,
  maxUnitsPerIntent: 20,
  ruleBasedTargets: true,
  confirmedOutDays: 14,
};
const PRODUCTS = {
  p1: { id: "p1", name: "Test Hoodie", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
  p2: { id: "p2", name: "Test Tee", productType: "clothing", category: "Clothing", sizes: ["M", "L"] },
};
const NOW = Date.parse("2026-08-13T08:00:00.000Z");
const snapshot = (over = {}) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS,
  targets: {}, targetDecisions: {}, openIndex: {}, refillRequests: {}, orders: {},
  rejectStreak: {}, retryState: {}, movements: [],
  stock: {
    "marathon-pe": { p1: { M: { qty: 0 }, L: { qty: 0 } }, p2: { M: { qty: 0 }, L: { qty: 0 } } },
    hub2:          { p1: { M: { qty: 10 }, L: { qty: 10 } }, p2: { M: { qty: 10 }, L: { qty: 10 } } },
    central:       { p1: { M: { qty: 10 }, L: { qty: 10 } }, p2: { M: { qty: 10 }, L: { qty: 10 } } },
  },
  ...over,
});

test("the fixture actually plans work for the products under test", () => {
  // A vacuous invariance proof (empty plan == empty plan) pins nothing. The
  // deficit above must produce intents for BOTH products, so hiding one of
  // them had something real to (not) change.
  const plan = computeRefillPlan(snapshot());
  const pids = new Set((plan.intents || []).map((i) => i.productId));
  assert.ok(pids.has("p1") && pids.has("p2"),
    `expected intents for p1 and p2, got ${JSON.stringify([...pids])}`);
});

test("the plan is byte-for-byte identical whether or not products are hidden", () => {
  const bare = computeRefillPlan(snapshot());
  // The hidden node as it would ride along in a full DB snapshot: BOTH
  // products hidden, one with each owner reason. If the engine ever consults
  // it, p1/p2's intents change and the serialisations diverge.
  const withHidden = computeRefillPlan(snapshot({
    settings: {
      missingProductsHidden: {
        p1: { at: NOW - 3600e3, by: "someUid", reason: "seasonal" },
        p2: { at: NOW - 60e3, by: "someUid", reason: "awaiting_stock" },
      },
    },
  }));
  assert.equal(JSON.stringify(withHidden), JSON.stringify(bare),
    "hiding is a view filter — the engine's plan must not change by a single byte");
});

test("neither the scan nor the engine references the hidden path", () => {
  assert.doesNotMatch(SCAN_SRC, /missingProductsHidden/,
    "refill-scan.cjs must never read the hidden set — hiding is app-side view state");
  assert.doesNotMatch(ENGINE_SRC, /missingProductsHidden/,
    "refill-engine.cjs must never read the hidden set — hiding is app-side view state");
});

test("the scan's only /settings read stays scoped to stockHold/held", () => {
  // The hidden node lives under /settings BECAUSE the functions side reads
  // that subtree only through this one scoped child path. A broader read
  // (db.ref("settings")) would silently pull the hidden set into the engine's
  // inputs and invalidate the placement decision.
  const settingsReads = SCAN_SRC.match(/ref\((["'`])settings[^"'`]*\1\)/g) || [];
  assert.deepEqual(settingsReads, ['ref("settings/stockHold/held")'],
    `unexpected /settings reads in refill-scan.cjs: ${JSON.stringify(settingsReads)}`);
});
