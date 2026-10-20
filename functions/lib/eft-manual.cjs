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
//     on the same key and the create-if-absent write makes it idempotent;
//     and a second entry with the SAME reference AND amount while one is
//     already in the pool tail is refused — a double-entered payment would
//     be two spendable records for one sum of money.
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

/**
 * A second entry for money already entered: the same normalised reference
 * AND the same amount on a manual record in the tail (any status — a used
 * one has been spent, an unmatched one is waiting). The same entryId is the
 * idempotent retry, not a duplicate.
 * @returns {{key:string, record:object}|null}
 */
function manualDuplicateOf({ reference, amountCents, entryId }, siblings) {
  const want = normaliseText(reference);
  for (const [key, rec] of siblings ?? []) {
    if (!isManualEntry(rec)) continue;
    if (rec.manualEntry.entryId === entryId) continue;
    if (rec.amountCents === amountCents && normaliseText(rec.reference) === want) return { key, record: rec };
  }
  return null;
}

/**
 * THE BANK'S OWN RECORD OF THE SAME MONEY. A manual entry exists because the
 * notification has not arrived — if an UNMATCHED bank-confirmed payment with
 * this reference and amount is already in the tail, Junid should use that
 * one, not type a second spendable copy. (Spec review, this PR.)
 * @returns {{key:string, record:object}|null}
 */
function bankTwinOfEntry({ reference, amountCents }, siblings) {
  const want = normaliseText(reference);
  for (const [key, rec] of siblings ?? []) {
    if (!rec || rec.outcome !== "recorded" || isManualEntry(rec) || rec.status !== "unmatched") continue;
    if (rec.amountCents === amountCents && normaliseText(rec.reference) === want) return { key, record: rec };
  }
  return null;
}

/**
 * Two pool records that are ONE payment: a manual entry and the bank's own
 * notification of it — same normalised reference, same amount, and the bank
 * record ARRIVED AT OR AFTER the entry was typed (a bank payment from last
 * week with the same reference and amount is a different payment, not a
 * twin). Either side may be `record`. Pure.
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
  const arrived = Number.isInteger(bank.bankTs) ? bank.bankTs : Number.isInteger(bank.receivedAt) ? bank.receivedAt : bank.at;
  return typedAt === null || !Number.isInteger(arrived) || arrived >= typedAt;
}

/**
 * SETTLE-TIME, BOTH DIRECTIONS: the record about to be spent has a twin that
 * was already USED — a bank record whose manual twin was spent, or a manual
 * entry whose bank notification arrived and was spent. The two carry
 * different fingerprints, so the fingerprint check cannot see they are one
 * payment; this can. Refused — the money was paid out once already; Junid
 * reverses one of them if they really are two.
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function manualTwinSettleCheck({ poolKey, record, siblings }) {
  if (!record || record.outcome !== "recorded") return { ok: true };
  for (const [key, other] of siblings ?? []) {
    if (key === poolKey || other?.status !== "used" || !isPaymentTwin(record, other)) continue;
    const slip = other.used?.sale?.receiptNumber ? ` on slip ${other.used.sale.receiptNumber}` : "";
    // ONE sentence and one code whichever side was typed by hand: the till
    // shows the message, and a cashier must not learn that from it (Junid,
    // 20 Oct 2026). `side` is for the server's own log line only.
    return {
      ok: false, code: "twin-used",
      side: isManualEntry(record) ? "bank-twin-used" : "manual-twin-used",
      message: `This payment — the same reference and amount — was already used${slip}. It cannot be used again. If the customer really paid twice, ask Junid.`,
    };
  }
  return { ok: true };
}

module.exports = {
  MANUAL_READER, MANUAL_ENTRY_BY, MANUAL_LOG_PATH,
  MANUAL_REFERENCE_MAX, MANUAL_REFERENCE_MIN_CHARS, MANUAL_AMOUNT_MIN_CENTS, MANUAL_AMOUNT_MAX_CENTS, MANUAL_NOTE_MAX,
  manualEntryKeyOf, manualEntryInputCheck, manualEntryRecord, isManualEntry, manualDuplicateOf,
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
