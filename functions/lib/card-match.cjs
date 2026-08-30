// ─── MATCHING A BATCH'S TRANSACTIONS TO THE TILL'S CARD LEGS ─────────────────
// The reconciliation used to be a subtraction: the report's total, minus every
// card leg on the till the terminal is mapped to. That is wrong the moment the
// MACHINE MOVES, and the machines do move — a speedpoint spent a morning at
// Trophy while its terminal ID is mapped to PE Till 2, so four of that day's
// sales were rung on Trophy's till. They were not missing money.
//
// ── THE MONEY DECIDES. THE CLOCK ONLY SUGGESTS. ──────────────────────────────
// This is the rule the whole file now turns on, and it was learned the hard
// way: an earlier version used time as an ELIGIBILITY gate — a leg outside a
// fifteen-minute tolerance simply could not answer a transaction — and it
// accused a cashier of taking R351 that was sitting in the ledger the whole
// time, because the terminal had stamped it late.
//
// A speedpoint's report is not a reliable clock. It delays timestamps, and it
// prints transactions out of order. So:
//
//     IF THE TERMINAL SAYS R351.00 AND THE TILL SAYS R351.00, THERE IS NO
//     ISSUE — whatever the two clocks say about when.
//
// Amount equality is therefore the only thing that makes a leg eligible to
// answer a transaction. Time is used solely to choose BETWEEN legs of the same
// amount, so the pairing shown to a person is the sensible one; it can never
// turn a leg into a non-candidate and so can never manufacture a discrepancy.
//
// That also makes the assignment trivially optimal: within one amount, every
// unclaimed leg is as eligible as any other, so a greedy pass matches
// min(transactions, legs) of them — the most there can be.
//
// ── WHAT THERE IS TO MATCH ON ────────────────────────────────────────────────
// Not much, and it is worth being blunt about it. The terminal knows an auth
// code, an RRN, a UTI and a masked card number. The till's payment ledger
// records NONE of them — a card leg carries only amount, time, till, cashier,
// receipt and sale id. So the only hard signal is THE AMOUNT, and a pairing is
// a proposal, never a proof. It is reported as such.
//
// ── WHAT THE CLOCK IS STILL GOOD FOR ─────────────────────────────────────────
// Choosing among equals. The lag is one-directional — the terminal stamps when
// the card is approved, the till writes its leg when the cashier finishes, so
// the leg can only be later. Measured across all forty transactions of a real
// report against the live ledger: minimum 118 seconds, median 135, maximum 249.
// Given several legs of the same amount, the nearest in time is the sensible
// one to show. Nothing more rests on it.
"use strict";

// How far either side of the batch window to FETCH legs. Not an eligibility
// test — see above — but the pool has to be bounded by something, and the
// window is derived from timestamps the terminal may have got wrong. An hour
// covers a badly drifting terminal clock and a slow till write; beyond that the
// risk of reaching a neighbouring batch outweighs the reach.
const MATCH_WINDOW_MARGIN_MS = 60 * 60 * 1000;

/**
 * Pair each transaction with at most one card leg, and each leg with at most
 * one transaction.
 *
 * TWO PASSES, AND THE ORDER MATTERS. The first pass considers only legs on the
 * till the terminal is mapped to, so a leg rung where it should have been is
 * never stolen by a cross-till candidate of the same amount. Only the
 * transactions still unmatched go looking further afield.
 *
 * Within a pass the nearest leg in time wins, which for a one-directional lag
 * means the earliest leg at or after the transaction.
 *
 * @param {object[]} txns   the report's transactions ({tsn, at, amountCents})
 * @param {object[]} legs   card legs in the window ({at, amount, storeId, tillId, …})
 * @param {{storeId:string, tillId:string}} terminal  where the terminal is mapped
 * @returns {{matches, unmatchedTxns, unmatchedLegsOnTill, matchedCents,
 *            onTillCents, offTillCents, unmatchedTxnCents, unmatchedLegCents,
 *            offTill}}
 */
function matchLegs(txns, legs, terminal) {
  // Both sides in time order — the assignment below depends on it.
  const transactions = (txns || [])
    .filter((t) => t && Number.isInteger(t.amountCents) && Number.isFinite(t.at))
    .sort((a, b) => a.at - b.at);
  // CARD LEGS ONLY, checked here as well as by the caller. A sale paid part
  // cash and part card writes one row per tender, and the cash row must never
  // be read as "a card sale the machine has no record of" — it is not a card
  // sale at all. The caller does filter, but a function that reports a
  // discrepancy should not depend on its caller to avoid inventing one.
  const candidates = (legs || [])
    .filter((l) => l && l.method === "card" && Number.isInteger(l.amount) && Number.isFinite(l.at))
    .sort((a, b) => a.at - b.at);
  const taken = new Set();
  const matches = [];

  const onMappedTill = (l) => l.storeId === terminal.storeId && l.tillId === terminal.tillId;

  // AMOUNT DECIDES ELIGIBILITY; TIME ONLY BREAKS THE TIE. A leg of the right
  // amount is always a candidate, however far off the two clocks are — that is
  // what stops a delayed or out-of-order terminal stamp inventing a shortfall.
  // Among several of the same amount the nearest in time is chosen, purely so
  // the pairing a person is shown is the sensible one.
  const findFor = (txn, pool) => {
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      if (taken.has(i)) continue;
      const leg = candidates[i];
      if (!pool(leg)) continue;
      if (leg.amount !== txn.amountCents) continue;
      const lag = leg.at - txn.at;
      if (best === null || Math.abs(lag) < Math.abs(best.lag)) best = { i, lag, leg };
    }
    return best;
  };

  // `offTill` is a fact about the LEG, not about which pass found it. Deriving
  // it from the pass would make the label depend on control flow — correct only
  // as long as an argument about pass one holds — and this label goes on the
  // record for someone to read months later.
  const take = (txn, hit) => {
    taken.add(hit.i);
    matches.push({ txn, leg: hit.leg, lagMs: hit.lag, offTill: !onMappedTill(hit.leg) });
  };

  const unmatchedTxns = [];
  const pending = [];
  // PASS ONE — the till the terminal is mapped to, so a leg rung where it
  // should have been is never taken by a cross-till candidate of equal amount.
  for (const txn of transactions) {
    const hit = findFor(txn, onMappedTill);
    if (hit) take(txn, hit);
    else pending.push(txn);
  }
  // PASS TWO — everything else. This is where a machine that moved shows up.
  for (const txn of pending) {
    const hit = findFor(txn, (l) => !onMappedTill(l));
    if (hit) take(txn, hit);
    else unmatchedTxns.push(txn);
  }

  // Legs on the mapped till that no transaction claimed: the till recorded a
  // card sale the terminal has no record of. A different error entirely from an
  // unmatched transaction, and it must NOT be netted off against one.
  const unmatchedLegsOnTill = candidates.filter((l, i) => !taken.has(i) && onMappedTill(l));

  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const offTillMatches = matches.filter((m) => m.offTill);
  // Where the machine's work was actually rung up, when it was not on its own
  // till — so "the speedpoint was at Trophy that morning" reads off the record.
  //
  // A LIST, NOT A MAP KEYED BY THE TILL. It was `offTill["trophy/till-1"]`, and
  // an RTDB key may not contain "/" — so the submit transaction threw
  // `Data returned contains an invalid key (trophy/till-1)` and the whole
  // capture failed with INTERNAL. Not on the email path: on EVERY path, for any
  // batch whose transactions were rung up on another till, which is precisely
  // the case this field exists to record. It was found by the mailbox poller
  // because that was the first capture to meet a moved machine (PE Till 2,
  // batch 60, 2026-08-30) — a manager's phone would have crashed identically.
  //
  // The repo has been here before: never build an RTDB key out of data
  // (project_engine_retryhistory_crash). Nothing indexed this by key — its one
  // consumer builds a sentence — so the shape carries storeId and tillId as
  // FIELDS and cannot be made illegal by a value.
  const offTillBy = new Map();
  for (const m of offTillMatches) {
    const where = `${m.leg.storeId}\u0000${m.leg.tillId}`;   // in-memory only
    const b = offTillBy.get(where) || { storeId: m.leg.storeId, tillId: m.leg.tillId, legs: 0, cents: 0 };
    b.legs += 1; b.cents += m.leg.amount;
    offTillBy.set(where, b);
  }
  const offTill = [...offTillBy.values()];

  const txnTotal = sum(transactions, (t) => t.amountCents);
  const onTillLegTotal = sum(candidates.filter(onMappedTill), (l) => l.amount);

  return {
    // THE PLAIN-MONEY VERDICT, first, because it is the one that settles it.
    // Everything below is attribution; this is whether anything is wrong.
    // Nothing unaccounted for on EITHER side. A surplus card leg on the mapped
    // till — a sale the machine has no record of — is a discrepancy too, and a
    // batch carrying one is not reconciled however well its transactions
    // matched. (CodeRabbit, PR #518.)
    reconciled: unmatchedTxns.length === 0 && unmatchedLegsOnTill.length === 0,
    txnTotal,
    onTillLegTotal,
    matches: matches.sort((a, b) => a.txn.tsn - b.txn.tsn),
    unmatchedTxns,
    unmatchedLegsOnTill,
    matchedCents: sum(matches, (m) => m.leg.amount),
    onTillCents: sum(matches.filter((m) => !m.offTill), (m) => m.leg.amount),
    offTillCents: sum(offTillMatches, (m) => m.leg.amount),
    unmatchedTxnCents: sum(unmatchedTxns, (t) => t.amountCents),
    unmatchedLegCents: sum(unmatchedLegsOnTill, (l) => l.amount),
    offTill,
  };
}

module.exports = { matchLegs, MATCH_WINDOW_MARGIN_MS };
