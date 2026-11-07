// ─── MANUAL EFT ENTRY — Junid's escape hatch while enforcement settles in ───
// With EFT matching ENFORCED at Trophy and Marathon PE (lib/eft-enforce.cjs)
// a sale whose bank notification never arrives — a bank the pool has no
// reader for, a delayed email, a payment Junid has seen on the statement —
// would have no way through. So JUNID, AND JUNID ALONE, can type a customer
// reference and an amount, and that becomes a SPENDABLE RECORD IN THE POOL
// which a cashier finds and consumes exactly like a bank-confirmed one:
//
//   · the same search (eftPoolSearch — by the reference, typed in full),
//   · the same settle (eftPoolSettle — customer attached and confirmed,
//     consume-once, the fingerprint claimed), the same attach, release,
//     remainder and reversal. NOTHING in that flow is re-implemented.
//
// WHAT MAKES IT DIFFERENT — TO JUNID, AND TO JUNID ONLY:
//   · reader "manual", `manualEntry: { by: "Junid", uid, email, at, note,
//     entryId }` on the record; the owner's pool tab, his EFT review list and
//     the /eft_manual_entries log say "MANUALLY ENTERED BY JUNID".
//   · THE TILL NEVER KNOWS (Junid, 20 Oct 2026): publicEftView carries no
//     trace of it, a twin warning or refusal never says which side was typed
//     by hand, and the cashier consumes it exactly like a bank-confirmed
//     payment — same card, same wording, same taps.
//   · no payer name, no bank transcript, `auth.verdict: "manual"`.
//   · its bankRef is SYNTHETIC and unique to the record ("MANUAL-<key…>"), so
//     paymentFingerprint() works unchanged: the fingerprint is claimed at
//     entry (create-only, like the poller does), and the settle's checks
//     (consumeFingerprintCheck, claimHolderCheck, the in-transaction
//     re-derivation) all apply. One entry, one spend.
//   · the KEY is derived from the client's entryId, so a retried tap lands
//     on the same key and the create-if-absent write makes it idempotent.
//     A second entry with the SAME reference AND amount typed the same SAST
//     day is ACCEPTED WITH A WARNING (Junid, 7 Nov 2026 — it used to be
//     refused, forcing "… 2" references): a customer can genuinely pay twice
//     under one reference, and each hand entry is its own record. Only the
//     EXACT same entry (reference, amount and note) submitted again within
//     MANUAL_DOUBLE_SUBMIT_MS is an accidental double tap, answered with the
//     first record instead of a second (manualDoubleSubmitOf).
//
// Every entry and every consumption is LOGGED (eft-manual log, commit 3) so
// Junid can see how often the hatch is used and retire it when enforcement
// has settled.
//
// Server time is Date.now() on the callable (the function's own clock IS the
// server clock; serverNowMs() is the client's corrected one). PURE here: no
// IO, no clock.
"use strict";

const { createHash } = require("node:crypto");
const { sastDate, nextBusinessDay } = require("./eft-text.cjs");
const { normaliseBankRef, bankTransactionIdOf } = require("./eft-fingerprint.cjs");

// ─── ONE PAYMENT, NOT ONE REFERENCE (7 Nov 2026) ─────────────────────────────
// A manual entry carries no bank identity — only what Junid typed: reference,
// amount, and WHEN he typed it. The twin rules below used to match reference
// + amount with no end date ("the bank record arrived at or after the entry"),
// so ONE manual "SOCCER T SHIRT" R870 of 29 Oct (used on S-50363) blocked
// every later R870 "Soccer T shirt" for ever: the customer reuses that
// reference for repeat orders, and MR S MAISTRY's genuinely new Absa payment
// of 7 Nov (its own transaction id) was refused at the till as "already used
// on slip S-50363". Junid then had to type it by hand as "SOCCER T SHIRT 2"
// to get past the manual duplicate block.
//
// The identity of a manual entry is therefore reference + amount + WHEN:
//   · a bank notice is a manual entry's twin only for a payment the bank
//     dates no later than the entry was typed and at most a week before it,
//     whose notice landed after the typing or the same day — or, a weekend
//     payment dated for the next business day whose notice landed before
//     that day (withinManualTwinWindow);
//   · a second manual entry is a duplicate when typed the same SAST day or
//     within 12 hours (23:55 and 00:05 are the same money typed twice).
// A payment made after an entry was typed, or on another day, that shares a reference and an amount are two
// payments. Bank against bank is never decided here: the bank's transaction id
// (or Absa's full synthetic identity — payer, account, date, amount,
// reference) is the fingerprint, and the fingerprint claim spends it once.
const DAY_MS = 24 * 60 * 60 * 1000;
// The bank's clock and the server's may disagree a little; a payment the bank
// timestamps up to an hour after the entry was typed is still the one typed.
const BANK_CLOCK_TOLERANCE_MS = 60 * 60 * 1000;
// How far back a hand entry may stand in for a payment: a weekend or a public
// holiday between the payment and Junid typing it, with room to spare.
const TWIN_LOOKBACK_DAYS = 7;
const DUPLICATE_ROLLING_MS = 12 * 60 * 60 * 1000;
const sameSastDay = (a, b) => Number.isInteger(a) && Number.isInteger(b) && sastDate(a) === sastDate(b);
/** Whole SAST calendar days from `from` to `to` (negative when `to` is earlier). */
const sastDaysBetween = (from, to) => Math.round((Date.parse(sastDate(to)) - Date.parse(sastDate(from))) / DAY_MS);
/** The bank's own date for the payment (bankTs), else when it arrived. */
function paidAtOf(record) {
  if (Number.isInteger(record?.bankTs)) return record.bankTs;
  if (Number.isInteger(record?.receivedAt)) return record.receivedAt;
  return Number.isInteger(record?.at) ? record.at : null;
}
/**
 * Is the bank record the payment the manual entry typed at `typedAt` stood in
 * for? A hand entry records money ALREADY PAID, so its bank twin is a payment
 * the bank dates NO LATER than the typing (an hour's clock tolerance) and no
 * more than TWIN_LOOKBACK_DAYS earlier, whose notice either landed after the
 * typing (the late notice the entry was for — however late: a Saturday
 * payment typed on Monday, its notice on Tuesday) or on the same SAST day.
 * A payment the bank dates AFTER the entry was typed is a new payment — a
 * repeat customer's next order under the same reference — never the twin.
 * (Fable spec review of #861: anchor on the payment date, not on how late
 * the email was.)
 */
function withinManualTwinWindow(typedAt, bank) {
  // An entry with no readable time (never written so) stays conservative.
  if (!Number.isInteger(typedAt)) return true;
  const arrived = Number.isInteger(bank?.receivedAt) ? bank.receivedAt : bank?.at;
  // No bank date to place the payment by (never true of a record written
  // since fix 8): the old rule — a notice landing after the entry is its twin.
  if (!Number.isInteger(bank?.bankTs)) return !Number.isInteger(arrived) || arrived >= typedAt;
  if (bank.bankTs > typedAt + BANK_CLOCK_TOLERANCE_MS) {
    // A later TIME the same day is a new payment, never the twin (it was
    // made after the entry was typed). (Substitute review of #866.)
    if (sastDate(bank.bankTs) <= sastDate(typedAt)) return false;
    // NEXT-BUSINESS-DAY SETTLEMENT (7 Nov 2026, Fable review of #866): a
    // weekend payment is dated for the day it settles. Junid typing it on
    // Saturday and the bank's notice dated Monday are ONE payment when the
    // notice landed from the typing day up to (not including) the next
    // business day — Saturday or Sunday for a weekend entry, the same day for
    // a weekday one — and the bank's date is no later than that next business
    // day. A repeat customer's next payment, whose notice lands on a later
    // business day, stays a payment of its own.
    const nbd = nextBusinessDay(sastDate(typedAt));
    return Number.isInteger(arrived) && arrived >= typedAt - DAY_MS
      && sastDate(arrived) >= sastDate(typedAt) && sastDate(arrived) < nbd
      && sastDate(bank.bankTs) <= nbd;
  }
  if (sastDaysBetween(bank.bankTs, typedAt) > TWIN_LOOKBACK_DAYS) return false;
  if (sameSastDay(typedAt, bank.bankTs)) return true;
  return !Number.isInteger(arrived) || arrived >= typedAt;
}

const MANUAL_READER = "manual";
const MANUAL_ENTRY_BY = "Junid";
const MANUAL_LOG_PATH = "eft_manual_entries";

// The reference the customer will give the cashier: 3–60 characters, at
// least three letters/digits once normalised (the search's own floor).
const MANUAL_REFERENCE_MAX = 60;
const MANUAL_REFERENCE_MIN_CHARS = 3;
// Rands are typed by hand: R1 to R50,000, whole cents.
const MANUAL_AMOUNT_MIN_CENTS = 100;
const MANUAL_AMOUNT_MAX_CENTS = 5_000_000;
const MANUAL_NOTE_MAX = 200;
// The client's idempotency token — minted once per form submit.
const ENTRY_ID = /^[A-Za-z0-9_-]{8,60}$/;

const normaliseText = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A pool key for the entry: 40 hex chars, like every other pool key, and
 *  the same key for the same entryId — so a retry is the same record. */
function manualEntryKeyOf(entryId) {
  return createHash("sha256").update(`eftmanual1|${entryId}`).digest("hex").slice(0, 40);
}

/** Validate what Junid typed. Returns the cleaned fields or a refusal. */
function manualEntryInputCheck(data) {
  const d = data && typeof data === "object" ? data : {};
  const entryId = typeof d.entryId === "string" ? d.entryId : "";
  if (!ENTRY_ID.test(entryId)) return { ok: false, code: "bad-entry-id", message: "The entry carries no id — reload and try again." };
  // Upper-cased: the search normalises anyway, and the till then shows the
  // reference the way a bank prints one.
  const reference = String(d.reference ?? "").trim().replace(/\s+/g, " ").slice(0, MANUAL_REFERENCE_MAX).toUpperCase();
  if (normaliseText(reference).length < MANUAL_REFERENCE_MIN_CHARS) {
    return { ok: false, code: "bad-reference", message: "Type the customer's payment reference — at least three letters or digits. The cashier will search by it." };
  }
  const amountCents = d.amountCents;
  if (!Number.isInteger(amountCents) || amountCents < MANUAL_AMOUNT_MIN_CENTS || amountCents > MANUAL_AMOUNT_MAX_CENTS) {
    return { ok: false, code: "bad-amount", message: "The amount must be between R1 and R50,000, in rands and cents." };
  }
  const note = d.note == null ? null : String(d.note).trim().slice(0, MANUAL_NOTE_MAX) || null;
  return { ok: true, entryId, reference, amountCents, note };
}

/**
 * The pool record. The shape is eftCore.mjs's recorded payment, so nothing
 * downstream needs a special case: outcome "recorded", status "unmatched",
 * amountCents, reference, bankRef (synthetic), reader, at/receivedAt/bankTs.
 * No payer, no raw text, no destination: nothing was read from a bank.
 */
function manualEntryRecord({ entryId, key, reference, amountCents, note, actor, at }) {
  return {
    at,
    receivedAt: at,
    bankTs: at,
    messageId: `manual:${entryId}`,
    from: actor?.email ?? null,
    subject: `Manual EFT entry by ${MANUAL_ENTRY_BY}`,
    auth: { verdict: "manual", fromDomain: null, dkimDomain: null, detail: `Entered by hand by ${MANUAL_ENTRY_BY} — no bank notification was read.` },
    rawText: null,
    reader: MANUAL_READER,
    outcome: "recorded",
    status: "unmatched",
    amountCents,
    reference,
    payer: null,
    // Unique per record so the fingerprint machinery treats it as one bank
    // transaction with one spendable copy. Never a real bank's id.
    bankRef: `MANUAL-${key.slice(0, 12).toUpperCase()}`,
    destination: null,
    accountTail: null,
    manualEntry: {
      by: MANUAL_ENTRY_BY,
      uid: actor?.uid ?? null,
      email: actor?.email ?? null,
      at,
      note: note ?? null,
      entryId,
    },
  };
}

/** Is this pool record one Junid typed, rather than one a bank sent? */
function isManualEntry(record) {
  return !!(record && typeof record === "object" && record.reader === MANUAL_READER
    && record.manualEntry && typeof record.manualEntry === "object");
}

// An accidental double-submit: the exact same entry again within seconds.
const MANUAL_DOUBLE_SUBMIT_MS = 10 * 1000;

/**
 * A SIMILAR entry — a WARNING since 7 Nov 2026, never a refusal: the same normalised reference,
 * the same amount, on a manual record TYPED THE SAME SAST DAY OR WITHIN 12
 * HOURS (any status — a
 * used one has been spent, an unmatched one is waiting). The same entryId is
 * the idempotent retry, not a duplicate. An earlier day's entry with the same
 * reference and amount is a different payment (a repeat customer's repeat
 * order) and never blocks — nobody has to rename a reference to "… 2".
 * `at` is when this entry is being typed; without it every day matches (the
 * old rule — kept only for a caller that cannot say).
 * @returns {{key:string, record:object}|null}
 */
function manualDuplicateOf({ reference, amountCents, entryId, at = null }, siblings) {
  const want = normaliseText(reference);
  for (const [key, rec] of siblings ?? []) {
    if (!isManualEntry(rec)) continue;
    if (rec.manualEntry.entryId === entryId) continue;
    if (rec.amountCents !== amountCents || normaliseText(rec.reference) !== want) continue;
    if (Number.isInteger(at) && Number.isInteger(rec.manualEntry.at)
      && !sameSastDay(at, rec.manualEntry.at) && Math.abs(at - rec.manualEntry.at) >= DUPLICATE_ROLLING_MS) continue;
    return { key, record: rec };
  }
  return null;
}

/**
 * THE ACCIDENTAL DOUBLE-SUBMIT (Junid, 7 Nov 2026): the EXACT same entry —
 * same normalised reference, same amount, same note — typed under another
 * entryId no more than MANUAL_DOUBLE_SUBMIT_MS before `at`. Answered with
 * that record (no second one). A deliberate second entry seconds later with
 * the same fields is indistinguishable from a double tap, so it is answered
 * the same way; Junid adds a note, or waits a few seconds, to enter it.
 * @returns {{key:string, record:object}|null}
 */
function manualDoubleSubmitOf({ reference, amountCents, note = null, entryId, at }, siblings) {
  if (!Number.isInteger(at)) return null;
  const want = normaliseText(reference);
  const wantNote = String(note ?? "").trim();
  for (const [key, rec] of siblings ?? []) {
    if (!isManualEntry(rec) || rec.manualEntry.entryId === entryId) continue;
    if (rec.amountCents !== amountCents || normaliseText(rec.reference) !== want) continue;
    if (String(rec.manualEntry.note ?? "").trim() !== wantNote) continue;
    const typed = rec.manualEntry.at;
    if (!Number.isInteger(typed) || at - typed < 0 || at - typed > MANUAL_DOUBLE_SUBMIT_MS) continue;
    return { key, record: rec };
  }
  return null;
}

/**
 * THE BANK'S OWN RECORD OF THE SAME MONEY. A manual entry exists because the
 * notification has not arrived — if an UNMATCHED bank-confirmed payment with
 * this reference and amount, dated within the last TWIN_LOOKBACK_DAYS (or
 * up to the next business day — a weekend payment dated Monday), is already in the
 * tail, Junid should use that one, not type a second spendable copy. (Spec
 * review, this PR.) An unused bank payment older than that with the same
 * reference is somebody's other payment — not this one's twin. (Blocking is
 * the safe side of a money-out error: Junid uses the waiting one or looks.)
 * @returns {{key:string, record:object}|null}
 */
function bankTwinOfEntry({ reference, amountCents, at = null }, siblings) {
  const want = normaliseText(reference);
  for (const [key, rec] of siblings ?? []) {
    if (!rec || rec.outcome !== "recorded" || isManualEntry(rec) || rec.status !== "unmatched") continue;
    if (rec.amountCents !== amountCents || normaliseText(rec.reference) !== want) continue;
    const paidAt = paidAtOf(rec);
    if (Number.isInteger(at) && Number.isInteger(paidAt)) {
      const back = sastDaysBetween(paidAt, at); // days from the payment to now
      // Forward: up to the next business day (a weekend payment dated Monday,
      // 7 Nov 2026).
      const ahead = sastDate(paidAt) > nextBusinessDay(sastDate(at));
      if (ahead || back > TWIN_LOOKBACK_DAYS) continue;
    }
    return { key, record: rec };
  }
  return null;
}

/**
 * Two pool records that are ONE payment: a manual entry and the bank's own
 * notification of it — same normalised reference, same amount, and the bank
 * dates the payment no later than the entry was typed and within a week of
 * it (withinManualTwinWindow). A bank payment made after the typing, or more
 * than a week before, is a different payment, not a twin. Either side may be `record`.
 * Two BANK records are never twins here: their fingerprints decide. Pure.
 */
function isPaymentTwin(record, other) {
  if (!record || !other || record === other) return false;
  const manual = isManualEntry(record) ? record : isManualEntry(other) ? other : null;
  const bank = manual === record ? other : record;
  if (!manual || isManualEntry(bank) || bank.outcome !== "recorded") return false;
  if (bank.amountCents !== manual.amountCents) return false;
  const ref = normaliseText(manual.reference);
  if (!ref || normaliseText(bank.reference) !== ref) return false;
  const typedAt = Number.isInteger(manual.manualEntry?.at) ? manual.manualEntry.at : null;
  return withinManualTwinWindow(typedAt, bank);
}

/**
 * SETTLE-TIME: the record about to be spent is a MANUAL ENTRY whose bank
 * notification arrived and was spent. (The other direction — a bank record
 * whose manual twin was spent — refused too until 7 Nov 2026; a bank record
 * carrying its own transaction number is now judged on that number alone.) The two carry
 * different fingerprints, so the fingerprint check cannot see they are one
 * payment; this can. Refused — the money was paid out once already; Junid
 * reverses one of them if they really are two.
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function manualTwinSettleCheck({ poolKey, record, siblings }) {
  if (!record || record.outcome !== "recorded") return { ok: true };
  // A BANK PAYMENT WITH ITS OWN TRANSACTION NUMBER is never refused here
  // (Junid, 7 Nov 2026): its number is its identity, and the fingerprint
  // claim alone decides whether it was used. A used hand entry sharing its
  // reference and amount is reported (`txnOverManualTwin`, for the server's
  // log line) and never blocks. Only the record WITHOUT a number — the hand
  // entry — is refused when its bank twin was spent.
  if (bankTransactionIdOf(record)) {
    for (const [key, other] of siblings ?? []) {
      if (key !== poolKey && other?.status === "used" && isPaymentTwin(record, other)) return { ok: true, txnOverManualTwin: key };
    }
    return { ok: true };
  }
  for (const [key, other] of siblings ?? []) {
    if (key === poolKey || other?.status !== "used" || !isPaymentTwin(record, other)) continue;
    const slip = other.used?.sale?.receiptNumber ? ` on slip ${other.used.sale.receiptNumber}` : "";
    // ONE sentence and one code whichever side was typed by hand: the till
    // shows the message, and a cashier must not learn that from it (Junid,
    // 20 Oct 2026). `side` is for the server's own log line only.
    return {
      ok: false, code: "twin-used",
      side: isManualEntry(record) ? "bank-twin-used" : "manual-twin-used",
      message: `This payment was already used${slip}. It cannot be used again. If the customer really paid twice, ask Junid.`,
    };
  }
  return { ok: true };
}

module.exports = {
  MANUAL_READER, MANUAL_ENTRY_BY, MANUAL_LOG_PATH,
  MANUAL_REFERENCE_MAX, MANUAL_REFERENCE_MIN_CHARS, MANUAL_AMOUNT_MIN_CENTS, MANUAL_AMOUNT_MAX_CENTS, MANUAL_NOTE_MAX,
  manualEntryKeyOf, manualEntryInputCheck, manualEntryRecord, isManualEntry, manualDuplicateOf,
  manualDoubleSubmitOf, MANUAL_DOUBLE_SUBMIT_MS,
  bankTwinOfEntry, manualTwinSettleCheck, isPaymentTwin,
};

// ─── THE LOG — how often the hatch is used, and where each entry went ───────
// /eft_manual_entries/{logKey}: one record per manual entry, written when
// Junid enters it and UPDATED as the pool record moves (settle, attach,
// release, markUsed, reverse) — so one list answers "how many did I type this
// week, and were they all spent?" without walking the pool. The log key is
// the entry's server moment (zero-padded epoch ms) + the pool key, so
// orderByKey() lists newest-last with NO index (no rule change needed) and
// the settle can address the row from the pool record alone.
const MANUAL_LIST_LIMIT = 60;

function manualLogKeyOf(at, poolKey) {
  return `${String(at).padStart(13, "0")}_${poolKey}`;
}

/** The row written at entry time. */
function manualLogRecord(record, key) {
  const m = record.manualEntry ?? {};
  return {
    key,
    entryId: m.entryId ?? null,
    at: m.at ?? record.at ?? null,
    by: m.by ?? MANUAL_ENTRY_BY,
    uid: m.uid ?? null,
    email: m.email ?? null,
    reference: record.reference ?? null,
    amountCents: Number.isInteger(record.amountCents) ? record.amountCents : null,
    note: m.note ?? null,
    status: "unmatched",
  };
}

/**
 * What a lifecycle event changes on the row. `record` is the pool record as
 * COMMITTED by that event's transaction (decision.value); the patch is an
 * update(), so earlier fields stay.
 *   settle   used — who consumed it, where, for whom, how much
 *   attach   the sale's identity lands
 *   release  the sale failed — back to waiting
 *   markUsed settled by hand outside the POS
 *   reverse  the owner unwound it — back to waiting, count kept
 * @returns {object|null} null when the record is not a manual entry
 */
function manualLogEventPatch(event, record, now) {
  if (!isManualEntry(record)) return null;
  const u = record.used ?? {};
  switch (event) {
    case "settle":
      return {
        status: "used", usedAt: Number.isInteger(u.at) ? u.at : now,
        cashierUid: u.cashierUid ?? null, cashierName: u.cashierName ?? null,
        storeId: u.storeId ?? null, tillId: u.tillId ?? null,
        customerId: u.customerId ?? null, customerName: u.customerName ?? null,
        appliedCents: Number.isInteger(u.appliedCents) ? u.appliedCents : null,
        saleId: null, receiptNumber: null,
      };
    case "attach":
      return { saleId: u.sale?.saleId ?? null, receiptNumber: u.sale?.receiptNumber ?? null, attachedAt: now };
    case "release":
      return { status: "unmatched", releasedAt: now, saleId: null, receiptNumber: null };
    case "markUsed":
      return {
        status: "used-outside-pos", usedAt: Number.isInteger(u.at) ? u.at : now,
        cashierUid: u.cashierUid ?? null, cashierName: u.cashierName ?? null,
        reason: u.outsidePos?.reason ?? null, storeId: null, tillId: null, saleId: null, receiptNumber: null,
      };
    case "reverse":
      return {
        status: "unmatched", reversedAt: now,
        reversals: record.reversals && typeof record.reversals === "object" ? Object.keys(record.reversals).length : 1,
      };
    default:
      return null;
  }
}

/** The owner's review list: newest first, with counts for the window. */
function manualLogView(node) {
  const rows = Object.entries(node ?? {})
    .map(([logKey, r]) => ({ logKey, ...r }))
    .filter((r) => r && typeof r === "object" && Number.isInteger(r.amountCents))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const counts = { entered: rows.length, used: 0, waiting: 0, outsidePos: 0 };
  for (const r of rows) {
    if (r.status === "used") counts.used++;
    else if (r.status === "used-outside-pos") counts.outsidePos++;
    else counts.waiting++;
  }
  return { entries: rows, counts, limit: MANUAL_LIST_LIMIT };
}

Object.assign(module.exports, {
  MANUAL_LIST_LIMIT, manualLogKeyOf, manualLogRecord, manualLogEventPatch, manualLogView,
});
