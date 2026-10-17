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
// WHAT MAKES IT DIFFERENT, AND VISIBLY SO:
//   · reader "manual", `manualEntry: { by: "Junid", uid, email, at, note,
//     entryId }` on the record. publicEftView carries `manualEntry` to the
//     till, and the till and the owner's tab print "MANUALLY ENTERED BY
//     JUNID" on it — it is never mistaken for a bank-confirmed payment.
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
  const reference = String(d.reference ?? "").trim().replace(/\s+/g, " ").slice(0, MANUAL_REFERENCE_MAX);
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

module.exports = {
  MANUAL_READER, MANUAL_ENTRY_BY, MANUAL_LOG_PATH,
  MANUAL_REFERENCE_MAX, MANUAL_REFERENCE_MIN_CHARS, MANUAL_AMOUNT_MIN_CENTS, MANUAL_AMOUNT_MAX_CENTS, MANUAL_NOTE_MAX,
  manualEntryKeyOf, manualEntryInputCheck, manualEntryRecord, isManualEntry, manualDuplicateOf,
};
