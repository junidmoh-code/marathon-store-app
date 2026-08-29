// ─── MATCHING A BATCH'S TRANSACTIONS TO THE TILL'S CARD LEGS ─────────────────
// The reconciliation used to be a subtraction: the report's total, minus every
// card leg on the till the terminal is mapped to. That is wrong the moment the
// MACHINE MOVES, and the machines do move — a speedpoint spent a morning at
// Trophy while its terminal ID is mapped to PE Till 2, so three of that day's
// sales were rung on Trophy's till. They were not missing money. The
// subtraction called them missing anyway, R2,800 of it, and buried the one
// sale that really was unaccounted for.
//
// So the legs are matched to the transactions instead, and what is left over is
// the finding. A machine that moved shows up as "matched on another till",
// which is information, not an error.
//
// ── WHAT THERE IS TO MATCH ON ────────────────────────────────────────────────
// Not much, and it is worth being blunt about it. The terminal knows an auth
// code, an RRN, a UTI and a masked card number. The till's payment ledger
// records NONE of them — a card leg carries only amount, time, till, cashier,
// receipt and sale id. So the only signals are THE AMOUNT and THE TIME, and a
// pairing here is a proposal, never a proof. It is reported as such.
//
// ── WHAT THE TIME SIGNAL IS WORTH ────────────────────────────────────────────
// A great deal, because the lag is one-directional. The terminal stamps when
// the card is approved; the till writes its leg when the cashier finishes the
// sale, which can only be later. Measured across all forty transactions of a
// real report against the live ledger: minimum 118 seconds, median 134, ninetieth
// percentile 539, and not one leg ahead of its terminal stamp.
//
// Hence the asymmetric tolerance below: generous forwards, barely anything
// backwards. The small backward allowance exists only for clock drift between
// two devices, not because a leg is ever expected first.
"use strict";

const MATCH_AHEAD_MS = 2 * 60 * 1000;        // a leg fractionally BEFORE: clock drift only
const MATCH_BEHIND_MS = 15 * 60 * 1000;      // …and comfortably past the ninetieth percentile

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
  const candidates = (legs || [])
    .filter((l) => l && Number.isInteger(l.amount) && Number.isFinite(l.at))
    .sort((a, b) => a.at - b.at);
  const taken = new Set();
  const matches = [];

  const onMappedTill = (l) => l.storeId === terminal.storeId && l.tillId === terminal.tillId;

  // ── EARLIEST ELIGIBLE, NOT NEAREST ────────────────────────────────────────
  // "Nearest in time" looks obviously right and quietly strands transactions.
  // Two sales of the same amount at 0 and +3 minutes, with legs at −1.5 and +1:
  // the first transaction takes the +1 leg because it is nearer, the second
  // then finds nothing in tolerance, and R500 is reported as missing money
  // although both could have been paired. (CodeRabbit, PR #516.)
  //
  // Taking the EARLIEST eligible leg instead, with the transactions walked in
  // time order, is not a heuristic improvement — it is optimal. Amounts must be
  // equal, so the problem decomposes into one group per amount; within a group
  // both sides are sorted and eligibility is an interval, which makes the graph
  // convex, and for convex bipartite graphs this greedy is known to produce a
  // MAXIMUM matching. No transaction is left unpaired that could have been.
  const findFor = (txn, pool) => {
    for (let i = 0; i < candidates.length; i++) {     // candidates are time-sorted
      if (taken.has(i)) continue;
      const leg = candidates[i];
      if (!pool(leg)) continue;
      if (leg.amount !== txn.amountCents) continue;
      const lag = leg.at - txn.at;
      if (lag < -MATCH_AHEAD_MS || lag > MATCH_BEHIND_MS) continue;
      return { i, lag, leg };
    }
    return null;
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
  const offTill = {};
  for (const m of offTillMatches) {
    const where = `${m.leg.storeId}/${m.leg.tillId}`;
    const b = offTill[where] || (offTill[where] = { legs: 0, cents: 0 });
    b.legs += 1; b.cents += m.leg.amount;
  }

  return {
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

module.exports = { matchLegs, MATCH_AHEAD_MS, MATCH_BEHIND_MS };
