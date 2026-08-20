// ─── THE STARVED LIST — BEHAVIOURAL TESTS ────────────────────────────────────
//
// The bug this card exists to catch is a SILENCE: a shop refused a refill because the
// index has no trace of it, with no error and no request to show for it. So these
// tests assert the ROWS the card produces from live-shaped fixtures, and — just as
// importantly — the rows it does NOT produce, because a detector that fires on
// everything is the same as one that fires on nothing.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { computeStarved, soldWindow, openWindow, unitsHeld } = require("../lib/starved-list.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const V = 1;
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-18T06:00:00.000Z", pairs: 5, version: V }]));
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "sold" });
const DESTS = ["hub2", "marathon-pe", "trophy"];

const TEE = "p_tee";       // sold at the shop, no provenance — the real silent miss
const BAG = "p_bag";       // held, no provenance
const HAT = "p_hat";       // open ask, no provenance
const OK = "p_ok";         // carried — must never appear
const PRODUCTS = {
  [TEE]: { name: "A tee", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] },
  [BAG]: { name: "A bag", categoryKey: "bags", productType: "clothing", sizes: ["_"] },
  [HAT]: { name: "A hat", categoryKey: "caps-beanies", productType: "clothing", sizes: ["_"] },
  [OK]: { name: "Carried", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] },
};

const base = () => ({
  dests: DESTS,
  stock: {
    "marathon-pe": { [BAG]: { _: cell(3) }, [OK]: { M: cell(2) }, [TEE]: { M: cell(0) } },
  },
  products: PRODUCTS,
  provenance: { "marathon-pe": { [OK]: { s: 5 } } },
  provenanceMeta: ready(...DESTS),
  movements: [
    { type: "sold", from: "marathon-pe", productId: TEE, qty: 4 },
    { type: "sold", from: "marathon-pe", productId: OK, qty: 1 },
  ],
  openIndex: { "marathon-pe": { [HAT]: { _: { refillId: "r1" } } } },
  targets: {},
  // The engine's real answer, expressed the way the caller passes it.
  carries: (loc, pid) => !!({ "marathon-pe": { [OK]: true } }[loc] || {})[pid],
});

test("a shop that SELLS a line the index refuses is listed — the POS blind spot", () => {
  // applyMovement maintains `s` only for sales through this app; the POS is a
  // separate writer. A till-only line accumulates no `s` at all, so the index can
  // refuse a product the shop demonstrably sells. That pair MUST surface.
  const rows = computeStarved(base());
  const tee = rows.find((r) => r.pid === TEE);
  assert.ok(tee, "the sold-but-refused pair must be listed");
  assert.deepStrictEqual(tee.why, ["sold"]);
  assert.strictEqual(tee.sold, 4);
  assert.strictEqual(tee.rec, undefined, "no index record at all is the point — and the field is OMITTED, not false (payload diet)");
});

test("HOLDS and ASKED are evidence too", () => {
  const rows = computeStarved(base());
  assert.deepStrictEqual(rows.find((r) => r.pid === BAG).why, ["holds"]);
  assert.strictEqual(rows.find((r) => r.pid === BAG).held, 3);
  assert.deepStrictEqual(rows.find((r) => r.pid === HAT).why, ["asked"]);
  assert.strictEqual(rows.find((r) => r.pid === HAT).openLines, 1);
});

test("a CARRIED pair never appears, however much it sells", () => {
  // The control. `OK` holds units and has a sale in the window — it is only absent
  // because the engine is already happy, which is exactly the discrimination the
  // card has to make.
  assert.strictEqual(computeStarved(base()).some((r) => r.pid === OK), false);
});

test("a refused pair with NO evidence is not listed — the card must not cry wolf", () => {
  const a = base();
  a.stock["marathon-pe"] = {};
  a.movements = [];
  a.openIndex = {};
  assert.deepStrictEqual(computeStarved(a), []);
});

test("an UNREADY destination is skipped entirely, not listed six thousand times", () => {
  // With no sentinel, storeCarries is false for everything, so every pair would
  // qualify. "The backfill has not run" is ONE fact and refill-scan already says it
  // in its own red card; repeating it per product would bury the real misses.
  const a = base();
  a.provenanceMeta = ready("hub2", "trophy");        // marathon-pe unready
  a.carries = () => false;
  assert.deepStrictEqual(computeStarved(a), []);
});

test("k − u netting to zero is distinguishable from no record at all", () => {
  // The two Lacoste sweatshirts: stocked then fully undone. The reader has to be
  // able to tell "we sent it and took it back" from "we have never heard of it",
  // because they call for different actions.
  const a = base();
  a.provenance["marathon-pe"] = { ...a.provenance["marathon-pe"], [BAG]: { k: 4, u: 4 } };
  const bag = computeStarved(a).find((r) => r.pid === BAG);
  assert.strictEqual(bag.rec, 1);
  assert.strictEqual(bag.k, 4);
  assert.strictEqual(bag.u, 4);
});

test("an explicit target:0 row is FLAGGED, not hidden, and sorts last", () => {
  // A zero row explains the refusal — it is a standing decision. But a shop
  // deliberately excluded from a line it is actively SELLING is worth a look, so it
  // stays on the list with its reason showing rather than being silently dropped.
  const a = base();
  a.targets = { "marathon-pe": { [TEE]: { M: { target: 0, minQty: 0 } } } };
  const rows = computeStarved(a);
  const tee = rows.find((r) => r.pid === TEE);
  assert.ok(tee, "still listed");
  assert.strictEqual(tee.excluded, true);
  assert.strictEqual(rows[rows.length - 1].pid, TEE, "explained rows sort last");
});

test("worst first — selling outranks holding outranks asking", () => {
  const a = base();
  a.stock["marathon-pe"][TEE] = { M: cell(2) };            // TEE now sells AND holds
  const rows = computeStarved(a).map((r) => r.pid);
  assert.strictEqual(rows[0], TEE, "sold+held is the most alarming row");
  assert.ok(rows.indexOf(BAG) < rows.indexOf(HAT), "holding outranks merely asking");
});

test("a sale at ANOTHER shop does not implicate this one", () => {
  const a = base();
  a.movements = [{ type: "sold", from: "trophy", productId: TEE, qty: 9 }];
  a.stock["marathon-pe"] = {};
  a.openIndex = {};
  assert.strictEqual(computeStarved(a).some((r) => r.loc === "marathon-pe" && r.pid === TEE), false);
});

test("negative cells are not evidence of trade", () => {
  const a = base();
  a.stock["marathon-pe"] = { [BAG]: { _: cell(-3) } };
  a.movements = []; a.openIndex = {};
  assert.deepStrictEqual(computeStarved(a), [], "a count error must not read as stock on the shelf");
});

test("helpers: unitsHeld clamps per cell, soldWindow sums, openWindow counts sizes", () => {
  assert.strictEqual(unitsHeld({ l: { p: { S: cell(2), M: cell(-5), L: cell(1) } } }, "l", "p"), 3);
  assert.strictEqual(soldWindow([{ type: "sold", from: "l", productId: "p", qty: 2 },
                                 { type: "sold", from: "l", productId: "p", qty: 3 }]).get("l|p"), 5);
  assert.strictEqual(soldWindow([{ type: "received", from: "l", productId: "p", qty: 9 }]).size, 0);
  assert.strictEqual(openWindow({ l: { p: { S: {}, M: {} } } }).get("l|p"), 2);
});

// ═══ END TO END, THROUGH THE REAL PLANNER ════════════════════════════════════
test("computeRefillPlan emits the starved list in its exceptions", () => {
  const plan = computeRefillPlan({
    nowMs: Date.parse("2026-08-18T09:00:00.000Z"),
    config: {
      routes: { hub2: "central", "marathon-pe": "hub2" },
      ruleBasedTargets: true,
      defaultRunByStore: { hub2: { M: 3 }, "marathon-pe": { M: 2 } },
      maxIntentsPerRun: 75,
    },
    products: PRODUCTS, targets: {},
    stock: { "marathon-pe": { [BAG]: { _: cell(3) } }, central: {}, hub2: {} },
    openIndex: {}, refillRequests: {}, orders: {},
    movements: [{ type: "sold", from: "marathon-pe", productId: TEE, qty: 4, ts: "2026-08-17T10:00:00.000Z" }],
    provenance: {}, provenanceMeta: ready("hub2", "marathon-pe"),
  });
  const starved = plan.exceptions.starved;
  assert.ok(starved, "exceptions.starved must exist");
  assert.strictEqual(typeof starved.count, "number");
  const pids = starved.items.map((r) => r.pid).sort();
  assert.deepStrictEqual(pids, [BAG, TEE].sort(), "both the held and the sold pair surface");
  assert.ok(starved.items.every((r) => r.loc === "marathon-pe"));
});

test("with the index unready end to end, the plan reports the pause and NOT a starved list", () => {
  const plan = computeRefillPlan({
    nowMs: Date.parse("2026-08-18T09:00:00.000Z"),
    config: { routes: { "marathon-pe": "hub2" }, ruleBasedTargets: true, defaultRunByStore: { "marathon-pe": { M: 2 } } },
    products: PRODUCTS, targets: {},
    stock: { "marathon-pe": { [BAG]: { _: cell(3) } } },
    openIndex: {}, refillRequests: {}, orders: {},
    movements: [{ type: "sold", from: "marathon-pe", productId: TEE, qty: 4 }],
    provenance: {}, provenanceMeta: {},
  });
  assert.strictEqual(plan.exceptions.starved.count, 0);
  assert.ok(plan.errors.some((e) => /PROVENANCE INDEX NOT READY/.test(e)));
});

test("END TO END: a CARRIED pair is absent from the plan's starved list", () => {
  // The control for the whole feature, at plan level. Without this, replacing the
  // injected `carries` with a constant `false` — a second, wrong copy of the
  // predicate — changes nothing observable, because every other end-to-end fixture
  // has empty provenance and is refused anyway. This is the fixture where the
  // engine's real answer is YES and the card must therefore say nothing.
  const carriedPlan = computeRefillPlan({
    nowMs: Date.parse("2026-08-18T09:00:00.000Z"),
    config: {
      routes: { "marathon-pe": "hub2" }, ruleBasedTargets: true,
      defaultRunByStore: { "marathon-pe": { M: 2 } }, maxIntentsPerRun: 75,
    },
    products: PRODUCTS, targets: {},
    stock: { "marathon-pe": { [OK]: { M: cell(2) } }, hub2: { [OK]: { M: cell(9) } } },
    openIndex: {}, refillRequests: {}, orders: {},
    movements: [{ type: "sold", from: "marathon-pe", productId: OK, qty: 3, ts: "2026-08-17T10:00:00.000Z" }],
    // marathon-pe HAS sold this — the index agrees it is carried.
    provenance: { "marathon-pe": { [OK]: { s: 12 } } },
    provenanceMeta: ready("marathon-pe", "hub2"),
  });
  assert.strictEqual(carriedPlan.exceptions.starved.count, 0,
    "a pair the engine carries must never appear on the starved list, however loudly it trades");

  // …and the same fixture WITHOUT the index record does list it, so the assertion
  // above is discriminating rather than vacuous.
  const refusedPlan = computeRefillPlan({
    nowMs: Date.parse("2026-08-18T09:00:00.000Z"),
    config: {
      routes: { "marathon-pe": "hub2" }, ruleBasedTargets: true,
      defaultRunByStore: { "marathon-pe": { M: 2 } }, maxIntentsPerRun: 75,
    },
    products: PRODUCTS, targets: {},
    stock: { "marathon-pe": { [OK]: { M: cell(2) } }, hub2: { [OK]: { M: cell(9) } } },
    openIndex: {}, refillRequests: {}, orders: {},
    movements: [{ type: "sold", from: "marathon-pe", productId: OK, qty: 3, ts: "2026-08-17T10:00:00.000Z" }],
    provenance: {},
    provenanceMeta: ready("marathon-pe", "hub2"),
  });
  assert.strictEqual(refusedPlan.exceptions.starved.count, 1);
  assert.strictEqual(refusedPlan.exceptions.starved.items[0].pid, OK);
});

test("a pair with an explicit target > 0 is NOT listed — the engine arms it without the index", () => {
  // resolveTarget's explicit branch never consults provenance: such a pair is
  // being refilled normally, so a Starved row for it would headline a refusal
  // that is not happening and offer an Introduce that is pure noise.
  // (Adversarial review, PR #383 — proven against the live planner.)
  const a = base();
  a.targets = { "marathon-pe": { [BAG]: { M: { target: 3, minQty: 1 } } } };
  assert.strictEqual(computeStarved(a).find((r) => r.pid === BAG), undefined);
  // …and a mixed set with any positive target reads the same way.
  a.targets = { "marathon-pe": { [BAG]: { M: { target: 0, minQty: 0 }, L: { target: 2, minQty: 1 } } } };
  assert.strictEqual(computeStarved(a).find((r) => r.pid === BAG), undefined);
});

test("zero-valued fields are omitted from every row — this node ships 49 times a day", () => {
  const rows = computeStarved(base());
  for (const r of rows) {
    for (const f of ["held", "sold", "openLines", "s", "k", "u"]) {
      assert.notStrictEqual(r[f], 0, `${f} must be omitted when 0, never written as 0`);
    }
    assert.strictEqual("name" in r, false, "name is the client's catalogue lookup, not payload");
    assert.strictEqual("category" in r, false, "category was never read by the client");
    assert.strictEqual("hasRecord" in r, false, "rec:1 (present only when true) replaced hasRecord");
  }
});
