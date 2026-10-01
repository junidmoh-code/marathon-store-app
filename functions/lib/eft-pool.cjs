// ─── EFT POOL — WHAT A CASHIER MAY SEE, AND HOW A PAYMENT IS FOUND (PURE) ────
// The pool at /eft_pool is owner-only by rule, deliberately: a record carries
// the payer's name, the notification's own text and Gmail's authentication
// transcript. The cashier at the till still has to FIND a payment in it, so the
// till reaches the pool through a callable (eftPool/eftPool.js) and this module
// decides, away from firebase-admin and the clock, exactly two things:
//
//   1. WHICH FIELDS of a pool record the till is allowed to see (publicEftView)
//      — the search's answer, never the record.
//   2. WHICH ONE RECORD answers a cashier's query (searchEftPool).
//
// LOCKED DOWN (fix 2, EFT interrogation H). The first builds were "forgiving":
// substring, prefix and one-typo matching on the reference AND the payer's
// name, three characters minimum, ten results. In practice three characters of
// a phone prefix ("082") or a common surname listed up to ten OTHER customers'
// full names, amounts and bank ids to whoever stood at the till — and, for
// used payments, whose sale it was and which cashier rang it. So now:
//
//   · THE KEY IS THE PAYMENT'S OWN IDENTIFIER, typed in full: the REFERENCE
//     the customer typed in their banking app, or the bank's TRANSACTION ID
//     printed on their proof of payment (FNB Trace ID, Absa transaction
//     number…). Case, spaces and punctuation are ignored; nothing else is.
//   · NEAR-EXACT means ONE typo in a LONG reference (both ≥ 6 characters,
//     whole-string optimal-string-alignment distance ≤ 1) — never a
//     substring, never a prefix, never on the bank id, never on a name.
//   · THE PAYER'S NAME IS NEVER A KEY, and is returned only as initials.
//   · AT MOST ONE PAYMENT IS RETURNED. When more than one could be the answer
//     the search returns NOTHING and says `ambiguous` — the cashier asks for
//     the bank's transaction id, which is unique. Another customer's payment
//     is never on the screen to be picked by mistake.
//   · NEVER BY AMOUNT. A query is text that must BE a reference or a bank id.
//   · A USED payment answers as used, when and on which slip — never the
//     customer, the cashier, the remainder's recipient or a typed reason.
//
// The record shape is eftCore.mjs's (scripts/cardrecon), stored by the mailbox
// poller. This module redefines nothing about it and reads only what it needs.
// PURE by the house rule: no IO, no clock; tested in test/eft-pool-search*.cjs.

"use strict";

const { paymentFingerprint } = require("./eft-fingerprint.cjs");

const EFT_POOL_PATH = "eft_pool";

// The callable reads the pool's TAIL (orderByChild("at").limitToLast(WINDOW)),
// never the whole node — the pool grows by a record per payment for ever. A
// payment older than the window is the owner's panel's business, not the
// till's: customers settle within days, not months.
const EFT_SEARCH_WINDOW = 400;
// What one search returns at most: ONE payment. More than one candidate is an
// ambiguity the cashier resolves with the bank's transaction id, never a list.
const EFT_SEARCH_LIMIT = 1;
// Shorter than this (letters and digits only) is not a search.
const EFT_MIN_QUERY = 3;
// One typo is tolerated only when BOTH the query and the reference are at
// least this long — on a short reference one edit is a different reference.
const NEAR_MISS_MIN_LENGTH = 6;

// ─── THE PUBLIC VIEW ─────────────────────────────────────────────────────────
/** "MARA-THONE TRADING" → "M T T": enough for the cashier to ask "is your
 *  account in the name J M…?", never a name another customer could read. */
function payerInitials(payer) {
  const letters = String(payer ?? "").toUpperCase().split(/[^A-Z]+/).filter(Boolean).map((w) => w[0]);
  return letters.length ? letters.slice(0, 4).join(" ") : null;
}

/**
 * The fields of one pool record a cashier's search result may carry — or null
 * when the record is not a payment at all (refusals and HELD records are owner
 * material; the till never sees them, not even their existence).
 *
 * No payer name (initials only), no bank id, no customer, no cashier, no
 * remainder recipient, no typed reason: a used payment says WHEN and WHICH
 * SLIP, which is what ends "but I paid" at the counter.
 */
function publicEftView(key, record) {
  if (!record || typeof record !== "object") return null;
  if (record.outcome !== "recorded") return null;
  const used = record.status === "used" && record.used && typeof record.used === "object"
    ? {
        at: Number.isInteger(record.used.at) ? record.used.at : null,
        receiptNumber: record.used.sale?.receiptNumber ?? null,
        outsidePos: Boolean(record.used.outsidePos && typeof record.used.outsidePos === "object"),
      }
    : null;
  return {
    key,
    status: record.status ?? null,
    amountCents: Number.isInteger(record.amountCents) ? record.amountCents : null,
    reference: record.reference ?? null,
    payerInitials: payerInitials(record.payer),
    // The bank's own timestamp when it parsed; the poller's arrival time
    // otherwise — the till shows ONE date and this picks it.
    paidAt: Number.isInteger(record.bankTs) ? record.bankTs
      : Number.isInteger(record.receivedAt) ? record.receivedAt
      : (record.at ?? null),
    at: record.at ?? null,
    // No bank transaction id and never released by the owner: the settle will
    // refuse it (fix 1), so the till says so instead of offering it.
    needsOwner: !paymentFingerprint(record) && !(record.releasedFromHold && typeof record.releasedFromHold === "object"),
    used,
    // A payment that has been settled and REVERSED carries its history count,
    // so the till can say "returned to the pool by the owner".
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

/** Whole-string optimal-string-alignment distance (Levenshtein + adjacent
 *  transposition). Bounded by construction: references are clipped at 140. */
function osaDistance(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

/** The query, read once: the whole of it, letters and digits, upper-cased.
 *  No amount is read from it, and it is never split into words — a word of a
 *  reference is not the reference. */
function searchPlan(query) {
  const whole = normaliseText(query);
  return { whole, tooShort: whole.length < EFT_MIN_QUERY };
}

/** How one payment answers the query: "reference" | "bankRef" (exact),
 *  "near" (one typo in a long reference), or null. */
function matchOf(record, plan) {
  if (plan.tooShort) return null;
  const ref = normaliseText(record.reference);
  const bank = normaliseText(record.bankRef);
  if (ref && ref === plan.whole) return "reference";
  if (bank && bank === plan.whole) return "bankRef";
  if (plan.whole.length >= NEAR_MISS_MIN_LENGTH && ref.length >= NEAR_MISS_MIN_LENGTH
    && osaDistance(plan.whole, ref) <= 1) return "near";
  return null;
}

/**
 * Copies of ONE bank transaction (records written before fix 1 — a resend
 * that landed as a second live record) are one payment to the cashier, not an
 * ambiguity: a used copy stands for the group (the money is spent), otherwise
 * the OLDEST copy does — the one the settle's fingerprint claim will favour.
 * Payments with no fingerprint stay as they are.
 */
function collapseCopies(hits) {
  const byFp = new Map();
  const out = [];
  for (const h of hits) {
    const fp = paymentFingerprint(h.record);
    if (!fp) { out.push(h); continue; }
    const cur = byFp.get(fp);
    if (!cur) { byFp.set(fp, h); continue; }
    const rank = (x) => [x.record.status === "used" ? 0 : 1, Number.isInteger(x.record.at) ? x.record.at : Infinity];
    const [a, b] = [rank(h), rank(cur)];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) byFp.set(fp, h);
  }
  return [...out, ...byFp.values()];
}

// ─── THE SEARCH ──────────────────────────────────────────────────────────────
/**
 * Find THE payment a cashier's query names — or nothing.
 *
 * Exact matches (reference or bank id) are considered first; near-misses only
 * when nothing matches exactly. Among the candidates, exactly ONE unmatched
 * payment is the answer; with none unmatched, exactly one used payment is
 * (answered as used). Anything else is `ambiguous` and returns NOTHING.
 *
 * @param {object|null} poolTail  the raw children of /eft_pool the callable
 *   read (key → record) — refusals and holds included; they are filtered here.
 * @param {string} query
 * @returns {{results: Array, searched: number, needQuery?: true, ambiguous?: true}}
 */
function searchEftPool(poolTail, query) {
  const plan = searchPlan(query);
  const payments = Object.entries(poolTail ?? {})
    .filter(([, record]) => record && typeof record === "object" && record.outcome === "recorded");
  const searched = payments.length;
  if (plan.tooShort) return { results: [], searched, needQuery: true };
  const hits = payments.map(([key, record]) => ({ key, record, on: matchOf(record, plan) })).filter((h) => h.on);
  const exact = hits.filter((h) => h.on !== "near");
  const candidates = collapseCopies(exact.length ? exact : hits);
  if (!candidates.length) return { results: [], searched };
  const unmatched = candidates.filter((h) => h.record.status === "unmatched");
  const pick = unmatched.length === 1 ? unmatched[0]
    : unmatched.length === 0 && candidates.length === 1 ? candidates[0]
    : null;
  if (!pick) return { results: [], searched, ambiguous: true };
  const view = { ...publicEftView(pick.key, pick.record), matchedOn: pick.on };
  // A NEAR match never echoes the stored reference: a cashier probing with
  // typo'd guesses must not learn another customer's reference from it.
  if (pick.on === "near") view.reference = null;
  return { results: [view], searched };
}

module.exports = {
  EFT_POOL_PATH,
  EFT_SEARCH_WINDOW,
  EFT_SEARCH_LIMIT,
  EFT_MIN_QUERY,
  NEAR_MISS_MIN_LENGTH,
  publicEftView,
  payerInitials,
  normaliseText,
  osaDistance,
  searchPlan,
  matchOf,
  searchEftPool,
};
