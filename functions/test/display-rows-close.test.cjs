// ─── closeDisplayRowOnSale — the decisions ───────────────────────────────────
// Runs under `node --test` from functions/, like every other suite here.
// The trigger itself is plumbing; these are the answers it acts on.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyMovement, decideCloses, closeUpdates, claimClose, leaseDecision, rowIsOpen,
  stockSizeKey, encodeSizeKey, LEASE_MS, DISPLAY_STORES,
} = require("../displayRows/lib.cjs");

const sold = (o = {}) => ({ type: "sold", from: "trophy", productId: "p1", size: "9", qty: 1, ...o });

test("a sale at a display store is a close", () => {
  assert.deepEqual(classifyMovement(sold()),
    { kind: "sold", store: "trophy", productId: "p1", sizeKey: "9", qty: 1 });
  assert.deepEqual(classifyMovement(sold({ from: "marathon-pe" })).store, "marathon-pe");
});

test("a sale ANYWHERE ELSE is ignored — this is the cheap early return", () => {
  // hub1/hub2 are NOT here: sneakers sell from the hub, and those are handled
  // as their own kind below. Everything else is a movement this trigger has no
  // business reading a single extra byte for.
  for (const from of ["central", "marathon-pine", "hub3", "in_transit", "", null, undefined]) {
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

// ─── HUB-SOURCED SALES — sneakers sell from the hub, not from the shop ───────
// Measured live 2026-09-08 over the newest 6,000 stock movements:
//   marathon-pe/sized 1539, trophy/sized 267  |  hub1/sized 761, hub2/sized 478
// So two in five in-scope sized sales carry `from: hub1|hub2` and NO store.

const { resolveHubSale, HUB_INFERENCE_MAX_AGE_MS } = require("../displayRows/lib.cjs");

// Every hub-inference case needs an instant and a clock, because the FIRST
// thing the inference checks is how old the sale is.
const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const fresh = (o = {}) => ({ movementTs: new Date(NOW - 1000).toISOString(), nowMs: NOW, ...o });

test("a hub-sourced sale is its own kind, carrying the hub and no store", () => {
  const hit = classifyMovement({ type: "sold", from: "hub1", productId: "p1", size: "9", qty: 1 });
  assert.equal(hit.kind, "sold_hub");
  assert.equal(hit.hub, "hub1");
  assert.equal(hit.store, null);
});

test("hub3 is NOT a hub-sourced display sale — Pine is out of scope", () => {
  assert.equal(classifyMovement({ type: "sold", from: "hub3", productId: "p1", size: "9", qty: 1 }), null);
});

test("A BARE HUB SALE CLOSES NOTHING — the whole safety of the inference", () => {
  // Hub 1 holds four size 9s and one is on Trophy's wall. An ordinary shelf
  // sale is not the display, and closing Trophy's row would take a real
  // display off the record.
  const r = resolveHubSale(fresh({ openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: 3 }));
  assert.equal(r.ok, false);
  assert.match(r.why, /still holds 3/);
});

test("two walls claiming the size is ambiguous, and ambiguous is a refusal", () => {
  const r = resolveHubSale(fresh({
    openRowsByStore: { trophy: [{ rowId: "a" }], "marathon-pe": [{ rowId: "b" }] },
    cellQty: 0,
  }));
  assert.equal(r.ok, false);
  assert.match(r.why, /not knowable/);
});

test("one wall, and the hub cell now empty: the sale could not have been anything else", () => {
  assert.deepEqual(resolveHubSale(fresh({ openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: 0 })),
    { ok: true, store: "trophy", rowId: "a" });
  // Negative cells happen (they clamp to 0 elsewhere); they are still empty.
  assert.equal(resolveHubSale(fresh({ openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: -1 })).ok, true);
});

test("an ABSENT cell is zero stock; an unreadable one is a refusal", () => {
  // RTDB keeps no node for a cell holding nothing, and the Admin SDK throws on
  // a failed read rather than handing back null — so null really is "none".
  for (const cellQty of [null, undefined]) {
    assert.equal(resolveHubSale(fresh({ openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty })).ok, true,
      `cellQty=${String(cellQty)}`);
  }
  // Anything else non-numeric is unknown, and unknown must never close a row.
  for (const cellQty of [NaN, "lots", {}, []]) {
    const r = resolveHubSale(fresh({ openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty }));
    assert.equal(r.ok, false, `cellQty=${JSON.stringify(cellQty)}`);
    assert.match(r.why, /could not be read/);
  }
});

test("no open row at that hub is simply nothing to do", () => {
  assert.equal(resolveHubSale(fresh({ openRowsByStore: {}, cellQty: 0 })).ok, false);
  assert.equal(resolveHubSale(fresh({ openRowsByStore: { trophy: [] }, cellQty: 0 })).ok, false);
});

test("an inferred close records WHY on the row, so a human can see the reasoning", () => {
  const out = claimClose({ status: "open", sizeKey: "9", events: {} },
    { at: "2026-09-08T10:00:00.000Z", reason: "sold", via: "pos_sale_hub", movementId: "m1",
      inferred: "the hub cell is empty and one wall claims this size" });
  const ev = Object.values(out.events)[0];
  assert.equal(ev.detail.inferred, "the hub cell is empty and one wall claims this size");
  assert.equal(out.closedVia, "pos_sale_hub");
  assert.equal(out.closedReason, "sold");
});

test("claimClose is a CAS — it refuses a row somebody else already closed", () => {
  assert.equal(claimClose({ status: "closed", sizeKey: "9" }, { at: "x", reason: "sold", via: "v" }), undefined);
  assert.equal(claimClose(null, { at: "x", reason: "sold", via: "v" }), undefined);
  assert.equal(claimClose({ status: "open", sizeKey: "_" }, { at: "x", reason: "sold", via: "v" }), undefined);
});

test("an all-underscore sizeKey is never an open row, on this side too", () => {
  assert.equal(rowIsOpen({ status: "open", sizeKey: "__" }), false);
  assert.equal(rowIsOpen({ status: "open", sizeKey: "___" }), false);
  assert.equal(rowIsOpen({ status: "open", sizeKey: "9" }), true);
});


// ── THE STALENESS BOUND — the fault that made the inference unsound ─────────
// The cell is read NOW and describes an event that happened THEN. A cold start,
// a redelivery or an offline-queue drain can put minutes between them, and in
// those minutes a counter or a transfer can empty the cell for a reason that
// has nothing to do with the sale.

test("a sale older than the bound is refused, however clean the evidence looks", () => {
  const one = { openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: 0 };
  assert.equal(resolveHubSale({ ...one, movementTs: new Date(NOW - 1000).toISOString(), nowMs: NOW }).ok, true);
  assert.equal(resolveHubSale({ ...one, movementTs: new Date(NOW - HUB_INFERENCE_MAX_AGE_MS + 1000).toISOString(), nowMs: NOW }).ok, true);
  const late = resolveHubSale({ ...one, movementTs: new Date(NOW - HUB_INFERENCE_MAX_AGE_MS - 1).toISOString(), nowMs: NOW });
  assert.equal(late.ok, false);
  assert.match(late.why, /too long to attribute/);
  // The 4-minute scenario from the review, explicitly.
  const scenario = resolveHubSale({ ...one, movementTs: new Date(NOW - 5 * 60 * 1000).toISOString(), nowMs: NOW });
  assert.equal(scenario.ok, false);
});

test("a sale with no readable instant is refused — unknown age is not fresh age", () => {
  const one = { openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: 0, nowMs: NOW };
  for (const movementTs of [null, undefined, "", "not a date", 12345]) {
    const r = resolveHubSale({ ...one, movementTs });
    assert.equal(r.ok, false, `ts=${String(movementTs)}`);
    assert.match(r.why, /no readable instant/);
  }
});

test("a sale stamped in the FUTURE is refused too — a wrong clock is not evidence", () => {
  const r = resolveHubSale({
    openRowsByStore: { trophy: [{ rowId: "a" }] }, cellQty: 0,
    movementTs: new Date(NOW + 60 * 1000).toISOString(), nowMs: NOW,
  });
  assert.equal(r.ok, false);
});

test("TWO ROWS ON ONE WALL is ambiguous too, so a duplicated wall never auto-closes", () => {
  const r = resolveHubSale(fresh({
    openRowsByStore: { trophy: [{ rowId: "a" }, { rowId: "b" }] }, cellQty: 0,
  }));
  assert.equal(r.ok, false);
  assert.match(r.why, /2 display records claim this size/);
});
