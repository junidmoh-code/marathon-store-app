// ─── cardBatchCapture CALLABLE — the FNB batch slip becomes evidence ─────────
// Managers photograph the terminal's own Batch Report (detail roll + summary);
// this callable OCRs it, refuses anything it could not read soundly, computes
// what the POS tender ledger says the card takings for that till over the
// slip's Opened→Closed window should have been, and records slip + expectation
// + variance append-only at /card_batches. NOBODY TYPES THE CARD TOTAL —
// there is no input for one, here or in the UI.
//
// TWO PHASES, one callable:
//   action:"extract" — photos in, OCR (Gemini 3.6 Flash, structured JSON — the
//     readStyleCodeLabel tier-2 plumbing: same secret, same endpoint shape,
//     key in a header), photos stored immutably, every validation run, a DRAFT
//     parked server-side. The response is the review screen's content. Rejects
//     carry a plain reason: unmapped TID, slip TID ≠ the till the operator
//     picked, duplicate batch number, low confidence, line-count shortfall,
//     TSN gaps. The detail roll is the default ask; summaryOnly is a permitted
//     fallback that FLAGS the record so downstream never implies a line match
//     ran.
//   channel:"email" — the SAME extract, with no picked till. The FNB terminals
//     email their batch report to the shop's mailbox and a poller on the Mac
//     mini (scripts/cardrecon/) feeds each PDF through here unattended. Every
//     refusal above applies unchanged; the ONE thing that cannot is the "slip
//     TID ≠ the till the operator picked" check, because there is no operator
//     and no pick. What replaces it is in lib/card-recon-email.cjs: the slip's
//     TID must resolve in the registry (an unmapped terminal is REFUSED, and
//     the poller records that refusal where it can be seen) and its printed
//     MID must not contradict the one registered for that terminal. The
//     channel is gated on its own permission flag, so nothing that can capture
//     from a phone acquires a path that skips the till pick.
//
//   action:"submit" — draftId in, duplicate re-checked inside a transaction on
//     the exact record key (append-only: the transaction aborts rather than
//     overwrites), expected recomputed, record written, variance out. The
//     review step offers no way to edit a figure; submit takes the draft
//     verbatim.
//
// GATE: the dedicated `card_recon` permission flag (the photo_generation
// pattern — permFlags scalar, fail closed), NOT stockRole. The browser never
// reads POS sales/payments: the expected figure is computed here with the
// Admin SDK and only the computed number travels back.
//
// COST: one Gemini call per extract, token usage logged to /aiAssistant/usage.
//
// DEPLOY BY NAME (functions/ is shared with marathon-pos-app):
//   firebase deploy --only functions:cardBatchCapture

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const {
  CARD_TERMINALS_PATH, CARD_BATCHES_PATH, CARD_BATCH_DRAFTS_PATH, DRAFT_TTL_MS,
  PHOTO_STORAGE_PREFIX,
  parseSlipTimestamp, parseRandsToCents,
  normaliseTid, normaliseBatchNo, resolveBatchWrite, MAX_REVISIONS,
  dedupeLines, validateExtraction, buildBatchRecord,
  chooseCaptureSource, readPdfPayload, formatCents,
} = require("../lib/card-recon.cjs");
const { parseSlipPdf } = require("../lib/card-recon-pdf.cjs");
const { routeEmailSlip, EMAIL_INTAKE_FLAG } = require("../lib/card-recon-email.cjs");
const { pdfToLines } = require("./pdfText.js");
const { computeExpectedCard, cardLegsInWindow } = require("../lib/card-expected.cjs");
const { matchLegs, MATCH_WINDOW_MARGIN_MS } = require("../lib/card-match.cjs");
const { STORAGE_BUCKET } = require("../lib/photo-scope.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Same model tier as readStyleCodeLabel's residual: a till slip is dense,
// low-contrast thermal print and misreading a digit here becomes a recorded
// "variance", so this is not a Flash-Lite job. ONE constant, one-line swap.
const OCR_MODEL = "gemini-3.6-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 120000;

// Published gemini-2.5-flash rates; 3.6-flash had no separate public sheet at
// build time. Order-of-magnitude honest for the usage log, revisit when billed.
const IN_PER_MTOK_USD = 0.30;
const OUT_PER_MTOK_USD = 2.50;

// A batch of 50 transactions is 2-4 detail photos plus the summary. 14 is the
// abuse ceiling, not the expectation. Client downscales to ≤2000px JPEG.
const MAX_PHOTOS = 14;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// A terminal's emailed batch report is tens of kilobytes. 10MB is the abuse
// ceiling, not the expectation, and it sits under the callable's own request
// limit so an oversized file is refused with a sentence rather than failing as
// a transport error the manager cannot read.
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// HOW FAR EITHER SIDE OF A DERIVED WINDOW TO LOOK FOR STRAY LEGS.
// Only reporting, never reconciliation: the expected figure counts nothing
// outside the window itself. A banking report's window is the span of its own
// transactions with no slack at either end, so a till leg written a few seconds
// off the terminal's clock lands outside a window it plainly belongs to. Two
// minutes is wide enough to catch that and far too narrow to reach a
// neighbouring batch (the shortest real gap between batches is a trading day).
const WINDOW_EDGE_MS = 2 * 60 * 1000;

// The reconciliation window either came off the slip or was worked out from the
// transactions; only the second kind has an edge worth reporting.
const edgeMsFor = (extraction) => (
  extraction.windowSource && extraction.windowSource !== "printed" ? WINDOW_EDGE_MS : 0);

const EXTRACTION_PROMPT = [
  "These photographs show ONE printed card-terminal Batch Report from an FNB",
  "(South Africa) payment terminal: a header, a detailed list of transactions,",
  "and totals. Read ONLY what is literally printed. Never invent, infer or",
  "complete a value — an unreadable field is an empty string with confidence 0.",
  "",
  "HEADER fields: MID (merchant ID, long digits), TID (terminal ID, e.g.",
  "0000HP1X), the batch number (printed like 'Batch Report (#494)' — return",
  "the digits), Opened, Closed and Printed timestamps (return exactly as",
  "printed, e.g. '2026/08/26 18:50:04'), the Transactions count, and any",
  "reconciliation line (e.g. '500 - Reconciled, in balance').",
  "",
  "TOTALS: from the Payment Type Summary / TOTALS SUMMARY / CARD TOTALS",
  "blocks read the purchases figure (MasterCard/Visa Purchases), any Cash",
  "figure, the Refunds figure (return its magnitude as printed — do not add a",
  "sign), and the TOTAL. Return amounts exactly as printed, e.g. 'R50,355.00'.",
  "If the same figure prints in more than one block and they disagree, lower",
  "that field's confidence below 0.5.",
  "",
  "TRANSACTIONS: list EVERY transaction line printed across ALL photos — date,",
  "time, UTI, RRN, auth code, TSN (the sequential transaction number), masked",
  "card number, amount (exactly as printed, keep any minus sign), and whether",
  "the line is a purchase or a refund. If two photos overlap and show the same",
  "line, output it once. Never skip a line and never fabricate one; if a line",
  "is partly unreadable, still output it with empty strings for the unreadable",
  "fields.",
  "",
  "Per-field confidence is 0..1: how certain you are the characters were read",
  "exactly as printed.",
].join("\n");

const EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    mid: { type: "STRING" },
    tid: { type: "STRING" },
    batchNo: { type: "STRING" },
    opened: { type: "STRING" },
    closed: { type: "STRING" },
    printed: { type: "STRING" },
    txnCount: { type: "NUMBER" },
    purchases: { type: "STRING" },
    cash: { type: "STRING" },
    refunds: { type: "STRING" },
    total: { type: "STRING" },
    reconLine: { type: "STRING" },
    confidence: {
      type: "OBJECT",
      properties: {
        mid: { type: "NUMBER" }, tid: { type: "NUMBER" }, batchNo: { type: "NUMBER" },
        opened: { type: "NUMBER" }, closed: { type: "NUMBER" }, txnCount: { type: "NUMBER" },
        purchases: { type: "NUMBER" }, refunds: { type: "NUMBER" }, total: { type: "NUMBER" },
      },
    },
    transactions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" }, time: { type: "STRING" },
          uti: { type: "STRING" }, rrn: { type: "STRING" },
          authCode: { type: "STRING" }, tsn: { type: "NUMBER" },
          pan: { type: "STRING" }, amount: { type: "STRING" },
          type: { type: "STRING", enum: ["purchase", "refund"] },
        },
        required: ["tsn", "amount"],
      },
    },
  },
  required: ["tid", "batchNo", "total", "confidence"],
};

// ── GATE — the card_recon permission flag (photo_generation pattern) ─────────
// FAIL CLOSED: an RTDB read error refuses. Reads the SAME scalar the client
// tile gate mirrors (permFlagsFor in src/components/permissionCatalog.js).
const ADMIN_EMAIL = "gunidmoh@gmail.com";
async function assertCardRecon(request) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let granted = false;
  try {
    const snap = await admin.database().ref(`users/${uid}/permFlags/card_recon`).once("value");
    granted = snap.val() === true;
  } catch (err) {
    console.error("assertCardRecon: permission read failed:", err.message);
    throw new HttpsError("unavailable", "Could not check permissions. Try again.");
  }
  if (!granted) throw new HttpsError("permission-denied", "Card recon permission required.");
}

// ── THE EMAIL CHANNEL'S OWN GATE — a SECOND flag, checked the same way ───────
// FAIL CLOSED, like the one above. This is not a convenience: the email channel
// is the one path with no picked till, so it must not be reachable by everyone
// who can capture a slip from a phone. One identity holds it — the poller's —
// and it is data, so revoking it is a rules-free edit rather than a redeploy.
async function assertEmailIntake(request) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return;
  const uid = request.auth?.uid;
  // assertCardRecon has already refused an unauthenticated call, so this cannot
  // be reached without a uid — and it does not depend on that being true, since
  // `users/undefined/permFlags/...` is a path that reads as granted the moment
  // somebody writes it.
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let granted = false;
  try {
    const snap = await admin.database().ref(`users/${uid}/permFlags/${EMAIL_INTAKE_FLAG}`).once("value");
    granted = snap.val() === true;
  } catch (err) {
    console.error("assertEmailIntake: permission read failed:", err.message);
    throw new HttpsError("unavailable", "Could not check permissions. Try again.");
  }
  if (!granted) throw new HttpsError("permission-denied", "This identity may not capture emailed slips.");
}

// What the poller may tell us about where a file came from. Recorded on the
// batch so a figure's provenance is never a guess — and SANITISED here, because
// it is the one part of an emailed capture that is attacker-supplied text (a
// subject line, a sender address) and it lands in an append-only record the
// owner reads. Strings only, bounded, never objects.
const INTAKE_TEXT_MAX = 200;
function readIntake(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s.slice(0, INTAKE_TEXT_MAX) : null;
  };
  const messageId = text(raw.messageId);
  if (!messageId) return null;
  return {
    channel: "email",
    messageId,
    from: text(raw.from),
    subject: text(raw.subject),
    filename: text(raw.filename),
    receivedAt: Number.isInteger(raw.receivedAt) ? raw.receivedAt : null,
  };
}

// ── PHOTO SANITY — the readStyleCodeLabel base64 discipline ──────────────────
function decodePhoto(raw, i) {
  if (!raw || typeof raw.base64 !== "string" || !raw.base64) {
    throw new HttpsError("invalid-argument", `Photo ${i + 1} is missing its image data.`);
  }
  const cleaned = raw.base64.replace(/^data:image\/[a-z+.-]+;base64,/i, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new HttpsError("invalid-argument", `Photo ${i + 1} is not valid base64.`);
  }
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.length) throw new HttpsError("invalid-argument", `Photo ${i + 1} decoded to nothing.`);
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new HttpsError("invalid-argument", `Photo ${i + 1} is too large — retake it.`);
  }
  return { buffer, base64: cleaned };
}

// ── OCR — one structured-JSON Gemini call over every photo ───────────────────
async function runSlipOcr(photos, apiKey) {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    // Key in a HEADER, never the query string — URLs land in logs and traces.
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          ...photos.map((p) => ({ inline_data: { mime_type: "image/jpeg", data: p.base64 } })),
          { text: EXTRACTION_PROMPT },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: EXTRACTION_SCHEMA },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const payload = await res.json();
  const text = ((((payload.candidates || [])[0] || {}).content || {}).parts || [])
    .map((p) => p && p.text).filter(Boolean).join("");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const usage = payload.usageMetadata || {};
  return {
    parsed,
    tokensIn: usage.promptTokenCount || 0,
    tokensOut: usage.candidatesTokenCount || 0,
  };
}

// Model output → the validated, integer-cents extraction the lib understands.
// Every money/time string goes through the strict parsers; a field that does
// not parse stays null and validateExtraction refuses it with a plain reason.
function toExtraction(parsed) {
  const conf = parsed.confidence || {};
  const lines = (Array.isArray(parsed.transactions) ? parsed.transactions : []).map((t) => {
    let amountCents = parseRandsToCents(t.amount);
    // The roll prints refund lines by type, not always by sign — normalise so
    // the line set sums like the ledger does (signed).
    if (t.type === "refund" && Number.isInteger(amountCents) && amountCents > 0) amountCents = -amountCents;
    const at = (t.date && t.time) ? parseSlipTimestamp(`${t.date} ${t.time}`) : null;
    return {
      tsn: Number(t.tsn),
      at,
      date: t.date || null, time: t.time || null,
      uti: t.uti || null, rrn: t.rrn || null,
      authCode: t.authCode || null, pan: t.pan || null,
      type: t.type === "refund" ? "refund" : "purchase",
      amountCents,
    };
  });
  return {
    mid: typeof parsed.mid === "string" && parsed.mid.trim() ? parsed.mid.trim() : null,
    tid: normaliseTid(parsed.tid),
    batchNo: parsed.batchNo,
    openedAt: parseSlipTimestamp(parsed.opened),
    closedAt: parseSlipTimestamp(parsed.closed),
    printedAt: parseSlipTimestamp(parsed.printed),
    openedText: parsed.opened || null, closedText: parsed.closed || null,
    txnCount: Number(parsed.txnCount),
    purchasesCents: parseRandsToCents(parsed.purchases),
    // ABSENCE is zero (many slips print no cash/refunds line); a GARBLED
    // printed figure stays null and validateExtraction refuses it — the
    // "mangled figure is refused, never coerced" contract (Codex + architect
    // review finding, 2026-08-28).
    cashCents: parsed.cash == null || String(parsed.cash).trim() === "" ? 0 : parseRandsToCents(parsed.cash),
    refundsCents: parsed.refunds == null || String(parsed.refunds).trim() === "" ? 0
      : (() => { const c = parseRandsToCents(parsed.refunds); return c === null ? null : Math.abs(c); })(),
    totalCents: parseRandsToCents(parsed.total),
    reconLine: typeof parsed.reconLine === "string" && parsed.reconLine.trim() ? parsed.reconLine.trim() : null,
    confidence: {
      tid: Number(conf.tid) || 0, batchNo: Number(conf.batchNo) || 0,
      totalCents: Number(conf.total) || 0,
      openedAt: Number(conf.opened) || 0, closedAt: Number(conf.closed) || 0,
      purchasesCents: Number(conf.purchases) || 0, refundsCents: Number(conf.refunds) || 0,
      txnCount: Number(conf.txnCount) || 0, mid: Number(conf.mid) || 0,
    },
    lines,
  };
}

// A reject the operator can act on — travels as a NORMAL response, not an
// exception, so the screen renders it as copy instead of a red toast.
const reject = (reason) => ({ ok: false, reason });

// The keys already holding this batch number for a TID. NEVER "read the TID
// node and look at its keys": each record carries a full transaction roll and
// they accumulate for years, so that is the bandwidth mistake this repo keeps
// a rule against — and an orderByKey range is a trap here too (RTDB sorts
// integer-like keys numerically BEFORE string keys, so a range from "494"
// would sweep every later batch). Instead: probe the only keys that can
// exist — "494", "494-r2", "494-r3", … — by reading ONE tiny child field
// each, and stop at the first gap. Revisions are created strictly in sequence
// (submit's transaction refuses anything else), so the first absent key ends
// the chain.
async function readBatchKeysFor(db, storeId, tid, batchNo) {
  const base = `${CARD_BATCHES_PATH}/${storeId}/${tid}`;
  const keys = [];
  // Bounded like resolveBatchWrite's own revision cap (CodeRabbit, PR #494):
  // an unexpected longer chain stops probing here and the resolver refuses.
  for (let rev = 1; rev <= MAX_REVISIONS; rev++) {
    const key = rev === 1 ? String(batchNo) : `${batchNo}-r${rev}`;
    const exists = (await db.ref(`${base}/${key}/batchKey`).once("value")).exists();
    if (!exists) break;
    keys.push(key);
  }
  return keys;
}


// ─── THE MATCH ───────────────────────────────────────────────────────────────
// Runs beside the till-scoped sum, not instead of it: both go on the record.
// The sum answers "what did this till take on card in the window"; the match
// answers "which of this batch's transactions can be accounted for, wherever
// they were rung". When a machine has moved, only the second is meaningful.

// The findings a MATCH produces, as sentences. Shared by both extract routes:
// the photo path computed a match and then said nothing about it, so a manager
// photographing a slip could not see that a machine had been moved until after
// they had submitted. (CodeRabbit, PR #516.)
function matchNotes(match) {
  if (!match) return [];
  // COUNTS DECIDE WHETHER THERE IS SOMETHING TO SAY, not sums. An unmatched
  // refund and an unmatched purchase of the same size sum to zero cents, and a
  // sum test would then fall silent about two transactions nobody can account
  // for — the exact case these notes exist for. (CodeRabbit, PR #517.)
  const notes = [];
  const offTillMatches = match.matches.filter((m) => m.offTill);
  if (offTillMatches.length) {
    const where = match.offTill
      .map((o) => `${o.storeId}/${o.tillId} (${formatCents(o.cents)})`).join(", ");
    notes.push(
      `${offTillMatches.length} of this batch's transactions were rung up on another till — ${where}. ` +
      "That is what a card machine being moved between shops looks like, and the money is accounted for. " +
      "The pairing is by amount and time only: the till's payment ledger records no auth code or card number.",
    );
  }
  if (match.unmatchedLegsOnTill.length) {
    notes.push(
      `${match.unmatchedLegsOnTill.length} card sale${match.unmatchedLegsOnTill.length === 1 ? "" : "s"} on this till ` +
      `(${formatCents(match.unmatchedLegCents)}) have no transaction on this report. They are NOT netted off against ` +
      "anything missing — a sale the machine has no record of is its own question.",
    );
  }
  if (match.unmatchedTxns.length) {
    notes.push(
      `${match.unmatchedTxns.length} transaction${match.unmatchedTxns.length === 1 ? "" : "s"} on this report ` +
      `(${formatCents(match.unmatchedTxnCents)}) have no card sale anywhere that answers them. This is the variance.`,
    );
  }
  return notes;
}

// ─── THE SUMMARY SETTLES IT FIRST ────────────────────────────────────────────
// If the terminal's total and the till's card total agree, the batch is done.
// Not "probably done" — done. Every rand the machine took is in the ledger, and
// nothing a transaction-by-transaction walk can find will add to that.
//
// So it is not walked. The owner's rule, and the right one: read the summary,
// and only open the catalogue when the summary disagrees. That saves a
// cross-till ledger query on every clean batch and — more to the point — leaves
// a matcher no opportunity at all to invent a finding on a batch where the
// money already balances.
//
// One honest limit, since it is real: two totals can agree while their
// COMPOSITION differs — a missing R100 transaction against surplus R60 and R40
// legs sums the same. That is not investigated, by instruction and by design.
// The money is all present; which sale is which is a different question from
// whether any is missing.
const totalsAgree = (extraction, expected) => extraction.totalCents === expected.cardCents;

async function matchBatch(db, { extraction, terminal, summaryOnly = false }) {
  // A SUMMARY-ONLY CAPTURE HAS NOTHING TO MATCH. It has totals and no
  // transactions, so matchLegs would return a perfectly valid result with
  // matchedCents of zero — and buildBatchRecord would then read the whole slip
  // total as unaccounted for. Every summary-only batch would report its own
  // total as missing money. It gets no match at all, and falls back to the
  // till-scoped subtraction, which is the only thing meaningful without lines.
  // (CodeRabbit, PR #516.)
  if (summaryOnly || !Array.isArray(extraction.lines) || !extraction.lines.length) return null;
  const legs = await cardLegsInWindow(db, {
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    // WIDE ENOUGH FOR A TERMINAL THAT KEEPS BAD TIME, not just the window's own
    // edge allowance — which is zero on a printed slip. The matcher decides on
    // AMOUNT, not time, but it can only match a leg the query actually fetched,
    // and the window itself is built from timestamps the terminal may have got
    // wrong. An hour either side covers a drifting clock and a slow till write.
    edgeMs: Math.max(edgeMsFor(extraction), MATCH_WINDOW_MARGIN_MS),
  });
  return matchLegs(extraction.lines, legs, terminal);
}

async function handleExtract(db, request) {
  const { photos, pdf, pickedTid, summaryOnly, channel } = request.data || {};

  // ONE PATH PER SUBMISSION — decided once, in chooseCaptureSource, because the
  // same answer stamps `capturedVia` on the record further down.
  const chosen = chooseCaptureSource({ photos, pdf, maxPhotos: MAX_PHOTOS });
  if (chosen.err) throw new HttpsError("invalid-argument", chosen.err);

  // ── THE EMAIL CHANNEL — no picked till, because there is no person ─────────
  // The mailbox poller submits here. It is a PDF-only path by construction: a
  // photograph has no email provenance to record and no exact text to read, so
  // allowing one would be inventing a third capture shape nobody asked for.
  if (channel === "email") {
    await assertEmailIntake(request);
    if (chosen.source !== "pdf") throw new HttpsError("invalid-argument", "The email channel carries the terminal's PDF, nothing else.");
    if (pickedTid) throw new HttpsError("invalid-argument", "An emailed slip has no picked till — its own TID is the routing key.");
    const intake = readIntake(request.data.intake);
    if (!intake) throw new HttpsError("invalid-argument", "An emailed capture must carry the source message id.");
    return handleExtractPdf(db, request, { picked: null, pdf, source: chosen.source, intake });
  }
  if (channel !== undefined && channel !== "app") {
    throw new HttpsError("invalid-argument", "Unknown capture channel.");
  }

  const picked = normaliseTid(pickedTid);
  if (!picked) throw new HttpsError("invalid-argument", "Pick the till first.");

  if (chosen.source === "pdf") return handleExtractPdf(db, request, { picked, pdf, source: chosen.source, intake: null });
  const decoded = photos.map(decodePhoto);

  // The terminal registry FIRST: an unmapped picked TID means setup, not OCR.
  const terminalsSnap = await db.ref(CARD_TERMINALS_PATH).once("value");
  const terminals = terminalsSnap.val() || {};
  const terminal = terminals[picked];
  if (!terminal || !terminal.storeId || !terminal.tillId) {
    return reject(`Terminal ${picked} is not registered under /config/cardTerminals — an admin must map it to its till before slips can be captured.`);
  }

  // ── OCR ──
  let ocr;
  try {
    ocr = await runSlipOcr(decoded, geminiApiKey.value());
  } catch (err) {
    console.error("cardBatchCapture: OCR failed:", err.message);
    throw new HttpsError("unavailable", "Could not read the photos right now — try again.");
  }
  // Cost is logged for EVERY billed call, rejected extractions included.
  const costUSD = +((ocr.tokensIn / 1e6) * IN_PER_MTOK_USD + (ocr.tokensOut / 1e6) * OUT_PER_MTOK_USD).toFixed(6);
  try {
    await db.ref(`aiAssistant/usage/${new Date().toISOString().slice(0, 10)}`).push({
      at: Date.now(), kind: "cardBatchOcr", by: request.auth.uid, model: OCR_MODEL,
      photos: decoded.length, tokensIn: ocr.tokensIn, tokensOut: ocr.tokensOut, costUSD,
    });
  } catch (err) { console.warn("cardBatchCapture: usage log failed:", err.message); }

  if (!ocr.parsed) return reject("The photos could not be read as a batch report — retake them, filling the frame with the slip.");
  const extraction = toExtraction(ocr.parsed);

  // ── THE TID DECIDES, NOT THE PICKER — a wrong slip rejects itself ──
  if (!extraction.tid) return reject("No terminal ID could be read off the slip — retake the header photo.");
  if (extraction.tid !== picked) {
    const mapped = terminals[extraction.tid];
    const where = mapped && mapped.label ? ` (that slip belongs to ${mapped.label})` : mapped ? ` (that slip belongs to ${mapped.storeId}/${mapped.tillId})` : " — and that TID is not registered at all";
    return reject(`This slip prints TID ${extraction.tid}, not the till you picked${where}. Capture the slip on its own till.`);
  }

  // Overlapping photos collapse; conflicting readings refuse.
  if (!summaryOnly) {
    const dedup = dedupeLines(extraction.lines);
    if (!dedup.ok) return reject(dedup.reason);
    extraction.lines = dedup.lines;
  } else {
    extraction.lines = [];
  }

  const verdict = validateExtraction(extraction, { summaryOnly: !!summaryOnly });
  if (!verdict.ok) return reject(verdict.reason);

  // Duplicate check at extract time so the operator hears it BEFORE reviewing.
  // The submit transaction re-checks — this one is for the message, that one
  // is the guarantee.
  const batchNo = normaliseBatchNo(extraction.batchNo);
  const existingKeys = await readBatchKeysFor(db, terminal.storeId, extraction.tid, batchNo);
  const write = resolveBatchWrite({ existingKeys, batchNo, correction: !!request.data.correction });
  if (!write.ok) return reject(write.reason);

  // ── EXPECTED — the POS ledger's answer for the slip's own window ──
  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: extraction.windowSource === "transactions-to-print"
      ? extraction.lastTxnAt ?? null
      : null,
  });
  // The summary first: the transactions are only looked at if it disagrees.
  const reconciledByTotals = totalsAgree(extraction, expected);
  const match = reconciledByTotals
    ? null
    : await matchBatch(db, {
    extraction, terminal, summaryOnly: !!summaryOnly,
  });
  // The SAME findings the PDF route reports. Computing a match and then
  // saying nothing about it left a manager unable to see that a machine had
  // been moved until after they had submitted. (CodeRabbit, PR #516.)
  const warnings = [...verdict.warnings, ...matchNotes(match)];

  // Drafts live under the CALLER's uid, so this sweep of abandoned (expired)
  // drafts is bounded by construction — one person holds at most a handful.
  const userDraftsRef = db.ref(`${CARD_BATCH_DRAFTS_PATH}/${request.auth.uid}`);
  try {
    const stale = (await userDraftsRef.once("value")).val() || {};
    const gone = Object.entries(stale).filter(([, d]) => d && Date.now() > d.expiresAt).map(([k]) => k);
    if (gone.length) await userDraftsRef.update(Object.fromEntries(gone.map((k) => [k, null])));
  } catch (err) { console.warn("cardBatchCapture: draft sweep failed:", err.message); }

  // ── PHOTOS, IMMUTABLY — a fresh draft id IS the never-overwrite guarantee ──
  const draftRef = userDraftsRef.push();
  const draftId = draftRef.key;
  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const photoPaths = [];
  for (let i = 0; i < decoded.length; i++) {
    const path = `${PHOTO_STORAGE_PREFIX}/${draftId}/photo-${i}.jpg`;
    await bucket.file(path).save(decoded[i].buffer, {
      resumable: false,
      contentType: "image/jpeg",
      metadata: { cacheControl: "private, max-age=31536000, immutable" },
    });
    photoPaths.push(path);
  }

  const draft = {
    by: request.auth.uid,
    byEmail: request.auth.token?.email || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS,
    pickedTid: picked,
    summaryOnly: !!summaryOnly,
    correction: !!request.data.correction,
    warnings: warnings.length ? warnings : null,
    photoPaths,
    // JSON round-trip strips the undefined values RTDB refuses.
    extraction: JSON.parse(JSON.stringify(extraction)),
    terminal: { storeId: terminal.storeId, tillId: terminal.tillId, label: terminal.label ?? null },
    // What the REVIEW screen showed — kept so submit can say out loud when the
    // ledger moved between review and record (architect review, 2026-08-28).
    reviewedExpectedCents: expected.cardCents,
    ocr: { model: OCR_MODEL, tokensIn: ocr.tokensIn, tokensOut: ocr.tokensOut, costUSD },
  };
  await draftRef.set(draft);

  // The review screen's content: everything the OCR read, nothing editable.
  return {
    ok: true,
    draftId,
    review: {
      tid: extraction.tid, mid: extraction.mid, batchNo: Number(batchNo),
      revision: write.revision, supersedes: write.supersedes,
      terminal: draft.terminal,
      openedAt: extraction.openedAt, closedAt: extraction.closedAt, printedAt: extraction.printedAt,
      openedText: extraction.openedText, closedText: extraction.closedText,
      txnCount: extraction.txnCount,
      purchasesCents: extraction.purchasesCents, cashCents: extraction.cashCents,
      refundsCents: extraction.refundsCents, totalCents: extraction.totalCents,
      reconLine: extraction.reconLine,
      confidence: extraction.confidence,
      lineCount: extraction.lines.length,
      summaryOnly: !!summaryOnly,
      warnings,
      // CAPTURE ONLY. The manager confirms the OCR read the SLIP IN THEIR HAND
      // correctly and that is the end of their involvement. Deliberately NOT
      // returned: expectedCardCents / varianceCents / expectedByKind (the
      // comparison and its verdict), `cashiers` (who was on the till — derived
      // POS data, not on the slip), and `lines` (the detail roll carries a
      // masked PAN per transaction; card numbers are never sent to a client).
      // All of it is still computed and still STORED on the record — the owner
      // reviews it in marathon-pos-app, which is super-admin only.
    },
  };
}

// ─── THE PDF PATH ────────────────────────────────────────────────────────────
// The terminal's own emailed batch report. One file covers the whole slip —
// header, totals and detail roll — so there is no detail/summary split here and
// a PDF with lines is never recorded as summary-only.
//
// NO OCR AND NO FALLBACK TO ONE. The text is read exactly or this refuses with
// a reason naming what it could not find. A fuzzy second attempt would be the
// one thing worse than refusing: a figure nobody can vouch for, recorded as a
// variance against a named person's till. Photos remain, and the refusal says so.
async function handleExtractPdf(db, request, { picked, pdf, source, intake }) {
  // Intactness, size and the magic bytes, all in one pure seam — see
  // readPdfPayload. A malformed upload is a sentence, never a transport error.
  const payload = readPdfPayload(pdf.base64, MAX_PDF_BYTES);
  if (payload.err) {
    // `reject` is a refusal the screen shows with the slip still attached; the
    // throw is for a payload that never was a submission.
    if (payload.reject) return reject(payload.err);
    throw new HttpsError("invalid-argument", payload.err);
  }
  const buffer = payload.buffer;

  // The terminal registry FIRST — an unmapped PICKED TID is setup, not a bad
  // file, and saying so before spending a PDF parse on it is the useful order.
  // The email channel has no pick, so its registry check happens after the
  // parse (the slip's own TID is what there is to look up).
  const terminals = (await db.ref(CARD_TERMINALS_PATH).once("value")).val() || {};
  if (picked) {
    const pickedTerminal = terminals[picked];
    if (!pickedTerminal || !pickedTerminal.storeId || !pickedTerminal.tillId) {
      return reject(`Terminal ${picked} is not registered under /config/cardTerminals — an admin must map it to its till before slips can be captured.`);
    }
  }

  const text = await pdfToLines(buffer);
  if (!text.ok) return reject(text.reason);
  const parsed = parseSlipPdf(text.lines);
  if (!parsed.ok) return reject(parsed.reason);
  const extraction = parsed.extraction;

  // ── WHICH TILL, AND WHAT VOUCHES FOR THAT ANSWER ──────────────────────────
  // TWO PATHS, ONE PRINCIPLE: the answer is never allowed to be a guess.
  //
  //   PICKED (a manager, on a phone) — the TID DECIDES, NOT THE PICKER. A slip
  //     whose TID is not the till they picked refuses itself.
  //
  //   EMAILED — there is no pick to disagree with, so the slip's own TID is the
  //     routing key and lib/card-recon-email.cjs is what checks it: the TID
  //     must resolve in the registry, and the printed MID must not contradict
  //     the one registered for that terminal. An unregistered terminal is
  //     refused with a reason the poller records — invisible non-reconciliation
  //     is the failure this whole feature exists to prevent.
  let terminal;
  const routingWarnings = [];
  if (picked) {
    if (extraction.tid !== picked) {
      const mapped = terminals[extraction.tid];
      const where = mapped && mapped.label ? ` (that file belongs to ${mapped.label})` : mapped ? ` (that file belongs to ${mapped.storeId}/${mapped.tillId})` : " — and that TID is not registered at all";
      return reject(`This PDF is for TID ${extraction.tid}, not the till you picked${where}. Capture it on its own till.`);
    }
    terminal = terminals[picked];
  } else {
    const routed = routeEmailSlip({ extraction, terminals });
    if (!routed.ok) return reject(routed.reason);
    terminal = routed.terminal;
    routingWarnings.push(...routed.warnings);
  }

  // ── THE INVARIANT BOTH BRANCHES MUST SATISFY ─────────────────────────────
  // A batch is recorded against THE REGISTRY ROW FOR THE TID PRINTED ON THE
  // SLIP. Nothing else, on either path — the pick only ever gets to disagree
  // and refuse, never to choose. That is true of both branches above today
  // (the picked one reached here only because extraction.tid === picked), and
  // this is what keeps it true of whatever is written next. It is a bug guard,
  // not a validation: if it ever fires, a slip was about to be filed against a
  // till it does not belong to, which is the one outcome this feature exists
  // to prevent.
  if (terminal !== terminals[extraction.tid]) {
    console.error("cardBatchCapture: routing invariant broken for TID", extraction.tid);
    return reject("This slip could not be matched to its terminal — nothing was recorded. Tell Junid.");
  }

  // Overlapping sections cannot happen in a single file, but a terminal that
  // prints a line twice still must not be averaged away.
  const dedup = dedupeLines(extraction.lines);
  if (!dedup.ok) return reject(dedup.reason);
  extraction.lines = dedup.lines;

  // EVERY existing refusal, unchanged — only the confidence gate is skipped,
  // because exact text has nothing to be confident about.
  const verdict = validateExtraction(extraction, { summaryOnly: false, source: "pdf" });
  if (!verdict.ok) return reject(verdict.reason);
  const batchNo = normaliseBatchNo(extraction.batchNo);
  const existingKeys = await readBatchKeysFor(db, terminal.storeId, extraction.tid, batchNo);
  const write = resolveBatchWrite({ existingKeys, batchNo, correction: !!request.data.correction });
  if (!write.ok) return reject(write.reason);

  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: extraction.windowSource === "transactions-to-print"
      ? extraction.lastTxnAt ?? null
      : null,
  });
  // The summary first: the transactions are only looked at if it disagrees.
  const reconciledByTotals = totalsAgree(extraction, expected);
  const match = reconciledByTotals
    ? null
    : await matchBatch(db, { extraction, terminal });

  // A DERIVED WINDOW HAS NO SLACK, so say when legs land just outside it rather
  // than letting them show up only as a variance. This is a warning, never a
  // refusal: the figures are exact, and whether those legs belong to this batch
  // is a judgement for the person reviewing it.
  // THE ROUTING WARNINGS COME FIRST, and they are part of the same list on
  // purpose: what could NOT be checked about which till this belongs to (an
  // emailed report from a terminal with no registered merchant id, say) belongs
  // on the record beside what the matching found, not in a second channel the
  // owner has to know to look at.
  const warnings = [...routingWarnings, ...verdict.warnings];
  warnings.push(...matchNotes(match));
  if (expected.tailLegs > 0) {
    warnings.push(
      `${expected.tailLegs} card leg${expected.tailLegs === 1 ? "" : "s"} on this till ` +
      `(${formatCents(expected.tailCents)}) fall after the report's last transaction and before it was printed. ` +
      "They ARE counted: a till leg is always written a minute or two after the terminal approves the card, " +
      "so the last sales of a batch land in that gap. Check them if this batch's variance looks wrong.",
    );
  }
  if (expected.nearEdgeLegs > 0) {
    warnings.push(
      `${expected.nearEdgeLegs} card leg${expected.nearEdgeLegs === 1 ? "" : "s"} on this till ` +
      `(${formatCents(expected.nearEdgeCents)}) sit within two minutes of this window but outside it. ` +
      "A banking report prints no Opened/Closed times, so the window is the span of its own transactions " +
      "and has no slack at either end — these are not counted in the expected figure.",
    );
  }

  const userDraftsRef = db.ref(`${CARD_BATCH_DRAFTS_PATH}/${request.auth.uid}`);
  try {
    const stale = (await userDraftsRef.once("value")).val() || {};
    const gone = Object.entries(stale).filter(([, d]) => d && Date.now() > d.expiresAt).map(([k]) => k);
    if (gone.length) await userDraftsRef.update(Object.fromEntries(gone.map((k) => [k, null])));
  } catch (err) { console.warn("cardBatchCapture: draft sweep failed:", err.message); }

  // The FILE is the evidence, stored exactly as the photos are: a fresh draft
  // id per extract, so no path is ever written twice.
  const draftRef = userDraftsRef.push();
  const draftId = draftRef.key;
  const pdfPath = `${PHOTO_STORAGE_PREFIX}/${draftId}/slip.pdf`;
  await admin.storage().bucket(STORAGE_BUCKET).file(pdfPath).save(buffer, {
    resumable: false,
    contentType: "application/pdf",
    metadata: { cacheControl: "private, max-age=31536000, immutable" },
  });

  const draft = {
    by: request.auth.uid,
    byEmail: request.auth.token?.email || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS,
    pickedTid: picked,
    summaryOnly: false,
    correction: !!request.data.correction,
    warnings: warnings.length ? warnings : null,
    photoPaths: [],
    pdfPath,
    // Where the file came from, when it did not come from a person: the source
    // message, sanitised in readIntake. null on the app path.
    intake: intake || null,
    capturedVia: source,   // the routing decision, not a second literal
    extraction: JSON.parse(JSON.stringify(extraction)),
    terminal: { storeId: terminal.storeId, tillId: terminal.tillId, label: terminal.label ?? null },
    reviewedExpectedCents: expected.cardCents,
    ocr: null,                       // nothing was OCR'd, and nothing was billed
    pdfPages: text.pages,
  };
  await draftRef.set(draft);

  // Same capture-only response as the photo path: what the FILE said, and
  // nothing about how the till did.
  return {
    ok: true,
    draftId,
    review: {
      tid: extraction.tid, mid: extraction.mid, batchNo: Number(batchNo),
      revision: write.revision, supersedes: write.supersedes,
      terminal: draft.terminal,
      openedAt: extraction.openedAt, closedAt: extraction.closedAt, printedAt: extraction.printedAt,
      openedText: extraction.openedText, closedText: extraction.closedText,
      txnCount: extraction.txnCount,
      purchasesCents: extraction.purchasesCents, cashCents: extraction.cashCents,
      refundsCents: extraction.refundsCents, totalCents: extraction.totalCents,
      reconLine: extraction.reconLine,
      confidence: null,
      lineCount: extraction.lines.length,
      summaryOnly: false,
      capturedVia: "pdf",
      channel: intake ? "email" : "app",
      warnings,
    },
  };
}

async function handleSubmit(db, request) {
  const { draftId } = request.data || {};
  if (typeof draftId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(draftId)) {
    throw new HttpsError("invalid-argument", "draftId is required.");
  }
  // Drafts are keyed under the caller's uid, so another user's draftId simply
  // does not resolve — ownership is structural; the `by` check is belt.
  const draftRef = db.ref(`${CARD_BATCH_DRAFTS_PATH}/${request.auth.uid}/${draftId}`);
  const draft = (await draftRef.once("value")).val();
  if (!draft) throw new HttpsError("not-found", "That capture has expired — extract the slip again.");
  if (draft.by !== request.auth.uid) throw new HttpsError("permission-denied", "This capture belongs to another session.");
  if (Date.now() > draft.expiresAt) {
    await draftRef.remove().catch(() => {});
    throw new HttpsError("deadline-exceeded", "That capture has expired — extract the slip again.");
  }

  const extraction = draft.extraction;
  // RTDB drops empty arrays; a summary-only draft comes back line-less.
  if (!Array.isArray(extraction.lines)) extraction.lines = [];
  const terminal = draft.terminal;
  const batchNo = normaliseBatchNo(extraction.batchNo);

  // ── RE-VALIDATE THE DRAFT, IN FULL ──────────────────────────────────────
  // DEFENCE IN DEPTH, not compensation for an open rule. This used to note that
  // the drafts sat under /pos, whose `$other` write grant would have let a
  // client author its own "draft" under its uid. They no longer do: PR #502
  // moved them to a TOP-LEVEL /card_batch_drafts whose live rules are
  // owner-only for both read and write (verified against the live
  // .settings/rules.json, 2026-08-29), so a staff client cannot write one at
  // all. Every field here is therefore server-written — `extraction.format`
  // included, which is what keeps the banking report's TSN-contiguity
  // exemption out of reach of a photographed slip.
  //
  // The full re-validation stays regardless, because a draft can go stale in
  // ways nothing about rules would catch: a terminal remapped to another till
  // between extract and submit, a batch number that has since been used. Submit
  // trusts NOTHING it did not just recompute — the same validation, the same
  // terminal-registry check, the same window bound. A draft that fails any of
  // it is refused and removed.
  const terminalsNow = (await db.ref(CARD_TERMINALS_PATH).once("value")).val() || {};
  const mapped = terminalsNow[extraction.tid];
  const revalid = !batchNo || !normaliseTid(extraction.tid) || !mapped
    || mapped.storeId !== terminal.storeId || mapped.tillId !== terminal.tillId
    ? { ok: false, reason: "This capture no longer matches a registered terminal — extract the slip again." }
    : validateExtraction(extraction, {
        summaryOnly: !!draft.summaryOnly,
        source: draft.capturedVia === "pdf" ? "pdf" : "photo",
      });
  if (!revalid.ok) {
    await draftRef.remove().catch(() => {});
    return reject(revalid.reason);
  }
  // AN EMAILED DRAFT IS RE-ROUTED FROM SCRATCH, not trusted. On this path the
  // TID chose the till with no human to disagree with it, so the check that
  // made that choice safe is re-run against the registry as it stands NOW —
  // the same discipline as the re-validation above, applied to the one decision
  // the phone path never has to make.
  // TRUST NOTHING THE DRAFT SAYS ABOUT ITSELF, INCLUDING ITS PROVENANCE. The
  // block above re-runs every validation rather than believing a draft this
  // function wrote, and `intake` deserves the same treatment for two reasons:
  // it is attacker-supplied text (a subject line, a sender address) on its way
  // into an append-only record the owner reads, and it is what says this
  // capture came in on the channel with no picked till. So it is re-sanitised
  // through the same seam extract used, and the channel's own permission is
  // asserted again at the moment of record — a flag revoked between extract and
  // submit must stop the submit. (CodeRabbit, PR #510.)
  const draftIntake = readIntake(draft.intake);
  if (draft.intake && !draftIntake) {
    await draftRef.remove().catch(() => {});
    return reject("This capture's source could not be verified — nothing was recorded.");
  }
  if (draftIntake) {
    await assertEmailIntake(request);
    const rerouted = routeEmailSlip({ extraction, terminals: terminalsNow });
    if (!rerouted.ok) {
      await draftRef.remove().catch(() => {});
      return reject(rerouted.reason);
    }
    if (rerouted.terminal.storeId !== terminal.storeId || rerouted.terminal.tillId !== terminal.tillId) {
      await draftRef.remove().catch(() => {});
      return reject("That terminal has been re-registered to a different till since the file was read — nothing was recorded.");
    }
  }

  // Recompute expected at the moment of record — the authoritative figure.
  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: extraction.windowSource === "transactions-to-print"
      ? extraction.lastTxnAt ?? null
      : null,
  });
  // The summary first: the transactions are only looked at if it disagrees.
  const reconciledByTotals = totalsAgree(extraction, expected);
  const match = reconciledByTotals
    ? null
    : await matchBatch(db, { extraction, terminal, summaryOnly: !!draft.summaryOnly });

  // Re-resolve the key against NOW's children, then guarantee append-only with
  // a transaction on the exact key: existing data aborts, never overwritten.
  const tidRef = db.ref(`${CARD_BATCHES_PATH}/${terminal.storeId}/${extraction.tid}`);
  const existingKeys = await readBatchKeysFor(db, terminal.storeId, extraction.tid, batchNo);
  const write = resolveBatchWrite({ existingKeys, batchNo, correction: !!draft.correction });
  if (!write.ok) return reject(write.reason);

  const record = buildBatchRecord({
    extraction, terminal, tid: extraction.tid, match, reconciledByTotals,
    batchKey: write.key, revision: write.revision, supersedes: write.supersedes,
    photoPaths: draft.photoPaths,
    summaryOnly: !!draft.summaryOnly,
    warnings: draft.warnings || [],
    expected,
    cashiers: expected.cashiers,
    submittedBy: { uid: request.auth.uid, email: request.auth.token?.email || null },
    submittedAt: Date.now(),
    draftId,
    ocr: draft.ocr || null,
    capturedVia: draft.capturedVia === "pdf" ? "pdf" : "photo",
    pdfPath: draft.pdfPath || null,
    intake: draftIntake,
  });

  const txn = await tidRef.child(write.key).transaction((cur) => {
    if (cur !== null) return undefined; // exists → abort, never overwrite
    return JSON.parse(JSON.stringify(record));
  });
  if (!txn.committed) {
    return reject(`Batch #${batchNo} for this terminal was captured by someone else a moment ago.`);
  }
  await draftRef.remove().catch(() => {});

  // CAPTURE ONLY — an acknowledgement, not a verdict. The manager learns that
  // the slip is recorded and whether the detail roll made it in (the only fact
  // that changes what they should DO next: reshoot, or walk away). No variance,
  // no expected figure, no comparison, no cashier list. `expected` and
  // `varianceCents` are computed above and written to the record; they are for
  // the owner's review screen, not for the phone that captured the slip.
  return {
    ok: true,
    batchKey: write.key,
    revision: write.revision,
    slipTotalCents: extraction.totalCents, // read off the slip in their hand
    linesCaptured: record.linesCaptured,
    warnings: draft.warnings || [],
  };
}

exports.cardBatchCapture = onCall(
  {
    region: "europe-west1",
    secrets: [geminiApiKey],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (request) => {
    await assertCardRecon(request);
    const db = admin.database();
    const action = request.data?.action;
    if (action === "extract") return handleExtract(db, request);
    if (action === "submit") return handleSubmit(db, request);
    throw new HttpsError("invalid-argument", "action must be 'extract' or 'submit'.");
  },
);

// Exported for tests (pure-ish seams).
exports.toExtraction = toExtraction;
// The summary-first gate, exported so it can be tested directly: everything
// else about it lives inside async handlers behind a database.
exports.totalsAgree = totalsAgree;
exports.EXTRACTION_SCHEMA = EXTRACTION_SCHEMA;
exports.OCR_MODEL = OCR_MODEL;
