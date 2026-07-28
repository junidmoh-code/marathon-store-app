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
