// ─── closeDisplayRowOnSale — the decisions ───────────────────────────────────
// Runs under `node --test` from functions/, like every other suite here.
// The trigger itself is plumbing; these are the answers it acts on.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyMovement, decideCloses, closeUpdates, leaseDecision, rowIsOpen,
  stockSizeKey, encodeSizeKey, LEASE_MS, DISPLAY_STORES,
} = require("../displayRows/lib.cjs");

const sold = (o = {}) => ({ type: "sold", from: "trophy", productId: "p1", size: "9", qty: 1, ...o });

test("a sale at a display store is a close", () => {
  assert.deepEqual(classifyMovement(sold()),
    { kind: "sold", store: "trophy", productId: "p1", sizeKey: "9", qty: 1 });
  assert.deepEqual(classifyMovement(sold({ from: "marathon-pe" })).store, "marathon-pe");
});

test("a sale ANYWHERE ELSE is ignored — this is the cheap early return", () => {
  for (const from of ["hub1", "hub2", "central", "marathon-pine", "", null, undefined]) {
    assert.equal(classifyMovement(sold({ from })), null, `from=${from}`);
  }
});

test("Pine is deliberately out of scope — its displays are booked at hub3", () => {
  assert.equal(DISPLAY_STORES.includes("marathon-pine"), false);
});

test("only a sale or a return-to-hub closes anything", () => {
  assert.equal(classifyMovement(sold({ type: "received" })), null);
  assert.equal(classifyMovement(sold({ type: "adjustment" })), null);
  assert.equal(classifyMovement(sold({ type: "transfer_in" })), null);
  assert.equal(classifyMovement({ type: "transfer_out", from: "trophy", to: "hub1", productId: "p1", size: "9" }).kind,
    "returned");
  // Shop to shop is not a return to the hub.
  assert.equal(classifyMovement({ type: "transfer_out", from: "trophy", to: "marathon-pe", productId: "p1", size: "9" }),
    null);
  // Hub 3 is not a hub this display lane books into.
  assert.equal(classifyMovement({ type: "transfer_out", from: "trophy", to: "hub3", productId: "p1", size: "9" }), null);
});

test("a one-size or size-less movement can never be a display row", () => {
  for (const size of [null, undefined, "", "Free Size", "   "]) {
    assert.equal(classifyMovement(sold({ size })), null, `size=${JSON.stringify(size)}`);
  }
});

test("a movement with no product is ignored, and a malformed one does not throw", () => {
  assert.equal(classifyMovement(sold({ productId: null })), null);
  assert.equal(classifyMovement(null), null);
  assert.equal(classifyMovement("nope"), null);
});

test("qty floors at one — a movement that moved something moved at least one", () => {
  assert.equal(classifyMovement(sold({ qty: 0 })).qty, 1);
  assert.equal(classifyMovement(sold({ qty: "3" })).qty, 3);
  assert.equal(classifyMovement(sold({ qty: -5 })).qty, 1);
});

test("the size is matched as a KEY, through the app's own encoder", () => {
  assert.equal(classifyMovement(sold({ size: "9.5" })).sizeKey, "9_5");
  assert.equal(stockSizeKey("9.5"), "9_5");
  assert.equal(encodeSizeKey(9.5), "9_5");
  assert.equal(stockSizeKey(" 8"), "_8");
});

// ── THE CENTRAL SAFETY PROPERTY ─────────────────────────────────────────────
test("a shelf sale of another size does NOT close the display record", () => {
  const byRow = { r1: { status: "open", sizeKey: "10", openedAt: "2026-09-01T00:00:00.000Z" } };
  assert.deepEqual(decideCloses(byRow, "9", 1), []);
});

test("the oldest matching open row goes first, and only as many as moved", () => {
  const byRow = {
    b: { status: "open", sizeKey: "9", openedAt: "2026-09-02T00:00:00.000Z" },
    a: { status: "open", sizeKey: "9", openedAt: "2026-09-01T00:00:00.000Z" },
  };
  assert.deepEqual(decideCloses(byRow, "9", 1).map((x) => x.rowId), ["a"]);
  assert.deepEqual(decideCloses(byRow, "9", 2).map((x) => x.rowId), ["a", "b"]);
  assert.deepEqual(decideCloses(byRow, "9", 9).map((x) => x.rowId), ["a", "b"]);
});

test("rows with no openedAt still sort deterministically, by id", () => {
  const byRow = { z: { status: "open", sizeKey: "9" }, a: { status: "open", sizeKey: "9" } };
  assert.deepEqual(decideCloses(byRow, "9", 2).map((x) => x.rowId), ["a", "z"]);
});

test("A CLOSED ROW IS NEVER RE-CLOSED — the structural half of idempotency", () => {
  const byRow = { r1: { status: "closed", sizeKey: "9", closedReason: "sold" } };
  assert.deepEqual(decideCloses(byRow, "9", 1), []);
  assert.equal(rowIsOpen(byRow.r1), false);
});

test("an empty or missing node closes nothing", () => {
  assert.deepEqual(decideCloses(null, "9", 1), []);
  assert.deepEqual(decideCloses({}, "9", 1), []);
  assert.deepEqual(decideCloses({ r: { status: "open", sizeKey: "9" } }, "9", 0), []);
});

test("the close writes FIELDS on the named row, never the row itself", () => {
  const u = closeUpdates("settings/displayRows/trophy/p1/r1",
    { at: "2026-09-08T10:00:00.000Z", reason: "sold", via: "pos_sale", movementId: "m9" });
  const paths = Object.keys(u);
  assert.ok(paths.every((p) => p.startsWith("settings/displayRows/trophy/p1/r1/")));
  assert.equal(u["settings/displayRows/trophy/p1/r1/status"], "closed");
  assert.equal(u["settings/displayRows/trophy/p1/r1/closedReason"], "sold");
  assert.equal(u["settings/displayRows/trophy/p1/r1/closedRef"], "m9");
  // The timeline entry's key is DERIVED, so a replay overwrites it rather than
  // appending the same fact twice.
  const again = closeUpdates("settings/displayRows/trophy/p1/r1",
    { at: "2026-09-08T10:00:00.000Z", reason: "sold", via: "pos_sale", movementId: "m9" });
  assert.deepEqual(u, again);
  // And the derived key is RTDB-legal — an ISO instant carries colons and dots.
  const eventPath = paths.find((p) => p.includes("/events/"));
  assert.equal(/[.#$[\]:]/.test(eventPath.split("/events/")[1]), false);
});

test("the lease claims once, refuses a replay, and is stealable when stale", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(leaseDecision({ cur: null, nowMs: now }), { at: now, done: false });
  assert.equal(leaseDecision({ cur: { done: true }, nowMs: now }), undefined);
  assert.equal(leaseDecision({ cur: { at: now - 1000, done: false }, nowMs: now }), undefined);
  // A crashed execution must not wedge the movement forever.
  assert.deepEqual(leaseDecision({ cur: { at: now - LEASE_MS - 1, done: false }, nowMs: now }),
    { at: now, done: false });
});
