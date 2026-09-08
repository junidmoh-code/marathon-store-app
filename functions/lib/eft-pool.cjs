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
// THE SEARCH IS BY REFERENCE AND PAYER NAME ONLY. Amount was a search key in
// the first build and that was a design error: in a shop, "550" finds ANY
// R550 payment, so a cashier can settle one customer's sale against another
// customer's money and neither of them can tell. The amount is now shown on
// every row as CONFIRMATION — the cashier reads it against what the customer
// says — and is never a query. No token of the query is ever compared with
// amountCents, and a query that looks like money is just text that has to
// appear in a reference or a name.
//
// FORGIVING, WITHIN THAT. Customers say "Junid" at the counter when they typed
// "JUNID1234" in their banking app; banks truncate references; people mistype.
// So matching is case-blind, ignores spaces and punctuation, finds a substring
// anywhere in the field, and tolerates ONE near-miss (a typo, a transposition,
// a dropped or extra character — optimal-string-alignment distance ≤ 1) on
// tokens of five or more characters. "JUNID1234" is found by "junid",
// "junid123" and "juind1234". Exactness affects RANK, never eligibility.
//
// NOTHING IS BROWSABLE. An empty or short query (under three characters after
// normalisation) returns nothing — no recent list, no suggestions, no default
// result set: the pool is other customers' payment data. Ten results at most,
// best match first, then newest.
//
// USED PAYMENTS STAY VISIBLE AND SEARCHABLE, shown as used with the date, the
// slip number, the customer assisted and the cashier who settled it — or, for
// a payment the owner marked as settled outside the POS, the reason, who and
// when. Hiding them creates arguments with customers who insist they paid;
// showing them ends the argument in five seconds. They are simply not
// selectable to settle again — that is the settle transaction's job
// (eft-settle.cjs), not the search's.
//
// The record shape is eftCore.mjs's (scripts/cardrecon), stored by the mailbox
// poller. This module redefines nothing about it and reads only what it needs.
// PURE by the house rule: no IO, no clock; tested in test/eft-pool-search.test.cjs.

"use strict";

const EFT_POOL_PATH = "eft_pool";

// The callable reads the pool's TAIL (orderByChild("at").limitToLast(WINDOW)),
// never the whole node — the pool grows by a record per payment for ever. A
// payment older than the window is the owner's panel's business, not the
// till's: customers settle within days, not months.
const EFT_SEARCH_WINDOW = 400;
// What one search returns at most — a till screen, not a report.
const EFT_SEARCH_LIMIT = 10;
// Shorter than this (letters and digits only) is not a search — it is a
// browse, and the pool is not browsable.
const EFT_MIN_QUERY = 3;
// Near-miss tolerance applies from this token length: one edit on a
// four-character token is a different word, not a typo.
const NEAR_MISS_MIN_LENGTH = 5;

// ─── THE PUBLIC VIEW ─────────────────────────────────────────────────────────
/**
 * The fields of one pool record a cashier's search result may carry — or null
 * when the record is not a payment at all (refusals are owner material; the
 * till never sees them, not even their existence).
 *
 * `used` is summarised for the counter conversation: when, which slip, who was
 * assisted, which cashier — or, for a manual settlement, that it was settled
 * OUTSIDE the POS, by whom, when and why. The settlement's uids, store/till
 * ids and attempt history stay in the pool record.
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
        // SETTLED OUTSIDE THE POS — the owner marked it used with no sale
        // attached (paid before the pool existed, settled by hand, a refund
        // given in cash). The till shows the reason, who and when, so "it says
        // used but there is no slip" has an answer at the counter. The actor's
        // uid stays in the pool record.
        outsidePos: record.used.outsidePos && typeof record.used.outsidePos === "object"
          ? {
              reason: record.used.outsidePos.reason ?? null,
              actorName: record.used.outsidePos.actorName ?? null,
              at: Number.isInteger(record.used.outsidePos.at) ? record.used.outsidePos.at : null,
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

// ─── NORMALISATION AND NEAR-MISS ─────────────────────────────────────────────
/** Letters and digits only, upper-cased: "Junid-1234 " and "JUNID 1234" are
 *  the same text. Everything the search compares goes through here. */
function normaliseText(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The smallest optimal-string-alignment distance between `needle` and ANY
 * substring of `hay` — Sellers' algorithm with adjacent transposition. The
 * first row is all zeros so a match may start anywhere; the minimum of the
 * last row lets it end anywhere. Distance 0 is a plain substring; distance 1
 * is one typo, one transposition, one dropped or one extra character
 * somewhere in the needle. Bounded by construction: tokens are short and
 * fields are clipped by the reader (reference ≤ 140, payer ≤ 120).
 */
function nearestSubstringDistance(needle, hay) {
  const n = needle.length;
  const m = hay.length;
  if (n === 0) return 0;
  if (m === 0) return n;
  let prev2 = null;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = needle[i - 1] === hay[j - 1] ? 0 : 1;
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && needle[i - 1] === hay[j - 2] && needle[i - 2] === hay[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      cur[j] = best;
    }
    prev2 = prev;
    prev = cur;
  }
  let min = Infinity;
  for (let j = 0; j <= m; j++) if (prev[j] < min) min = prev[j];
  return min;
}

// ─── THE QUERY ───────────────────────────────────────────────────────────────
/**
 * A cashier's query, read once: whitespace-split tokens, each normalised to
 * letters and digits, plus the query AS A WHOLE normalised the same way (so
 * "junid 1234" still finds "JUNID1234", and "ousmane thiam" finds the payer
 * "OUSMANE THIAM"). No amount is read from it, by design — see the header.
 * `tooShort` is the refusal the callable turns into "type more": under three
 * characters of letters and digits, nothing is searched.
 */
function searchPlan(query) {
  const raw = String(query ?? "").trim();
  const whole = normaliseText(raw);
  const tokens = raw
    ? raw.split(/\s+/).map(normaliseText).filter(Boolean).slice(0, 8)
    : [];
  return { whole, tokens, tooShort: whole.length < EFT_MIN_QUERY };
}

/** How well one token lands on one normalised field: exact beats prefix beats
 *  substring beats near-miss; 0 when it does not land at all. `scale` is the
 *  field's weight (a reference hit outranks a payer hit). */
function fieldScore(token, field, scale) {
  if (!field || !token) return 0;
  if (field === token) return 100 * scale;
  if (field.startsWith(token)) return 85 * scale;
  if (field.includes(token)) return 70 * scale;
  if (token.length >= NEAR_MISS_MIN_LENGTH && nearestSubstringDistance(token, field) <= 1) return 55 * scale;
  return 0;
}

/**
 * How well one payment answers the query — or null when it doesn't.
 *
 * EVERY token must land on the reference or the payer's name (exact beats
 * prefix beats substring beats near-miss; reference beats payer). A query
 * whose tokens do not each land on their own still answers when the query AS
 * A WHOLE lands ("junid 1234" against "JUNID1234"). A query with no tokens
 * answers nothing — there is no empty-search view of the pool.
 */
function scoreEftView(view, plan) {
  if (!plan.tokens.length || plan.tooShort) return null;
  const ref = normaliseText(view.reference);
  const payer = normaliseText(view.payer);
  const best = (token) => Math.max(fieldScore(token, ref, 1), fieldScore(token, payer, 0.65));
  let total = 0;
  let allLand = true;
  for (const token of plan.tokens) {
    const s = best(token);
    if (s === 0) { allLand = false; break; }
    total += s;
  }
  if (allLand) return total;
  // Not every token on its own — but the whole query, spaces and punctuation
  // gone, might be one reference or one name.
  const whole = best(plan.whole);
  return whole > 0 ? whole : null;
}

// ─── THE SEARCH ──────────────────────────────────────────────────────────────
/**
 * Rank the pool's tail against a cashier's query.
 *
 * @param {object|null} poolTail  the raw children of /eft_pool the callable
 *   read (key → record) — refusals included; they are filtered here.
 * @param {string} query
 * @returns {{results: Array, searched: number, needQuery?: true}} public
 *   views, best match first, then newest (by the bank's own timestamp).
 *   `searched` says how many payments the window actually held, so the till
 *   can say "nothing in the last N" honestly; `needQuery` says the query was
 *   too short to search at all.
 */
function searchEftPool(poolTail, query) {
  const plan = searchPlan(query);
  const views = Object.entries(poolTail ?? {})
    .map(([key, record]) => publicEftView(key, record))
    .filter(Boolean);
  if (plan.tooShort) return { results: [], searched: views.length, needQuery: true };
  const scored = [];
  for (const view of views) {
    const score = scoreEftView(view, plan);
    if (score === null) continue;
    scored.push({ view, score });
  }
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((b.view.paidAt ?? b.view.at ?? 0) - (a.view.paidAt ?? a.view.at ?? 0)));
  return {
    results: scored.slice(0, EFT_SEARCH_LIMIT).map((s) => s.view),
    searched: views.length,
  };
}

module.exports = {
  EFT_POOL_PATH,
  EFT_SEARCH_WINDOW,
  EFT_SEARCH_LIMIT,
  EFT_MIN_QUERY,
  publicEftView,
  normaliseText,
  nearestSubstringDistance,
  searchPlan,
  scoreEftView,
  searchEftPool,
};
