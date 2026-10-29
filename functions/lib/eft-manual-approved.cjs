// ─── MANUALLY APPROVED PAYMENTS — Junid's proof-of-payment ledger ───────────
// Junid, 29 Oct 2026. A customer shows the shop a proof of payment on their
// phone before the bank's notification has reached the mailbox — or the bank
// never sends one. Junid floats the money by hand today (eftPoolManualEntry:
// a typed reference and amount, instant, NO proof required — that path is
// untouched by this module and must stay so). What was missing is the other
// half: when the bank's notification for that money DOES arrive, the pool
// had no way to know it was already settled, and floated it again.
//
// So the phone (marathon-pos-app) can also UPLOAD the proof, and
// eftPoolManualApprove — Junid alone, server-enforced — reads it with the
// very reader the poller would have used (functions/lib/eft-banks.cjs,
// selected by content: there is no sending domain and no DKIM; Junid is
// vouching for the document), takes its IDENTITY — the bank's transaction
// id, or Absa's synthetic identity when the notice prints none — and
// registers it as APPROVED BY HAND:
//
//   · one pool record per identity, keyed by the identity (approvedKeyOf),
//     outcome "recorded", status "used", used.outsidePos naming Junid — the
//     shape the owner's mark-as-used already writes, so every list, view and
//     reversal that understands a used payment understands this one;
//   · its fingerprint claim names the approval as holder AND spender, flagged
//     manualApproved. The bank's notification, arriving later, claims the
//     same fingerprint, finds it taken, and is filed held-duplicate naming the
//     approval (eftCore applyFingerprintHold) — never a spendable record. The
//     settle's claimHolderCheck refuses it too (duplicate-used). Two doors,
//     both shut;
//   · nothing is floated. Registration never creates spendable money: Junid
//     floats by hand as before, or the till uses the bank's record if it
//     arrived first. The approval is a LEDGER entry, optional and separate.
//
// WHAT A PROOF MAY NOT DO: if the bank's own notification is already in the
// pool unused, the proof is refused with the record's key ("use that one");
// if the money was already used, refused as already-used. An identity another
// REFUSED record holds (not immediate, stale, wrong account) is stamped spent
// by the approval — the refusal stays refused, the id is now spent.
//
// PURE here: no IO, no clock, no PDF engine. The callable (eftPool/eftPool.js)
// extracts the PDF's lines with cardRecon/pdfText.js — the same extraction,
// the same "bucket" grouping the poller uses for EFT PDFs — and hands them in.
"use strict";

const { createHash } = require("node:crypto");
const { clip, redactAccountDigits } = require("./eft-text.cjs");
const { paymentFingerprint, syntheticIdentityOf } = require("./eft-fingerprint.cjs");
const { markUsedOutsidePosDecision } = require("./eft-settle.cjs");

const MANUAL_APPROVED_BY = "Junid";
const MANUAL_APPROVED_LOG_PATH = "eft_manual_approvals";
const MANUAL_APPROVED_LIST_LIMIT = 60;
const MANUAL_APPROVED_REASON = "Approved by hand from the uploaded proof of payment";
// A proof of payment is a one-page bank PDF — tens of kilobytes. Five
// megabytes is far above any real one and far below the callable's own limit.
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const PROOF_NOTE_MAX = 200;
const PROOF_FILENAME_MAX = 120;
// The client's idempotency token — minted once per upload (same shape as the
// manual entry's).
const ENTRY_ID = /^[A-Za-z0-9_-]{8,60}$/;

/** The pool key of the approval for one identity: 40 hex chars like every
 *  pool key, and the SAME key for the same identity — one approval per
 *  payment, a retried upload the same record. */
function approvedKeyOf(fingerprint) {
  return createHash("sha256").update(`eftapproved1|${fingerprint}`).digest("hex").slice(0, 40);
}

/**
 * Validate what the phone sent. Returns the cleaned fields — the PDF as a
 * Buffer — or a refusal.
 */
function approvedInputCheck(data) {
  const d = data && typeof data === "object" ? data : {};
  const entryId = typeof d.entryId === "string" ? d.entryId : "";
  if (!ENTRY_ID.test(entryId)) return { ok: false, code: "bad-entry-id", message: "The upload carries no id — reload and try again." };
  const b64 = typeof d.pdfBase64 === "string" ? d.pdfBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
  if (!b64) return { ok: false, code: "no-proof", message: "Attach the proof of payment PDF." };
  // 4/3 expansion: the base64 text may not describe more than PROOF_MAX_BYTES.
  if (b64.length > Math.ceil(PROOF_MAX_BYTES / 3) * 4) return { ok: false, code: "proof-too-big", message: "That PDF is bigger than 5 MB — a proof of payment is a one-page bank document." };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, code: "bad-proof", message: "The proof did not upload cleanly — try again." };
  const pdf = Buffer.from(b64, "base64");
  if (pdf.length < 8 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, code: "not-a-pdf", message: "That file is not a PDF. Upload the bank's proof of payment PDF (a screenshot cannot be read)." };
  }
  const filename = clip(typeof d.filename === "string" ? d.filename.replace(/[\r\n\t]/g, " ") : "", PROOF_FILENAME_MAX);
  const note = d.note == null ? null : clip(String(d.note), PROOF_NOTE_MAX);
  return { ok: true, entryId, pdf, filename, note };
}

/**
 * The identity of a parsed proof: the bank's id, or Absa's synthetic one.
 * @returns {{ok:true, fingerprint, bankRef, syntheticRef, synthetic:boolean}
 *          |{ok:false, code, message}}
 */
function proofIdentityOf(parse, readerId) {
  if (!parse?.ok) return { ok: false, code: "unreadable-proof", message: `This ${readerId} proof could not be read exactly: ${clip(redactAccountDigits(parse?.reason ?? ""), 300) ?? "no reason"}` };
  const syntheticRef = syntheticIdentityOf(parse, readerId);
  const fingerprint = paymentFingerprint({ reader: readerId, bankRef: parse.bankRef, syntheticRef });
  if (!fingerprint) {
    return { ok: false, code: "no-identity", message: `This ${readerId} proof prints no bank transaction id and nothing else that identifies the payment, so it cannot be registered. Float it by hand as before.` };
  }
  const bankRef = clip(parse.bankRef, 60) || null;
  return { ok: true, fingerprint, bankRef, syntheticRef: bankRef ? null : syntheticRef, synthetic: !bankRef };
}

/**
 * The pool record of an approval: a recorded payment in the poller's own
 * shape (so nothing downstream needs a special case), then USED by Junid
 * outside the POS through the existing mark-as-used decision — the same
 * `used.outsidePos` the owner's panel already renders. auth.verdict is
 * "manual-approved": nothing was authenticated, and the record says so.
 * @returns {{ok:true, value:object}|{ok:false, code, message}}
 */
function manualApprovedRecord({ key, readerId, parse, lines, identity, destination, actor, at, note, filename, entryId }) {
  const text = Array.isArray(lines) ? lines.join("\n") : "";
  const unmatched = {
    at,
    receivedAt: at,
    bankTs: Number.isInteger(parse.bankTs) ? parse.bankTs : null,
    messageId: `manual-approved:${entryId}`,
    from: actor?.email ?? null,
    subject: `Proof of payment (${readerId}) approved by hand by ${MANUAL_APPROVED_BY}`,
    auth: {
      verdict: "manual-approved", fromDomain: null, dkimDomain: null,
      detail: `Proof of payment uploaded by ${MANUAL_APPROVED_BY} and approved by hand — no bank notification was read and nothing was authenticated.`,
    },
    rawText: clip(redactAccountDigits(text), 4000),
    reader: readerId,
    outcome: "recorded",
    status: "unmatched",
    amountCents: parse.amountCents,
    reference: parse.reference ?? null,
    payer: parse.payer ?? null,
    bankRef: identity.bankRef,
    syntheticRef: identity.syntheticRef,
    fingerprint: identity.fingerprint,
    destination: destination ?? null,
    accountTail: destination?.accountTail ?? null,
    manualApproved: {
      by: MANUAL_APPROVED_BY,
      uid: actor?.uid ?? null,
      email: actor?.email ?? null,
      at,
      note: note ?? null,
      filename: filename ?? null,
      entryId,
    },
  };
  const used = markUsedOutsidePosDecision(unmatched, { at, actorUid: actor?.uid, actorName: MANUAL_APPROVED_BY, reason: MANUAL_APPROVED_REASON });
  if (!used.ok) return used;
  return { ok: true, value: { ...used.value, approvedKey: key } };
}

/** Is this pool record one Junid approved from an uploaded proof? */
function isManualApproved(record) {
  return !!(record && typeof record === "object" && record.manualApproved && typeof record.manualApproved === "object" && record.status === "used");
}

/**
 * What the existing claim on this identity means for a new approval.
 *   create   nobody holds it: the approval claims it (holder + spender)
 *   own      the approval already holds it (a retry after a crash)
 *   spend    a REFUSED record (or no record at all) holds it: the approval
 *            stamps itself as spender; the holder stays
 *   refuse   the bank's own record is in the pool unused (use that one), or
 *            the money was already used
 */
function approvedClaimDecision({ approvedKey, claim, holderRecord }) {
  if (!claim || typeof claim !== "object" || typeof claim.poolKey !== "string") {
    return claim == null ? { action: "create" } : { action: "refuse", code: "claim-corrupt", message: "The payment's identity claim could not be read cleanly — not registered. Ask for it to be looked at." };
  }
  if (claim.poolKey === approvedKey || claim.spentBy === approvedKey) return { action: "own" };
  if (typeof claim.spentBy === "string") {
    return { action: "refuse", code: "already-used", key: claim.spentBy, message: "This payment has already been used — its bank transaction id is spent. Nothing to approve." };
  }
  const r = holderRecord;
  if (r && typeof r === "object" && r.outcome === "recorded") {
    if (r.status === "used") {
      return { action: "refuse", code: "already-used", key: claim.poolKey, message: "This payment has already been used at a till (or marked used). Nothing to approve." };
    }
    return {
      action: "refuse", code: "bank-record-waiting", key: claim.poolKey,
      message: "The bank's own notification for this payment is already in the pool, unused — the cashier can use that one at the till, or mark it used. No approval by proof is needed.",
    };
  }
  return { action: "spend", holder: claim.poolKey };
}

/**
 * The transaction body on /eft_pool_fingerprints/{fp} for one approval.
 * `stampOver` is the holder the decision judged (a refused record): only THAT
 * claim is stamped spent, and never one that already names a spender — a
 * claim that changed hands between the read and the write aborts.
 * `capture` receives {holder, spentBy, manualApproved} as fingerprintClaimStep does.
 */
function approvedClaimStep({ approvedKey, at, stampOver = null }, capture = () => {}) {
  return (existing) => {
    if (existing === null || existing === undefined) {
      capture({ holder: approvedKey, spentBy: approvedKey, manualApproved: true });
      return { poolKey: approvedKey, at, spentBy: approvedKey, manualApproved: true };
    }
    if (typeof existing !== "object" || typeof existing.poolKey !== "string") {
      capture({ holder: null, spentBy: null, manualApproved: false, corrupt: true });
      return undefined;
    }
    const spentBy = typeof existing.spentBy === "string" ? existing.spentBy : null;
    if (existing.poolKey === approvedKey || spentBy === approvedKey) {
      capture({ holder: existing.poolKey, spentBy: spentBy ?? existing.poolKey, manualApproved: existing.manualApproved === true });
      return undefined;
    }
    if (!spentBy && stampOver && existing.poolKey === stampOver) {
      capture({ holder: existing.poolKey, spentBy: approvedKey, manualApproved: true });
      return { ...existing, spentBy: approvedKey, manualApproved: true, approvedAt: at };
    }
    capture({ holder: existing.poolKey, spentBy, manualApproved: existing.manualApproved === true });
    return undefined;
  };
}

// ─── THE LOG — every approval, newest last by key, no index needed ───────────
function approvedLogKeyOf(at, poolKey) {
  return `${String(at).padStart(13, "0")}_${poolKey}`;
}

function approvedLogRecord(record, key) {
  const m = record.manualApproved ?? {};
  return {
    key,
    entryId: m.entryId ?? null,
    at: m.at ?? record.at ?? null,
    by: m.by ?? MANUAL_APPROVED_BY,
    uid: m.uid ?? null,
    email: m.email ?? null,
    reader: record.reader ?? null,
    reference: record.reference ?? null,
    payer: record.payer ?? null,
    amountCents: Number.isInteger(record.amountCents) ? record.amountCents : null,
    bankTs: Number.isInteger(record.bankTs) ? record.bankTs : null,
    bankRef: record.bankRef ?? null,
    synthetic: !record.bankRef && !!record.syntheticRef,
    note: m.note ?? null,
    filename: m.filename ?? null,
  };
}

/** The owner's review list: newest first. */
function approvedListView(node) {
  const entries = Object.entries(node ?? {})
    .map(([logKey, r]) => ({ logKey, ...r }))
    .filter((r) => r && typeof r === "object" && Number.isInteger(r.amountCents))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return { entries, count: entries.length, limit: MANUAL_APPROVED_LIST_LIMIT };
}

/** The response the phone shows. */
function approvedResponse(record, { already = false } = {}) {
  return {
    ok: true,
    already,
    key: record.approvedKey,
    reader: record.reader,
    amountCents: record.amountCents,
    reference: record.reference ?? null,
    payer: record.payer ?? null,
    bankTs: record.bankTs ?? null,
    bankRef: record.bankRef ?? null,
    synthetic: !record.bankRef && !!record.syntheticRef,
    at: record.manualApproved?.at ?? record.at,
    by: MANUAL_APPROVED_BY,
    status: record.status,
  };
}

module.exports = {
  MANUAL_APPROVED_BY, MANUAL_APPROVED_LOG_PATH, MANUAL_APPROVED_LIST_LIMIT, MANUAL_APPROVED_REASON,
  PROOF_MAX_BYTES, PROOF_NOTE_MAX,
  approvedKeyOf, approvedInputCheck, proofIdentityOf, manualApprovedRecord, isManualApproved,
  approvedClaimDecision, approvedClaimStep, approvedLogKeyOf, approvedLogRecord, approvedListView, approvedResponse,
};
