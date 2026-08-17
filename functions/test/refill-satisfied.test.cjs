// ─── SATISFIED-BY-STOCK WITHDRAWAL ────────────────────────────────────────────
// Pins the fix for requests that outlived their need. Run: cd functions && node --test
//
// THE BUG (live, 2026-08-07): Timberland Premium 6-Inch Wheat had 5 sizes raised
// into Hub 1's refill queue at 2026-08-06T20:50 from the Missing Sneakers
// screen. At 07:17 the next morning the stock was MANUALLY TRANSFERRED
// central→hub1 (transfer -OzQ4L7BrRds21dcNgkB, 3 units each of 7/8/9/10/11).
// Seven and a half hours later all five requests were still "open" and Central
// was still being told to pick them.
//
// The reason: every reconciliation in computeRefillPlan walks `openIndex`
// (/refill_engine/open). Missing Sneakers writes /refill_requests DIRECTLY and
// never claims a lock, so those rows were invisible to the engine — including to
// `needGone`, the self-reversal rule that already handles exactly this case for
// requests the engine created itself.
//
// The rule these tests encode: SATISFACTION IS A FUNCTION OF THE DESTINATION
// CELL, never of which code path filled it.
const { test } = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan: _rawComputeRefillPlan } = require("../lib/refill-engine.cjs");
// storeCarries() now reads the derived provenance index, not cell existence
// (2026-08-17 — a customer-collection husk was arming whole size runs). The
// fixtures below write a /stock cell to mean "this shop stocks this line", which
// was true of the old predicate, so withProvenance() states that in the index's own
// terms and leaves every assertion in this file measuring what it always did.
// It never overrides a `provenance`/`provenanceMeta` a test sets itself.
const { withProvenance } = require("./helpers/provenance.cjs");
const computeRefillPlan = (snap) => _rawComputeRefillPlan(withProvenance(snap, Object.keys(snap?.config?.routes || {})));

const NOW = Date.parse("2026-08-07T13:00:00.000Z");
const cell = (qty) => ({ qty, v: 1, mv: "m1" });

// Hub 1 as it is actually configured in production: a real destination routed
// from central, in shadow mode, with footwear targeting OFF (the owner rule —
// sneaker refills are requests, never auto-generated).
const CONFIG = {
  enabled: true,
  routes: { hub1: "central", hub2: "central" },
  mode: { hub1: "shadow", hub2: "live" },
  defaultRunByStore: { hub2: { M: 3, L: 3 } },
  ruleBasedTargets: true,
  staleIntentHours: 168,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 75,
};

const PRODUCTS = {
  boot: { name: "Timberland Premium 6-Inch Wheat", category: "Footwear", sizes: ["7", "8", "9", "10", "11"] },
};

// A Missing Sneakers request: the real write shape from MissingFootwear.jsx —
// no /refill_engine/open lock, createdFrom.manual, via missing_sneakers.
const missingSneakerReq = (over = {}) => ({
  productId: "boot", size: "7", qty: 2,
  requestingLocation: "hub1", status: "open",
  createdAt: "2026-08-06T20:50:09.106Z",
  createdFrom: { manual: true, source: "central", via: "missing_sneakers" },
  ...over,
});

function base(over = {}) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {},
    stock: { hub1: {}, hub2: {}, central: {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    ...over,
  };
}

const satisfiedIds = (plan) => (plan.satisfiedClosures || []).map((s) => s.refillId).sort();

// ── THE HEADLINE CASE ────────────────────────────────────────────────────────

test("a request whose destination cell now holds enough withdraws — MANUAL transfer", () => {
  const plan = computeRefillPlan(base({
    // The manual transfer landed 3 units in hub1's size-7 cell. The movement
    // carries transferId, NOT a refillId — nothing links it to the request, and
    // that is the entire point: the engine must not need the link.
    stock: { hub1: { boot: { 7: cell(3) } }, hub2: {}, central: { boot: { 7: cell(40) } } },
    refillRequests: { r1: missingSneakerReq() },
    movements: [{
      type: "transfer_out", productId: "boot", size: "7", qty: 3,
      from: "central", to: "hub1", ts: "2026-08-07T07:17:19.918Z",
      link: { transferId: "-OzQ4L7BrRds21dcNgkB" },
    }],
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["r1"]);
  const s = plan.satisfiedClosures[0];
  assert.strictEqual(s.rrStatus, "cancelled");
  assert.strictEqual(s.cancelReason, "already_in_stock");
  assert.strictEqual(s.dest, "hub1");
  assert.strictEqual(s.have, 3, "the evidence — what the cell held — must be carried for the audit trail");
  assert.strictEqual(s.qty, 2);
});

test("the same cell state withdraws no matter HOW the stock arrived", () => {
  // Four arrival paths that all bypass the refill fulfilment code: a manual
  // transfer, a supplier receive, a customer return, and a stock adjustment.
  // The plan must be byte-identical for all four, because the engine is only
  // ever allowed to look at the cell.
  const paths = [
    { type: "transfer_out", from: "central", to: "hub1", link: { transferId: "t1" } },
    { type: "received", to: "hub1", link: null },
    { type: "return", to: "hub1", link: { saleId: "s1" } },
    { type: "adjustment", to: "hub1", reason: "recount", link: null },
  ];
  const plans = paths.map((p) => computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(2) } }, hub2: {}, central: {} },
    refillRequests: { r1: missingSneakerReq() },
    movements: [{ ...p, productId: "boot", size: "7", qty: 2, ts: "2026-08-07T07:17:00.000Z" }],
  })));
  for (const plan of plans) assert.deepStrictEqual(satisfiedIds(plan), ["r1"]);
  // and identical decisions, not merely the same ids
  for (const plan of plans) assert.deepStrictEqual(plan.satisfiedClosures, plans[0].satisfiedClosures);
});

test("a still-genuinely-short cell KEEPS its request", () => {
  // The live size-10 case: asked for 2, the transfer landed 3, one sold. The
  // shelf holds 1. That request is still real work and must survive.
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 10: cell(1) } }, hub2: {}, central: { boot: { 10: cell(8) } } },
    refillRequests: { r10: missingSneakerReq({ size: "10", qty: 2 }) },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

test("an empty destination cell keeps its request", () => {
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(0) } }, hub2: {}, central: { boot: { 7: cell(9) } } },
    refillRequests: { r1: missingSneakerReq() },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

test("a NEGATIVE destination cell is zero available, never satisfaction", () => {
  // An oversold cell reads -3. Treating that as "stock present" would withdraw a
  // request into a hole. avail() floors at 0 everywhere in this engine and must
  // here too.
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(-3) } }, hub2: {}, central: {} },
    refillRequests: { r1: missingSneakerReq({ qty: 1 }) },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

// ── ONE UNIT SATISFIES ONE REQUEST ───────────────────────────────────────────

test("two requests on one cell cannot both be retired by the same pair", () => {
  // 3 on the shelf, two open asks of 2 each. The older one is covered; the
  // younger is not — 3 units cannot answer 4. Retiring both would tell Central a
  // size needing another pair was fully handled.
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(3) } }, hub2: {}, central: {} },
    refillRequests: {
      older: missingSneakerReq({ createdAt: "2026-08-06T20:50:09.106Z" }),
      newer: missingSneakerReq({ createdAt: "2026-08-06T21:10:00.000Z" }),
    },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["older"], "oldest request wins the units");
});

test("allocation is deterministic when two requests share a createdAt", () => {
  // The engine stamps a whole run with ONE createdAt, so same-timestamp siblings
  // are the normal case, not an edge case. Without the id tie-break the split
  // would depend on object key order and could flip between scans.
  const build = () => base({
    stock: { hub1: { boot: { 7: cell(2) } }, hub2: {}, central: {} },
    refillRequests: {
      bbb: missingSneakerReq({ createdAt: "2026-08-06T20:50:09.106Z" }),
      aaa: missingSneakerReq({ createdAt: "2026-08-06T20:50:09.106Z" }),
    },
  });
  assert.deepStrictEqual(satisfiedIds(computeRefillPlan(build())), ["aaa"]);
  assert.deepStrictEqual(satisfiedIds(computeRefillPlan(build())), ["aaa"], "same input, same decision");
});

// ── IT CANNOT CHURN OR LOOP ──────────────────────────────────────────────────

test("the withdrawal cannot churn — a cancelled request is never re-touched", () => {
  // Feed the plan its own output. A withdrawn request comes back as
  // status:"cancelled", and the pass must not see it at all — no second
  // withdrawal, no resurrection, nothing to oscillate.
  const first = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(3) } }, hub2: {}, central: {} },
    refillRequests: { r1: missingSneakerReq() },
  }));
  assert.deepStrictEqual(satisfiedIds(first), ["r1"]);
  const second = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(3) } }, hub2: {}, central: {} },
    refillRequests: { r1: missingSneakerReq({ status: "cancelled", cancelReason: "already_in_stock" }) },
  }));
  assert.deepStrictEqual(satisfiedIds(second), [], "a resolved request is out of scope forever");
});

test("the withdrawal never creates work — no intent, no order, no lock", () => {
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(3) } }, hub2: {}, central: { boot: { 7: cell(40) } } },
    refillRequests: { r1: missingSneakerReq() },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["r1"]);
  assert.strictEqual(plan.intents.length, 0, "a pass that only cancels can never feed itself");
  // and it emits nothing that could delete a lock
  for (const s of plan.satisfiedClosures) {
    assert.strictEqual(s.removeOrderId, undefined);
    assert.strictEqual(s.streakOp, undefined);
  }
});

test("a sale that empties the cell later does NOT un-cancel anything", () => {
  // Monotonicity in the right direction: the trigger is stock ARRIVING. A cell
  // dropping back to zero simply produces a fresh deficit through the normal
  // loop; it can never reopen a resolved row.
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(0) } }, hub2: {}, central: {} },
    refillRequests: { r1: missingSneakerReq({ status: "cancelled", cancelReason: "already_in_stock" }) },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

// ── SCOPE: WHAT IT MUST NOT TOUCH ────────────────────────────────────────────

test("a LOCKED request is left to needGone, which knows the target", () => {
  // hub2 wants 3 of size M and holds 2 — one short of TARGET but level with the
  // request quantity. The lock-less rule would wrongly retire it; the reconcile
  // loop, which nets against the approved target, correctly keeps it. Anything
  // in openIndex must stay out of this pass or target policy is silently
  // downgraded to "whatever the request happened to ask for".
  const plan = computeRefillPlan(base({
    config: { ...CONFIG, mode: { ...CONFIG.mode, hub2: "live" } },
    products: { ...PRODUCTS, tee: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    stock: { hub1: {}, hub2: { tee: { M: cell(2) } }, central: { tee: { M: cell(9) } } },
    refillRequests: {
      locked: {
        productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open",
        createdAt: "2026-08-06T20:50:00.000Z", createdFrom: { engine: true, source: "central" },
      },
    },
    openIndex: { hub2: { tee: { M: { refillId: "locked", qty: 2, source: "central", createdAt: "2026-08-06T20:50:00.000Z" } } } },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), [], "locked requests belong to the reconcile loop");
});

test("a locked sibling's units are claimed before an unlocked request is judged", () => {
  // Cell holds 3. A locked request has 2 spoken for, leaving 1 free — not enough
  // for the unlocked sibling's ask of 2. Cancelling it would retire an ask
  // against stock another request is already counting on, and a Missing Sneakers
  // ask is never re-raised once cancelled (that screen needs ZERO at both hubs).
  // (Kimi review, PR #332.)
  const plan = computeRefillPlan(base({
    products: { ...PRODUCTS, tee: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    stock: { hub1: {}, hub2: { tee: { M: cell(3) } }, central: { tee: { M: cell(9) } } },
    refillRequests: {
      locked: { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open",
                createdAt: "2026-08-06T18:00:00.000Z", createdFrom: { engine: true, source: "central" } },
      free: { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open",
              createdAt: "2026-08-06T19:00:00.000Z", createdFrom: { manual: true, source: "central", via: "missing_sneakers" } },
    },
    openIndex: { hub2: { tee: { M: { refillId: "locked", qty: 2, source: "central", createdAt: "2026-08-06T18:00:00.000Z" } } } },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), [], "only 1 unit is free — not enough for an ask of 2");
});

test("an unlocked request IS withdrawn when enough is free after locked claims", () => {
  const plan = computeRefillPlan(base({
    products: { ...PRODUCTS, tee: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    stock: { hub1: {}, hub2: { tee: { M: cell(4) } }, central: { tee: { M: cell(9) } } },
    refillRequests: {
      locked: { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open",
                createdAt: "2026-08-06T18:00:00.000Z", createdFrom: { engine: true, source: "central" } },
      free: { productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "open",
              createdAt: "2026-08-06T19:00:00.000Z", createdFrom: { manual: true, source: "central", via: "missing_sneakers" } },
    },
    openIndex: { hub2: { tee: { M: { refillId: "locked", qty: 2, source: "central", createdAt: "2026-08-06T18:00:00.000Z" } } } },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["free"]);
});

test("an ORPHANED engine request — lock gone, row alive — IS withdrawn", () => {
  // Found live on 2026-08-07: two requests created by the 12:30 run with no lock
  // in /refill_engine/open. Same immortal-open state as a Missing Sneakers row,
  // arrived at from the other direction, and the same rule retires it.
  const plan = computeRefillPlan(base({
    products: { ...PRODUCTS, tee: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    stock: { hub1: {}, hub2: { tee: { M: cell(2) } }, central: {} },
    refillRequests: {
      orphan: {
        productId: "tee", size: "M", qty: 1, requestingLocation: "hub2", status: "open",
        createdAt: "2026-08-07T12:30:29.618Z", createdFrom: { engine: true, source: "central" },
      },
    },
    openIndex: {},   // the lock is gone
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["orphan"]);
});

test("fulfilled and cancelled requests are out of scope", () => {
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(9) } }, hub2: {}, central: {} },
    refillRequests: {
      done: missingSneakerReq({ status: "fulfilled" }),
      gone: missingSneakerReq({ status: "cancelled" }),
    },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

test("shadow-mode preview requests are never withdrawn", () => {
  // Shadow rows are a read-only picture of what Live Mode would do; the intent
  // sync owns their lifecycle and deletes them wholesale. Cancelling one would
  // put a fake resolution in the history.
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(9) } }, hub2: {}, central: {} },
    refillRequests: { "SHDWrr-boot-7": missingSneakerReq({ shadow: true }) },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

test("a destination the scan did not load is silence, not satisfaction", () => {
  // marathon-pine is not in config.routes, so its stock is never fetched. An
  // absent location must never read as "cell is 0 / target met" in either
  // direction — the honest answer is to say nothing about it.
  const plan = computeRefillPlan(base({
    stock: { hub1: {}, hub2: {}, central: {} },
    refillRequests: { stray: missingSneakerReq({ requestingLocation: "marathon-pine" }) },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

test("a malformed request row is skipped, never withdrawn on a guess", () => {
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(9) } }, hub2: {}, central: {} },
    refillRequests: {
      noPid: { size: "7", qty: 1, requestingLocation: "hub1", status: "open", createdAt: "2026-08-06T20:50:00.000Z" },
      noSize: { productId: "boot", qty: 1, requestingLocation: "hub1", status: "open", createdAt: "2026-08-06T20:50:00.000Z" },
      noLoc: { productId: "boot", size: "7", qty: 1, status: "open", createdAt: "2026-08-06T20:50:00.000Z" },
      nullRow: null,
    },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), []);
});

// THE qty >= 1 FLOOR IS THE LOAD-BEARING GUARD. Mutation testing found this:
// the avail() floor on the cell and the "destination not loaded" check are both
// defensive-only, because a cell that reads 0 or −3 is below any want of 1 and
// is skipped either way. Remove the qty floor, however, and a malformed
// NEGATIVE quantity makes `free < want` true for an empty or oversold cell — the
// engine would then withdraw a request against a hole in the stock.
test("a negative or zero qty can never make an empty cell look satisfied", () => {
  for (const qty of [-5, 0, null, "abc"]) {
    const plan = computeRefillPlan(base({
      stock: { hub1: { boot: { 7: cell(-3) } }, hub2: {}, central: {} },
      refillRequests: { r1: missingSneakerReq({ qty }) },
    }));
    assert.deepStrictEqual(satisfiedIds(plan), [], `qty ${JSON.stringify(qty)} must not withdraw against an oversold cell`);
  }
});

test("a request with no qty is treated as asking for one unit", () => {
  const plan = computeRefillPlan(base({
    stock: { hub1: { boot: { 7: cell(1) } }, hub2: {}, central: {} },
    refillRequests: { r1: { ...missingSneakerReq(), qty: undefined } },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["r1"]);
  assert.strictEqual(plan.satisfiedClosures[0].qty, 1);
});

test("the one-size '_' sentinel resolves to the cell that actually holds the stock", () => {
  // A one-size request stores size "_". stockSizeKey and encodeSizeKey agree on
  // that sentinel, so the lookup lands on the real cell rather than a phantom.
  const plan = computeRefillPlan(base({
    products: { ...PRODUCTS, belt: { name: "Belt", productType: "clothing", sizes: ["_"] } },
    stock: { hub1: {}, hub2: { belt: { _: cell(2) } }, central: {} },
    refillRequests: {
      one: { productId: "belt", size: "_", qty: 1, requestingLocation: "hub2", status: "open", createdAt: "2026-08-06T20:50:00.000Z" },
    },
  }));
  assert.deepStrictEqual(satisfiedIds(plan), ["one"]);
});

// ── NO REGRESSION TO THE EXISTING PIPELINE ───────────────────────────────────

test("the new pass changes nothing when every open request is short", () => {
  const snap = base({
    products: { ...PRODUCTS, tee: { name: "Tee", productType: "clothing", sizes: ["M"] } },
    stock: { hub1: {}, hub2: { tee: { M: cell(0) } }, central: { tee: { M: cell(9) } } },
  });
  const plan = computeRefillPlan(snap);
  assert.deepStrictEqual(plan.satisfiedClosures, []);
  assert.ok(plan.intents.length > 0, "the normal deficit loop is untouched");
});
