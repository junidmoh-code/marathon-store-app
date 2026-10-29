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
// A PHOTO OF THE PROOF (Junid, 29 Oct 2026). A phone screenshot has no text
// to parse, and it is NOT read by OCR: Junid KEYS the identity from it —
// bank, amount, payment date, reference, and the bank's transaction id when
// the proof shows one (Absa's synthetic identity also needs the payer, as
// the notice prints it). keyedIdentityCheck turns those fields into the very
// parse a reader would have produced, so proofIdentityOf builds the SAME
// fingerprint the poller will build from the bank's notification, and
// everything after that — destination, claim, record, log — is the PDF's
// path unchanged. The image itself is kept as the evidence (Cloud Storage,
// eftProofs/{approval key}/…, written by the callable with the Admin SDK).
//
// PURE here: no IO, no clock, no PDF engine. The callable (eftPool/eftPool.js)
// extracts the PDF's lines with cardRecon/pdfText.js — the same extraction,
// the same "bucket" grouping the poller uses for EFT PDFs — and hands them in.
"use strict";

const { createHash } = require("node:crypto");
const { clip, redactAccountDigits, parseBankTimestamp, sastDate } = require("./eft-text.cjs");
const { paymentFingerprint, syntheticIdentityOf } = require("./eft-fingerprint.cjs");
const { EFT_READERS } = require("./eft-banks.cjs");
const { markUsedOutsidePosDecision } = require("./eft-settle.cjs");

const MANUAL_APPROVED_BY = "Junid";
const MANUAL_APPROVED_LOG_PATH = "eft_manual_approvals";
const MANUAL_APPROVED_LIST_LIMIT = 60;
const MANUAL_APPROVED_REASON = "Approved by hand from the uploaded proof of payment";
// A proof of payment is a one-page bank PDF — tens of kilobytes. Five
// megabytes is far above any real one and far below the callable's own limit.
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
// A phone photo is bigger than a bank PDF; 7 MB of image is ~9.4 MB of
// base64, inside the callable's 10 MB request limit.
const PROOF_IMAGE_MAX_BYTES = 7 * 1024 * 1024;
const PROOF_STORAGE_PREFIX = "eftProofs";
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

// The image formats a phone hands over, told apart by their magic bytes —
// never by the client's say-so.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
function imageKindOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", contentType: "image/png" };
  if (buf.subarray(4, 8).toString("latin1") === "ftyp" && HEIF_BRANDS.has(buf.subarray(8, 12).toString("latin1"))) return { ext: "heic", contentType: "image/heic" };
  return null;
}

function decodeBase64(raw, maxBytes) {
  const b64 = typeof raw === "string" ? raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
  if (!b64) return { ok: false, empty: true };
  // 4/3 expansion: the base64 text may not describe more than maxBytes.
  if (b64.length > Math.ceil(maxBytes / 3) * 4) return { ok: false, tooBig: true };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, bad: true };
  return { ok: true, buf: Buffer.from(b64, "base64") };
}

/**
 * Validate what the phone sent. Returns the cleaned fields — the PDF (or the
 * image) as a Buffer — or a refusal. kind "pdf" | "image".
 */
function approvedInputCheck(data) {
  const d = data && typeof data === "object" ? data : {};
  const entryId = typeof d.entryId === "string" ? d.entryId : "";
  if (!ENTRY_ID.test(entryId)) return { ok: false, code: "bad-entry-id", message: "The upload carries no id — reload and try again." };
  const filename = clip(typeof d.filename === "string" ? d.filename.replace(/[\r\n\t]/g, " ") : "", PROOF_FILENAME_MAX);
  const note = d.note == null ? null : clip(String(d.note), PROOF_NOTE_MAX);
  const hasPdf = typeof d.pdfBase64 === "string" && d.pdfBase64.trim() !== "";
  const hasImage = typeof d.imageBase64 === "string" && d.imageBase64.trim() !== "";
  if (hasPdf && hasImage) return { ok: false, code: "two-proofs", message: "Send the PDF or the photo, not both." };
  if (hasImage) {
    const img = decodeBase64(d.imageBase64, PROOF_IMAGE_MAX_BYTES);
    if (img.tooBig) return { ok: false, code: "proof-too-big", message: "That photo is bigger than 7 MB — send a screenshot, or a smaller photo." };
    if (!img.ok) return { ok: false, code: "bad-proof", message: "The proof did not upload cleanly — try again." };
    const type = imageKindOf(img.buf);
    if (!type) return { ok: false, code: "not-an-image", message: "That file is not a JPEG, PNG or HEIC photo. Upload the screenshot or photo of the proof, or the bank's PDF." };
    return { ok: true, kind: "image", entryId, image: img.buf, imageType: type, filename, note };
  }
  const dec = decodeBase64(d.pdfBase64, PROOF_MAX_BYTES);
  if (dec.empty) return { ok: false, code: "no-proof", message: "Attach the proof of payment PDF." };
  if (dec.tooBig) return { ok: false, code: "proof-too-big", message: "That PDF is bigger than 5 MB — a proof of payment is a one-page bank document." };
  if (!dec.ok) return { ok: false, code: "bad-proof", message: "The proof did not upload cleanly — try again." };
  const pdf = dec.buf;
  if (pdf.length < 8 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, code: "not-a-pdf", message: "That file is not a PDF. Upload the bank's proof of payment PDF — or send a screenshot as a photo, with its details typed in." };
  }
  return { ok: true, kind: "pdf", entryId, pdf, filename, note };
}

// ─── THE KEYED IDENTITY OF A PHOTO ───────────────────────────────────────────
const KEYED_AMOUNT_MAX_CENTS = 100_000_000; // R1,000,000 — no shop EFT comes near it
const KEYED_REFERENCE_MAX = 80;
const KEYED_PAYER_MAX = 60;
const KEYED_BANK_REF_MAX = 60;
const KEYED_MAX_AGE_DAYS = 366;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BANK_NAMES = { standardbank: "Standard Bank", fnb: "FNB", capitec: "Capitec", absa: "Absa", nedbank: "Nedbank" };
const KEYED_READER_IDS = EFT_READERS.map((r) => r.id);

/** The shop's account the photo's money went into: the one ending with the
 *  typed digits, or — none typed — the first configured (Marathon's). */
function keyedDestinationOf(accountTail, allowedAccounts) {
  const accounts = Array.isArray(allowedAccounts) ? allowedAccounts : [];
  if (accountTail == null || accountTail === "") {
    return accounts.length ? { ok: true, accountMask: accounts[0] } : { ok: true, accountMask: null };
  }
  const digits = String(accountTail).replace(/[\s-]/g, "");
  if (!/^\d{4,20}$/.test(digits)) return { ok: false, code: "bad-account", message: "The destination account must be digits (at least the last four) — or leave it empty for the shop's own account." };
  const hit = accounts.find((a) => a.endsWith(digits));
  if (!hit) return { ok: false, code: "wrong-destination", message: `This payment credits an account ending ${digits.slice(-4)}, which is not the shop's own account.` };
  return { ok: true, accountMask: hit };
}

/**
 * The fields Junid keyed from a photo, turned into the parse the bank's
 * reader would have produced — so proofIdentityOf builds the same identity.
 *   bank         one of the reader ids (standardbank, fnb, capitec, absa, nedbank)
 *   amountCents  positive integer
 *   paymentDate  "YYYY-MM-DD", the bank's payment day (SAST), not in the future
 *   reference    the payer's reference, as the proof prints it
 *   bankRef      the bank's transaction id — REQUIRED except on Absa
 *   payer        as printed — REQUIRED on Absa without a transaction id
 *   accountTail  optional: the destination account digits (default the shop's)
 * @returns {{ok:true, readerId, parse, lines}|{ok:false, code, message}}
 */
function keyedIdentityCheck(data, { allowedAccounts = [], now } = {}) {
  const d = data && typeof data === "object" ? data : {};
  const bank = typeof d.bank === "string" ? d.bank.trim().toLowerCase() : "";
  if (!KEYED_READER_IDS.includes(bank)) {
    return { ok: false, code: "bad-bank", message: `Choose the bank that sent the payment (${KEYED_READER_IDS.join(", ")}).` };
  }
  const amountCents = d.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > KEYED_AMOUNT_MAX_CENTS) {
    return { ok: false, code: "bad-amount", message: "Type the amount the proof shows, in cents (more than zero)." };
  }
  const date = typeof d.paymentDate === "string" ? d.paymentDate.trim() : "";
  const bankTs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseBankTimestamp(date) : null;
  if (!Number.isInteger(bankTs)) return { ok: false, code: "bad-date", message: "Type the payment date the proof shows, as YYYY-MM-DD." };
  if (Number.isInteger(now)) {
    if (date > sastDate(now)) return { ok: false, code: "bad-date", message: "The payment date is in the future — check the date on the proof." };
    if (now - bankTs > KEYED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return { ok: false, code: "bad-date", message: "The payment date is more than a year ago — check the date on the proof." };
  }
  const reference = typeof d.reference === "string" ? d.reference.trim() : "";
  if (!reference || reference.length > KEYED_REFERENCE_MAX || CONTROL_CHARS.test(reference) || !/[A-Za-z0-9]/.test(reference)) {
    return { ok: false, code: "bad-reference", message: `Type the reference the proof shows (up to ${KEYED_REFERENCE_MAX} characters).` };
  }
  const payerRaw = d.payer == null ? "" : typeof d.payer === "string" ? d.payer.trim() : null;
  if (payerRaw === null || payerRaw.length > KEYED_PAYER_MAX || CONTROL_CHARS.test(payerRaw) || (payerRaw && !/[A-Za-z]/.test(payerRaw))) {
    return { ok: false, code: "bad-payer", message: `The payer must be the name the proof shows (up to ${KEYED_PAYER_MAX} characters).` };
  }
  const refRaw = d.bankRef == null ? "" : typeof d.bankRef === "string" ? d.bankRef.trim() : null;
  if (refRaw === null || refRaw.length > KEYED_BANK_REF_MAX || CONTROL_CHARS.test(refRaw) || (refRaw && refRaw.replace(/[^A-Za-z0-9]/g, "").length < 4)) {
    return { ok: false, code: "bad-bank-ref", message: "The bank's transaction id must be the number the proof shows (at least four letters or digits)." };
  }
  if (!refRaw && bank !== "absa") {
    return { ok: false, code: "bank-ref-required", message: `A ${BANK_NAMES[bank]} payment is identified by its transaction id — type the reference / trace number the proof shows. Without it, float it by hand as before.` };
  }
  if (!refRaw && !payerRaw) {
    return { ok: false, code: "payer-required", message: "An Absa proof with no transaction number is identified by the payer, amount, date and reference — type the payer's name as the proof shows it." };
  }
  const dest = keyedDestinationOf(d.accountTail, allowedAccounts);
  if (!dest.ok) return dest;
  const parse = {
    ok: true, amountCents, reference, payer: payerRaw || null, bankTs, bankRef: refRaw || null,
    accountMask: dest.accountMask, destBankName: "FIRST NATIONAL BANK", beneficiaryName: null,
  };
  const lines = [
    `Keyed by hand by ${MANUAL_APPROVED_BY} from a photo of the proof of payment (not read by machine).`,
    `Bank: ${BANK_NAMES[bank]}`,
    `Amount: R${(amountCents / 100).toFixed(2)}`,
    `Payment date: ${date}`,
    `Reference: ${reference}`,
    ...(payerRaw ? [`Payer: ${payerRaw}`] : []),
    ...(refRaw ? [`Transaction id: ${refRaw}`] : []),
  ];
  return { ok: true, readerId: bank, parse, lines };
}

/** Where the photo is kept: one folder per approval, one file per upload. */
function proofStoragePathOf(approvedKey, entryId, ext) {
  return `${PROOF_STORAGE_PREFIX}/${approvedKey}/${entryId}.${ext}`;
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
function manualApprovedRecord({ key, readerId, parse, lines, identity, destination, actor, at, note, filename, entryId, proof = null }) {
  const text = Array.isArray(lines) ? lines.join("\n") : "";
  const photo = proof && proof.kind === "image";
  const unmatched = {
    at,
    receivedAt: at,
    bankTs: Number.isInteger(parse.bankTs) ? parse.bankTs : null,
    messageId: `manual-approved:${entryId}`,
    from: actor?.email ?? null,
    subject: photo
      ? `Photo of a proof of payment (${readerId}) keyed and approved by hand by ${MANUAL_APPROVED_BY}`
      : `Proof of payment (${readerId}) approved by hand by ${MANUAL_APPROVED_BY}`,
    auth: {
      verdict: "manual-approved", fromDomain: null, dkimDomain: null,
      detail: photo
        ? `Photo of a proof of payment uploaded by ${MANUAL_APPROVED_BY}; its identity was typed by hand from the photo — no bank notification was read and nothing was authenticated.`
        : `Proof of payment uploaded by ${MANUAL_APPROVED_BY} and approved by hand — no bank notification was read and nothing was authenticated.`,
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
      ...(photo ? { keyedByHand: true, proof: { kind: "image", path: proof.path, contentType: proof.contentType, bytes: proof.bytes, sha256: proof.sha256 } } : {}),
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
// A claim younger than this with NO pool record behind it is the poller
// mid-write (it claims first, writes the record after): not a stale refusal
// to stamp over, but a live bank record about to land. Try again later.
const CLAIM_SETTLING_MS = 5 * 60 * 1000;

function approvedClaimDecision({ approvedKey, claim, holderRecord, now = null }) {
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
  if ((r === null || r === undefined) && Number.isInteger(now) && Number.isInteger(claim.at) && now - claim.at < CLAIM_SETTLING_MS) {
    return { action: "refuse", code: "claim-settling", key: claim.poolKey, message: "The bank's notification for this payment is being recorded right now — wait a minute and try again, or use it at the till once it shows." };
  }
  return { action: "spend", holder: claim.poolKey };
}

/**
 * SETTLE-TIME: the record about to be spent is the bank's record of money
 * Junid approved from its proof — matched NOT by identity (the proof and the
 * emailed notice can be different documents: one may print the transaction
 * number the other leaves blank, or format the payer differently, so their
 * fingerprints can differ) but the way the manual twin is matched: same
 * amount, same normalised reference, and the bank dates it on or after the
 * day of the approval's own bank date (a payment from last week with the
 * same reference and amount is a different payment). Refused: the money was
 * settled under the approval. One sentence, no provenance, for the till
 * (Junid, 20 Oct 2026).
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
const normaliseRef = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const DAY_MS = 24 * 60 * 60 * 1000;
function approvedTwinSettleCheck({ poolKey, record, siblings }) {
  if (!record || record.outcome !== "recorded" || isManualApproved(record)) return { ok: true };
  const ref = normaliseRef(record.reference);
  if (!ref) return { ok: true };
  const paidAt = Number.isInteger(record.bankTs) ? record.bankTs : Number.isInteger(record.receivedAt) ? record.receivedAt : record.at;
  for (const [key, other] of siblings ?? []) {
    if (key === poolKey || !isManualApproved(other)) continue;
    if (other.amountCents !== record.amountCents || normaliseRef(other.reference) !== ref) continue;
    const approvedPaidAt = Number.isInteger(other.bankTs) ? other.bankTs : other.manualApproved.at;
    if (Number.isInteger(paidAt) && Number.isInteger(approvedPaidAt) && paidAt < approvedPaidAt - DAY_MS) continue;
    return {
      ok: false, code: "twin-used",
      message: "This payment — the same reference and amount — was already used. It cannot be used again. If the customer really paid twice, ask Junid.",
    };
  }
  return { ok: true };
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
    ...(m.proof ? { keyedByHand: true, proofKind: m.proof.kind ?? null, proofPath: m.proof.path ?? null } : {}),
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
    ...(record.manualApproved?.proof ? { keyedByHand: true, proofPath: record.manualApproved.proof.path ?? null } : {}),
  };
}

module.exports = {
  MANUAL_APPROVED_BY, MANUAL_APPROVED_LOG_PATH, MANUAL_APPROVED_LIST_LIMIT, MANUAL_APPROVED_REASON,
  PROOF_MAX_BYTES, PROOF_IMAGE_MAX_BYTES, PROOF_NOTE_MAX, PROOF_STORAGE_PREFIX,
  approvedKeyOf, approvedInputCheck, imageKindOf, keyedIdentityCheck, keyedDestinationOf, proofStoragePathOf, proofIdentityOf, manualApprovedRecord, isManualApproved,
  approvedClaimDecision, approvedClaimStep, approvedTwinSettleCheck, CLAIM_SETTLING_MS,
  approvedLogKeyOf, approvedLogRecord, approvedListView, approvedResponse,
};
