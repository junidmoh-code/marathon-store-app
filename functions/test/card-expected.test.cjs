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
