// ─── LINKED COPIES OF ONE PAYMENT — held automatically, never floated twice ──
// Junid, 7 Nov 2026 (the evening after store #867). A payment's own bank
// transaction number is its identity (eft-fingerprint.cjs bankTransactionIdOf)
// and the fingerprint claim spends it once. Two copies of the SAME money can
// still carry DIFFERENT fingerprints, and these must not both be spendable.
// No hand-run script is needed for either; the claim scripts
// (claim-settled-*.mjs) stay a backstop only.
//
//   HOLE 1 — A HAND ENTRY, THEN ITS BANK NOTICE. Junid types a payment whose
//   notice is late (its fingerprint is MANUAL-…); the notice then arrives
//   with the bank's own number. When the notice is the hand entry's twin
//   (eft-manual.cjs isPaymentTwin: same reference, same amount, the bank's
//   date inside the entry's window) and the hand entry was floated — used or
//   waiting — the notice is HELD at ingest as held-possible-duplicate
//   (linkedHold "manual-twin"), naming the entry. The owner releases it from
//   the EFT pool tab if the statement shows a genuine second payment.
//
//   HOLE 2 — A BLANK-NUMBER COPY AND A NUMBERED COPY. Absa prints the
//   transaction number on some copies and leaves it blank on others; the
//   blank one is identified synthetically (payer | account | day | cents |
//   reference). When a numbered Absa copy arrives and a blank-number record
//   of the same identity is already in the pool (a notice, or a proof Junid
//   approved), or the reverse, the SECOND is HELD (linkedHold
//   "blank-numbered-twin"), naming the first. Two NUMBERED copies with
//   different numbers are two payments — never linked here.
//
//   Both holds are re-checked at the SETTLE (linkedCopySettleCheck) so a pair
//   recorded before this shipped, or a race, still pays out once: a record
//   whose linked copy was already USED is refused, unless the owner released
//   it from a hold.
//
//   HOLE 3 — MONITORED, NOT HELD. A proof Junid approved from one bank's
//   document and a notice from ANOTHER bank with a different number, same
//   amount, days close: two customers can pay the same amount the same day,
//   so this never blocks. The notice is recorded spendable and carries
//   reviewFlag "possible-cross-bank-duplicate" for the owner's pool tab, and
//   the poller logs EFT_POSSIBLE_CROSS_BANK_DUPLICATE.
//
// PURE: no IO, no clock.
"use strict";

const { sastDate } = require("./eft-text.cjs");
const { bankTransactionIdOf, absaSyntheticRef, isSyntheticIdentity } = require("./eft-fingerprint.cjs");
const { isManualEntry, isPaymentTwin } = require("./eft-manual.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const LINKED_HOLD_KINDS = ["manual-twin", "blank-numbered-twin"];
const CROSS_BANK_FLAG = "possible-cross-bank-duplicate";
// The proof's date and the notice's may differ by a weekend (transaction vs
// clearing date) — the same window eft-manual-approved.cjs uses.
const CROSS_BANK_DAYS_BEFORE = 1;
const CROSS_BANK_DAYS_AFTER = 3;

const isManualApproved = (r) => !!(r && typeof r === "object" && r.manualApproved && typeof r.manualApproved === "object");
/** A payment record that holds money: recorded (waiting or used). */
const isLivePayment = (r) => !!(r && typeof r === "object" && r.outcome === "recorded");

/**
 * The Absa identity of a record — payer | account last 4 | day | cents |
 * reference — whether it was built synthetically (a blank number; a release
 * suffix is dropped) or can be built from a numbered record's own fields.
 * null for any other bank, or a record missing a part.
 */
function absaIdentityOf(record) {
  if (!record || record.reader !== "absa") return null;
  if (isSyntheticIdentity(record)) return String(record.syntheticRef).replace(/\|RELEASED:\d+$/, "");
  return absaSyntheticRef({
    payer: record.payer,
    accountMask: record.destination?.accountMask ?? record.accountMask ?? record.accountTail,
    bankTs: record.bankTs, amountCents: record.amountCents, reference: record.reference,
  });
}

/** Exactly one of the two has its own bank number, and the identities match. */
function isBlankNumberedPair(a, b) {
  if (!a || !b || a === b) return false;
  const na = !!bankTransactionIdOf(a), nb = !!bankTransactionIdOf(b);
  if (na === nb) return false;
  const ia = absaIdentityOf(a), ib = absaIdentityOf(b);
  return !!ia && ia === ib;
}

/**
 * INGEST: should this freshly recorded payment be held because another copy
 * of the same money is already in the pool? `siblings` is the pool tail.
 * @returns {{kind:string, duplicateOf:string, reason:string}|null}
 */
function linkedHoldOf(record, poolKey, siblings) {
  if (!isLivePayment(record) || isManualEntry(record) || isManualApproved(record)) return null;
  const others = (siblings ?? []).filter(([key, o]) => key !== poolKey && isLivePayment(o));
  // HOLE 1: the bank's notice of money a hand entry already floated.
  if (bankTransactionIdOf(record)) {
    for (const [key, o] of others) {
      if (!isManualEntry(o) || !["used", "unmatched"].includes(o.status) || !isPaymentTwin(record, o)) continue;
      return {
        kind: "manual-twin", duplicateOf: key,
        reason: `The bank's notification of a payment already put in the pool by hand (same reference and amount, ${o.status === "used" ? "already used" : "waiting"}) — HELD so the money is not floated twice. If the statement shows a genuine SECOND payment, release it.`,
      };
    }
  }
  return null;
}

/** The held record for a linkedHoldOf answer: every field kept, no status. */
function applyLinkedHold(record, hold) {
  if (!hold) return record;
  const { status: _status, ...held } = record;
  return { ...held, outcome: "held-possible-duplicate", duplicateOf: hold.duplicateOf, linkedHold: hold.kind, reason: hold.reason };
}

/**
 * SETTLE: the record about to be spent has a linked copy (hole 1 or 2) that
 * was already USED. Refused, in the till's one sentence — unless the owner
 * released this record from a hold (he checked the statement).
 * @returns {{ok:true}|{ok:false, code:string, side:string, message:string}}
 */
function linkedCopySettleCheck({ poolKey, record, siblings }) {
  if (!isLivePayment(record) || record.releasedFromHold || isManualEntry(record)) return { ok: true };
  for (const [key, o] of siblings ?? []) {
    if (key === poolKey || !isLivePayment(o) || o.status !== "used") continue;
    const manualTwin = bankTransactionIdOf(record) && isManualEntry(o) && isPaymentTwin(record, o);
    if (!manualTwin) continue;
    const slip = o.used?.sale?.receiptNumber ? ` on slip ${o.used.sale.receiptNumber}` : "";
    return {
      ok: false, code: "twin-used", side: manualTwin ? "manual-twin-used" : "blank-numbered-twin-used",
      message: `This payment was already used${slip}. It cannot be used again. If the customer really paid twice, ask Junid.`,
    };
  }
  return { ok: true };
}

module.exports = {
  LINKED_HOLD_KINDS,
  absaIdentityOf, isBlankNumberedPair, linkedHoldOf, applyLinkedHold, linkedCopySettleCheck,
};
