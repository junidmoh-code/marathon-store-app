// ─── THE REQUIRED-FIELDS GATE FOR AN UPLOADED PROOF (Junid, 25 Nov 2026) ──────
// An uploaded proof used to be refused for its LAYOUT: no reader's detect()
// matched, and the answer was "not a payment notification this pool has a
// reader for" — true of a Capitec notification Capitec had merely reworded.
// The gate now asks the question that matters: are the fields this purpose
// needs present and valid? It refuses EXACTLY as strictly as before — the same
// fields are required, nothing is inferred — but it says WHICH field could not
// be read, and what it could read, so the refusal is a work order instead of a
// dead end.
//
// WHAT AN APPROVAL NEEDS (unchanged from eftPoolManualApprove before this):
//   · a reader for the issuing bank (layout or strong evidence, eft-banks.cjs)
//   · the reader's exact parse: a positive amount and the destination account
//     (every reader refuses without either)
//   · the payment's identity: the bank's transaction id, or Absa's synthetic
//     identity for a notice that prints none (paymentFingerprint)
// The destination is then checked against the allowlist by the callable, as
// before. The payment date and the immediate flag were never required for an
// approval (nothing floats; Junid attests receipt) and are not now.
//
// PURE: no IO, no clock.
"use strict";

const { createHash } = require("node:crypto");
const { clip, redactAccountDigits } = require("./eft-text.cjs");
const { paymentFingerprint, syntheticIdentityOf } = require("./eft-fingerprint.cjs");
const { banksEvidencedBy } = require("./eft-banks.cjs");
const { fieldsSummary, FIELD_NAMES } = require("./eft-labels.cjs");

const BANK_LABELS = { standardbank: "Standard Bank", fnb: "FNB", capitec: "Capitec", absa: "Absa", nedbank: "Nedbank" };
const LAST_RESORT = "Nothing was registered; it is saved for Junid on the EFT payments tab. Only if the customer cannot wait: float it by hand.";

// Which required field a reader's refusal names. A reader's reason is its own
// sentence ("carries no Amount line", "the destination account cannot be
// checked", "appears 2 times with different values"); this maps it to the
// field, so the staff line is short and the same for every bank.
function fieldOfReason(reason) {
  const r = String(reason ?? "");
  if (/payment blocks|Trace ID lines|more than one payment/i.test(r)) return { field: null, why: "it holds more than one payment" };
  if (/amount/i.test(r)) return { field: FIELD_NAMES.amount, why: /different values|different amount/i.test(r) ? "printed twice with different values" : /parse/i.test(r) ? "not an exact rand amount" : /zero or negative/i.test(r) ? "zero or negative" : "not found" };
  if (/account/i.test(r)) return { field: FIELD_NAMES.account, why: /different values/i.test(r) ? "printed twice with different values" : "not found" };
  const twice = /different values/i.test(r) ? "printed twice with different values" : "not readable";
  if (/transaction id|Notification number|Reference number|Trace ID|Transaction number|SkyQR|Unique Document/i.test(r)) return { field: FIELD_NAMES.txnId, why: twice };
  if (/reference/i.test(r)) return { field: FIELD_NAMES.reference, why: twice };
  return { field: null, why: clip(redactAccountDigits(r), 160) };
}

/**
 * @param {{lines:string[], reader:object|null, parse:object|null}} p
 * @returns {{ok:true, identity:{fingerprint:string, syntheticRef:string|null}}
 *          | {ok:false, code:string, message:string, detectedBank:string|null,
 *             missing:string[], read:string[], detail:string}}
 */
function approvalGate({ lines, reader, parse }) {
  const summary = fieldsSummary(Array.isArray(lines) ? lines : []);
  const evidenced = banksEvidencedBy(Array.isArray(lines) ? lines : []);
  const detectedBank = reader?.id ?? (evidenced.length === 1 ? evidenced[0] : null);
  const bankLabel = detectedBank ? BANK_LABELS[detectedBank] ?? detectedBank : null;
  const fail = (code, missing, sentence, detail) => ({
    ok: false, code, detectedBank, missing, read: summary.read,
    detail: clip(redactAccountDigits(detail ?? sentence), 400),
    message: `${sentence} ${LAST_RESORT}`,
  });

  if (!Array.isArray(lines) || !lines.some((l) => String(l ?? "").trim())) {
    return fail("unreadable-proof", ["all text"], "This PDF has no readable text (it may be a scan or a photo saved as PDF).");
  }
  if (!reader) {
    if (evidenced.length > 1) {
      return fail("no-reader", summary.missing, `This PDF names more than one bank (${evidenced.map((b) => BANK_LABELS[b]).join(", ")}), so it cannot be read safely.`);
    }
    if (bankLabel) {
      return fail("no-reader", summary.missing.length ? summary.missing : ["the payment sentence"],
        `This looks like a ${bankLabel} proof, but it does not say plainly that a payment was made${summary.missing.length ? `, and its ${summary.missing.join(", ")} could not be read` : ""}.`);
    }
    return fail("no-reader", summary.missing.length ? summary.missing : ["the issuing bank"],
      `Could not tell which bank issued this PDF${summary.missing.length ? `, and its ${summary.missing.join(", ")} could not be read` : ""} — it may not be a bank's payment notification.`);
  }
  if (!parse?.ok) {
    const f = fieldOfReason(parse?.reason);
    const missing = f.field ? [f.field] : [];
    const sentence = f.field
      ? `Could not read the ${f.field} on this ${bankLabel} proof (${f.why}).`
      : `Could not read this ${bankLabel} proof: ${f.why}.`;
    return fail("unreadable-proof", missing, sentence, parse?.reason);
  }
  // The identity — exactly what proofIdentityOf requires.
  const syntheticRef = syntheticIdentityOf(parse, reader.id);
  const fingerprint = paymentFingerprint({ reader: reader.id, bankRef: parse.bankRef, syntheticRef });
  if (!fingerprint) {
    return fail("no-identity", [FIELD_NAMES.txnId], `Could not read the ${FIELD_NAMES.txnId} on this ${bankLabel} proof, so it cannot be told apart from another payment.`);
  }
  return { ok: true, identity: { fingerprint, syntheticRef } };
}

// ─── AN UNREAD PROOF GOES TO JUNID, NEVER A SILENT DEAD END ──────────────────
// Every uploaded PDF the gate refuses is filed in the owner-only quarantine
// that already holds the poller's refusals — /eft_pool, outcome
// "refused-parse" — so it shows on Junid's EFT payments tab the same day,
// with what the readers saw (account runs struck out), the bank it could
// still name, and the fields read and missing. The next layout change is
// caught on day one, from the first proof it breaks.
//
// INERT BY CONSTRUCTION: outcome "refused-parse" is not "recorded", so the
// search, the settle, the tail cache and the linked-copy checks all skip it;
// it claims no fingerprint; and eftRetryPlan refuses it (no mailbox claim
// row). One record per FILE (the key is the PDF's own hash): the same proof
// uploaded twice is one record, never a pile.
//
// EXPOSURE: /eft_pool is owner-only (rules) and written only by the Admin
// SDK. The raw text keeps the payer's name as printed (the poller's refusals
// do the same) but every account-number run is struck out
// (redactAccountDigits), and nothing here is returned to the uploader beyond
// the field NAMES.

/** The quarantine key of an unread proof: 40 hex from the file's bytes. */
function unreadProofKeyOf(pdfSha256) {
  return createHash("sha256").update(`eftunread1|${pdfSha256}`).digest("hex").slice(0, 40);
}

/**
 * The /eft_pool refusal record for an uploaded proof the gate refused.
 * @returns {object}
 */
function unreadProofRecord({ gate, lines, readerId = null, at, actor, entryId, filename, pdfSha256, bytes, extractionReason = null }) {
  const by = actor?.name || "Junid";
  const bank = gate.detectedBank ? BANK_LABELS[gate.detectedBank] ?? gate.detectedBank : null;
  const read = gate.read?.length ? gate.read.join(", ") : "nothing";
  const missing = gate.missing?.length ? gate.missing.join(", ") : "—";
  const text = Array.isArray(lines) ? lines.join("\n") : "";
  return {
    at,
    receivedAt: at,
    messageId: `proof-upload:${entryId}`,
    from: actor?.email ?? null,
    subject: clip(`Proof of payment uploaded by ${by} — not read${bank ? ` (${bank})` : ""}`, 200),
    auth: {
      verdict: "manual-upload", fromDomain: null, dkimDomain: null,
      detail: `Uploaded by ${by} through "Upload approved proof". It could not be read, so nothing was registered and nothing floated.`,
    },
    rawText: clip(redactAccountDigits(text || extractionReason || ""), 4000),
    // The reader that claimed it (null when none did — the poller's shape).
    reader: readerId,
    outcome: "refused-parse",
    // The Read / Missing tail always survives: the detail is clipped first.
    reason: clip(redactAccountDigits(`${clip(extractionReason ?? gate.detail, 240)} Read: ${read}. Missing: ${missing}.`), 400),
    unreadProof: {
      source: "upload",
      code: gate.code,
      detectedBank: gate.detectedBank ?? null,
      fieldsRead: gate.read ?? [],
      fieldsMissing: gate.missing ?? [],
      by,
      entryId,
      filename: filename || null,
      sha256: pdfSha256,
      bytes: Number.isInteger(bytes) ? bytes : null,
    },
  };
}

module.exports = { approvalGate, fieldOfReason, unreadProofKeyOf, unreadProofRecord, LAST_RESORT, BANK_LABELS };
