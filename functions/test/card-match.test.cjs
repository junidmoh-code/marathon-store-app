// ─── MATCHING TRANSACTIONS TO TILL LEGS ──────────────────────────────────────
// The reconciliation used to subtract every card leg on the till the terminal
// is MAPPED to. The machines move, so that is wrong whenever one does: a
// speedpoint spent a morning at Trophy while its terminal ID points at PE
// Till 2, and four of that day's sales were rung on Trophy's till. R3,500 of
// perfectly good takings were reported as missing, and the subtraction had
// nothing to say about which R3,500.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { matchLegs, MATCH_AHEAD_MS, MATCH_BEHIND_MS } = require("../lib/card-match.cjs");

const T0 = Date.UTC(2026, 7, 29, 7, 0, 0);
const TERMINAL = { storeId: "pe", tillId: "till-2" };
const txn = (tsn, mins, cents) => ({ tsn, at: T0 + mins * 60000, amountCents: cents });
// A till leg lands AFTER the terminal's stamp — measured on the real report:
// minimum 118 s, median 135 s, maximum 249 s across forty transactions.
const leg = (mins, cents, over = {}) => ({
  at: T0 + mins * 60000, amount: cents, method: "card",
  storeId: "pe", tillId: "till-2", cashierName: "zinhle@marathon.internal", ...over,
});
const TROPHY = { storeId: "trophy", tillId: "till-1", cashierName: "yasmin@marathon.internal" };

test("an ordinary batch matches on its own till", () => {
  const r = matchLegs(
    [txn(1, 0, 90000), txn(2, 10, 70000)],
    [leg(2.25, 90000), leg(12.25, 70000)],
    TERMINAL,
  );
  assert.equal(r.matches.length, 2);
  assert.equal(r.matchedCents, 160000);
  assert.equal(r.onTillCents, 160000);
  assert.equal(r.offTillCents, 0);
  assert.equal(r.unmatchedTxnCents, 0);
  assert.equal(r.unmatchedLegCents, 0);
  assert.equal(r.offTill.pe, undefined);
});

test("THE MOVED MACHINE: legs rung on another till still count", () => {
  // The real case. Four transactions rung at Trophy because the speedpoint was
  // there that morning; the rest on its own till. Nothing is missing.
  const txns = [txn(1, 0, 90000), txn(2, 5, 70000), txn(3, 10, 150000), txn(4, 20, 40000), txn(5, 30, 35000)];
  const legs = [
    leg(2.25, 90000, TROPHY), leg(7.25, 70000, TROPHY),
    leg(12.3, 150000, TROPHY), leg(22.3, 40000, TROPHY),
    leg(32.2, 35000),
  ];
  const r = matchLegs(txns, legs, TERMINAL);
  assert.equal(r.matches.length, 5, "every transaction is accounted for");
  assert.equal(r.unmatchedTxnCents, 0, "…so nothing is missing");
  assert.equal(r.onTillCents, 35000);
  assert.equal(r.offTillCents, 350000, "R3,500 rung elsewhere");
  assert.deepEqual(r.offTill, { "trophy/till-1": { legs: 4, cents: 350000 } },
    "…and the record says where, so a moved machine reads as information");
});

test("a leg on the RIGHT till is never stolen by a cross-till candidate", () => {
  // Two transactions of the same amount, one leg on each till. The two-pass
  // order guarantees the on-till transaction keeps the on-till leg.
  const txns = [txn(1, 0, 50000), txn(2, 1, 50000)];
  const legs = [leg(3, 50000, TROPHY), leg(3.1, 50000)];
  const r = matchLegs(txns, legs, TERMINAL);
  assert.equal(r.matches.length, 2);
  assert.equal(r.onTillCents, 50000);
  assert.equal(r.offTillCents, 50000);
  assert.equal(r.unmatchedTxnCents, 0);
});

test("money on the machine with no sale anywhere is THE finding", () => {
  const r = matchLegs(
    [txn(1, 0, 90000), txn(2, 10, 70000)],
    [leg(2.25, 90000)],
    TERMINAL,
  );
  assert.equal(r.unmatchedTxns.length, 1);
  assert.equal(r.unmatchedTxns[0].tsn, 2);
  assert.equal(r.unmatchedTxnCents, 70000, "R700 taken on the machine that no sale accounts for");
  assert.equal(r.matchedCents, 90000);
});

test("a card sale with no transaction is a SEPARATE finding, never netted off", () => {
  // One transaction unmatched (R700 on the machine, no sale) and one leg
  // unmatched (R500 sale, no machine record). These are different questions and
  // must not cancel to R200.
  const r = matchLegs(
    [txn(1, 0, 90000), txn(2, 10, 70000)],
    [leg(2.25, 90000), leg(40, 50000)],
    TERMINAL,
  );
  assert.equal(r.unmatchedTxnCents, 70000);
  assert.equal(r.unmatchedLegCents, 50000);
  assert.equal(r.unmatchedLegsOnTill.length, 1);
  assert.notEqual(r.unmatchedTxnCents - r.unmatchedLegCents, r.unmatchedTxnCents,
    "…and the two are reported apart, not as one number");
});

test("an unmatched leg on ANOTHER till is not this batch's business", () => {
  // Pine's own terminal takes a card sale on Pine's till. It is not on this
  // report and should not be reported as an anomaly of this batch.
  const r = matchLegs(
    [txn(1, 0, 90000)],
    [leg(2.25, 90000), leg(3, 110000, { storeId: "pine", tillId: "till-1" })],
    TERMINAL,
  );
  assert.equal(r.unmatchedLegsOnTill.length, 0, "another till's leg is not an unmatched leg here");
  assert.equal(r.unmatchedTxnCents, 0);
});

// ── THE TIME TOLERANCE, WHICH IS DELIBERATELY ASYMMETRIC ─────────────────────
test("a leg long after the transaction is not its counterpart", () => {
  const r = matchLegs([txn(1, 0, 90000)], [leg((MATCH_BEHIND_MS / 60000) + 1, 90000)], TERMINAL);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatchedTxnCents, 90000);
});

test("a leg well BEFORE the transaction is not its counterpart either", () => {
  // The lag is one-directional — a till leg cannot precede the approval it
  // records. The small backward allowance is for clock drift between two
  // devices, nothing more.
  const r = matchLegs([txn(1, 10, 90000)], [leg(10 - (MATCH_AHEAD_MS / 60000) - 1, 90000)], TERMINAL);
  assert.equal(r.matches.length, 0);
  const drift = matchLegs([txn(1, 10, 90000)], [leg(9.5, 90000)], TERMINAL);
  assert.equal(drift.matches.length, 1, "…but a little drift still matches");
});

test("the nearest leg in time wins", () => {
  const r = matchLegs([txn(1, 0, 90000)], [leg(9, 90000), leg(2.25, 90000)], TERMINAL);
  assert.equal(r.matches[0].leg.at, T0 + 2.25 * 60000);
  assert.equal(Math.round(r.matches[0].lagMs / 1000), 135);
});

test("one leg answers one transaction, never two", () => {
  const r = matchLegs([txn(1, 0, 50000), txn(2, 0, 50000)], [leg(2.25, 50000)], TERMINAL);
  assert.equal(r.matches.length, 1);
  assert.equal(r.unmatchedTxns.length, 1);
  assert.equal(r.unmatchedTxnCents, 50000);
});

test("a different amount is never a match, however close in time", () => {
  const r = matchLegs([txn(1, 0, 90000)], [leg(2.25, 90001)], TERMINAL);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatchedTxnCents, 90000);
});

test("a refund matches a refund, not a purchase of the same magnitude", () => {
  // Refund amounts are signed negative on both sides, so they cannot cross.
  const r = matchLegs(
    [{ tsn: 1, at: T0, amountCents: -4800 }],
    [leg(2.25, 4800), leg(2.3, -4800)],
    TERMINAL,
  );
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].leg.amount, -4800);
});

test("malformed rows on either side are ignored, not counted as zero", () => {
  const r = matchLegs(
    [txn(1, 0, 90000), { tsn: 2, at: T0, amountCents: null }, null],
    [leg(2.25, 90000), { ...leg(3, 0), amount: null }, null],
    TERMINAL,
  );
  assert.equal(r.matches.length, 1);
  assert.equal(r.unmatchedTxns.length, 0);
  assert.equal(r.unmatchedLegsOnTill.length, 0, "a null-amount leg is not an unmatched sale");
});

test("nothing at all is an empty result, not a crash", () => {
  const r = matchLegs([], [], TERMINAL);
  assert.equal(r.matches.length, 0);
  assert.equal(r.matchedCents, 0);
  assert.equal(r.unmatchedTxnCents, 0);
});

test("off-till is a fact about the leg, not about which pass found it", () => {
  // Every match must be labelled by WHERE the leg was rung. Deriving it from
  // the pass would make a label that goes on the record depend on control flow.
  const r = matchLegs(
    [txn(1, 0, 90000), txn(2, 5, 70000)],
    [leg(2.25, 90000), leg(7.25, 70000, TROPHY)],
    TERMINAL,
  );
  const byTsn = Object.fromEntries(r.matches.map((m) => [m.txn.tsn, m]));
  assert.equal(byTsn[1].offTill, false, "rung on its own till");
  assert.equal(byTsn[2].offTill, true, "rung at Trophy");
  for (const m of r.matches) {
    const rungOnTill = m.leg.storeId === TERMINAL.storeId && m.leg.tillId === TERMINAL.tillId;
    assert.equal(m.offTill, !rungOnTill, `TSN ${m.txn.tsn}: the label must follow the leg`);
  }
});
