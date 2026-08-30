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
const { matchLegs } = require("../lib/card-match.cjs");

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
  assert.deepEqual(r.offTill, [], "nothing was rung elsewhere");
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
  assert.deepEqual(r.offTill, [{ storeId: "trophy", tillId: "till-1", legs: 4, cents: 350000 }],
    "…and the record says where, so a moved machine reads as information");
  // A LIST, never a map keyed by "store/till": RTDB refuses "/" in a key and
  // the batch would fail to save after a clean review. (Found in production.)
  assert.ok(Array.isArray(r.offTill));
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
// ═══ THE MONEY DECIDES; THE CLOCK ONLY SUGGESTS ══════════════════════════════
// A speedpoint's report is not a reliable clock: it delays timestamps and
// prints transactions out of order. An earlier version used time as an
// ELIGIBILITY gate — a leg outside a fifteen-minute tolerance could not answer
// a transaction — and it accused a cashier of taking R351 that was sitting in
// the ledger the whole time.
//
// If the terminal says R351.00 and the till says R351.00, there is no issue,
// whatever the two clocks say about when.

test("a leg far LATER in time still answers its transaction", () => {
  const r = matchLegs([txn(1, 0, 35100)], [leg(40, 35100)], TERMINAL);
  assert.equal(r.reconciled, true, "the money agrees, so nothing is missing");
  assert.equal(r.unmatchedTxnCents, 0);
});

test("a leg far EARLIER in time still answers its transaction", () => {
  // A terminal running fast puts its stamp after the till's write.
  const r = matchLegs([txn(1, 40, 35100)], [leg(0, 35100)], TERMINAL);
  assert.equal(r.reconciled, true);
  assert.equal(r.unmatchedTxnCents, 0);
});

test("a report listed out of order reconciles", () => {
  const r = matchLegs(
    [txn(1, 30, 20000), txn(2, 0, 15100)],
    [leg(2, 20000), leg(32, 15100)],
    TERMINAL,
  );
  assert.equal(r.reconciled, true);
  assert.equal(r.matches.length, 2);
});

test("hours between the report and the till changes nothing", () => {
  const r = matchLegs([txn(1, 0, 35100)], [leg(180, 35100)], TERMINAL);
  assert.equal(r.reconciled, true);
  assert.equal(r.unmatchedTxnCents, 0);
});

test("the totals are reported so the plain-money check is readable", () => {
  const r = matchLegs(
    [txn(1, 0, 20000), txn(2, 5, 15100)],
    [leg(2, 20000), leg(7, 15100)],
    TERMINAL,
  );
  assert.equal(r.txnTotal, 35100, "what the terminal says");
  assert.equal(r.onTillLegTotal, 35100, "what the till says");
  assert.equal(r.reconciled, true);
});

test("…and a genuine shortfall is STILL found", () => {
  // Loosening time must not loosen the finding. There is no R700 leg anywhere.
  const r = matchLegs(
    [txn(1, 0, 35100), txn(2, 5, 70000)],
    [leg(2, 35100)],
    TERMINAL,
  );
  assert.equal(r.reconciled, false);
  assert.equal(r.unmatchedTxnCents, 70000);
  assert.equal(r.unmatchedTxns[0].tsn, 2);
});

test("an amount is never matched to a different amount, however close in time", () => {
  const r = matchLegs([txn(1, 0, 35100)], [leg(0, 35000)], TERMINAL);
  assert.equal(r.reconciled, false);
  assert.equal(r.unmatchedTxnCents, 35100);
  assert.equal(r.unmatchedLegCents, 35000, "…and the stray leg is its own finding");
});

test("among legs of the SAME amount, the nearest in time is shown", () => {
  // Time cannot make a leg ineligible; it only picks which of several equal
  // candidates is presented as the pairing, so the one a person reads is the
  // sensible one. Nothing about whether the batch reconciles rests on it.
  const r = matchLegs([txn(1, 0, 90000)], [leg(9, 90000), leg(2.25, 90000)], TERMINAL);
  assert.equal(r.matches[0].leg.at, T0 + 2.25 * 60000);
  assert.equal(Math.round(r.matches[0].lagMs / 1000), 135);
  // …and the far leg is still a leg: with two transactions, both pair.
  const both = matchLegs([txn(1, 0, 90000), txn(2, 1, 90000)], [leg(9, 90000), leg(2.25, 90000)], TERMINAL);
  assert.equal(both.matches.length, 2);
  assert.equal(both.reconciled, true);
});

test("no transaction is stranded that a leg could have answered", () => {
  // The old interval gate could strand a pairing: two same-amount sales at 0
  // and +3 minutes with legs at −1.5 and +1 left one unmatched. With amount as
  // the only eligibility test there is nothing left to strand — within one
  // amount every unclaimed leg answers every transaction, so a greedy pass
  // matches min(transactions, legs), which is the most there can be.
  const r = matchLegs(
    [txn(1, 0, 50000), txn(2, 3, 50000)],
    [leg(-1.5, 50000), leg(1, 50000)],
    TERMINAL,
  );
  assert.equal(r.matches.length, 2);
  assert.equal(r.reconciled, true);
});

test("the input order does not change the outcome", () => {
  const inOrder = matchLegs(
    [txn(1, 0, 50000), txn(2, 1, 50000)],
    [leg(0.5, 50000), leg(16, 50000)], TERMINAL,
  );
  const reversed = matchLegs(
    [txn(2, 1, 50000), txn(1, 0, 50000)],
    [leg(16, 50000), leg(0.5, 50000)], TERMINAL,
  );
  assert.equal(inOrder.matches.length, 2);
  assert.equal(reversed.matches.length, 2);
  assert.equal(inOrder.unmatchedTxnCents, reversed.unmatchedTxnCents);
});

test("a longer chain of same-amount sales pairs completely", () => {
  const txns = [txn(1, 0, 20000), txn(2, 2, 20000), txn(3, 4, 20000), txn(4, 6, 20000)];
  const legs = [leg(2.2, 20000), leg(4.2, 20000), leg(6.2, 20000), leg(8.2, 20000)];
  const r = matchLegs(txns, legs, TERMINAL);
  assert.equal(r.matches.length, 4, "every one of them");
  assert.equal(r.unmatchedTxnCents, 0);
  assert.equal(r.unmatchedLegCents, 0);
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

// ─── SPLIT PAYMENTS ──────────────────────────────────────────────────────────
// A sale paid part cash, part card. The till writes ONE ROW PER TENDER LEG, so
// the card row carries only the card portion — and that is precisely what the
// terminal charged. Verified against the live ledger: receipt S-11481 on PE
// Till 2 is a R350 sale, R150 cash + R200 card, and the report's TSN 11 at
// 10:28:05 is R200.00. The R350 never appears on the terminal at all.
//
// This works by construction rather than by special handling, which is exactly
// why it needs a test: matching on a SALE TOTAL instead of a tender leg would
// break every split payment in the shop and look fine on a day without one.
test("a split payment matches on the CARD portion, not the sale total", () => {
  const cardPortion = 20000;
  const r = matchLegs(
    [txn(11, 0, cardPortion)],
    [
      leg(2.2, cardPortion),                                  // the card leg
      { at: T0 + 2.2 * 60000, amount: 15000, method: "cash",  // …and the cash half
        storeId: "pe", tillId: "till-2" },
    ],
    TERMINAL,
  );
  assert.equal(r.reconciled, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].leg.amount, cardPortion, "the card leg, not the R350 sale");
  assert.equal(r.unmatchedTxnCents, 0);
});

test("the cash half of a split is never an unmatched card sale", () => {
  // The caller hands the matcher card legs only, but if a cash leg ever reached
  // it, it must not be reported as a card sale the machine has no record of.
  const r = matchLegs(
    [txn(11, 0, 20000)],
    [
      leg(2.2, 20000),
      { at: T0 + 2.2 * 60000, amount: 15000, method: "cash", storeId: "pe", tillId: "till-2" },
    ],
    TERMINAL,
  );
  assert.equal(r.unmatchedLegsOnTill.filter((l) => l.method === "cash").length, 0,
    "a cash tender is not a card discrepancy");
});

test("a surplus card leg on the mapped till means NOT reconciled", () => {
  // Every transaction matched, but the till also recorded a card sale the
  // machine has no record of. That is a discrepancy, and a batch carrying one
  // is not reconciled however well its transactions paired. (CodeRabbit, #518.)
  const r = matchLegs(
    [txn(1, 0, 90000)],
    [leg(2.2, 90000), leg(20, 50000)],
    TERMINAL,
  );
  assert.equal(r.unmatchedTxns.length, 0, "every transaction is accounted for");
  assert.equal(r.unmatchedLegsOnTill.length, 1, "…but a sale is not");
  assert.equal(r.reconciled, false, "so the batch is not reconciled");
  assert.equal(r.unmatchedLegCents, 50000);
});
