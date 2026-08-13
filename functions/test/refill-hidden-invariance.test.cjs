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

// Every string literal in a source, so path checks see child()-based and
// ref(db, ...)-based construction alike — not just the db.ref("...") form.
// (CodeRabbit, PR #356: the earlier pin only matched ref("settings…").)
// Backtick literals may span lines and are captured whole (Kimi + Sonnet
// substitute pair: the first cut excluded \n everywhere and a template
// string spanning lines slipped the net); quote/apostrophe literals stay
// single-line, as the language requires — letting THEM span lines glues a
// comment's apostrophe ("the engine's run") to the next one and manufactures
// phantom literals. The filters below match SUBSTRINGS deliberately — an
// unrelated future literal containing "settings" will fail loudly and force
// this allowlist to be extended by hand, which is the strictness this
// contract wants.
const stringLiterals = (src) =>
  (src.match(/(["'])(?:(?!\1)[^\\\n]|\\.)*\1|`(?:[^\\`]|\\[\s\S])*`/g) || []).map((s) => s.slice(1, -1));

test("the literal scanner itself sees multi-line template literals", () => {
  // A test of the pin's own net: if the regex regresses to single-line
  // capture, the fragment below vanishes from the scan and this fails.
  const caught = stringLiterals("const p = `settings/\nmissingProductsHidden`;");
  assert.equal(caught.length, 1);
  assert.match(caught[0], /missingProductsHidden/);
});

test("neither the scan nor the engine references the hidden path — in any fragment", () => {
  // "missingProducts" rather than the full node name, so a fragmented
  // "missingProducts" + "Hidden" construction is caught too. A determined
  // evasion ("missing" + "ProductsHidden") is beyond static pinning — the
  // byte-for-byte plan test above is the guarantee that survives it.
  for (const [name, src] of [["refill-scan.cjs", SCAN_SRC], ["refill-engine.cjs", ENGINE_SRC]]) {
    assert.doesNotMatch(src, /missingProductsHidden/, `${name} must never read the hidden set`);
    const fragments = stringLiterals(src).filter((s) => /missingProducts/i.test(s));
    assert.deepEqual(fragments, [], `${name} carries hidden-path fragments: ${JSON.stringify(fragments)}`);
  }
});

test("the scan's only settings-flavoured string is stockHold/held; the engine has none", () => {
  // The hidden node lives under /settings BECAUSE the functions side reads
  // that subtree only through this one scoped child path. Checked over ALL
  // string literals — db.ref(), ref(db, ...), .child(...) and concatenated
  // path parts all have to spell "settings" in a literal somewhere.
  const scanSettings = [...new Set(stringLiterals(SCAN_SRC).filter((s) => /settings/i.test(s)))];
  assert.deepEqual(scanSettings, ["settings/stockHold/held"],
    `unexpected settings literals in refill-scan.cjs: ${JSON.stringify(scanSettings)}`);
  const engineSettings = stringLiterals(ENGINE_SRC).filter((s) => /settings/i.test(s));
  assert.deepEqual(engineSettings, [],
    `unexpected settings literals in refill-engine.cjs: ${JSON.stringify(engineSettings)}`);
});
