"use strict";

// ─── THE IDENTITY OF A PAYMENT, NOT OF AN EMAIL ─────────────────────────────
// The pool used to dedupe on sha256(Message-ID + auth verdict) — the identity
// of the MESSAGE. Every notification of a given payment was assumed to arrive
// once, from the bank, and to carry one Message-ID for ever.
//
// It does not. A customer can forward, or re-send from their banking app's
// "share proof of payment", and the mail that arrives is a NEW message with a
// NEW Message-ID carrying the SAME payment. The old key hashed the envelope, so
// it landed on a fresh node and the pool grew a second, spendable copy of money
// that had already been spent. That happened, in production, on 2026-09-09:
// bank reference 4141078732 exists twice — once used against sale S-12042 on
// 31 August, once unmatched and consumable.
//
// So identity moves onto the payment itself, and there are two tiers of it.
//
// HARD — THE BANK'S OWN NUMBER. Every bank this pool reads prints a identifier
// it issued itself, and the readers already capture it as `bankRef`:
//
//     Standard Bank   "Reference number"        e.g. 4141078732
//     FNB             "Trace ID"                e.g. 5TG59DVQ
//     Capitec         "Notification number"
//     Absa            "Transaction number"      e.g. 80D2F2AB5A-1
//
// That is the payment, for ever. One identifier, one payment: a second arrival
// is a duplicate however many days later it comes and whatever envelope carries
// it. Scoped by bank, because two banks' numbering spaces are unrelated and a
// collision between them would be an accident, not a duplicate.
//
// SOFT — A COMPOSITE, when a reader got no bankRef (the label is required to
// parse but the VALUE can come through blank on FNB and Absa). Bank, amount,
// normalised reference, normalised payer and THE PAYMENT DAY THE BANK STATED —
// not the day we happened to read the mail, which is why it is bankTs and not
// receivedAt. This cannot distinguish a genuine second payment of the same
// amount, from the same payer, with the same reference, on the same day — a
// regular is perfectly capable of that. So a composite match is never treated
// as proof: it is a QUESTION, and the caller quarantines rather than rejects.
//
// PURE by the house rule: no IO, no clock, no firebase.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS THE MIRROR of scripts/cardrecon/eftFingerprint.mjs, which the
// mailbox poller uses (that is ESM; functions/ is CommonJS and the two cannot
// import each other). The FUNCTION BODIES MUST STAY BYTE-IDENTICAL — a
// fingerprint computed at ingestion and one computed at consume time that
// disagree would let a duplicate through the very guard built to catch it.
// scripts/cardrecon/eftFingerprint.test.mjs runs BOTH files against the same
// table and fails if either drifts from the other.
// ─────────────────────────────────────────────────────────────────────────────

const { createHash } = require("node:crypto");

/** Letters and digits only, folded to lower case. "MR M " and "mr-m" are one
 *  reference; a payer typed with a middle initial one day and not the next is
 *  NOT, and that is deliberate — the composite tier errs towards letting a
 *  payment through to be looked at, never towards swallowing one. */
function normaliseIdentityText(v) {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The SAST calendar day of the bank's own stated payment time. Undated
 *  payments collapse to "nodate", which makes the composite weaker, never
 *  wrong: it can only cause a quarantine, never a rejection. */
function paymentDay(bankTs) {
  const ms = Number(bankTs);
  if (!Number.isFinite(ms) || ms <= 0) return "nodate";
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The fingerprint of one parsed payment.
 *
 * @returns {{ kind: "bank"|"composite", basis: string, hash: string }}
 *   `kind` is what the caller acts on: "bank" is proof of duplication and is
 *   refused outright; "composite" is a suspicion and is quarantined.
 *   `basis` is kept readable so a held record can say WHY it was held without
 *   anyone having to reverse a hash.
 */
function paymentFingerprint({ reader, bankRef, amountCents, reference, payer, bankTs }) {
  const bank = normaliseIdentityText(reader) || "unknownbank";
  const ref = String(bankRef ?? "").trim();
  if (ref) {
    const basis = `bank:${bank}:${normaliseIdentityText(ref)}`;
    return { kind: "bank", basis, hash: hashOf(basis) };
  }
  const basis = [
    "composite",
    bank,
    Number.isInteger(amountCents) ? amountCents : "noamount",
    normaliseIdentityText(reference) || "noref",
    normaliseIdentityText(payer) || "nopayer",
    paymentDay(bankTs),
  ].join(":");
  return { kind: "composite", basis, hash: hashOf(basis) };
}

function hashOf(basis) {
  return createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

/**
 * The fingerprint of a STORED pool record, which is the same function reading
 * the field names the poller wrote. Separate so the backfill and the consume
 * guard cannot drift from ingestion by reading a field differently.
 *
 * @returns null when the record is not a payment — refusals and unknown-bank
 *   notices are not money and have no payment identity.
 */
function recordFingerprint(record) {
  if (!record || typeof record !== "object" || record.outcome !== "recorded") return null;
  return paymentFingerprint({
    reader: record.reader,
    bankRef: record.bankRef,
    amountCents: record.amountCents,
    reference: record.reference,
    payer: record.payer,
    bankTs: record.bankTs,
  });
}

// ─── WHAT TO DO ABOUT A SECOND ARRIVAL ───────────────────────────────────────
/**
 * Decide where an arriving payment goes, given whatever the fingerprint index
 * already holds for it.
 *
 * `existing` is the index entry (`{ poolKey, kind }`) or null.
 *
 * MONEY IS NEVER DISCARDED. The three outcomes are admit, hold, and refuse —
 * and "refuse" still writes a record saying what arrived and why it was not
 * admitted. Nothing is dropped on the floor.
 */
function admissionDecision({ fingerprint, existing, incomingPoolKey }) {
  if (!fingerprint) return { action: "admit", reason: null };
  if (!existing || !existing.poolKey) return { action: "admit", reason: null };
  // The same record arriving again — a replay of one message, not a duplicate
  // payment. It is already in the pool under this very key.
  if (existing.poolKey === incomingPoolKey) return { action: "admit", reason: null };

  if (fingerprint.kind === "bank") {
    return {
      action: "reject",
      reason: `The bank's own reference for this payment has already been received. It is in the pool as ${existing.poolKey}. A bank reference identifies one payment for ever, so this is the same money arriving a second time — most often a proof of payment re-sent from a banking app.`,
    };
  }
  return {
    action: "quarantine",
    reason: `A payment already received carries the same bank, amount, reference, payer and payment date (${existing.poolKey}), and this notification carries no bank reference of its own to tell them apart. It is HELD, not refused: two genuine payments can look like this. Release it if it is real money.`,
  };
}

module.exports = {
  normaliseIdentityText, paymentDay, paymentFingerprint, recordFingerprint, admissionDecision,
};
