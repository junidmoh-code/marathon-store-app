// ─── EFT POOL — WHAT A CASHIER MAY SEE, AND HOW A PAYMENT IS FOUND (PURE) ────
// The pool at /eft_pool is owner-only by rule, deliberately: a record carries
// the payer's name, the notification's own text and Gmail's authentication
// transcript. The cashier at the till still has to FIND a payment in it, so the
// till reaches the pool through a callable (eftPool/eftPool.js) and this module
// decides, away from firebase-admin and the clock, exactly two things:
//
//   1. WHICH FIELDS of a pool record the till is allowed to see (publicEftView)
//      — the search's answer, never the record. rawText, subject, sender,
//      auth transcript and destination account never cross this line: they are
//      other customers' payment data and the owner's forensics.
//   2. WHICH RECORDS answer a cashier's query, and in what order (search).
//
// THE SEARCH IS FORGIVING BY DESIGN. Customers say "Junid" at the counter when
// they typed "JUNID1234" in their banking app; banks truncate references; some
// customers type no reference at all. So a partial reference matches, the
// payer's name matches, and an AMOUNT matches standalone — "550" finds the
// R550.00 payment with a blank reference. Every token of the query must land
// somewhere (reference, payer, bank ref, or the amount); a record nothing in
// the query touches is not a result. Exactness only affects RANK, never
// eligibility.
//
// USED PAYMENTS STAY VISIBLE AND SEARCHABLE, shown as used with the date, the
// slip number, the customer assisted and the cashier who settled it. Hiding
// them creates arguments with customers who insist they paid; showing them
// ends the argument in five seconds. They are simply not selectable to settle
// again — that is the settle transaction's job (eft-settle.cjs), not the
// search's.
//
// The record shape is eftCore.mjs's (scripts/cardrecon), stored by the mailbox
// poller. This module redefines nothing about it and reads only what it needs.
// PURE by the house rule: no IO, no clock; tested in test/eft-pool-search.test.cjs.

"use strict";

// The fuzzed money parser, borrowed — never a second copy. It refuses mangled
// figures, which here just means a token that isn't money scores as text only.
const { parseRandsToCents } = require("./card-recon.cjs");

const EFT_POOL_PATH = "eft_pool";

// The callable reads the pool's TAIL (orderByChild("at").limitToLast(WINDOW)),
// never the whole node — the pool grows by a record per payment for ever. A
// payment older than the window is the owner's panel's business, not the
// till's: customers settle within days, not months.
const EFT_SEARCH_WINDOW = 400;
// What one search returns at most — a till screen, not a report.
const EFT_SEARCH_LIMIT = 20;

// ─── THE PUBLIC VIEW ─────────────────────────────────────────────────────────
/**
 * The fields of one pool record a cashier's search result may carry — or null
 * when the record is not a payment at all (refusals are owner material; the
 * till never sees them, not even their existence).
 *
 * `used` is summarised for the counter conversation: when, which slip, who was
 * assisted, which cashier. The settlement's uids, store/till ids and attempt
 * history stay in the pool record.
 */
function publicEftView(key, record) {
  if (!record || typeof record !== "object") return null;
  if (record.outcome !== "recorded") return null;
  const used = record.status === "used" && record.used && typeof record.used === "object"
    ? {
        at: Number.isInteger(record.used.at) ? record.used.at : null,
        cashierName: record.used.cashierName ?? null,
        customerName: record.used.customerName ?? null,
        saleId: record.used.sale?.saleId ?? null,
        receiptNumber: record.used.sale?.receiptNumber ?? null,
        // The WHOLE amount must be accounted for at the counter: how much of
        // the payment the sale took, and where the difference went — store
        // credit (whose, which credit) or held unallocated for the owner. A
        // used payment must never leave a cashier guessing about the rest.
        appliedCents: Number.isInteger(record.used.appliedCents) ? record.used.appliedCents : null,
        remainder: record.used.remainder && typeof record.used.remainder === "object"
          ? {
              cents: Number.isInteger(record.used.remainder.cents) ? record.used.remainder.cents : null,
              disposition: record.used.remainder.disposition ?? null,
              status: record.used.remainder.status ?? null,
              customerName: record.used.remainder.customerName ?? null,
              creditId: record.used.remainder.creditId ?? null,
            }
          : null,
      }
    : null;
  return {
    key,
    status: record.status ?? null,
    amountCents: Number.isInteger(record.amountCents) ? record.amountCents : null,
    reference: record.reference ?? null,
    payer: record.payer ?? null,
    bankRef: record.bankRef ?? null,
    // The bank's own timestamp when it parsed; the poller's arrival time
    // otherwise — the till shows ONE date and this picks it.
    paidAt: Number.isInteger(record.bankTs) ? record.bankTs
      : Number.isInteger(record.receivedAt) ? record.receivedAt
      : (record.at ?? null),
    at: record.at ?? null,
    reader: record.reader ?? null,
    used,
    // A payment that has been settled and REVERSED carries its history count,
    // so the till can say "used before, released by the owner" instead of
    // presenting it as if nothing ever happened.
    reversals: record.reversals && typeof record.reversals === "object"
      ? Object.keys(record.reversals).length
      : 0,
  };
}

// ─── THE QUERY ───────────────────────────────────────────────────────────────
/**
 * A cashier's query, read once: whitespace-split tokens (uppercased — matching
 * is case-blind throughout) plus, per token AND for the query as a whole, the
 * rand amount it parses to. "junid 550" is the token "JUNID" and the amount
 * R550.00; "550.00" alone is an amount-only search — amount search must work
 * standalone because some customers type no reference at all.
 */
function searchPlan(query) {
  const raw = String(query ?? "").trim();
  const tokens = raw ? raw.toUpperCase().split(/\s+/).slice(0, 8) : [];
  // The WHOLE query as one amount, besides the per-token reading: "R 550.00"
  // tokenises as ["R", "550.00"] and the bare "R" lands nowhere — but the
  // cashier typed exactly what the slip says, and that must find the payment.
  const whole = parseRandsToCents(raw);
  return {
    wholeAmountCents: Number.isInteger(whole) && whole > 0 ? whole : null,
    tokens: tokens.map((t) => {
      const cents = parseRandsToCents(t);
      return { text: t, amountCents: Number.isInteger(cents) && cents > 0 ? cents : null };
    }),
  };
}

/**
 * How well one payment answers the query — or null when it doesn't.
 *
 * EVERY token must land somewhere on the record: the reference (exact beats
 * prefix beats substring), the bank's own transaction id, the payer's name, or
 * the amount. Exactness affects rank only; eligibility is the forgiving
 * substring. A query with no tokens matches everything at score 0 — the
 * empty-search "recent payments" view.
 */
function scoreEftView(view, plan) {
  if (!plan.tokens.length) return 0;
  const ref = String(view.reference ?? "").toUpperCase();
  const payer = String(view.payer ?? "").toUpperCase();
  const bankRef = String(view.bankRef ?? "").toUpperCase();
  let total = 0;
  for (const token of plan.tokens) {
    let best = 0;
    const t = token.text;
    if (ref) {
      if (ref === t) best = 100;
      else if (ref.startsWith(t)) best = 85;
      else if (ref.includes(t)) best = 70;
    }
    if (bankRef && bankRef.includes(t)) best = Math.max(best, 55);
    if (payer && payer.includes(t)) best = Math.max(best, 50);
    if (token.amountCents !== null && view.amountCents === token.amountCents) {
      best = Math.max(best, 75);
    }
    if (best === 0) {
      // The token lands nowhere on its own — but if the query AS A WHOLE is
      // this payment's amount ("R 550.00"), the payment still answers it.
      if (plan.wholeAmountCents !== null && view.amountCents === plan.wholeAmountCents) return 75;
      return null; // touches nothing — not a result
    }
    total += best;
  }
  return total;
}

// ─── THE SEARCH ──────────────────────────────────────────────────────────────
/**
 * Rank the pool's tail against a cashier's query.
 *
 * @param {object|null} poolTail  the raw children of /eft_pool the callable
 *   read (key → record) — refusals included; they are filtered here.
 * @param {string} query
 * @returns {{results: Array, searched: number}} public views, best first —
 *   score, then still-unmatched before used (the cashier is here to settle),
 *   then newest. `searched` says how many payments the window actually held,
 *   so the till can say "nothing in the last N" honestly.
 */
function searchEftPool(poolTail, query) {
  const plan = searchPlan(query);
  const views = Object.entries(poolTail ?? {})
    .map(([key, record]) => publicEftView(key, record))
    .filter(Boolean);
  const scored = [];
  for (const view of views) {
    const score = scoreEftView(view, plan);
    if (score === null) continue;
    scored.push({ view, score });
  }
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((a.view.status === "unmatched" ? 0 : 1) - (b.view.status === "unmatched" ? 0 : 1))
    || ((b.view.at ?? 0) - (a.view.at ?? 0)));
  return {
    results: scored.slice(0, EFT_SEARCH_LIMIT).map((s) => s.view),
    searched: views.length,
  };
}

module.exports = {
  EFT_POOL_PATH,
  EFT_SEARCH_WINDOW,
  EFT_SEARCH_LIMIT,
  publicEftView,
  searchPlan,
  scoreEftView,
  searchEftPool,
};
