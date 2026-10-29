// ─── EFT PAYMENT FINGERPRINT — one bank transaction, one spendable record ────
// THE 9 SEP HOLE. The pool deduped on the EMAIL: a record's key is derived from
// the message (eftMessageKey / eftPaymentKey), so "Resend proof of payment" in
// a banking app — a NEW email with a NEW Message-ID for the SAME money — landed
// on a new key as a second live "unmatched" record, and both could be spent
// (EFT interrogation B, D, E).
//
// The fix keys on the BANK'S OWN TRANSACTION IDENTIFIER — FNB's Trace ID,
// Absa's Transaction number, Standard Bank's Reference number, Capitec's
// Notification number — which every resend of one payment repeats:
//
//   fingerprint = sha256("eftfp1|" + reader + "|" + normalised bankRef)
//
// The reader id namespaces it (each bank numbers its own transactions; one
// bank's id says nothing about another's). /eft_pool_fingerprints/{fp} is a
// CREATE-ONLY claim naming the ONE pool record allowed to spend that money:
//
//   · INGEST (the poller) claims it before writing a recorded payment. A
//     second record for the same transaction finds the claim held by another
//     key and is stored "held-duplicate" — owner-only, never spendable.
//   · CONSUME (eftPoolSettle) re-checks it: the claim must name THIS record,
//     and no other record carrying the same fingerprint may already be used
//     (records written before this fix have no claim — the check at consume
//     is what keeps a pre-fix duplicate from being spent twice).
//   · NO bankRef → no fingerprint → the payment is NOT spendable. The poller
//     stores it "held-no-bankref"; settle refuses a recorded payment without
//     one unless the OWNER released it from the hold by hand.
//
// PURE by the house rule: no IO, no clock. Shared by the poller (ESM, via
// createRequire — the same way it borrows the money parser) and the callable.
//
// ─── ABSA WITHOUT A TRANSACTION NUMBER (Junid, 29 Oct 2026) ──────────────────
// Absa's "Notice of Payment" prints "Transaction number:" BLANK on some
// payments (real notices of 5, 27, 28 and 29 Oct 2026 — the R10, R1,900,
// R1,000 and R610 payments; the 1 Sep, 24 Oct and 26 Oct notices did carry
// one). There is no time of day and no running balance either, so nothing the
// bank prints identifies the payment. Every such notice landed held-no-bankref
// and waited for the owner. Instead, a SYNTHETIC IDENTITY is built from what
// the notice does print — payer, destination account (last four), payment
// day, amount and the payer's reference:
//
//   syntheticRef = "ABSA|<payer>|<account tail>|<YYYY-MM-DD>|<cents>|<reference>"
//   fingerprint  = sha256("eftfp1|absa|synthetic|" + syntheticRef)
//
// and claimed exactly like a bank id. Two notices with the same synthetic
// identity are either one payment resent or two genuinely identical payments
// — indistinguishable from here — so the FIRST is confirmed and the SECOND
// is held for the owner (held-possible-duplicate, eftCore.applyFingerprintHold)
// rather than confirmed or discarded: a replay never floats twice, and a real
// second payment is floated by hand (releaseHoldDecision re-keys it). A notice
// that DOES print a transaction number keeps using it; the synthetic identity
// is the fallback, never the preference.
"use strict";

const { createHash } = require("node:crypto");
const { sastDate } = require("./eft-text.cjs");

const EFT_FINGERPRINT_PATH = "eft_pool_fingerprints";
// A transaction id shorter than this, once normalised, identifies nothing —
// treated as ABSENT, which fails closed (held, never live).
const MIN_BANK_REF_CHARS = 4;
// Reader ids are eftBanks.mjs's EFT_READERS ids: lower-case letters only.
const READER_ID = /^[a-z][a-z0-9]{1,30}$/;

/** "5tg5 9dvq" and "5TG59DVQ" are one id. Letters and digits only, upper. */
function normaliseBankRef(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= MIN_BANK_REF_CHARS ? s : null;
}

// A synthetic identity: letters, digits and the field separators, bounded.
// Anything else is not one this module built and identifies nothing.
const SYNTHETIC_REF = /^[A-Z0-9|:-]{12,300}$/;
const normaliseText = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Bounded, so the identity plus a release suffix ("|RELEASED:<ms>") always
// fits SYNTHETIC_REF: a payer or reference longer than any bank prints is
// clipped, never a reason to lose the identity.
const SYNTHETIC_PAYER_MAX = 40;
const SYNTHETIC_REFERENCE_MAX = 80;

/**
 * The synthetic identity of an Absa notice that prints no transaction number
 * — or null when the notice does not print enough to build one (no payer, no
 * readable payment day, no amount, no destination account: each of those is
 * on every real notice, so a notice missing one is a layout this has not
 * seen and must fail closed to held-no-bankref). The reference may be empty:
 * a payer who typed none still paid once.
 */
function absaSyntheticRef({ payer, accountMask, bankTs, amountCents, reference } = {}) {
  const who = normaliseText(payer).slice(0, SYNTHETIC_PAYER_MAX);
  const digits = String(accountMask ?? "").replace(/\D/g, "");
  if (!who || digits.length < 4 || !Number.isInteger(bankTs) || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  return `ABSA|${who}|${digits.slice(-4)}|${sastDate(bankTs)}|${amountCents}|${normaliseText(reference).slice(0, SYNTHETIC_REFERENCE_MAX)}`;
}

/**
 * The synthetic identity a parsed payment carries when its bank prints no
 * transaction id — ABSA ONLY, today: the one bank seen to leave the field
 * blank. Every other reader's documents carry an id, and one that stops
 * carrying it must go on being held (held-no-bankref) until its own synthetic
 * identity is designed from real samples — never generalised from Absa's.
 * @returns {string|null}
 */
function syntheticIdentityOf(parsed, reader) {
  if (reader !== "absa" || !parsed?.ok) return null;
  if (paymentFingerprint({ reader, bankRef: parsed.bankRef })) return null; // the bank's own id wins
  return absaSyntheticRef({
    payer: parsed.payer, accountMask: parsed.accountMask, bankTs: parsed.bankTs,
    amountCents: parsed.amountCents, reference: parsed.reference,
  });
}

/** Does this record identify itself synthetically (no bank id, a syntheticRef)? */
function isSyntheticIdentity({ bankRef, syntheticRef } = {}) {
  return !normaliseBankRef(bankRef) && typeof syntheticRef === "string" && SYNTHETIC_REF.test(syntheticRef);
}

/**
 * The fingerprint of a payment — or null when it has none (no reader, or no
 * usable bank transaction id). Accepts a pool record or a reader's parse plus
 * its reader id ({reader, bankRef, syntheticRef}). The bank's own id always
 * wins; the synthetic identity is read only when there is none.
 */
function paymentFingerprint({ reader, bankRef, syntheticRef } = {}) {
  if (typeof reader !== "string" || !READER_ID.test(reader)) return null;
  const ref = normaliseBankRef(bankRef);
  if (ref) return createHash("sha256").update(`eftfp1|${reader}|${ref}`).digest("hex").slice(0, 40);
  if (isSyntheticIdentity({ bankRef, syntheticRef })) {
    return createHash("sha256").update(`eftfp1|${reader}|synthetic|${syntheticRef}`).digest("hex").slice(0, 40);
  }
  return null;
}

/**
 * The transaction body that claims /eft_pool_fingerprints/{fp} for `poolKey`.
 * Create-only: an empty node is claimed; an occupied one is never touched.
 * `capture` receives {holder} — the pool key that holds the claim after this
 * run (the last call is authoritative, as with every RTDB transaction).
 *
 * A cold-cache null first call returns the claim; the server's compare-and-
 * swap then fails against a real existing claim and the function re-runs with
 * it, which aborts and reports the real holder.
 */
function fingerprintClaimStep(poolKey, at, capture = () => {}) {
  return (existing) => {
    if (existing && typeof existing === "object" && typeof existing.poolKey === "string") {
      capture({
        holder: existing.poolKey,
        spentBy: typeof existing.spentBy === "string" ? existing.spentBy : null,
        // A claim written by eftPoolManualApprove (Junid approved the payment
        // from an uploaded proof): the poller files the bank's later copy as
        // the bank's record of money already settled, never a fresh payment.
        manualApproved: existing.manualApproved === true,
      });
      return undefined;
    }
    if (existing !== null && existing !== undefined) {
      // Something that is not a claim sits there. Never overwrite it; nobody
      // holds the money cleanly, so nobody may spend it.
      capture({ holder: null, corrupt: true });
      return undefined;
    }
    capture({ holder: poolKey });
    return { poolKey, at };
  };
}

/**
 * CONSUME-TIME re-check, decided before the settle transaction runs.
 *
 * @param {object} p
 * @param {string} p.poolKey      the record being settled
 * @param {object} p.record       its current value
 * @param {Array<[string, object]>} p.siblings  other pool records the callable
 *   read (the search tail) — any of them may carry the same fingerprint
 * @returns {{ok:true, fingerprint:string|null} | {ok:false, code, message}}
 *   `fingerprint` null only for an owner-released no-bankref payment.
 */
function consumeFingerprintCheck({ poolKey, record, siblings }) {
  const fp = paymentFingerprint(record ?? {});
  if (!fp) {
    if (record?.releasedFromHold && typeof record.releasedFromHold === "object") return { ok: true, fingerprint: null };
    return {
      ok: false, code: "no-bank-id",
      message: "This payment carries no bank transaction id, so it cannot be told apart from a resent copy — it cannot settle a sale. The owner can check it against the bank statement.",
    };
  }
  for (const [key, other] of siblings ?? []) {
    if (key === poolKey || !other || typeof other !== "object") continue;
    if (paymentFingerprint(other) !== fp) continue;
    if (other.status === "used") {
      return {
        ok: false, code: "duplicate-used",
        message: "This is a second copy of a payment that has ALREADY been used (the bank's transaction id matches). It cannot settle a sale.",
      };
    }
  }
  return { ok: true, fingerprint: fp };
}

/** The claim says who may spend this transaction; it must be this record —
 *  and no OTHER record may already have spent it (`spentBy`, stamped by the
 *  backfill for payments used before fix 1, which had no claim). */
function claimHolderCheck({ poolKey, holder, spentBy = null }) {
  if (spentBy && spentBy !== poolKey) {
    return {
      ok: false, code: "duplicate-used",
      message: "This is a second copy of a payment that has ALREADY been used (the bank's transaction id matches). It cannot settle a sale.",
    };
  }
  // The spender itself — an original the owner reversed — may settle again,
  // whoever happened to claim first.
  if (spentBy && spentBy === poolKey) return { ok: true };
  if (holder === poolKey) return { ok: true };
  return {
    ok: false, code: "duplicate",
    message: "This is a second copy of a payment the pool already holds under another record (the bank's transaction id matches). Use the original — search by its reference or the bank's transaction id.",
  };
}

// ─── THE ONE-TIME BACKFILL: payments USED before fix 1 ──────────────────────
// Records written before the fix carry no claim, and the settle's sibling
// check sees only the pool's latest window — so once a spent pre-fix payment
// scrolled out of it, a resend could claim the fingerprint and be spent again
// (CodeRabbit, this PR). eftRemainderScan walks /eft_pool once, a bounded page
// per run, and for every USED payment stamps `spentBy` on its fingerprint's
// claim (creating the claim for it when none exists). The claim's holder is
// never moved; spentBy alone makes every other copy refuse.
const EFT_FP_BACKFILL_PATH = "_migrations/eftFingerprintBackfill";
const EFT_FP_BACKFILL_PAGE = 100;

function backfillSpentStep(poolKey, at) {
  return (existing) => {
    if (existing === null || existing === undefined) return { poolKey, at, spentBy: poolKey, backfilledAt: at };
    if (typeof existing !== "object" || typeof existing.spentBy === "string") return undefined;
    return { ...existing, spentBy: poolKey, backfilledAt: at };
  };
}

module.exports = {
  EFT_FP_BACKFILL_PATH,
  EFT_FP_BACKFILL_PAGE,
  backfillSpentStep,
  EFT_FINGERPRINT_PATH,
  MIN_BANK_REF_CHARS,
  normaliseBankRef,
  paymentFingerprint,
  absaSyntheticRef,
  isSyntheticIdentity,
  syntheticIdentityOf,
  fingerprintClaimStep,
  consumeFingerprintCheck,
  claimHolderCheck,
};
