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
// FORGIVING ON SPELLING, NEVER ON WHICH PAYMENT (Junid, 19 Oct 2026). The
// "whole reference or nothing" rule above made the cashier type every
// character before anything appeared, and a one-letter slip on a short
// reference ("HAFF" for "HAFG") found nothing. So the reference is now matched
// AS IT IS TYPED — what the cashier has so far as the START of a reference,
// and with a typo tolerated once the typed text is long enough that one edit
// is not simply a different reference — while everything that protects the
// pool stays exactly as it was:
//
//   · still AT MOST ONE payment, and still NOTHING when two could be the
//     answer. Forgiveness widens what a payment may be matched BY; it never
//     decides BETWEEN payments. Two references that both start with what was
//     typed, or are both one edit from it, surface nothing and the till says
//     "keep typing". An exact match outranks a prefix, which outranks a typo:
//     the cashier who has typed the whole reference gets that payment, never a
//     longer one it happens to begin.
//   · still never by name, never by amount, still initials only, still the
//     used-payment projection. The bank's transaction id is matched whole or
//     by a six-character-plus prefix — never with a typo (it is the unique
//     key the cashier falls back to).
//   · the reference IS shown on a near match now (it was blanked): the cashier
//     confirms "HAFG" against the proof of payment, which is the point.
//
// SAME REFERENCE, SEPARATE PAYMENTS (Junid, 29 Oct 2026). A customer who pays
// one sale with two EFTs often types the SAME reference on both (two R300
// payments, "SIPHO"), and the rule above answered NOTHING for that reference —
// the second payment could never be found by it. Payments are told apart by
// their OWN identity (the pool key, which the bank's transaction id — or
// Absa's synthetic fingerprint — fixes; copies of one transaction still fold
// into one, collapseCopies), never by the reference string. So when every
// candidate carries the SAME reference, each one is returned as its own row
// (oldest first, at most EFT_SEARCH_LIMIT) and the cashier picks against the
// proof — amount and time are on every row. Only on the reference typed IN
// FULL (exact rank): the start of a common reference ("REN" for RENT) still
// lists nobody — "keep typing" (architect review, 29 Oct 2026). Candidates
// with DIFFERENT references (a prefix or a typo away from two payments) are still nothing:
// "keep typing".
//
// The record shape is eftCore.mjs's (scripts/cardrecon), stored by the mailbox
// poller. This module redefines nothing about it and reads only what it needs.
// PURE by the house rule: no IO, no clock; tested in test/eft-pool-search*.cjs.

"use strict";

const { paymentFingerprint } = require("./eft-fingerprint.cjs");
const { isManualEntry, isPaymentTwin } = require("./eft-manual.cjs");

const EFT_POOL_PATH = "eft_pool";

// The callable reads the pool's TAIL (orderByChild("at").limitToLast(WINDOW)),
// never the whole node — the pool grows by a record per payment for ever. A
// payment older than the window is the owner's panel's business, not the
// till's: customers settle within days, not months.
const EFT_SEARCH_WINDOW = 400;
// What one search returns at most. Several rows only ever share ONE reference
// (separate payments made with the same reference, 29 Oct 2026); candidates
// with different references are an ambiguity, never a list.
const EFT_SEARCH_LIMIT = 6;
// Shorter than this (letters and digits only) is not a search.
const EFT_MIN_QUERY = 3;
// FORGIVING MATCHING, by the length of what the cashier has TYPED:
//   ≥ 3  the typed text as the start of a reference ("HAF" → HAFG…)
//   ≥ 4  one edit — typo, dropped, extra or swapped character ("HAFF" → HAFG)
//   ≥ 10 two edits on a long reference
//   ≥ 6  the typed text as the start of the bank's transaction id (never a typo)
const PREFIX_MIN_LENGTH = EFT_MIN_QUERY;
// An ALL-DIGIT query (a phone number used as the reference — the PII case) is
// matched forgivingly only from five digits: "0821" would otherwise hand back
// the one 0821… number in the window. Exact and bank-id matching unchanged.
// (Spec review, 19 Oct 2026.)
const DIGITS_FORGIVING_MIN_LENGTH = 5;
const NEAR_MISS_MIN_LENGTH = 4;
const NEAR_MISS_TWO_EDITS_LENGTH = 10;
const BANK_PREFIX_MIN_LENGTH = 6;
// How a match ranks: an exact match beats a prefix beats a typo. Only the best
// rank present is considered, so a fully typed reference is never ambiguous
// with a longer one it begins.
const MATCH_RANK = { reference: 0, bankRef: 0, prefix: 1, bankPrefix: 1, near: 2 };

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
    // NOTHING about a manual entry (lib/eft-manual.cjs) reaches the till:
    // a payment Junid typed in is consumed exactly like a bank-confirmed one,
    // same card, same wording (Junid, 20 Oct 2026). Its provenance lives on
    // the pool record, in /eft_manual_entries and in Junid's own review.
  };
}

/**
 * The answer's TWIN, already SPENT — a bank-confirmed payment whose manual
 * entry was used, or a manual entry whose bank notification was used
 * (isPaymentTwin, either direction). The settle refuses this record outright
 * (manualTwinSettleCheck) — one sum is never paid twice — and the till warns
 * first. The till's view says only THAT the same payment was used, where and
 * when: never which side was typed by hand (Junid, 20 Oct 2026). A twin that
 * is still waiting is not the cashier's concern: the search already answers
 * with the bank's record when both wait, and either one spends the money.
 * @returns {{at:number|null, receiptNumber:string|null}|null}
 */
function manualTwinOf(record, payments) {
  if (!record || record.status !== "unmatched") return null;
  for (const [, other] of payments ?? []) {
    if (other?.status !== "used" || !isPaymentTwin(record, other)) continue;
    return { at: Number.isInteger(other.used?.at) ? other.used.at : null, receiptNumber: other.used?.sale?.receiptNumber ?? null };
  }
  return null;
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

/** How many edits the typed text may be from the reference. */
function editsAllowed(typedLength) {
  if (typedLength >= NEAR_MISS_TWO_EDITS_LENGTH) return 2;
  if (typedLength >= NEAR_MISS_MIN_LENGTH) return 1;
  return 0;
}

/** How one payment answers the query: "reference" | "bankRef" (exact),
 *  "prefix" | "bankPrefix" (the typed text starts it), "near" (a typo in the
 *  reference, whole or as far as it has been typed), or null. */
function matchOf(record, plan) {
  if (plan.tooShort) return null;
  const q = plan.whole;
  const ref = normaliseText(record.reference);
  const bank = normaliseText(record.bankRef);
  if (ref && ref === q) return "reference";
  if (bank && bank === q) return "bankRef";
  if (/^[0-9]+$/.test(q) && q.length < DIGITS_FORGIVING_MIN_LENGTH) {
    // Digits only, too few of them: the bank id's own prefix rule still
    // applies below (six or more), the reference is not guessed at.
    if (bank && q.length >= BANK_PREFIX_MIN_LENGTH && bank.startsWith(q)) return "bankPrefix";
    return null;
  }
  if (ref && q.length >= PREFIX_MIN_LENGTH && ref.startsWith(q)) return "prefix";
  if (bank && q.length >= BANK_PREFIX_MIN_LENGTH && bank.startsWith(q)) return "bankPrefix";
  const k = editsAllowed(q.length);
  if (!k || !ref) return null;
  // The whole reference…
  if (osaDistance(q, ref) <= k) return "near";
  // …or the part of it typed so far (a slip mid-way through a long reference):
  // the reference's head, one character either side of the typed length to
  // allow for a dropped or an extra character.
  for (let len = q.length - 1; len <= q.length + 1; len++) {
    if (len < NEAR_MISS_MIN_LENGTH || len >= ref.length) continue;
    if (osaDistance(q, ref.slice(0, len)) <= k) return "near";
  }
  return null;
}

/**
 * Copies of ONE bank transaction (records written before fix 1 — a resend
 * that landed as a second live record) are one payment to the cashier, not an
 * ambiguity: a used copy stands for the group (the money is spent), otherwise
 * the OLDEST copy does — the one the settle's fingerprint claim will favour.
 * Payments with no fingerprint stay as they are.
 */
function collapseCopies(hits, allPayments = []) {
  // A copy that did NOT match the query still decides the group's state: a
  // pre-fix resend can carry a different reference from the spent original
  // (CodeRabbit, this PR). Every payment sharing a matched fingerprint joins
  // its group before the representative is chosen.
  // Each fingerprint computed ONCE (sha256 per record, 400-record tail).
  const fpOf = new Map();
  const fp = (key, record) => { if (!fpOf.has(key)) fpOf.set(key, paymentFingerprint(record)); return fpOf.get(key); };
  const onByFp = new Map();
  const hitKeys = new Set();
  for (const h of hits) {
    hitKeys.add(h.key);
    const f = fp(h.key, h.record);
    if (f && !onByFp.has(f)) onByFp.set(f, h.on);
  }
  const extra = [];
  for (const [key, record] of allPayments) {
    if (hitKeys.has(key)) continue;
    const f = fp(key, record);
    if (f && onByFp.has(f)) extra.push({ key, record, on: onByFp.get(f) });
  }
  const byFp = new Map();
  const out = [];
  for (const h of [...hits, ...extra]) {
    const fp_ = fp(h.key, h.record);
    if (!fp_) { out.push(h); continue; }
    const cur = byFp.get(fp_);
    if (!cur) { byFp.set(fp_, h); continue; }
    const rank = (x) => [x.record.status === "used" ? 0 : 1, Number.isInteger(x.record.at) ? x.record.at : Infinity];
    const [a, b] = [rank(h), rank(cur)];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) byFp.set(fp_, h);
  }
  return [...out, ...byFp.values()];
}

// ─── THE SEARCH ──────────────────────────────────────────────────────────────
/**
 * Find THE payment a cashier's query names — or nothing.
 *
 * Only the best rank of match present is considered: exact (reference or bank
 * id), else prefix, else a typo. Among those candidates, exactly ONE unmatched
 * payment is the answer; with none unmatched, exactly one used payment is
 * (answered as used). Anything else is `ambiguous` and returns NOTHING —
 * with `partial` when the ambiguity is between prefix or typo matches, so the
 * till can say "keep typing" rather than "ask for the bank's transaction id".
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
  if (!hits.length) return { results: [], searched };
  const best = Math.min(...hits.map((h) => MATCH_RANK[h.on]));
  const candidates = collapseCopies(hits.filter((h) => MATCH_RANK[h.on] === best), payments);
  if (!candidates.length) return { results: [], searched };
  const unmatched = candidates.filter((h) => h.record.status === "unmatched");
  // A MANUAL ENTRY AND ITS BANK TWIN, both waiting (the notification landed
  // after Junid typed it): one payment, not two. The bank's record is the
  // answer; the manual one stays unused (and is refused once the bank's is
  // spent).
  const bankOnly = unmatched.filter((h) => !isManualEntry(h.record));
  const waiting = unmatched.filter((h) => !isManualEntry(h.record) || !bankOnly.some((b) => isPaymentTwin(b.record, h.record)));
  // Waiting payments answer; used ones only when nothing is waiting.
  const rows = waiting.length ? waiting : candidates;
  // One payment, or several that all carry the SAME reference (separate
  // payments, told apart by their own identity — see the header). Anything
  // else is an ambiguity between references.
  const refs = new Set(rows.map((h) => normaliseText(h.record.reference)));
  const sameReference = best === 0 && refs.size === 1 && !refs.has("");
  if (rows.length > 1 && !sameReference) return { results: [], searched, ambiguous: true, ...(best > 0 ? { partial: true } : {}) };
  const at = (h) => (Number.isInteger(h.record.at) ? h.record.at : Infinity);
  const picks = [...rows].sort((a, b) => at(a) - at(b) || (a.key < b.key ? -1 : 1)).slice(0, EFT_SEARCH_LIMIT);
  // The reference is shown whatever matched it — on a prefix or a typo match
  // it is what the cashier checks against the proof of payment before using
  // the payment (Junid, 19 Oct 2026; it was blanked on a near match before).
  const results = picks.map((pick) => {
    const view = { ...publicEftView(pick.key, pick.record), matchedOn: pick.on };
    const twin = manualTwinOf(pick.record, payments);
    if (twin) view.sameUsed = twin;
    return view;
  });
  return { results, searched };
}

module.exports = {
  EFT_POOL_PATH,
  EFT_SEARCH_WINDOW,
  EFT_SEARCH_LIMIT,
  EFT_MIN_QUERY,
  PREFIX_MIN_LENGTH,
  DIGITS_FORGIVING_MIN_LENGTH,
  NEAR_MISS_MIN_LENGTH,
  NEAR_MISS_TWO_EDITS_LENGTH,
  BANK_PREFIX_MIN_LENGTH,
  MATCH_RANK,
  editsAllowed,
  publicEftView,
  manualTwinOf,
  payerInitials,
  normaliseText,
  osaDistance,
  searchPlan,
  matchOf,
  searchEftPool,
};
