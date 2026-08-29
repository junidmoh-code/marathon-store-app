// Tests for functions/lib/card-expected.cjs — expected card takings from
// tender legs. Event shapes mirror live /pos/paymentEvents rows (verified
// 2026-08-28): signed cents, method, kind, storeId, tillId, at, cashier*.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expectedCardFromEvents, cashiersFromEvents, computeExpectedCard } = require("../lib/card-expected.cjs");

// A batch window that straddles midnight, like every real one: opened 18:50,
// closed 18:50 the next day (SAST offsets don't matter here — `at` is epoch ms).
const OPEN = Date.UTC(2026, 7, 26, 16, 50, 4);   // 18:50:04 SAST
const CLOSE = Date.UTC(2026, 7, 27, 16, 50, 4);
const W = { storeId: "pe", tillId: "till-1", startMs: OPEN, endMs: CLOSE };

const ev = (over) => ({
  amount: 10000, at: OPEN + 1000, method: "card", kind: "sale",
  storeId: "pe", tillId: "till-1", cashierUid: "u1", cashierName: "Ikraan", ...over,
});

test("sums only the card legs of the right till in the window", () => {
  const r = expectedCardFromEvents([
    ev({ amount: 40000 }),
    ev({ amount: 20000, method: "cash" }),          // excluded: cash
    ev({ amount: 15000, method: "eft" }),           // excluded: EFT
    ev({ amount: 5000, method: "storeCredit" }),    // excluded: store credit
    ev({ amount: 5000, method: "onAccount" }),      // excluded: on-account
    ev({ amount: 30000, tillId: "till-2" }),        // excluded: other till
    ev({ amount: 30000, storeId: "trophy" }),       // excluded: other store
  ], W);
  assert.equal(r.cardCents, 40000);
  assert.equal(r.legs, 1);
});

test("the card portion of a split tender counts alone", () => {
  // One sale, three legs: R200 card + R100 cash + R50 store credit.
  const r = expectedCardFromEvents([
    ev({ amount: 20000, saleId: "s1" }),
    ev({ amount: 10000, method: "cash", saleId: "s1" }),
    ev({ amount: 5000, method: "storeCredit", saleId: "s1" }),
  ], W);
  assert.equal(r.cardCents, 20000);
});

test("layby deposits and instalments taken on card are included", () => {
  const r = expectedCardFromEvents([
    ev({ amount: 40000, kind: "layby_deposit" }),
    ev({ amount: 37500, kind: "layby_instalment" }),
    ev({ amount: 10000, kind: "sale" }),
  ], W);
  assert.equal(r.cardCents, 87500);
  assert.deepEqual(r.byKind.layby_deposit, { cents: 40000, legs: 1 });
  assert.deepEqual(r.byKind.layby_instalment, { cents: 37500, legs: 1 });
});

test("card refunds and voided card legs subtract (signed rows)", () => {
  const r = expectedCardFromEvents([
    ev({ amount: 50000 }),
    ev({ amount: -48000, kind: "refund" }),          // live shape: refund rows are negative
    ev({ amount: -20000, kind: "sale", voidOf: "x" }), // live shape: v~ void rows are negative
  ], W);
  assert.equal(r.cardCents, -18000);
  assert.equal(r.byKind.refund.cents, -48000);
});

test("window is start-inclusive, end-exclusive — one leg never lands in two batches", () => {
  const r = expectedCardFromEvents([
    ev({ amount: 100, at: OPEN }),          // exactly at open → THIS batch
    ev({ amount: 1000, at: OPEN - 1 }),     // before open → previous batch
    ev({ amount: 10000, at: CLOSE - 1 }),   // last ms → this batch
    ev({ amount: 100000, at: CLOSE }),      // exactly at close → NEXT batch
  ], W);
  assert.equal(r.cardCents, 10100);
});

test("a window straddling midnight keeps both sides", () => {
  const beforeMidnight = Date.UTC(2026, 7, 26, 21, 59, 0);
  const afterMidnight = Date.UTC(2026, 7, 27, 0, 1, 0);
  const r = expectedCardFromEvents([
    ev({ amount: 11100, at: beforeMidnight }),
    ev({ amount: 22200, at: afterMidnight }),
  ], W);
  assert.equal(r.cardCents, 33300);
});

test("malformed rows are skipped, never summed as NaN", () => {
  const r = expectedCardFromEvents([
    ev({ amount: 5000 }),
    ev({ amount: "R50" }),
    ev({ amount: null }),
    { method: "card" }, // no at/store/till
    null,
  ], W);
  assert.equal(r.cardCents, 5000);
  assert.equal(r.legs, 1);
});

test("accepts the RTDB object shape, not just arrays", () => {
  const r = expectedCardFromEvents({ a: ev({ amount: 100 }), b: ev({ amount: 200 }) }, W);
  assert.equal(r.cardCents, 300);
});

// ── cashiers (the read-only who-was-on-this-till evidence) ───────────────────
test("cashiers derive from ANY method on the till, with first/last times", () => {
  const cs = cashiersFromEvents([
    ev({ at: OPEN + 1000, cashierUid: "u1", cashierName: "Ikraan" }),
    ev({ at: OPEN + 9000, cashierUid: "u1", method: "cash" }),
    ev({ at: OPEN + 5000, cashierUid: "u2", cashierName: "Junid", method: "cash" }),
    ev({ at: OPEN + 500, cashierUid: "u3", cashierName: "Elsewhere", tillId: "till-2" }), // other till: out
    ev({ at: CLOSE + 10, cashierUid: "u4", cashierName: "TooLate" }),                     // after close: out
  ], W);
  assert.deepEqual(cs.map((c) => c.uid), ["u1", "u2"]);
  assert.equal(cs[0].firstAt, OPEN + 1000);
  assert.equal(cs[0].lastAt, OPEN + 9000);
  assert.equal(cs[0].legs, 2);
});

// ── the IO wrapper: query bounds + fold, with an injected fake db ────────────
test("computeExpectedCard queries by at-window and folds", async () => {
  const calls = [];
  const fakeDb = {
    ref(path) {
      return {
        orderByChild(field) {
          return {
            startAt(s) {
              return {
                endAt(e) {
                  return {
                    async once() {
                      calls.push({ path, field, s, e });
                      return { val: () => ({ a: ev({ amount: 12300 }), b: ev({ amount: 45600, method: "cash" }) }) };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const r = await computeExpectedCard(fakeDb, W);
  assert.equal(r.cardCents, 12300);
  assert.equal(r.cashiers.length, 1);
  assert.deepEqual(calls, [{ path: "pos/paymentEvents", field: "at", s: OPEN, e: CLOSE }]);
});

test("computeExpectedCard refuses a bad window", async () => {
  await assert.rejects(() => computeExpectedCard({}, { ...W, endMs: OPEN }), /bad window/);
});

// ─── THE WINDOW EDGE ─────────────────────────────────────────────────────────
// A printed slip's window has slack: the terminal opens the batch before the
// first sale and closes it after the last. A window DERIVED from transaction
// timestamps (the emailed banking report prints none) has none at all, so a
// till leg written seconds either side of the terminal's clock falls outside a
// window it plainly belongs to.
//
// Nothing is widened to compensate — a fabricated window is a fabricated
// variance. The near-misses are counted and reported instead, and these tests
// pin BOTH halves of that: they are reported, and they are NOT reconciled.
const EDGE = { storeId: "pe", tillId: "till-1" };
const leg = (at, amount, over = {}) => ({ method: "card", storeId: "pe", tillId: "till-1", at, amount, kind: "sale", ...over });

test("a leg just outside a derived window is reported but NOT counted", () => {
  const events = { a: leg(1000, 100), b: leg(2000, 200), c: leg(2500, 300) };
  const w = { ...EDGE, startMs: 1000, endMs: 2001, edgeMs: 1000 };
  const r = expectedCardFromEvents(events, w);
  assert.equal(r.cardCents, 300, "the expected figure counts only what is INSIDE the window");
  assert.equal(r.legs, 2);
  assert.equal(r.nearEdgeLegs, 1, "…and the one just outside is still reported");
  assert.equal(r.nearEdgeCents, 300);
});

test("the expected figure is identical whether or not the edge is being reported", () => {
  // The whole design rests on this: turning edge reporting on must not move a
  // single cent of the reconciliation.
  const events = { a: leg(1000, 100), b: leg(2000, 200), c: leg(2500, 300), d: leg(500, 400) };
  const base = { ...EDGE, startMs: 1000, endMs: 2001 };
  const off = expectedCardFromEvents(events, base);
  const on = expectedCardFromEvents(events, { ...base, edgeMs: 60000 });
  assert.equal(on.cardCents, off.cardCents);
  assert.equal(on.legs, off.legs);
  assert.deepEqual(on.byKind, off.byKind);
  assert.equal(off.nearEdgeLegs, 0, "with no edge asked for, nothing is reported");
  assert.equal(on.nearEdgeLegs, 2, "with one asked for, both sides are");
});

test("a leg far outside the window is not reported as near the edge", () => {
  const events = { a: leg(1000, 100), far: leg(999999, 900) };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: 1000, endMs: 2001, edgeMs: 1000 });
  assert.equal(r.nearEdgeLegs, 0, "the edge report must not reach a neighbouring batch");
  assert.equal(r.cardCents, 100);
});

test("only this till's card legs count as near the edge", () => {
  const events = {
    other: leg(2500, 300, { tillId: "till-2" }),
    cash: leg(2500, 300, { method: "cash" }),
    store: leg(2500, 300, { storeId: "trophy" }),
    mine: leg(2500, 111),
  };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: 1000, endMs: 2001, edgeMs: 1000 });
  assert.equal(r.nearEdgeLegs, 1);
  assert.equal(r.nearEdgeCents, 111);
});

test("a malformed amount is not reported as a near-edge leg either", () => {
  const events = { bad: leg(2500, null), worse: leg(2500, "300") };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: 1000, endMs: 2001, edgeMs: 1000 });
  assert.equal(r.nearEdgeLegs, 0, "a null must not fold in as a 0-cent near-edge leg");
  assert.equal(r.nearEdgeCents, 0);
});

test("the query WIDENS by edgeMs, or the near-edge legs are never fetched", () => {
  // The pure filter can only report a leg the query actually returned. Widening
  // the fetch is what makes the edge visible at all — and it must not widen the
  // window itself, which the assertions below hold to.
  const calls = [];
  const mkDb = (rows) => ({
    ref: (path) => ({
      orderByChild: (field) => ({
        startAt: (s) => ({
          endAt: (e) => ({
            async once() { calls.push({ path, field, s, e }); return { val: () => rows }; },
          }),
        }),
      }),
    }),
  });
  const justOutside = ev({ amount: 7700, at: CLOSE + 30 * 1000 });
  return (async () => {
    const r = await computeExpectedCard(mkDb({ a: ev({ amount: 12300 }), z: justOutside }), { ...W, edgeMs: 60 * 1000 });
    assert.deepEqual(calls, [{ path: "pos/paymentEvents", field: "at", s: OPEN - 60000, e: CLOSE + 60000 }],
      "the FETCH is widened by the edge");
    assert.equal(r.cardCents, 12300, "…but the reconciled figure is not");
    assert.equal(r.nearEdgeLegs, 1, "…and the leg just past the close is reported");
    assert.equal(r.nearEdgeCents, 7700);
  })();
});

// ─── THE TAIL ────────────────────────────────────────────────────────────────
// A banking report states no closing time, so its window runs to the moment the
// report was printed — minutes after its last transaction, because a till leg
// is always written after the terminal approves the card (measured on the real
// report against the live ledger: minimum 118 seconds, median 134, never
// negative). Legs in that gap are counted, and rightly. But a sale rung up in
// the gap and settled into the NEXT batch would land there too and be counted
// twice, so the tail is measured and reported rather than hidden inside the
// figure it contributes to.
test("legs after the last transaction are counted AND reported", () => {
  const events = {
    a: leg(OPEN + 1000, 10000),
    b: leg(OPEN + 5000, 35000),
    c: leg(OPEN + 9000, 20000),
  };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: OPEN, endMs: OPEN + 20000, tailFromMs: OPEN + 4000 });
  assert.equal(r.cardCents, 65000, "the tail IS part of the expected figure");
  assert.equal(r.legs, 3);
  assert.equal(r.tailLegs, 2, "…and is reported as its own number");
  assert.equal(r.tailCents, 55000);
});

test("a leg exactly at the last transaction's instant is not tail", () => {
  // The boundary is the last transaction's own timestamp, and the tail is what
  // comes AFTER it. A leg at that very instant belongs to the transaction, not
  // to the gap that follows.
  const events = { at: leg(OPEN + 4000, 5000), after: leg(OPEN + 4001, 6000) };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: OPEN, endMs: OPEN + 20000, tailFromMs: OPEN + 4000 });
  assert.equal(r.cardCents, 11000, "both are inside the window either way");
  assert.equal(r.tailLegs, 1, "only the one after the boundary");
  assert.equal(r.tailCents, 6000);
});

test("with no tail boundary nothing is reported as tail", () => {
  // A printed slip declares its own window, so it has no tail to speak of.
  const events = { a: leg(OPEN + 1000, 10000), b: leg(OPEN + 9000, 20000) };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: OPEN, endMs: OPEN + 20000 });
  assert.equal(r.cardCents, 30000);
  assert.equal(r.tailLegs, 0);
  assert.equal(r.tailCents, 0);
});

test("the tail never changes the expected figure it is measured from", () => {
  const events = { a: leg(OPEN + 1000, 10000), b: leg(OPEN + 9000, 20000) };
  const base = { ...EDGE, startMs: OPEN, endMs: OPEN + 20000 };
  const off = expectedCardFromEvents(events, base);
  const on = expectedCardFromEvents(events, { ...base, tailFromMs: OPEN + 4000 });
  assert.equal(on.cardCents, off.cardCents);
  assert.equal(on.legs, off.legs);
  assert.deepEqual(on.byKind, off.byKind);
  assert.equal(on.tailLegs, 1);
});

test("only this till's card legs count as tail", () => {
  const events = {
    other: leg(OPEN + 9000, 30000, { tillId: "till-2" }),
    cash: leg(OPEN + 9000, 30000, { method: "cash" }),
    mine: leg(OPEN + 9000, 12300),
  };
  const r = expectedCardFromEvents(events, { ...EDGE, startMs: OPEN, endMs: OPEN + 20000, tailFromMs: OPEN + 4000 });
  assert.equal(r.tailLegs, 1);
  assert.equal(r.tailCents, 12300);
});
