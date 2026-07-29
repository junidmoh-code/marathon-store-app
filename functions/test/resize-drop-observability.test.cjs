// ─── RESIZE DROP OBSERVABILITY — tests ───────────────────────────────────────
// The apply path has two `continue`s that discard a resize the plan asked for.
// Until 2026-07-28 both were silent: no counter, no log, no exception row, so a
// planned resize that never landed left NO trace in the run record.
//
// The cost, measured live: STORE legs (which carry an order, so they run the
// order transaction) landed 186 resizes on 2026-07-13 then fell to ~1/day, while
// HUB legs (no orderId → that transaction is skipped) kept flowing — 150 landed,
// the most recent on the day this was written. Two weeks of one-directional
// under-delivery that took a database archaeology session to notice, because
// `resized` only ever counted successes.
//
// These tests pin the reason vocabulary. The counter is only useful if the
// reasons are STABLE — an operator reading `{order_guard_bailed: 4}` on a run
// record has to be able to trust that string means what it meant last month.
//
// Run: cd functions && node --test test/resize-drop-observability.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _resizeDropReason: reason } = require("../refill-scan.cjs");

// ── ORDER stage — store legs only (hub legs have no orderId and skip it) ─────

test("order: a thrown transaction is named a txn error, not a guard bail", () => {
  // Network/rules failure. Distinct from the guard deliberately refusing —
  // conflating them would hide an outage inside a normal-looking counter.
  assert.equal(reason("order", { threw: true }), "order_txn_error");
});

test("order: callback returned undefined → guard bailed (in-flight / touched / not autoRefill)", () => {
  // The three documented guards: clothingPlanGen set, clothingRefillStatus set,
  // or !autoRefill. All surface as one reason — they mean the same thing
  // operationally: a human or a fulfil attempt owns this card, leave it alone.
  assert.equal(reason("order", { committed: false }), "order_guard_bailed");
});

test("order: committed against a null node → vanished, the close path owns it", () => {
  // Confirmed live behaviour (scratch-node probe, 2026-07-28): when the node is
  // genuinely absent the transaction COMMITS with a null snapshot, so
  // committed=true / exists=false. Dropping here is correct — a resize must not
  // resurrect a deleted order.
  assert.equal(reason("order", { committed: true, exists: false }), "order_vanished");
});

// ── REQUEST stage — runs for BOTH leg types ─────────────────────────────────

test("request: thrown transaction is named a txn error", () => {
  assert.equal(reason("request", { threw: true }), "request_txn_error");
});

test("request: callback returned undefined → status was not open", () => {
  // The only guard on the rr callback. Typically resolved concurrently — e.g. a
  // hub2 leg fulfilled between plan and apply.
  assert.equal(reason("request", { committed: false }), "request_not_open");
});

test("request: committed against a null node → vanished", () => {
  assert.equal(reason("request", { committed: true, exists: false }), "request_vanished");
});

test("request: committed and present but the wrong qty → a concurrent writer won", () => {
  // The scan asked for 2, the node holds 3. Not an error and not a bail —
  // somebody else changed it, and the lock must NOT be written to 2.
  assert.equal(reason("request", { committed: true, exists: true, qty: 3, want: 2 }), "request_qty_mismatch");
});

test("request: committed, present, qty matches → no drop reason applies", () => {
  // The success shape never reaches the classifier in the scan; asserted here so
  // a future edit cannot make the happy path silently classify as a drop.
  assert.equal(reason("request", { committed: true, exists: true, qty: 2, want: 2 }), "request_unknown");
});

// ── vocabulary stability ─────────────────────────────────────────────────────

test("every reason is stage-prefixed and snake_case — stable for run-record readers", () => {
  const all = [
    reason("order", { threw: true }),
    reason("order", { committed: false }),
    reason("order", { committed: true, exists: false }),
    reason("request", { threw: true }),
    reason("request", { committed: false }),
    reason("request", { committed: true, exists: false }),
    reason("request", { committed: true, exists: true, qty: 3, want: 2 }),
  ];
  for (const r of all) {
    assert.match(r, /^(order|request)_[a-z_]+$/, `unstable reason string: ${r}`);
  }
  // No two distinct outcomes may collapse onto the same string, or the counter
  // stops distinguishing "an outage" from "working as designed".
  assert.equal(new Set(all).size, all.length, "reason strings must be unique per outcome");
});

test("threw wins over every other flag — an exception is never reported as a clean bail", () => {
  assert.equal(reason("order", { threw: true, committed: true, exists: true }), "order_txn_error");
  assert.equal(reason("request", { threw: true, committed: true, exists: true, qty: 2, want: 2 }), "request_txn_error");
});

test("defaults are safe: no outcome info still yields a named reason, never undefined", () => {
  // The scan falls back to `dropResize(dropReason || "order_unknown")`, but the
  // classifier itself must never hand back undefined and put it in a counter key.
  assert.equal(typeof reason("order"), "string");
  assert.equal(typeof reason("request"), "string");
});

// ═══ APPLY-PATH ACCOUNTING ═══════════════════════════════════════════════════
// The classifier tests above prove the reason VOCABULARY. These prove the
// accounting actually happens: that a dropped resize increments the counter and
// names its reason, and that a success does not. Without these, `dropResize`,
// the `counts.resizeDropped` shape and the lock-write branch are unpinned — a
// refactor could stop counting entirely and every test above would still pass.
// (CodeRabbit, PR #286.)
const { _applyResizes: applyResizes } = require("../refill-scan.cjs");

const snap = (val) => ({ exists: () => val !== null && val !== undefined, val: () => val });

// Fake db modelling the RTDB transaction wire closely enough for this path:
// the callback runs against the CURRENT server value; returning undefined aborts
// (committed:false), anything else commits.
function fakeDb(nodes, opts = {}) {
  return {
    ref(path) {
      return {
        async transaction(fn) {
          if (opts.throwOn && opts.throwOn.test(path)) throw new Error("simulated network failure");
          const cur = path in nodes ? nodes[path] : null;
          const out = fn(cur);
          if (out === undefined) return { committed: false, snapshot: snap(cur) };
          // CONCURRENT WRITE = RETRY, not a divergent commit. RTDB re-invokes the
          // handler against the new value and commits THAT result — it can never
          // commit a value the handler did not return. `raceOnce` models exactly
          // that: one interfering write, then the handler runs again and wins.
          if (opts.raceOnce && opts.raceOnce.test(path) && !opts._raced) {
            opts._raced = true;
            nodes[path] = { ...(cur || {}), ...opts.raceOnce_value };
            const retried = fn(nodes[path]);
            if (retried === undefined) return { committed: false, snapshot: snap(nodes[path]) };
            nodes[path] = retried;
            return { committed: true, snapshot: snap(retried) };
          }
          nodes[path] = out;
          return { committed: true, snapshot: snap(out) };
        },
      };
    },
  };
}

const RZ = { dest: "marathon-pe", pid: "p1", sizeKey: "L", orderId: "R001-1", refillId: "rr1", from: 1, to: 2 };
const OK_SET = async () => true;
const START = "2026-07-28T00:00:00.000Z";

test("apply: a clean resize increments `resized` and records NO drop", () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  return applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: OK_SET }).then((r) => {
    assert.equal(r.resized, 1);
    assert.deepEqual(r.resizeDrops, {}, "a success must not record a drop");
    assert.equal(nodes["orders/R001-1"].qty, 2, "order qty written");
    assert.equal(nodes["refill_requests/rr1"].qty, 2, "request qty written");
    assert.equal(nodes["refill_requests/rr1"].resizedFrom, 1, "resizedFrom from the in-transaction value");
  });
});

test("apply: order guard bails → counter increments and NAMES order_guard_bailed", async () => {
  // clothingPlanGen set = a fulfil attempt locked its split.
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true, clothingPlanGen: 3 }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: OK_SET });
  assert.equal(r.resized, 0);
  assert.deepEqual(r.resizeDrops, { order_guard_bailed: 1 });
  assert.equal(nodes["refill_requests/rr1"].qty, 1, "request untouched once the order bailed");
});

test("apply: order vanished → order_vanished, request never attempted", async () => {
  const nodes = { "refill_requests/rr1": { qty: 1, status: "open" } };   // no order node
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: OK_SET });
  assert.deepEqual(r.resizeDrops, { order_vanished: 1 });
  assert.equal(nodes["refill_requests/rr1"].qty, 1);
});

test("apply: order transaction throws → order_txn_error", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const r = await applyResizes({ db: fakeDb(nodes, { throwOn: /^orders\// }), resizes: [RZ], startedAt: START, setFn: OK_SET });
  assert.deepEqual(r.resizeDrops, { order_txn_error: 1 });
});

test("apply: request not open → request_not_open, and the LOCK is not written", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "fulfilled" } };
  let lockWrites = 0;
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: async () => { lockWrites++; return true; } });
  assert.deepEqual(r.resizeDrops, { request_not_open: 1 });
  assert.equal(lockWrites, 0, "lock must not move when the request bailed");
});

test("apply: lock write fails → lock_write_failed (order+request MOVED, lock did not)", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: async () => false });
  assert.equal(r.resized, 0, "a failed lock write must not count as a success");
  assert.deepEqual(r.resizeDrops, { lock_write_failed: 1 });
  // This is the inconsistent-state drop the reason exists to surface.
  assert.equal(nodes["orders/R001-1"].qty, 2, "order already moved");
  assert.equal(nodes["refill_requests/rr1"].qty, 2, "request already moved");
});

test("apply: hub legs (no orderId) skip the order transaction entirely", async () => {
  // The structural difference behind the live store-vs-hub split.
  const hubRz = { ...RZ, dest: "hub2", orderId: null };
  const nodes = { "refill_requests/rr1": { qty: 1, status: "open" } };   // no order node at all
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [hubRz], startedAt: START, setFn: OK_SET });
  assert.equal(r.resized, 1, "a hub leg lands without any order node");
  assert.deepEqual(r.resizeDrops, {});
});

test("apply: reasons TALLY across several resizes in one run", async () => {
  const nodes = {
    "orders/A": { qty: 1, autoRefill: true, clothingPlanGen: 1 },        // guard bail
    "orders/B": { qty: 1, autoRefill: true, clothingRefillStatus: "x" }, // guard bail
    "orders/C": { qty: 1, autoRefill: true },                            // clean
    "refill_requests/ra": { qty: 1, status: "open" },
    "refill_requests/rb": { qty: 1, status: "open" },
    "refill_requests/rc": { qty: 1, status: "open" },
  };
  const rzs = [
    { ...RZ, orderId: "A", refillId: "ra" },
    { ...RZ, orderId: "B", refillId: "rb" },
    { ...RZ, orderId: "C", refillId: "rc" },
  ];
  const r = await applyResizes({ db: fakeDb(nodes), resizes: rzs, startedAt: START, setFn: OK_SET });
  assert.equal(r.resized, 1);
  assert.deepEqual(r.resizeDrops, { order_guard_bailed: 2 }, "same reason accumulates, not overwrites");
});

test("apply: a clean run yields an EMPTY drops object, so counts stays quiet", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: OK_SET });
  assert.equal(Object.keys(r.resizeDrops).length, 0,
    "runScan only sets counts.resizeDropped when non-empty — an empty object here is what keeps a clean run silent");
});

// ── request-side drops through the APPLY path ────────────────────────────────
// These three were classifier-only until CodeRabbit flagged it on PR #286: the
// reason string was pinned but the extraction of it from a real transaction
// result was not, so a wrong field read (`r2.snapshot.val().qty` vs `r2.val()`)
// would have gone undetected.

test("apply: request transaction throws → request_txn_error, order already moved", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const r = await applyResizes({ db: fakeDb(nodes, { throwOn: /^refill_requests\// }), resizes: [RZ], startedAt: START, setFn: OK_SET });
  assert.equal(r.resized, 0);
  assert.deepEqual(r.resizeDrops, { request_txn_error: 1 });
  assert.equal(nodes["orders/R001-1"].qty, 2, "the order moved before the request threw — same inconsistency class as lock_write_failed");
});

test("apply: request node vanished → request_vanished, lock not written", async () => {
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true } };   // no request node
  let lockWrites = 0;
  const r = await applyResizes({ db: fakeDb(nodes), resizes: [RZ], startedAt: START, setFn: async () => { lockWrites++; return true; } });
  assert.deepEqual(r.resizeDrops, { request_vanished: 1 });
  assert.equal(lockWrites, 0);
});

test("apply: a concurrent write RETRIES the handler and the resize still lands", () => {
  // RTDB re-invokes the transaction handler against the new value rather than
  // committing a divergent one, so `request_qty_mismatch` is DEFENSIVE ONLY —
  // unreachable through the real API. This pins the behaviour that actually
  // occurs: someone else writes, the handler runs again, our value wins, and no
  // drop is recorded. (CodeRabbit, PR #286 — the earlier version of this test
  // synthesised a committed-but-divergent snapshot, which the API cannot produce.)
  const nodes = { "orders/R001-1": { qty: 1, autoRefill: true }, "refill_requests/rr1": { qty: 1, status: "open" } };
  const opts = { raceOnce: /^refill_requests\//, raceOnce_value: { qty: 3 } };
  return applyResizes({ db: fakeDb(nodes, opts), resizes: [RZ], startedAt: START, setFn: OK_SET }).then((r) => {
    assert.equal(r.resized, 1, "the retry commits our value, so the resize lands");
    assert.deepEqual(r.resizeDrops, {}, "a retry is not a drop");
    assert.equal(nodes["refill_requests/rr1"].qty, 2, "our qty wins after the retry");
    assert.equal(nodes["refill_requests/rr1"].resizedFrom, 3,
      "resizedFrom comes from the AUTHORITATIVE in-transaction value (3), not the planning snapshot (1)");
  });
});
