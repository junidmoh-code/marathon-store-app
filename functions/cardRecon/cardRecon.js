// ─── cardBatchCapture CALLABLE — the FNB batch slip becomes evidence ─────────
// Managers photograph the terminal's own Batch Report (detail roll + summary);
// this callable OCRs it, refuses anything it could not read soundly, computes
// what the POS tender ledger says the card takings for that till over the
// slip's Opened→Closed window should have been, and records slip + expectation
// + variance append-only at /card_batches. NOBODY TYPES THE CARD TOTAL — with
// ONE exception, Junid's alone: on a terminal whose printer prints half the
// slip he may type the total BESIDE the photo (`declaredTotal`), and the record
// says so, with who and when. See readDeclaredTotal in lib/card-recon.cjs.
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
const { onValueCreated } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const {
  CARD_TERMINALS_PATH, CARD_BATCHES_PATH, CARD_BATCH_DRAFTS_PATH, DRAFT_TTL_MS,
  PHOTO_STORAGE_PREFIX,
  parseSlipTimestamp, parseRandsToCents,
  normaliseTid, readSlipTid, slipTidMatchesPicked, emptyBatchOpenedAt, emptyReprintOpensAt, normaliseBatchNo, resolveBatchWrite, comparePriorCapture, MAX_REVISIONS, MAX_REPRINT_REVISIONS, sastDayIndexOf,
  dedupeLines, validateExtraction, buildBatchRecord,
  chooseCaptureSource, readPdfPayload, formatCents,
  hasDeclaredTotal, readDeclaredTotal, mayDeclareTotal, anchorDeclaredWindow,
  planTypedCapture,
} = require("../lib/card-recon.cjs");
const { readSlipPdfLines, PARSER_VERSION } = require("../lib/card-recon-pdf.cjs");
const { routeEmailSlip, EMAIL_INTAKE_FLAG } = require("../lib/card-recon-email.cjs");
const { pdfToLines } = require("./pdfText.js");
const { computeExpectedCard, cardLegsInWindow, DERIVED_WINDOW_SLACK_MS } = require("../lib/card-expected.cjs");
const { matchLegs, MATCH_WINDOW_MARGIN_MS } = require("../lib/card-match.cjs");
const { STORAGE_BUCKET } = require("../lib/photo-scope.cjs");
const { isRetiredTerminal, retiredCaptureRefusal, tillMoveWarning, takesPhoto, typesTotal } = require("../lib/card-terminals.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");
const { readAccountSections, readSectionClaim, locationInSections } = require("../lib/section-access.cjs");
const { tillAt } = require("../lib/card-terminal-placements.cjs");
const { SLIP_SCOPE_FIELD, readSlipScope, slipScopeAllows } = require("../lib/card-slip-scope.cjs");
const { SUPPORTING_FIELD, MAX_SUPPORTING_SLIPS, shouldAttach, authorityOf, isStaffSlipRecord, buildSupportingSlip, carriedSlips, sameDaySuccessors } = require("../lib/card-supporting-slips.cjs");
const {
  JOBS_PATH, DUE_PATH, JOB_PHOTO_PREFIX, dueKey, dueCutoff, claimJob, classifyRun, nextStep, unreadReason,
} = require("../lib/card-read-jobs.cjs");
const {
  NOTICES_PATH, NOTIFY_TO, sastDayYmd, unreadPath, noticeKey,
  addUnreadFailure, resolveUnreadMarker, noticeRecord,
} = require("../lib/card-unread.cjs");
const { slipTradingDay, batchCloseOf, staffSlipDayPath, staffSlipEntry, latestStaffSlip } = require("../lib/card-staff-slip-log.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");
// The second reader, for the one failure Gemini cannot recover from by itself
// (see CREDIT_WALL_MODEL). Same secret the rest of the store app's Claude
// calls use.
const anthropicApiKey = defineSecret("anthropic-api-key");

// Same model tier as readStyleCodeLabel's residual: a till slip is dense,
// low-contrast thermal print and misreading a digit here becomes a recorded
// "variance", so this is not a Flash-Lite job. ONE constant, one-line swap.
const OCR_MODEL = "gemini-3.6-flash";
// ── WHEN THE MODEL IS OVERLOADED ─────────────────────────────────────────────
// On 20-21 Sept 2026 gemini-3.6-flash answered "503 — This model is currently
// experiencing high demand" to most slip photos: every Trophy Till 2 attempt
// in the log, and 12 of 13 probes of a real Marathon Till 2 slip (the 13th read
// it perfectly on its 7th try). The account was funded throughout. So a 503 is
// retried a few times, briefly, and then ONE attempt goes to the next model
// tier, which read the same real slips correctly (TID, batch, total) while
// 3.6 was refusing. Every other status fails at once — a 402 does not get
// better by asking twice.
const OCR_FALLBACK_MODEL = "gemini-3.8-flash";
// ── WHEN GEMINI HAS RUN OUT OF CREDIT ────────────────────────────────────────
// 18 Oct 2026: Yasmin's Marathon PE Till 2 slip (#546, R22,460.00) arrived at
// 14:58 and sat unread, because the Gemini prepay balance was empty (HTTP 402)
// and every retry met the same wall — so Junid's report showed the till as
// "awaiting a slip" all afternoon. A 402/429 is the one failure no number of
// retries fixes, so it is handed ONCE to Claude, which read the same photo
// exactly (TID, batch, opened/closed, total, count). Never used for anything
// else: a 503 or a hang still goes to the Gemini fallback tier as before.
const CREDIT_WALL_MODEL = "claude-opus-5-5";
const CLAUDE_TIMEOUT_MS = 120000;
const isCreditWall = (err) => !!err && (err.httpStatus === 402 || err.httpStatus === 429);
const OCR_503_RETRIES = 3;
const OCR_503_BACKOFF_MS = [1500, 3000, 5000];
// No new attempt starts unless it could still finish inside the callable's
// 300 s — a slow reader must end in the named message, not a killed call.
const OCR_BUDGET_MS = 270 * 1000;
const geminiEndpoint = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const GEMINI_TIMEOUT_MS = 120000;

// Published gemini-2.5-flash rates; 3.6-flash had no separate public sheet at
// build time. Order-of-magnitude honest for the usage log, revisit when billed.
const IN_PER_MTOK_USD = 0.30;
const OUT_PER_MTOK_USD = 2.50;
// Per model, so a fallback-served capture is logged against its own tier. No
// public sheet for either 3.x flash at build time: both carry the estimate
// above until one is billed, and `model` on the usage row says which it was.
const OCR_RATES = {
  "gemini-3.6-flash": { in: IN_PER_MTOK_USD, out: OUT_PER_MTOK_USD },
  "gemini-3.8-flash": { in: IN_PER_MTOK_USD, out: OUT_PER_MTOK_USD },
  [CREDIT_WALL_MODEL]: { in: 4, out: 20 },
};

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
// …and the SLACK a derived window's own transactions may claim legs from — see
// DERIVED_WINDOW_SLACK_MS in lib/card-expected.cjs. Printed windows get none.
const slackFor = (extraction) => (
  extraction.windowSource && extraction.windowSource !== "printed"
    ? { slackMs: DERIVED_WINDOW_SLACK_MS, lines: extraction.lines || [] }
    : {});

const EXTRACTION_PROMPT = [
  "These photographs show ONE printed card-terminal Batch Report from an FNB",
  "(South Africa) payment terminal: a header, a detailed list of transactions,",
  "and totals. Read ONLY what is literally printed. Never invent, infer or",
  "complete a value — an unreadable field is an empty string with confidence 0.",
  "",
  // THE EXAMPLE TID IS MADE UP, deliberately. It is there to show the model the
  // SHAPE of the thing — four-to-eight alphanumerics, sometimes leading zeros —
  // and a real one would be a live machine written into a shipped artefact, in
  // a feature whose whole rule is that no terminal is named in what ships.
  "HEADER fields: MID (merchant ID, long digits), TID (terminal ID, e.g.",
  "0000AB1C or 67000000 — letters AND digits are both normal; return only the",
  "ID itself, without the 'TID:' label), the batch number (printed like 'Batch Report (#494)'",
  "— return the digits), Opened, Closed and Printed timestamps (return exactly as",
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

// ── THE SECTION WALL, FOR A HAND CAPTURE ─────────────────────────────────────
// The capture screen only draws the tills in the viewer's own sections; this is
// the half that holds when an old bundle or a direct call picks one anyway. A
// terminal's store is a POS store id ("pe", "concrete"), which the network
// registry resolves to its section. The caller's sections are the same answer
// the screens use (sectionsFor): Junid and anyone he gives both see both, an
// account scoped to a section — or an enrolled device whose code was made for
// one — captures only that section's tills, and an account that predates
// sections captures everything it always could.
//
// Returns the refusal SENTENCE, or null when the capture may go ahead.
// FAIL CLOSED, like the permission gates above: a scope that cannot be read
// throws rather than waving a capture through. A store the registry does not
// know has no section and is refused to nobody — this check narrows by
// section, it does not invent a second "is this store real" rule.
//
// The EMAIL channel does not come through here: it has no picked till and one
// identity (the poller's), gated by assertEmailIntake.
async function sectionRefusalFor(db, request, picked, terminal) {
  const token = request.auth?.token || {};
  if (token.email === ADMIN_EMAIL) return null;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let sections;
  let registry;
  try {
    registry = await loadNetwork(db);
    sections = await readAccountSections(db, registry, uid, { deviceSection: readSectionClaim(token.section) });
  } catch (err) {
    console.error("sectionRefusalFor: section read failed:", err && err.message);
    throw new HttpsError("unavailable", "Could not check which section this account works in. Try again.");
  }
  if (locationInSections(registry, sections, terminal.storeId)) return null;
  return `${terminal.label || picked} is not in your section, so it cannot be captured from this account. Ask Junid if this is your till.`;
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

// ── ONE TILL'S SLIP: THE PER-TILL SCOPE (lib/card-slip-scope.cjs) ─────────────
// The gate on action "slip", INSTEAD of `card_recon`: the account may send the
// daily slip for the tills in /users/{uid}/cardSlipTills and for nothing else.
// The till is where the terminal stands AT THIS MOMENT (its placement, else its
// registry row) — a machine moved to another till is that till's from then on.
// FAIL CLOSED, like the gates above: a scope that cannot be read refuses.
// Junid passes, as he does every other gate here.
async function slipScopeAllowsNow(db, request, terminal, nowMs) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return true;
  const uid = request.auth?.uid;
  if (!uid) return false;
  let raw;
  try {
    raw = (await db.ref(`users/${uid}/${SLIP_SCOPE_FIELD}`).once("value")).val();
  } catch (err) {
    console.error("slipScope: scope read failed:", err && err.message);
    throw new HttpsError("unavailable", "Could not check which till this account sends. Try again.");
  }
  const here = tillAt(terminal, nowMs);
  return slipScopeAllows(readSlipScope(raw), { storeId: here.storeId || terminal.storeId, tillId: here.tillId || terminal.tillId });
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
// One photo set, tried against the primary model with a short 503 retry, then
// once against the fallback. `deps` is the test seam: fetch and sleep.
async function runSlipOcr(photos, apiKey, deps = {}) {
  const started = (deps.now || Date.now)();
  try {
    return await runGeminiOcr(photos, apiKey, deps);
  } catch (err) {
    // Out of credit, and a second reader is configured: one read there.
    if (!isCreditWall(err) || !deps.claudeKey) throw err;
    // Inside the callable's 300 s: a wall met late (after 503 retries) leaves
    // only what is left of the budget, and none at all under 30 s.
    const left = OCR_BUDGET_MS - ((deps.now || Date.now)() - started);
    if (left < 30 * 1000) throw err;
    console.warn(`cardBatchCapture: Gemini HTTP ${err.httpStatus} (out of credit) — reading with ${CREDIT_WALL_MODEL}`);
    try {
      const out = await runClaudeOcrOnce(photos, deps.claudeKey, deps.fetch || fetch, Math.min(CLAUDE_TIMEOUT_MS, left));
      return { ...out, model: CREDIT_WALL_MODEL, attempts: (err.attempts || 1) + 1 };
    } catch (second) {
      // Still Gemini's wall (the person is told the reader is out of credit),
      // and that the backup failed too, with its own status or timeout.
      if (second.secondStatus) throw second;
      console.error(`cardBatchCapture: ${CREDIT_WALL_MODEL} fallback failed: ${second.name}: ${second.message}`);
      throw Object.assign(new Error(`claude ${second.name || "error"}`), { httpStatus: err.httpStatus, secondStatus: second.name === "TimeoutError" || second.name === "AbortError" ? "timeout" : "unreachable" });
    }
  }
}

/** Both readers, with the keys the deployed functions hold. */
const liveOcr = (photos) => runSlipOcr(photos, geminiApiKey.value(), { claudeKey: anthropicApiKey.value() });

async function runGeminiOcr(photos, apiKey, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = deps.now || Date.now;
  const started = clock();
  const plan = [
    ...Array.from({ length: 1 + OCR_503_RETRIES }, () => OCR_MODEL),
    OCR_FALLBACK_MODEL,
  ];
  let last;
  let made = 0;
  for (let i = 0; i < plan.length; i++) {
    if (i > 0 && clock() - started + GEMINI_TIMEOUT_MS > OCR_BUDGET_MS) break;
    made++;
    try {
      const out = await runSlipOcrOnce(photos, apiKey, plan[i], deps.fetch || fetch);
      return { ...out, model: plan[i], attempts: made };
    } catch (err) {
      last = err;
      // A MODEL THAT HUNG OR FELL OVER GOES STRAIGHT TO THE OTHER TIER. On 7 Oct
      // 2026 Marathon Till 2's slip was sent twice and gemini-3.6-flash held
      // both requests until the 120 s timeout fired — and a timeout used to
      // end the read on the spot, with the fallback model never asked. A hang
      // is not worth a second two-minute wait on the same model, so it (and a
      // 500/502/504) skips the short 503 retries and takes the one fallback
      // attempt, budget permitting.
      if (isHungOrBroken(err)) {
        const fallback = plan.indexOf(OCR_FALLBACK_MODEL);
        if (plan[i] === OCR_FALLBACK_MODEL || fallback < 0) break;
        i = fallback - 1; // the loop's i++ lands on the fallback
        continue;
      }
      if (err.httpStatus !== 503) { err.attempts = made; throw err; }
      const wait = OCR_503_BACKOFF_MS[i];
      if (wait && plan[i + 1] === OCR_MODEL) await sleep(wait);
    }
  }
  last.attempts = made;
  throw last;
}

/** A read that timed out, or a server-side failure other than "overloaded". */
function isHungOrBroken(err) {
  return !!err && (err.name === "TimeoutError" || err.name === "AbortError"
    || err.httpStatus === 500 || err.httpStatus === 502 || err.httpStatus === 504);
}

async function runSlipOcrOnce(photos, apiKey, model, fetchImpl) {
  const res = await fetchImpl(geminiEndpoint(model), {
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
  // The STATUS travels with the error. It used to be formatted into a string
  // and nothing else, which made "out of credit" (402) indistinguishable from
  // "the reader is down" (503) by the time anyone could act on it — and on
  // 19 Sept 2026 that cost a full day of captures across the whole estate,
  // because the one sentence both produced told managers to check the signal.
  if (!res.ok) {
    const err = new Error(`gemini HTTP ${res.status}`);
    err.httpStatus = res.status;
    // The body carries Google's own explanation ("Your prepayment credits are
    // depleted"). Read best-effort and kept for the LOG only — it names an
    // internal billing account and never goes to a shop floor.
    try { err.body = (await res.text()).slice(0, 400); } catch { /* body is a bonus */ }
    throw err;
  }
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

// Gemini's schema, in the JSON Schema dialect Claude's structured output takes:
// lower-case types, and every object closed (additionalProperties: false).
function toJsonSchema(node) {
  if (!node || typeof node !== "object") return node;
  const out = { type: String(node.type).toLowerCase() };
  if (node.enum) out.enum = node.enum;
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.additionalProperties = false;
  }
  if (node.items) out.items = toJsonSchema(node.items);
  if (node.required) out.required = node.required;
  return out;
}
const CLAUDE_EXTRACTION_SCHEMA = toJsonSchema(EXTRACTION_SCHEMA);

async function runClaudeOcrOnce(photos, apiKey, fetchImpl, timeoutMs = CLAUDE_TIMEOUT_MS) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CREDIT_WALL_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: CLAUDE_EXTRACTION_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          ...photos.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.base64 } })),
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`claude HTTP ${res.status}`);
    // The 402 is GEMINI's — the person is told the reader is out of credit,
    // which it still is. Claude's own status is in the log line.
    err.httpStatus = 402;
    err.secondStatus = res.status;
    try { err.body = (await res.text()).slice(0, 400); } catch { /* bonus */ }
    console.error(`cardBatchCapture: ${CREDIT_WALL_MODEL} fallback failed: HTTP ${res.status} ${err.body || ""}`);
    throw err;
  }
  const payload = await res.json();
  const text = (payload.stop_reason === "refusal" ? [] : payload.content || [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const usage = payload.usage || {};
  return { parsed, tokensIn: usage.input_tokens || 0, tokensOut: usage.output_tokens || 0 };
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
    tid: readSlipTid(parsed.tid),
    batchNo: parsed.batchNo,
    openedAt: parseSlipTimestamp(parsed.opened),
    closedAt: parseSlipTimestamp(parsed.closed),
    printedAt: parseSlipTimestamp(parsed.printed),
    openedText: parsed.opened || null, closedText: parsed.closed || null,
    // A slip that prints no Transactions count comes back with the field
    // ABSENT, and Number(undefined) is NaN — which the callable cannot encode,
    // so Trophy Till 2's typed-total capture died as INTERNAL on 26 Sept 2026.
    // Unread is null: validateExtraction still refuses it on any capture
    // without a typed total.
    txnCount: Number.isFinite(Number(parsed.txnCount)) && parsed.txnCount !== null && parsed.txnCount !== ""
      ? Number(parsed.txnCount) : null,
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

// ── WHAT THE MODEL READ, ONE LINE PER EXTRACTION ─────────────────────────────
// One OCR call reads every photo of a capture together, so this is one line per
// extraction, not per photo. On 21 Sept a retake at Junid's till was refused
// after its TID matched and nothing said why. An ALLOWLIST of header fields and
// confidences — never a transaction line, PAN, RRN, UTI or auth code.
const LOGGED_HEADER_FIELDS = ["tid", "batchNo", "total", "purchases", "refunds", "cash", "opened", "closed", "txnCount", "confidence"];
function photoReadLogLine(picked, ocr) {
  const p = (ocr && ocr.parsed) || {};
  const header = Object.fromEntries(LOGGED_HEADER_FIELDS.map((k) => [k, p[k] ?? null]));
  return `cardBatchCapture: photo read picked=${picked} model=${ocr && ocr.model} attempts=${ocr && ocr.attempts} ${JSON.stringify(header)}`;
}
function refusalLogLine(picked, reason) {
  return `cardBatchCapture: extract refused picked=${picked || "(email)"} reason=${JSON.stringify(reason)}`;
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
  // Up to the RE-PRINT ceiling, the higher of the two caps: an idle till's
  // chain of empty re-prints runs past the correction cap (see
  // MAX_REPRINT_REVISIONS). Every other chain stops at its first gap long before.
  for (let rev = 1; rev <= MAX_REPRINT_REVISIONS; rev++) {
    const key = rev === 1 ? String(batchNo) : `${batchNo}-r${rev}`;
    const exists = (await db.ref(`${base}/${key}/batchKey`).once("value")).exists();
    if (!exists) break;
    keys.push(key);
  }
  return keys;
}

/**
 * The APPROVED lines of the capture currently in force for this batch — the
 * highest revision, which is the last key readBatchKeysFor found.
 *
 * Read so a fuller report of the same batch can be told from a re-send of it;
 * see comparePriorCapture. Only the three fields the comparison uses are kept,
 * because this runs on every second-and-later report of a batch and the whole
 * roll is not needed to answer whether one list contains another.
 *
 * RTDB HANDS BACK A SPARSE ARRAY AS AN OBJECT, and a dense integer-keyed one
 * as a real array WITH NULL HOLES (560 of 5,793 /stock rows were array-coerced
 * on 15 Sept 2026). Both shapes are walked, and null cells are skipped rather
 * than read — a hole is not a transaction.
 */
async function readRecordedLinesFor(db, storeId, tid, keys) {
  if (!keys.length) return [];
  const key = keys[keys.length - 1];
  const snap = await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${key}/lines`).once("value");
  const raw = snap.val();
  const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
  return rows
    .filter((r) => r && typeof r === "object")
    .map((r) => ({ tsn: Number(r.tsn), amountCents: Number(r.amountCents), rrn: r.rrn || "" }))
    .filter((r) => Number.isInteger(r.tsn));
}

/**
 * The slip of the capture in force for this batch (its highest revision), or
 * null — one small read, asked only when the line comparison has nothing to go
 * on.
 */
async function readRecordedSlipFor(db, storeId, tid, keys) {
  if (!keys.length) return null;
  const snap = await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${keys[keys.length - 1]}/slip`).once("value");
  return snap.val() || null;
}

/**
 * Is the capture in force for this batch a SETTLED EMPTY BATCH?
 *
 * Read from the record's own slip, never inferred from the line count: an empty
 * batch and a summary-only capture both have no lines, and only one of them may
 * be superseded automatically (comparePriorCapture's note has the whole case,
 * and Marathon Till 3 #84 on 29 Sept 2026 is why it is here).
 *
 * BOTH halves are required. `windowSource` is written only by
 * emptyBatchExtraction, and buildBatchRecord refuses a report wearing the flag
 * unless every figure on it is zero — so the total is already guaranteed. It is
 * re-checked anyway because this is the gate on overwriting a recorded figure,
 * and a gate that trusts one field is a gate that opens when that field is
 * mangled by a hand edit or a half-written record.
 */
const isSettledEmptyBatch = (slip) => !!slip && slip.windowSource === "empty-batch" && slip.totalCents === 0;

/**
 * Decide the write for a batch, reading what is already recorded.
 *
 * ONE place, used by both extract paths and by submit, so the three cannot
 * drift — the extract-time answer is the message the operator hears and the
 * submit-time answer is the guarantee, and they must agree about what counts
 * as a fuller report.
 *
 * A refusal caused by a CONTRADICTION says what the contradiction was. "Batch
 * #58 is already captured" is the right sentence for a re-send and the wrong
 * one for a report that disagrees with the record, which is a thing somebody
 * has to look at.
 */
async function resolveWriteFor(db, { storeId, tid, batchNo, correction, lines, totalCents = null, incoming = null }) {
  const existingKeys = await readBatchKeysFor(db, storeId, tid, batchNo);
  let comparison = null;
  // Where a later-day re-print of an empty batch opens — see emptyReprintOpensAt.
  let reprintOpensAt = null;
  let typedMetByReport = false;
  let lateOverTyped = false;
  if (existingKeys.length && !correction) {
    const recorded = await readRecordedLinesFor(db, storeId, tid, existingKeys);
    // Only asked when there is nothing to compare against — the one case where
    // the answer can change the relation, and one read saved on every other.
    const recordedSlip = recorded.length ? null : await readRecordedSlipFor(db, storeId, tid, existingKeys);
    comparison = comparePriorCapture(recorded, lines || [], { recordedEmptyBatch: isSettledEmptyBatch(recordedSlip) });
    reprintOpensAt = recorded.length ? null : emptyReprintOpensAt(recordedSlip, incoming);
    // A STAFF SLIP'S FILING NUMBER MET BY THE MACHINE'S OWN REPORT. A typed
    // total is filed under the next number after the terminal's highest
    // (planTypedCapture), so on a machine that also reports — by email, or a
    // manager's photo — the real report of that number arrives on top of it.
    // The real report is the better evidence and takes over as a later report
    // of the batch; the typed record and its photo are kept beneath it.
    if (!recorded.length && recordedSlip && recordedSlip.format === "typed"
        && incoming && incoming.format !== "typed") {
      typedMetByReport = true;
      // …unless the report is of an EARLIER day: yesterday's report arriving
      // late meets today's slip only because the slip took the next number.
      // It is recorded as the slip's REPLACEMENT (not a later report, which
      // would put yesterday's money on today), and the slip is kept beside it
      // (lib/card-supporting-slips.cjs inherits). (Fable spec review, #731.)
      if (Number.isFinite(incoming.closedAt) && Number.isFinite(recordedSlip.closedAt)
          && sastDayIndexOf(incoming.closedAt) < sastDayIndexOf(recordedSlip.closedAt)) {
        lateOverTyped = true;
      }
    }
    // THE SAME BATCH, RE-PRINTED UNCHANGED ON A LATER DAY. A terminal whose last
    // batch had sales and which takes nothing more may re-print that batch at
    // the next evening's settlement: every line identical, a later PRINT time.
    // That is the empty re-print's case with lines in it — the machine saying,
    // on that day, that nothing was added — and it is recorded the same way: a
    // later report of the batch, adding R0.00 on its own day. The PRINT time
    // decides, so a photo taken today of yesterday's printout is still a re-send.
    if (comparison.relation === "identical" && incoming && Number.isFinite(incoming.printedAt)) {
      const slip = await readRecordedSlipFor(db, storeId, tid, existingKeys);
      if (slip && Number.isFinite(slip.closedAt) && incoming.printedAt > slip.closedAt
          && sastDayIndexOf(incoming.printedAt) > sastDayIndexOf(slip.closedAt)
          && Number.isInteger(incoming.totalCents) && incoming.totalCents === slip.totalCents) {
        reprintOpensAt = slip.closedAt;
      }
    }
  }
  const write = resolveBatchWrite({
    existingKeys, batchNo, correction: correction || lateOverTyped,
    extends: lateOverTyped ? false : comparison ? comparison.relation === "extends" || reprintOpensAt !== null || typedMetByReport : false,
    maxRevisions: reprintOpensAt !== null ? MAX_REPRINT_REVISIONS : MAX_REVISIONS,
  });
  if (write.ok && reprintOpensAt !== null) return { existingKeys, comparison, write, reprintOpensAt };
  // ── A TOTALS-ONLY RECORD OF A BATCH THAT WAS STILL OPEN ──────────────────
  // A batch recorded from its totals alone (card-recon-pdf.cjs →
  // emailedTotalsOnly) has no lines, so a later, fuller report of the same
  // open batch cannot be shown to extend it and is not let through. But it
  // must not be filed as a harmless re-send either — "already captured" is
  // what the feed and the automatic re-run both treat as nothing to do, and
  // the later days' money would sit unrecorded behind it. A different total
  // gets its own sentence, which stays red until Junid looks.
  if (!write.ok && comparison && comparison.relation === "unknown" && Number.isInteger(totalCents) && existingKeys.length) {
    const slip = (await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${existingKeys.at(-1)}/slip`).once("value")).val() || {};
    if (/^stamps/.test(String(slip.windowSource || "")) && Number.isInteger(slip.totalCents) && slip.totalCents !== totalCents) {
      return { existingKeys, comparison, write: { ok: false,
        reason: `Batch #${batchNo} was recorded from its totals only, and this later report of it states a different total — the batch was probably still open when the first report came. Nothing was recorded — tell Junid.` } };
    }
  }
  if (!write.ok && comparison && comparison.reason &&
      (comparison.relation === "conflict" || comparison.relation === "shrinks")) {
    return { existingKeys, comparison, write: { ok: false,
      reason: `Batch #${batchNo} is already captured, and this report does not agree with it: ${comparison.reason}. Nothing was recorded — tell Junid, and keep the slip.` } };
  }
  return { existingKeys, comparison, write };
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

// [typed-capture:start] — see card-batch-numbers.test.cjs for why this region
// is held apart from that file's batch-number scan.
/**
 * This terminal's highest recorded batch, and what that record is — the whole
 * state the typed path needs to decide the next number and where its window
 * starts (planTypedCapture has the reasoning).
 *
 * ONE QUERY, bounded by the index the live rules already declare on this node
 * (`batchNo`, see rules-live-backup-*.json). Never a read of the whole
 * terminal: a machine on batch 530 has 530 records under it.
 *
 * A REVISION WEARS ITS BATCH'S NUMBER, so ordering by batchNo can land on
 * either `487` or `487-r2`; both carry the same batchNo, which is all the
 * caller reads, and the LATER CLOSE of the two is the one a window should
 * start from. limitToLast(2) is what makes that choice possible at all.
 *
 * THE RANGE IS WHAT MAKES "LAST" MEAN "HIGHEST" (CodeRabbit, PR #527).
 * RTDB's ordering runs null < booleans < numbers < STRINGS, so a record whose
 * batchNo is the string "12" sorts ABOVE every numeric one, however large.
 * With an unbounded limitToLast(2), two such records would be the two rows
 * returned and the real highest batch would not appear at all — this function
 * would then mint a number already in use. (It would be caught: the key
 * collides and resolveBatchWrite refuses as a duplicate. A refusal the owner
 * cannot explain is still the wrong answer.)
 *
 * Bounding the query by two NUMERIC endpoints excludes every non-numeric value
 * from the window, so what comes back is the highest numbers, by definition.
 * Nothing is migrated to achieve it: a legacy string-valued record is simply
 * not what this read is asking for, and readBatchKeysFor — which probes exact
 * KEYS, not values — still finds it when the duplicate guard looks.
 */
async function readLastBatchFor(db, storeId, tid) {
  const snap = await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}`)
    .orderByChild("batchNo")
    .startAt(0).endAt(Number.MAX_SAFE_INTEGER)
    .limitToLast(2).once("value");
  const rows = Object.values(snap.val() || {})
    .filter((r) => r && typeof r === "object" && Number.isInteger(Number(r.batchNo)));
  if (!rows.length) return { batchNo: null, openedAt: null, closedAt: null, typed: false, key: null, record: null };
  const highest = Math.max(...rows.map((r) => Number(r.batchNo)));
  // EVERY REVISION OF THE HIGHEST BATCH, not the two the range happened to
  // return: within one batchNo the children sort by KEY, and "545-r10" sorts
  // before "545-r2", so a chain of ten or more would hide its latest report.
  // equalTo on the indexed batchNo is that one batch's records, never more.
  const all = (await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}`).orderByChild("batchNo").equalTo(highest).once("value")).val();
  // Keyed: the record in force is what a staff slip is attached to.
  const ofHighest = Object.entries(all || {}).filter(([, r]) => r && typeof r === "object")
    .map(([key, r]) => ({ ...r, batchKey: r.batchKey || key }));
  if (!ofHighest.length) {
    ofHighest.push(...Object.entries(snap.val() || {})
      .filter(([, r]) => r && typeof r === "object" && Number(r.batchNo) === highest)
      .map(([key, r]) => ({ ...r, batchKey: r.batchKey || key })));
  }
  // A STAFF SLIP NEVER OUTRANKS THE MACHINE'S OWN REPORT of the same batch
  // (precedence machine > Junid > staff): its close is the 18:50 cut-off, a
  // stated time, and must not win "latest close" against a real report that
  // printed 18:49:58. (Sonnet review, #743.)
  if (ofHighest.some((r) => !isStaffSlipRecord(r))) {
    for (let i = ofHighest.length - 1; i >= 0; i--) if (isStaffSlipRecord(ofHighest[i])) ofHighest.splice(i, 1);
  }
  const closes = ofHighest.map((r) => Number(r.slip && r.slip.closedAt)).filter(Number.isFinite);
  // The latest close wins; at the same close, the higher revision (a
  // correction keeps the close of what it corrects — a manual entry may).
  const latest = ofHighest
    .filter((r) => !closes.length || Number(r.slip && r.slip.closedAt) === Math.max(...closes))
    .sort((a, b) => (Number(a.revision) || 1) - (Number(b.revision) || 1)).at(-1) || ofHighest[0];
  const opened = Number(latest.slip && latest.slip.openedAt);
  return {
    key: latest.batchKey,
    record: latest,
    batchNo: highest,
    // Where the record in force STARTED — what a correction must start from,
    // since it replaces that record's figure for the same trading period.
    openedAt: Number.isFinite(opened) ? opened : null,
    closedAt: closes.length ? Math.max(...closes) : null,
    typed: (latest.slip && latest.slip.format) === "typed",
  };
}

/**
 * A TYPED-TOTAL MACHINE'S WHOLE CAPTURE — one figure, no photograph, no OCR.
 *
 * Trophy Till 2 cannot email and does not print its total, so there is nothing
 * to photograph and nothing to read (Junid, 1 Oct 2026). What makes this safe
 * is not that it checks less, but that it INVENTS LESS THAN THE PATH IT
 * REPLACES: the window runs from the previous settlement to now, both real
 * instants, where anchorDeclaredWindow had to guess which day a bare clock time
 * belonged to — and when it guessed wrong, the till's money fell outside its
 * own window and was reported twice.
 *
 * ── WHO MAY DO THIS, AND WHY IT IS NOT mayDeclareTotal ──────────────────────
 * Anyone the `card_recon` permission already trusts to capture that till's
 * money (Junid, 1 Oct 2026): it is the machine's only capture route and has to
 * work on the evening the owner is not there. The owner's typed total beside a
 * photograph stays his alone and is untouched. This is bounded by the
 * registry, not by the caller: only a terminal an admin has set to "typed" can
 * be captured this way at all, and every such record says in its warnings that
 * no paper exists behind it.
 */
async function handleTypedCapture(db, request, { picked, terminal, slip = null, nowMs = Date.now() }) {
  let correction = !!request.data?.correction;
  const last = await readLastBatchFor(db, terminal.storeId, picked);
  // A STAFF SLIP IS FILED AGAINST ITS BATCH, not the minute it was sent
  // (Junid, 17 Oct 2026): the batch closes at the FNB cut-off of the slip's
  // trading day, so a slip sent at 16:24 still covers that batch's card sales
  // until 18:50, and the next batch opens where the bank's does.
  const closeAtMs = slip ? batchCloseOf(slipTradingDay(nowMs)) : null;
  const planFor = (asCorrection) => planTypedCapture({
    tid: picked,
    totalText: request.data?.declaredTotal,
    nowMs,
    lastBatchNo: last.batchNo,
    lastOpenedAt: last.openedAt,
    lastClosedAt: last.closedAt,
    lastWasTyped: last.typed,
    correction: asCorrection,
    closeAtMs,
  });
  let plan = planFor(correction);
  // A STAFF SLIP SENT TWICE IN ONE BATCH WINDOW IS A CORRECTION, never a
  // refusal and never a second batch (Junid, 16 Oct 2026): the person has no
  // "replace" button and must not need one. Same number, a new revision,
  // the same window as the entry it replaces — both kept.
  if (!plan.ok && slip && plan.code === "typed-today") {
    correction = true;
    plan = planFor(true);
  }
  if (!plan.ok) return reject(plan.reason);
  const { extraction, batchNo } = plan;

  const verdict = validateExtraction(extraction, { summaryOnly: true, source: "typed", declaredTotal: true });
  if (!verdict.ok) return reject(verdict.reason);

  const { write } = await resolveWriteFor(db, {
    storeId: terminal.storeId, tid: picked, batchNo, correction, lines: [],
  });
  if (!write.ok) return reject(write.reason);

  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
  });

  // ── WHAT THE RECORD SAYS ABOUT ITSELF ─────────────────────────────────────
  // Loudly, and first: there is no slip behind this figure and nobody can check
  // it against paper afterwards. A reader of this batch must never have to work
  // that out from the absence of a photo path.
  const who = request.auth.token?.email || request.auth.uid;
  const warnings = [
    slip
      ? `The total (${formatCents(extraction.totalCents)}) was typed in by ${who} from the slip, with a photo of the slip attached. The server did not read it off the slip — the photo is read in the background and any difference is shown here.`
      : `The total (${formatCents(extraction.totalCents)}) was typed in by ${who}. This machine is set to typed entry: there is no slip photo and no emailed report behind this figure, and nothing can be checked against paper afterwards.`,
    `Batch #${batchNo} is this record's filing number, not a number read off the machine — a typed capture never sees the terminal's own batch number.`,
    ...(slip ? [`Filed against the batch that closes at the FNB cut-off (${sastClock(extraction.closedAt)} on ${slipTradingDay(nowMs)}); the slip was sent at ${sastClock(nowMs)}.`] : []),
    ...(slip && correction ? [`This replaces the total sent earlier today for batch #${batchNo}; both are kept.`] : []),
    ...plan.warnings,
    ...verdict.warnings,
  ];
  const straddle = tillMoveWarning(picked, terminal, extraction.openedAt);
  if (straddle) warnings.push(straddle);

  const userDraftsRef = db.ref(`${CARD_BATCH_DRAFTS_PATH}/${request.auth.uid}`);
  const draftRef = userDraftsRef.push();
  const draftId = draftRef.key;
  // THE SLIP PHOTO, STORED BEFORE ANYTHING IS RECORDED and immutably, under
  // the draft's fresh id — the same place and shape as every photographed
  // slip, so the owner's report opens it like any other.
  const photoPaths = [];
  if (slip) {
    const bucket = slip.bucket || admin.storage().bucket(STORAGE_BUCKET);
    for (let i = 0; i < slip.photos.length; i++) {
      const path = `${PHOTO_STORAGE_PREFIX}/${draftId}/photo-${i}.jpg`;
      await bucket.file(path).save(slip.photos[i].buffer, {
        resumable: false,
        contentType: "image/jpeg",
        metadata: { cacheControl: "private, max-age=31536000, immutable" },
      });
      photoPaths.push(path);
    }
  }
  await draftRef.set({
    by: request.auth.uid,
    byEmail: request.auth.token?.email || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS,
    pickedTid: picked,
    summaryOnly: true,
    correction,
    warnings,
    photoPaths,
    // A STAFF SLIP: a typed total WITH its photo, sent under the per-till
    // scope rather than as Junid. Submit re-checks that scope, and that there
    // is exactly the one photo, before it records.
    slipSubmit: !!slip,
    // The flag submit re-checks against the registry before it records — a
    // draft cannot talk its own way out of needing a photograph.
    typedOnly: true,
    extraction: JSON.parse(JSON.stringify(extraction)),
    terminal: { storeId: terminal.storeId, tillId: terminal.tillId, label: terminal.label ?? null },
    reviewedExpectedCents: expected.cardCents,
    ocr: null,
    declaredTotal: {
      cents: extraction.totalCents, ocrReadCents: null,
      byUid: request.auth.uid, byEmail: request.auth.token?.email || null, at: Date.now(),
    },
  });

  // CAPTURE ONLY, exactly as the photo path returns: no expected figure and no
  // variance reach the handset — see the note on handleExtract's reply.
  return {
    ok: true,
    draftId,
    review: {
      tid: picked, mid: null, batchNo: Number(batchNo),
      revision: write.revision, supersedes: write.supersedes,
      terminal: { storeId: terminal.storeId, tillId: terminal.tillId, label: terminal.label ?? null },
      openedAt: extraction.openedAt, closedAt: extraction.closedAt, printedAt: extraction.printedAt,
      openedText: null, closedText: null,
      txnCount: null,
      purchasesCents: null, cashCents: null, refundsCents: null,
      totalCents: extraction.totalCents,
      reconLine: null, confidence: null, lineCount: 0,
      summaryOnly: true, totalDeclaredByHand: true, typedOnly: true,
      warnings,
    },
  };
}

// [typed-capture:end]

async function handleExtract(db, request, opts = {}) {
  const { photos, pdf, pickedTid, channel } = request.data || {};

  // ── A TOTAL DECLARED BY HAND — Junid's alone, and never without the paper ──
  // Checked FIRST, before a byte of OCR is paid for. See readDeclaredTotal in
  // lib/card-recon.cjs for the whole contract.
  const declaring = hasDeclaredTotal(request.data?.declaredTotal);
  let declared = null;
  if (declaring) {
    if (!mayDeclareTotal(request.auth?.token)) {
      throw new HttpsError("permission-denied", "Only Junid can type a batch total. Photograph the slip instead.");
    }
    if (channel === "email" || pdf) {
      throw new HttpsError("invalid-argument", "A typed total goes with a photo of the slip, never with a file.");
    }
    if (!Array.isArray(photos) || photos.length === 0) {
      return reject("A typed total is refused without a photo of the slip — the paper is the evidence. Nothing was recorded.");
    }
    declared = readDeclaredTotal(request.data.declaredTotal);
    if (declared.err) return reject(declared.err);
  }
  // A declared total is always summary-only: a slip that did not print its
  // total did not print a whole roll either.
  const summaryOnly = !!request.data?.summaryOnly || declaring;

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
    return handleExtractPdf(db, request, { picked: null, pdf, source: chosen.source, intake, bucket: opts.bucket });
  }
  if (channel !== undefined && channel !== "app") {
    throw new HttpsError("invalid-argument", "Unknown capture channel.");
  }

  const picked = normaliseTid(pickedTid);
  if (!picked) throw new HttpsError("invalid-argument", "Pick the till first.");

  if (chosen.source === "pdf") return handleExtractPdf(db, request, { picked, pdf, source: chosen.source, intake: null, bucket: opts.bucket });
  const decoded = photos.map(decodePhoto);

  // The terminal registry FIRST: an unmapped picked TID means setup, not OCR.
  const terminalsSnap = await db.ref(CARD_TERMINALS_PATH).once("value");
  const terminals = terminalsSnap.val() || {};
  const terminal = terminals[picked];
  if (!terminal || !terminal.storeId || !terminal.tillId) {
    return reject(`Terminal ${picked} is not registered under /config/cardTerminals — an admin must map it to its till before slips can be captured.`);
  }
  // A RETIRED MACHINE TAKES NO HAND CAPTURE. Its row stays (its batches are
  // filed under its TID and would be stranded by a delete), but there is no
  // longer a till to stand at, and a capture made against one is a slip filed
  // against a machine that left. The screen does not offer the card; this is
  // the half that holds when someone calls the callable anyway.
  if (isRetiredTerminal(terminal)) return reject(retiredCaptureRefusal(picked, terminal));
  // A TILL IN ANOTHER SECTION — before any OCR is paid for. See sectionRefusalFor.
  const walled = await sectionRefusalFor(db, request, picked, terminal);
  if (walled) return reject(walled);
  // AN EMAIL-ONLY MACHINE TAKES NO PHOTO. The screen shows it no camera; this
  // is the half that holds when an old bundle or a direct call sends one
  // anyway — before any OCR is paid for.
  if (!takesPhoto(terminal)) {
    return reject(`${terminal.label || picked} is set to Email only, so its report is not photographed — it ticks when the email arrives. Junid can change this in Card machines → settings.`);
  }

  // ── OCR ──
  let ocr;
  try {
    ocr = await liveOcr(decoded);
  } catch (err) {
    // ── THE SENTENCE THE MANAGER GETS IS THE POINT OF ALL THIS ──────────────
    // "Could not read the photos right now — try again." was the answer to
    // EVERY OCR failure, including an account with no money in it, and trying
    // again never once helped. Attaching the status to the error was only half
    // the fix; this is the half a person reads.
    //
    // THE LOG KEEPS THE DETAIL, THE SCREEN NEVER SEES IT. Google's body names
    // an internal billing account and links a console nobody at a till can
    // open, so it goes to Cloud Logging and no further.
    console.error(`cardBatchCapture: OCR failed: ${err.message}`
      + `${err.httpStatus ? ` [status=${err.httpStatus}]` : ""}`
      + `${err.body ? ` body=${String(err.body).slice(0, 300)}` : ""}`);
    // 402 is prepayment credits depleted; 429 is the same wall with a
    // different number on it (a depleted PREPAY account answers 429 to image
    // generation and 402 here, which is how one outage wore two faces for six
    // days). Both mean the same thing to the person holding the slip: this
    // will not work until somebody puts money in, so DO NOT retake the photo.
    if (err.httpStatus === 402 || err.httpStatus === 429) {
      // The backup reader failed too: said, with what it answered, so a
      // broken key never reads as "just top it up" (Sonnet review, #752).
      const backup = err.secondStatus ? ` The backup reader failed too (${err.secondStatus === "timeout" ? "it timed out" : `HTTP ${err.secondStatus}`}).` : "";
      throw new HttpsError("resource-exhausted",
        `The slip reader has run out of credit, so photographed slips cannot be read until it is topped up.${backup} `
        + "Retaking the photo will not help. Tell Junid — the machines that email their report are still recording normally.");
    }
    // 503 after every retry and the fallback: Google's reader is overloaded.
    // Not the signal, not the photo — and it passes, usually within minutes.
    if (err.httpStatus === 503) {
      throw new HttpsError("unavailable",
        "Google's slip reader is overloaded right now (it refused every attempt, on two models), so the photo could not be read. "
        + "It is not your signal and not the photo — wait a few minutes and tap the till again.");
    }
    // EVERY OTHER FAILURE STILL SAYS WHAT IT WAS. A reader that took too long
    // and one that answered with an error are different things to do about.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new HttpsError("deadline-exceeded",
        "Google's slip reader took over two minutes and gave up, so the photo was not read. "
        + "It is not your signal — try again in a few minutes.");
    }
    if (err.httpStatus) {
      throw new HttpsError("unavailable",
        `Google's slip reader answered with an error (HTTP ${err.httpStatus}), so the photo was not read. `
        + "It is not your signal and not the photo — try again in a few minutes, and tell Junid if it keeps happening.");
    }
    throw new HttpsError("unavailable",
      "The slip reader could not be reached from the server, so the photo was not read. "
      + "It is not your phone's signal — try again in a few minutes, and tell Junid if it keeps happening.");
  }
  // Cost is logged for EVERY billed call, rejected extractions included.
  const rate = OCR_RATES[ocr.model] || { in: IN_PER_MTOK_USD, out: OUT_PER_MTOK_USD };
  const costUSD = +((ocr.tokensIn / 1e6) * rate.in + (ocr.tokensOut / 1e6) * rate.out).toFixed(6);
  try {
    await db.ref(`aiAssistant/usage/${new Date().toISOString().slice(0, 10)}`).push({
      at: Date.now(), kind: "cardBatchOcr", by: request.auth.uid, model: ocr.model, attempts: ocr.attempts,
      photos: decoded.length, tokensIn: ocr.tokensIn, tokensOut: ocr.tokensOut, costUSD,
    });
  } catch (err) { console.warn("cardBatchCapture: usage log failed:", err.message); }

  if (!ocr.parsed) return reject("The photos could not be read as a batch report — retake them, filling the frame with the slip.");
  const extraction = toExtraction(ocr.parsed);
  console.log(photoReadLogLine(picked, ocr));
  // What the reader made of the total, kept beside the typed one — on a
  // half-printed slip this is normally null, and when it is not, the owner can
  // see both.
  const ocrReadCents = Number.isInteger(extraction.totalCents) ? extraction.totalCents : null;

  // ── THE TID DECIDES, NOT THE PICKER — a wrong slip rejects itself ──
  // The model's RAW answer is logged on a TID refusal. On 20 Sept Marathon
  // Till 2's slip was refused here and nothing recorded what the model had
  // actually returned, so the cause could not be established afterwards.
  if (!extraction.tid || extraction.tid !== picked) {
    console.warn(`cardBatchCapture: TID refusal picked=${picked} raw=${JSON.stringify(ocr.parsed.tid)}`
      + ` conf=${JSON.stringify((ocr.parsed.confidence || {}).tid)} batch=${JSON.stringify(ocr.parsed.batchNo)}`
      + ` model=${ocr.model} tokensOut=${ocr.tokensOut}`);
  }
  // ── A HAND-DECLARED SLIP MAY PRINT NO TID, AND TIMES WITHOUT DATES ─────────
  // The typed-total path exists for the slip that did not print everything
  // (Trophy Till 2, 26 Sept 2026: no TID, "19:00:05" → "16:17:36"). A slip
  // that prints NO TID is filed under the till Junid tapped; one that prints a
  // DIFFERENT TID is still refused below — that is the wrong slip. Every
  // substitution is said on the record.
  const declaredNotes = [];
  if (declared && !extraction.tid) {
    extraction.tid = picked;
    declaredNotes.push("The slip printed no terminal ID, so this batch is filed under the till that was tapped.");
  }
  if (declared && (!Number.isInteger(extraction.openedAt) || !Number.isInteger(extraction.closedAt)
      || extraction.closedAt <= extraction.openedAt)) {
    const w = anchorDeclaredWindow({ openedText: extraction.openedText, closedText: extraction.closedText, nowMs: Date.now() });
    extraction.openedAt = w.openedAt;
    extraction.closedAt = w.closedAt;
    extraction.windowSource = w.windowSource;
    declaredNotes.push(w.windowSource === "declared-time-only"
      ? "The slip printed its Opened/Closed times without dates; the close was placed on the capture day and the open on the day before it where needed."
      : "The slip's Opened/Closed times could not be read, so the window is the 24 hours before this capture.");
  }
  if (!extraction.tid) return reject("No terminal ID could be read off the slip — retake the header photo.");
  // An O read for a 0 (or I for 1) on the PICKED till's own TID is that TID.
  // From here on the record carries the registry's spelling, never the misread.
  if (extraction.tid !== picked && slipTidMatchesPicked(extraction.tid, picked, Object.keys(terminals))) {
    extraction.tid = picked;
  }
  if (extraction.tid !== picked) {
    const mapped = terminals[extraction.tid];
    const where = mapped && mapped.label ? ` (that slip belongs to ${mapped.label})` : mapped ? ` (that slip belongs to ${mapped.storeId}/${mapped.tillId})` : " — and that TID is not registered at all";
    return reject(`This slip prints TID ${extraction.tid}, not the till you picked${where}. Capture the slip on its own till.`);
  }

  // THE TOTAL ONLY, and only now that the slip has proved which till it is.
  if (declared) extraction.totalCents = declared.cents;

  // Overlapping photos collapse; conflicting readings refuse.
  if (!summaryOnly) {
    const dedup = dedupeLines(extraction.lines);
    if (!dedup.ok) return reject(dedup.reason);
    extraction.lines = dedup.lines;
  } else {
    extraction.lines = [];
  }

  const verdict = validateExtraction(extraction, { summaryOnly: !!summaryOnly, declaredTotal: declaring });
  if (!verdict.ok) return reject(verdict.reason);

  // Duplicate check at extract time so the operator hears it BEFORE reviewing.
  // The submit transaction re-checks — this one is for the message, that one
  // is the guarantee.
  const batchNo = normaliseBatchNo(extraction.batchNo);
  const { write } = await resolveWriteFor(db, {
    storeId: terminal.storeId, tid: extraction.tid, batchNo,
    correction: !!request.data.correction, lines: extraction.lines, totalCents: extraction.totalCents,
    incoming: extraction,
  });
  if (!write.ok) return reject(write.reason);

  // ── EXPECTED — the POS ledger's answer for the slip's own window ──
  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
    ...slackFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: /-to-print$/.test(extraction.windowSource || "")
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
  // A WINDOW THAT SPANS A TILL REASSIGNMENT cannot produce a trustworthy
  // expected figure — the reasoning is in tillMoveWarning (lib/card-terminals.cjs).
  // Said out loud on the record rather than left to be chased as an ordinary
  // variance on the one batch most likely to be looked at.
  const straddle = tillMoveWarning(extraction.tid, terminal, extraction.openedAt);
  if (straddle) warnings.push(straddle);
  if (declared) {
    warnings.unshift(...declaredNotes);
    warnings.unshift(`The total (${formatCents(declared.cents)}) was typed by ${request.auth.token?.email || request.auth.uid}, not read off the slip — the slip did not print it. Nobody has verified it against paper.`);
  }

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
  const photoPaths = [];
  // A BACKGROUND READ (processReadJob) hands over the paths its photos were
  // stored under the moment they arrived — they are the same bytes, so they are
  // not stored a second time under the draft.
  const stored = Array.isArray(opts.storedPhotoPaths) && opts.storedPhotoPaths.length === decoded.length
    ? opts.storedPhotoPaths : null;
  if (stored) photoPaths.push(...stored);
  const bucket = stored ? null : admin.storage().bucket(STORAGE_BUCKET);
  for (let i = 0; !stored && i < decoded.length; i++) {
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
    ocr: { model: ocr.model, tokensIn: ocr.tokensIn, tokensOut: ocr.tokensOut, costUSD },
    // Who typed the total, when, and what the reader made of it. Server-written
    // (the drafts node is owner-only by rule) and re-checked at submit.
    declaredTotal: declared ? {
      cents: declared.cents, ocrReadCents,
      byUid: request.auth.uid, byEmail: request.auth.token?.email || null, at: Date.now(),
    } : null,
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
      totalDeclaredByHand: !!declared,
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
// ─── WHICH TERMINAL WAS REFUSED ──────────────────────────────────────────────
// A REFUSAL HAS TO NAME ITS TILL, or it cannot be shown against one.
//
// On the email channel nobody picks a till: the PDF's own printed TID is the
// routing key. So until the file is parsed there is no terminal to blame — but
// AFTER it is parsed there always is, and every refusal from that point on was
// still answering `{ ok:false, reason }` and nothing else.
//
// The cost was exact. On 19 Sept 2026 all 24 refused attachments on file
// carried no TID, against 53 of 53 recorded ones that did — so the poller wrote
// "refused" rows the capture screen could not attribute to any card, and
// Marathon Till 1's refusal was invisible for a day. The TID is stamped on the
// way out here rather than at each of the dozen `reject` sites inside, so a
// refusal added later cannot forget to carry it.
async function handleExtractPdf(db, request, opts) {
  const seen = { tid: null };
  const out = await handleExtractPdfBody(db, request, opts, seen);
  if (out && out.ok === false && !out.tid && seen.tid) return { ...out, tid: seen.tid };
  return out;
}

async function handleExtractPdfBody(db, request, { picked, pdf, source, intake, bucket = null }, seen) {
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
    // Retired: same refusal as the photo path. The EMAIL path deliberately does
    // NOT refuse — see lib/card-recon-email.cjs. A late final batch that
    // arrives by itself is money that still has to reconcile.
    if (isRetiredTerminal(pickedTerminal)) return reject(retiredCaptureRefusal(picked, pickedTerminal));
    // A picked till in another section. The email path has no pick and is
    // gated by its own flag — see sectionRefusalFor.
    const walled = await sectionRefusalFor(db, request, picked, pickedTerminal);
    if (walled) return reject(walled);
  }

  const text = await pdfToLines(buffer);
  if (!text.ok) return reject(text.reason);
  // THE WHOLE PURE PDF PATH — parse, line dedupe, every validation, and the
  // totals-only fallback when only the transaction list failed — in one call
  // the real-report corpus test measures too (lib/card-recon-pdf.cjs).
  const read = readSlipPdfLines(text.lines);
  if (!read.ok) return reject(read.reason);
  const extraction = read.extraction;
  // TRUE only for an emailed report whose list would not read but whose
  // identity and both totals blocks did: recorded summary-only, never with a
  // figure the report does not print.
  const summaryOnly = read.summaryOnly === true;
  // From here on every refusal can name its terminal — see handleExtractPdf.
  seen.tid = normaliseTid(extraction.tid) || null;

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

  // ── AN EMPTY BATCH SPANS BACK TO THE BATCH BEFORE IT ──────────────────────
  // It prints no transactions and so no span of its own, but it DOES say "no
  // card was taken on this machine since the last settlement". The window is
  // therefore the previous batch's close → this report's print, so a card leg
  // the till rang in that gap shows up as this batch's variance instead of
  // falling between two windows unseen. With no previous batch on file (or one
  // more than a week back), the 1 ms window at print time stands.
  if (extraction.emptyBatch === true) {
    const prevNo = Number(normaliseBatchNo(extraction.batchNo)) - 1;
    if (prevNo > 0) {
      // THE REVISION IN FORCE, not the bare key: a batch reported twice
      // (58 → 58-r2) closed when its FULLER report says it did.
      // A READ THAT FAILS REFUSES — recording R0 over a window that could not
      // be worked out would hide the very gap this exists to show. The poller
      // records the refusal and the file can be re-run.
      let prevClosed;
      try {
        const keys = await readBatchKeysFor(db, terminal.storeId, extraction.tid, String(prevNo));
        prevClosed = keys.length
          ? (await db.ref(`${CARD_BATCHES_PATH}/${terminal.storeId}/${extraction.tid}/${keys.at(-1)}/slip/closedAt`).once("value")).val()
          : null;
      } catch (err) {
        console.error("cardBatchCapture: previous batch read failed:", err.message);
        return reject(`Batch ${extraction.batchNo} is an empty batch, and the batch before it could not be read to place it. Nothing was recorded — it can be re-run once the database answers.`);
      }
      const opened = emptyBatchOpenedAt(prevClosed, extraction.printedAt);
      if (opened !== null) {
        extraction.openedAt = opened;
        extraction.openedFrom = "previous-batch";
      }
    }
  }


  // The dedupe and every validation already ran inside readSlipPdfLines — on
  // the window the DOCUMENT gives. An empty batch's window may have just been
  // widened back to the previous batch's close, so the window that will
  // actually bound the ledger read is validated again here, before it is
  // used. Every other capture validates identically the second time.
  const verdict = validateExtraction(extraction, { summaryOnly, source: "pdf" });
  if (!verdict.ok) return reject(verdict.reason);
  // The pure path's warnings (a totals-only note, the long-batch note) are
  // the ones to keep: summary-only validation adds a generic line of its own
  // that the totals-only warning already says better.
  verdict.warnings = read.warnings;
  const batchNo = normaliseBatchNo(extraction.batchNo);
  const { write, reprintOpensAt } = await resolveWriteFor(db, {
    storeId: terminal.storeId, tid: extraction.tid, batchNo,
    correction: !!request.data.correction, lines: extraction.lines, totalCents: extraction.totalCents,
    incoming: extraction,
  });
  if (!write.ok) return reject(write.reason);
  // ── AN EMPTY BATCH RE-PRINTED ON A LATER DAY — that day's report ──────────
  // See emptyReprintOpensAt. Its window runs from the report on file to this
  // print, so a card leg rung in between is this day's variance, never lost.
  // Bounded by the same 7-day cap as any empty batch; past it, the window
  // computed above stands (and the POS report anchors it the same way).
  if (reprintOpensAt !== null) {
    // An EMPTY batch has no span of its own, so its window is the report on
    // file → this print. A batch with lines keeps the window its lines give;
    // the report's own day is still told apart by the POS report (it adds R0).
    const opened = extraction.emptyBatch === true ? emptyBatchOpenedAt(reprintOpensAt, extraction.printedAt) : null;
    if (opened !== null) {
      extraction.openedAt = opened;
      extraction.openedFrom = "previous-report";
    }
    verdict.warnings = [
      opened !== null || extraction.emptyBatch !== true
        ? `The terminal re-printed batch #${batchNo} on a later day with no card taken since its last report — recorded as R0.00 for this day, as a later report of the same batch.`
        : `The terminal re-printed batch #${batchNo} more than 7 days after its last report — recorded as R0.00 for this day, but its window could not reach back to that report.`,
      ...verdict.warnings,
    ];
  }

  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
    edgeMs: edgeMsFor(extraction),
    ...slackFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: /-to-print$/.test(extraction.windowSource || "")
      ? extraction.lastTxnAt ?? null
      : null,
  });
  // The summary first: the transactions are only looked at if it disagrees.
  const reconciledByTotals = totalsAgree(extraction, expected);
  const match = reconciledByTotals
    ? null
    : await matchBatch(db, { extraction, terminal, summaryOnly });

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
  // The same guard as the photo path.
  const straddleTill = tillMoveWarning(extraction.tid, terminal, extraction.openedAt);
  if (straddleTill) warnings.push(straddleTill);
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
  // `bucket` is a test seam only; production always stores to the real one.
  await (bucket || admin.storage().bucket(STORAGE_BUCKET)).file(pdfPath).save(buffer, {
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
    summaryOnly,
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
      summaryOnly,
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

  // A TOTAL DECLARED BY HAND is re-checked like everything else: still the
  // owner at the moment of record, still the figure on the draft, still
  // summary-only, still a photograph.
  const declaredTotal = draft.declaredTotal || null;
  // ── A TYPED-ONLY CAPTURE IS A DIFFERENT CONTRACT ──────────────────────────
  // No photograph, and not the owner's alone — but it is only ever allowed for
  // a machine the REGISTRY says is captured that way, and the registry is read
  // again HERE rather than taken from the draft. A draft that claims to be
  // typed-only against a machine that takes photographs is refused: that is the
  // one way this could otherwise become a route around the camera for every
  // till. (Read fresh for the same reason the terminal mapping is — a draft is
  // never allowed to vouch for itself.)
  const typedOnly = draft.typedOnly === true;
  // A STAFF SLIP (action "slip"): a typed total WITH exactly one photo, sent
  // under the per-till scope. The scope is read again HERE, as the registry is
  // — a till taken off the account between the two halves stops the record.
  const slipSubmit = typedOnly && draft.slipSubmit === true;
  const draftPhotos = Array.isArray(draft.photoPaths) ? draft.photoPaths.filter(Boolean)
    : Object.values(draft.photoPaths || {}).filter(Boolean);
  if (typedOnly) {
    const row = (await db.ref(`${CARD_TERMINALS_PATH}/${extraction.tid}`).once("value")).val();
    const intact = !!declaredTotal && Number.isInteger(declaredTotal.cents)
      && declaredTotal.cents === extraction.totalCents
      && draft.summaryOnly === true && draft.capturedVia !== "pdf" && !draft.intake
      && extraction.format === "typed"
      && (slipSubmit
        ? draftPhotos.length === 1 && draftPhotos.every((p) => typeof p === "string" && p.startsWith(`${PHOTO_STORAGE_PREFIX}/${draftId}/`))
        : draftPhotos.length === 0);
    const allowed = !!row && (slipSubmit
      ? await slipScopeAllowsNow(db, request, row, Date.now())
      : mayDeclareTotal(request.auth?.token) && typesTotal(row));
    if (!allowed || isRetiredTerminal(row) || !intact) {
      await draftRef.remove().catch(() => {});
      return reject("This typed total could not be verified against the machine it was typed for — nothing was recorded. Try again.");
    }
  } else if (declaredTotal) {
    const intact = Number.isInteger(declaredTotal.cents) && declaredTotal.cents === extraction.totalCents
      && draft.summaryOnly === true && draft.capturedVia !== "pdf" && !draft.intake
      && Array.isArray(draft.photoPaths) && draft.photoPaths.length > 0;
    if (!mayDeclareTotal(request.auth?.token) || !intact) {
      await draftRef.remove().catch(() => {});
      return reject("This capture's typed total could not be verified — nothing was recorded. Photograph the slip and type the total again.");
    }
  }

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
        // A typed capture has no OCR confidence to gate — see validateExtraction.
        source: typedOnly ? "typed" : (draft.capturedVia === "pdf" ? "pdf" : "photo"),
        declaredTotal: !!declaredTotal,
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
  // RETIREMENT IS PART OF THAT RE-CHECK, and it has to be asked SEPARATELY —
  // retiring a machine changes neither its storeId nor its tillId, so the
  // re-validation above is blind to it. Without this, a slip extracted moments
  // before an admin retires the machine was still recorded against a terminal
  // that had left: the refusal was only ever as strong as the gap between
  // extract and submit, during a swap, which is the exact moment this mechanism
  // exists for.
  //
  // IT ASKS ONLY OF A HAND CAPTURE, and the position of this block is the whole
  // reason it is correct. A retired terminal's EMAILED slip is deliberately
  // RECORDED, with the retirement said out loud on it (lib/card-recon-email.cjs)
  // — a late final settlement is money that still has to reconcile, and
  // dropping it to make a point about tidiness is the worse answer. An earlier
  // version of this guard sat above, before the draft's provenance had been
  // read, and so refused the emailed slip too: a fix for one path that quietly
  // broke the other. (CodeRabbit, PR #611.)
  if (!draftIntake && mapped && isRetiredTerminal(mapped)) {
    await draftRef.remove().catch(() => {});
    return reject(retiredCaptureRefusal(extraction.tid, mapped));
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
    ...slackFor(extraction),
    // Only a window that runs past its last transaction has a tail worth
    // reporting — see the tail note in lib/card-expected.cjs.
    tailFromMs: /-to-print$/.test(extraction.windowSource || "")
      ? extraction.lastTxnAt ?? null
      : null,
  });
  // The summary first: the transactions are only looked at if it disagrees.
  const reconciledByTotals = totalsAgree(extraction, expected);
  const match = reconciledByTotals
    ? null
    : await matchBatch(db, { extraction, terminal, summaryOnly: !!draft.summaryOnly });
  // The straddle warning is recomputed HERE too, against the registry as it
  // stands now: the till move can land between extract and submit, and the
  // record is written from this side. The draft's own warnings are kept — this
  // adds to them without replacing what extract saw.
  // `mapped`, not the draft's copy of the terminal: the move can land between
  // extract and submit, and this is the side the record is written from. It is
  // non-null by here — the re-validation above rejects an unmapped TID.
  const straddleNow = tillMoveWarning(extraction.tid, mapped, extraction.openedAt);

  // Re-resolve the key against NOW's children, then guarantee append-only with
  // a transaction on the exact key: existing data aborts, never overwritten.
  const tidRef = db.ref(`${CARD_BATCHES_PATH}/${terminal.storeId}/${extraction.tid}`);
  const { write } = await resolveWriteFor(db, {
    storeId: terminal.storeId, tid: extraction.tid, batchNo,
    correction: !!draft.correction, lines: extraction.lines, totalCents: extraction.totalCents,
    // The same answer extract gave: an empty batch re-printed on a later day
    // is a later report of it (emptyReprintOpensAt), on either side.
    incoming: extraction,
  });
  if (!write.ok) return reject(write.reason);

  const record = buildBatchRecord({
    extraction, terminal, tid: extraction.tid, match, reconciledByTotals,
    batchKey: write.key, revision: write.revision, supersedes: write.supersedes,
    autoSuperseded: !!write.autoSuperseded,
    photoPaths: slipSubmit ? draftPhotos : draft.photoPaths,
    summaryOnly: !!draft.summaryOnly,
    // The draft's warnings PLUS anything only now can know. Deduped, because
    // extract computed the straddle too and the same sentence twice on one
    // record reads like two findings.
    warnings: [...new Set([...(draft.warnings || []), ...(straddleNow ? [straddleNow] : [])])],
    expected,
    cashiers: expected.cashiers,
    submittedBy: { uid: request.auth.uid, email: request.auth.token?.email || null },
    submittedAt: Date.now(),
    draftId,
    ocr: draft.ocr || null,
    // HOW THIS RECORD CAME TO EXIST, as a fact about it for ever. "typed" is
    // its own value and not a flavour of "photo": a reader asking what evidence
    // sits behind a figure must get the honest answer from this field alone.
    capturedVia: typedOnly ? "typed" : (draft.capturedVia === "pdf" ? "pdf" : "photo"),
    pdfPath: draft.pdfPath || null,
    intake: draftIntake,
    // WHO and WHEN come from the verified caller at the moment of record, never
    // from the draft: the drafts node is owner-writable, so a draft cannot be
    // trusted to say who typed the figure. mayDeclareTotal has just proved this
    // caller is the owner. (CodeRabbit, PR #649.)
    declaredTotal: declaredTotal ? {
      cents: declaredTotal.cents,
      ocrReadCents: Number.isInteger(declaredTotal.ocrReadCents) ? declaredTotal.ocrReadCents : null,
      byUid: request.auth.uid,
      byEmail: request.auth.token?.email || null,
      at: Date.now(),
      // A staff slip says so: typed by the person given that till, with the
      // photo on the record beside it (capturedVia stays "typed").
      ...(slipSubmit ? { via: "staff-slip" } : {}),
    } : null,
  });

  // A STAFF SLIP THIS RECORD TAKES OVER FROM stays beside it, as a supporting
  // slip — the machine's report of its filing number, or Junid's correction,
  // outranks it but must not hide what was typed (lib/card-supporting-slips.cjs).
  const carried = await carriedSlipsFor(db, terminal.storeId, extraction.tid, write.supersedes, record);
  if (carried) record[SUPPORTING_FIELD] = carried;

  const txn = await tidRef.child(write.key).transaction((cur) => {
    if (cur !== null) return undefined; // exists → abort, never overwrite
    return JSON.parse(JSON.stringify(record));
  });
  if (!txn.committed) {
    return reject(`Batch #${batchNo} for this terminal was captured by someone else a moment ago.`);
  }
  // A slip attached to the superseded record between the read above and this
  // write is brought across now (attachSupportingSlip does the same from its side).
  if (write.supersedes) await syncCarried(db, `${CARD_BATCHES_PATH}/${terminal.storeId}/${extraction.tid}`, write.supersedes, write.key);
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

/** The supporting slips a new record inherits from the one it supersedes (one read), or null. */
async function carriedSlipsFor(db, storeId, tid, supersedesKey, successor) {
  if (!supersedesKey) return null;
  const prev = (await db.ref(`${CARD_BATCHES_PATH}/${storeId}/${tid}/${supersedesKey}`).once("value")).val();
  return carriedSlips(prev, supersedesKey, successor);
}

// ─── ONE TILL'S DAILY SLIP, FROM THE PERSON GIVEN THAT TILL ─────────────────
// Junid, 16 Oct 2026: Yasmin sends Marathon PE Till 2's slip, Amanda Trophy
// Till 2's. What they send is a photo of the speedpoint slip and the card
// TOTAL it prints, typed (0 when nothing was taken on card). What they get
// back is "Sent" — no expected figure, no variance, no verdict, the same
// capture-only rule as every manager screen.
//
// NOT A NEW CAPTURE PATH. It is the typed-total capture (handleTypedCapture
// → planTypedCapture → validateExtraction → the draft → handleSubmit), with
// the photo stored on the record and two differences, both server-side:
//   • the gate is the PER-TILL SCOPE (slipScopeAllowsNow), not `card_recon`
//     and not "Junid only" — refused for any till outside it;
//   • a second slip for the same batch is recorded as a correction (a new
//     revision of that batch), never refused and never dropped.
// The verdict on the record is the owner's report's (matcher.js, R5
// tolerance), and the photo is read in the background (a "check" job) only to
// tell Junid when it disagrees with the typed figure — never to block.
// ─── WHICH TILLS ARE MINE — over HTTP, not the database socket ───────────────
// Junid, 17 Oct 2026: on a shop phone the Card Slip screen took ~47 s to open,
// because its 2 KB registry listen queued on the one RTDB connection behind
// the app's ~6 MB first load (products, orders). A callable is its own HTTP
// request, so nothing queues in front of it. It answers ONLY the caller's own
// tills (their per-till scope, resolved against where each machine stands
// now): the machine id, the label and whether its total is typed. Never a
// figure, never another till.
async function handleSlipTills(db, request, deps = {}) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  const nowMs = (deps.now || Date.now)();
  const [rawScope, terminals] = await Promise.all([
    db.ref(`users/${uid}/${SLIP_SCOPE_FIELD}`).once("value").then((s) => s.val()),
    db.ref(CARD_TERMINALS_PATH).once("value").then((s) => s.val() || {}),
  ]);
  const scope = readSlipScope(rawScope);
  const dayYmd = slipTradingDay(nowMs);
  const tills = [];
  for (const [tid, row] of Object.entries(terminals)) {
    if (!row || !row.storeId || !row.tillId || isRetiredTerminal(row)) continue;
    const here = tillAt(row, nowMs);
    const storeId = here.storeId || row.storeId;
    const tillId = here.tillId || row.tillId;
    if (!slipScopeAllows(scope, { storeId, tillId })) continue;
    tills.push({ tid, filedStoreId: row.storeId, storeId, tillId, label: here.label || row.label || `${storeId} · ${tillId}`, typed: typesTotal(row) });
  }
  // A GRANTED TILL NO MACHINE STANDS AT is said out loud, never dropped
  // quietly: the screen tells the person to call Junid, and the log carries
  // the alarm (18 Oct 2026 — one till must only ever have one identity).
  for (const key of scope) {
    if (!tills.some((t) => `${t.storeId}/${t.tillId}` === key)) {
      console.error(`CARD_SLIP_SCOPE_ORPHAN uid=${uid} till=${key}: no registered card machine stands at this till — the person cannot send its slip`);
    }
  }
  // TODAY'S SLIP IS IN — one leaf per till (their own tills only), from the
  // log every accepted staff slip writes. When it arrived, never a figure.
  // A log that cannot be read leaves `sent` unknown (undefined), never "no".
  // Each read is bounded (CodeRabbit, #743): one slow read leaves its own
  // till unknown and never holds the answer for the others.
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms).unref?.())]);
  await Promise.all(tills.map(async (t) => {
    try {
      const last = latestStaffSlip((await within(db.ref(staffSlipDayPath({ storeId: t.filedStoreId, tid: t.tid, dayYmd })).once("value"), deps.readMs || SLIP_TILLS_READ_MS)).val());
      t.sent = last ? { at: Number(last.at) } : null;
    } catch (err) {
      console.warn(`slipTills: staff slip log unread for ${t.tid}: ${err && err.message}`);
    }
    delete t.filedStoreId;
  }));
  tills.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return { ok: true, tills, dayYmd };
}

const SLIP_TILLS_READ_MS = 4000;
const SLIP_PHOTOS = 1;
async function handleSlip(db, request, deps = {}) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  const data = request.data || {};
  const picked = normaliseTid(data.pickedTid);
  if (!picked) throw new HttpsError("invalid-argument", "This account's till could not be found. Ask Junid.");
  if (!Array.isArray(data.photos) || data.photos.length !== SLIP_PHOTOS) {
    throw new HttpsError("invalid-argument", "Take one photo of the slip.");
  }
  // One registry row, never the registry.
  const terminal = (await db.ref(`${CARD_TERMINALS_PATH}/${picked}`).once("value")).val();
  if (!terminal || !terminal.storeId || !terminal.tillId) {
    return reject("This till's card machine is not set up yet — nothing was recorded. Tell Junid.");
  }
  if (isRetiredTerminal(terminal)) return reject(retiredCaptureRefusal(picked, terminal));
  const nowMs = (deps.now || Date.now)();
  if (!(await slipScopeAllowsNow(db, request, terminal, nowMs))) {
    throw new HttpsError("permission-denied", "This account can only send the slip for its own till.");
  }
  // WHAT A SLIP CARRIES (Junid, 17 Oct 2026): a typed-total till (Trophy Till
  // 2 — its paper has no total) sends the photo AND the typed figure; every
  // other till (Marathon PE Till 2) sends the PHOTO ONLY, and its total is read
  // off the photo exactly as a manager's photographed slip is — stored first,
  // read in the background, recorded, or marked Unread for Junid
  // (handleReceive). Gated above by the per-till scope, never by card_recon.
  if (!hasDeclaredTotal(data.declaredTotal)) {
    if (typesTotal(terminal)) {
      throw new HttpsError("invalid-argument", "Type the card total on the slip — 0 if there were no card sales.");
    }
    return handleReceive(db, request, { ...deps, staffSlip: true });
  }
  const decoded = data.photos.map(decodePhoto);
  // A PHOTO, not any bytes: the screen always sends a JPEG (slipPhoto.js), and
  // it is stored as one and read by the slip reader.
  if (!decoded.every((d) => d.buffer.length > 3 && d.buffer[0] === 0xff && d.buffer[1] === 0xd8 && d.buffer[2] === 0xff)) {
    throw new HttpsError("invalid-argument", "That is not a photo. Take a photo of the slip.");
  }
  // A BETTER FIGURE FOR TODAY IS ALREADY IN — the machine's own report (by
  // email, or a manager's photo) or Junid's (typed, or a manual entry). The
  // slip is NEVER refused for that (Junid, 16 Oct 2026): it is attached to
  // that record as a supporting slip, photo and typed total, and the record's
  // figure stays the one the verdict uses. Filing it as the next batch instead
  // would read as a day's takings too many. Their own earlier slip today is
  // corrected instead (handleTypedCapture); nothing today, and the slip is the
  // day's record. Precedence: machine report > Junid > staff typed.
  const last = await readLastBatchFor(db, terminal.storeId, picked);
  if (shouldAttach(last, nowMs)) {
    return attachSupportingSlip(db, request, { terminal, picked, inForce: last, photos: decoded, nowMs, bucket: deps.bucket });
  }
  const drafted = await handleTypedCapture(db, request, {
    picked, terminal, nowMs, slip: { photos: decoded, bucket: deps.bucket || null },
  });
  if (!drafted || drafted.ok !== true) return drafted;
  const done = await handleSubmit(db, { auth: request.auth, data: { action: "submit", draftId: drafted.draftId } });
  if (!done || done.ok !== true) {
    // Nothing was recorded, so the stored photo is evidence of nothing — remove
    // it rather than leave an orphan per refused attempt.
    const bucket = deps.bucket || admin.storage().bucket(STORAGE_BUCKET);
    for (let i = 0; i < decoded.length; i++) {
      try { await bucket.file(`${PHOTO_STORAGE_PREFIX}/${drafted.draftId}/photo-${i}.jpg`).delete(); } catch { /* best effort */ }
    }
    return done;
  }
  console.log(`cardBatchCapture: slip recorded picked=${picked} key=${done.batchKey} by=${uid}`);
  const receipt = await logStaffSlip(db, request, {
    kind: "record", terminal, picked, nowMs, batchKey: done.batchKey,
    photos: decoded.map((_, i) => `${PHOTO_STORAGE_PREFIX}/${drafted.draftId}/photo-${i}.jpg`),
  });
  // THE PHOTO IS READ IN THE BACKGROUND, only to tell Junid when the slip says
  // something other than what was typed. Queued AFTER the record exists, and a
  // failure to queue never un-sends the slip: the record and its photo stand.
  try {
    await queueSlipCheck(db, { terminal, picked, batchKey: done.batchKey, nowMs: (deps.now || Date.now)() });
  } catch (err) {
    console.error(`cardBatchCapture: slip check not queued for ${picked}/${done.batchKey}: ${err && err.message}`);
  }
  // "Sent" — and nothing about the figure, the batch or how it compares.
  return { ok: true, received: true, receipt };
}

/**
 * The staff-slip log entry (lib/card-staff-slip-log.cjs) for a slip already
 * kept — the record or the supporting slip is the write that counts, so a log
 * that fails to write is said in the log and never un-sends the slip. Returns
 * the receipt the phone shows "Sent" against: when, and for which day.
 */
async function logStaffSlip(db, request, { kind, terminal, picked, nowMs, photos, batchKey = null, slipId = null }) {
  const dayYmd = slipTradingDay(nowMs);
  // Twice, then said loudly: the slip itself is kept either way.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const here = tillAt(terminal, nowMs);
      const ref = db.ref(staffSlipDayPath({ storeId: terminal.storeId, tid: picked, dayYmd })).push();
      await ref.set(staffSlipEntry({
        kind, storeId: terminal.storeId, tid: picked, placeStoreId: here.storeId || terminal.storeId, tillId: here.tillId || terminal.tillId,
        label: here.label || terminal.label || null, dayYmd, at: nowMs,
        byUid: request.auth.uid, byEmail: request.auth.token?.email || null, photos, batchKey, slipId,
      }));
      break;
    } catch (err) {
      console.error(`cardBatchCapture: staff slip log not written for ${picked}/${dayYmd} (attempt ${attempt}): ${err && err.message}`);
    }
  }
  return { at: nowMs, dayYmd };
}

/**
 * A STAFF SLIP KEPT BESIDE A BETTER FIGURE — see lib/card-supporting-slips.cjs.
 * The photo is stored first, under its own id; then the slip goes onto the
 * record in force at {record}/supportingSlips/{slipId}, in ONE transaction on
 * that record: a record deleted meanwhile stays deleted (null in, null out),
 * and the record's own figures are never touched. Then — because a better
 * figure may have taken over from that record while this was in flight — the
 * slip is copied along its same-day successors (propagateSlips), and every
 * writer of a successor does the same from its side (syncCarried), so the slip
 * always ends up on the record Junid sees. The reply is "Sent", nothing more.
 */
async function attachSupportingSlip(db, request, { terminal, picked, inForce, photos, nowMs, bucket: bucketDep = null }) {
  const declared = readDeclaredTotal(request.data && request.data.declaredTotal);
  if (declared.err) return reject(declared.err);
  const tidPath = `${CARD_BATCHES_PATH}/${terminal.storeId}/${picked}`;
  const recordPath = `${tidPath}/${inForce.key}`;
  const slipId = db.ref(`${recordPath}/${SUPPORTING_FIELD}`).push().key;
  const bucket = bucketDep || admin.storage().bucket(STORAGE_BUCKET);
  const paths = [];
  const cleanup = async () => {
    for (const path of paths) { try { await bucket.file(path).delete(); } catch { /* best effort */ } }
  };
  let full = false;
  try {
    for (let i = 0; i < photos.length; i++) {
      const path = `${PHOTO_STORAGE_PREFIX}/slip-${slipId}/photo-${i}.jpg`;
      paths.push(path);
      await bucket.file(path).save(photos[i].buffer, {
        resumable: false,
        contentType: "image/jpeg",
        metadata: { cacheControl: "private, max-age=31536000, immutable" },
      });
    }
    const entry = JSON.parse(JSON.stringify(buildSupportingSlip({
      slipId, cents: declared.cents, photos: paths,
      byUid: request.auth.uid, byEmail: request.auth.token?.email || null, nowMs, dayYmd: slipTradingDay(nowMs),
    })));
    const txn = await db.ref(recordPath).transaction((cur) => {
      if (cur === null) return null; // cold-null: never invent a record
      const have = cur[SUPPORTING_FIELD] || {};
      full = Object.keys(have).length >= MAX_SUPPORTING_SLIPS;
      if (full) return undefined;
      return { ...cur, [SUPPORTING_FIELD]: { ...have, [slipId]: entry } };
    });
    const after = txn.committed && txn.snapshot ? txn.snapshot.val() : null;
    const kept = !!(after && after[SUPPORTING_FIELD] && after[SUPPORTING_FIELD][slipId]);
    if (!kept) {
      await cleanup();
      return reject(full
        ? "This till's slip has already been sent many times today — nothing more was kept. Tell Junid."
        : "This till's record changed while the slip was being sent — nothing was kept. Send it again.");
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  await propagateSlips(db, tidPath, inForce.key);
  console.log(`cardBatchCapture: slip attached picked=${picked} key=${inForce.key} slip=${slipId} (${authorityOf(inForce.record)} figure in force) by=${request.auth.uid}`);
  const receipt = await logStaffSlip(db, request, { kind: "supporting", terminal, picked, nowMs, photos: paths, batchKey: inForce.key, slipId });
  try {
    await queueSlipCheck(db, { terminal, picked, batchKey: inForce.key, nowMs, slip: { slipId, cents: declared.cents, photos: paths, by: request.auth.uid } });
  } catch (err) {
    console.error(`cardBatchCapture: slip check not queued for ${picked}/${inForce.key}/${slipId}: ${err && err.message}`);
  }
  return { ok: true, received: true, receipt };
}

/** Every record of the batch `key` belongs to — one indexed equalTo(batchNo) read. */
async function batchRevisions(db, tidPath, key) {
  const batchNo = Number(String(key).split("-")[0]);
  if (!Number.isInteger(batchNo)) return {};
  return (await db.ref(tidPath).orderByChild("batchNo").equalTo(batchNo).once("value")).val() || {};
}

/**
 * Bring the slips carried from `fromKey` onto `toKey` (its same-day successor):
 * any slip missing there is added, and a slip there without a photo read gets
 * the source's. Never removes or rewrites what is there; never invents a record.
 */
async function syncCarried(db, tidPath, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const from = (await db.ref(`${tidPath}/${fromKey}`).once("value")).val();
  if (!from) return;
  await db.ref(`${tidPath}/${toKey}`).transaction((cur) => {
    if (cur === null) return null;
    const want = carriedSlips(from, fromKey, cur);
    if (!want) return undefined;
    const have = { ...(cur[SUPPORTING_FIELD] || {}) };
    let changed = false;
    for (const [id, s] of Object.entries(want)) {
      if (!have[id]) { have[id] = s; changed = true; } else if (!have[id].photoRead && s.photoRead) { have[id] = { ...have[id], photoRead: s.photoRead }; changed = true; }
    }
    return changed ? JSON.parse(JSON.stringify({ ...cur, [SUPPORTING_FIELD]: have })) : undefined;
  });
}

/** Copy the slips on `fromKey` along its same-day successors, oldest first. */
async function propagateSlips(db, tidPath, fromKey) {
  const chain = sameDaySuccessors(await batchRevisions(db, tidPath, fromKey), fromKey);
  let prev = fromKey;
  for (const next of chain) { await syncCarried(db, tidPath, prev, next); prev = next; }
}

// ─── THE STAFF SLIP'S PHOTO, READ IN THE BACKGROUND ──────────────────────────
// A "check" job on the same queue the received photos use (card_batch_jobs →
// cardBatchReadJob on arrival, cardBatchReadRetry behind it), with the same
// retries for an overloaded reader. What it does with the answer is the whole
// difference: it records NOTHING new. It writes what the reader made of the
// slip's total beside the typed one on the batch already recorded
// (`photoRead`), so Junid's report can say "typed R X, slip reads R Y". A read
// that finds no total, or never succeeds, is said there too, quietly — it is
// not an error, raises no Unread row and sends no email: the typed total is the
// record, and the photo is on it either way.
async function queueSlipCheck(db, { terminal, picked, batchKey, nowMs, slip = null }) {
  // A SUPPORTING slip carries its own photo and figure; a slip that is the
  // record is read off the record.
  const rec = slip ? null : (await db.ref(`${CARD_BATCHES_PATH}/${terminal.storeId}/${picked}/${batchKey}`).once("value")).val();
  const photos = slip ? slip.photos.slice()
    : rec ? (Array.isArray(rec.photos) ? rec.photos : Object.values(rec.photos || {})).filter(Boolean) : [];
  if ((!slip && !rec) || !photos.length) return null;
  const jobRef = db.ref(JOBS_PATH).push();
  const job = {
    jobId: jobRef.key,
    mode: "check",
    pickedTid: picked,
    storeId: terminal.storeId,
    tillId: terminal.tillId,
    label: terminal.label || null,
    batchKey,
    slipId: slip ? slip.slipId : null,
    typedCents: slip ? slip.cents : rec.slip ? rec.slip.totalCents : null,
    by: slip ? slip.by : rec.submittedBy ? rec.submittedBy.uid : null,
    photoPaths: photos,
    receivedAt: nowMs,
    dayYmd: sastDayYmd(nowMs),
    status: "queued",
    attempts: 0,
    refusedReads: 0,
    dueAt: nowMs + 2 * 60 * 1000,
  };
  job.dueKey = dueKey(job.dueAt, job.jobId);
  await db.ref().update({ [`${JOBS_PATH}/${job.jobId}`]: job, [`${DUE_PATH}/${job.dueKey}`]: job.jobId });
  return job.jobId;
}

/** One OCR read of a check job's photo: the total the slip prints, or null. Throws what the reader throws. */
async function checkJobOnce(db, job, photos, deps = {}) {
  const ocr = await (deps.ocr || liveOcr)(photos);
  const rate = OCR_RATES[ocr.model] || { in: IN_PER_MTOK_USD, out: OUT_PER_MTOK_USD };
  const costUSD = +(((ocr.tokensIn || 0) / 1e6) * rate.in + ((ocr.tokensOut || 0) / 1e6) * rate.out).toFixed(6);
  try {
    await db.ref(`aiAssistant/usage/${new Date().toISOString().slice(0, 10)}`).push({
      at: Date.now(), kind: "cardSlipCheck", by: job.by || null, model: ocr.model || null, attempts: ocr.attempts || 1,
      photos: photos.length, tokensIn: ocr.tokensIn || 0, tokensOut: ocr.tokensOut || 0, costUSD,
    });
  } catch (err) { console.warn("cardSlipCheck: usage log failed:", err.message); }
  const ex = ocr.parsed ? toExtraction(ocr.parsed) : null;
  const readCents = ex && Number.isInteger(ex.totalCents) ? ex.totalCents : null;
  // The TID it read, compared only — a slip from another machine is worth a word.
  const tid = ex && ex.tid ? ex.tid : null;
  return { kind: "recorded", batchKey: job.batchKey, read: { readCents, tidMatches: tid ? tid === job.pickedTid : null, model: ocr.model || null } };
}

/** What the photo said, beside the typed figure, on the recorded batch — never a new record. */
async function writePhotoRead(db, job, read, nowMs) {
  const base = `${CARD_BATCHES_PATH}/${job.storeId}/${job.pickedTid}/${job.batchKey}`;
  if (!(await db.ref(`${base}/batchKey`).once("value")).exists()) return; // deleted (a test record) — nothing to annotate
  const typed = Number.isInteger(job.typedCents) ? job.typedCents : null;
  const readCents = read && Number.isInteger(read.readCents) ? read.readCents : null;
  const photoRead = {
    // "read" — a total came off the photo; "no-total" — the photo read but
    // printed no total the reader could find (blurry, or a slip that does not
    // print one); "unread" — the reader never answered.
    status: read && read.status === "unread" ? "unread" : readCents === null ? "no-total" : "read",
    readCents,
    typedCents: typed,
    differs: readCents !== null && typed !== null && readCents !== typed,
    tidMatches: read && typeof read.tidMatches === "boolean" ? read.tidMatches : null,
    model: (read && read.model) || null,
    reason: read && read.reason ? String(read.reason).slice(0, 300) : null,
    at: nowMs,
  };
  // On the record as it stands, inside a transaction: a record deleted between
  // the check above and this write stays deleted (null in, null out — the
  // cold-null rule), rather than coming back as a lone photoRead. A
  // SUPPORTING slip's read goes on that slip, never on the record's figures.
  const at = job.slipId ? `${base}/${SUPPORTING_FIELD}/${job.slipId}` : base;
  await db.ref(at).transaction((cur) => (cur === null ? null : { ...cur, photoRead }));
  // …and on the copies carried to the records that took over since the slip
  // was queued (a machine report, Junid's correction): the read is the same
  // slip's, and the card Junid sees is the successor's.
  const tidPath = `${CARD_BATCHES_PATH}/${job.storeId}/${job.pickedTid}`;
  const carriedId = job.slipId || `rec-${job.batchKey}`;
  for (const key of sameDaySuccessors(await batchRevisions(db, tidPath, job.batchKey), job.batchKey)) {
    await db.ref(`${tidPath}/${key}/${SUPPORTING_FIELD}/${carriedId}`)
      .transaction((cur) => (cur === null ? null : { ...cur, photoRead }));
  }
}

// ─── RECEIVED: THE SLIP IS KEPT, THE READ HAPPENS LATER ──────────────────────
// Junid, 7 Oct 2026: "Submission returns Received immediately and the manager
// can leave." This is the whole of what the manager's submit does now — the
// SAME gates the photo path always ran before any OCR was paid for (a
// registered terminal, not retired, in the caller's section, one that takes a
// photo), then the photos are STORED and a job is queued. The answer is
// `{ ok: true, received: true }` and nothing else: no figure, no verdict, and
// no hint of whether the slip will read. What happens to it is the owner's
// business (processReadJob, the POS Card recon report, an email to Junid).
//
// THE PHOTO IS STORED FIRST. The path this replaces stored it only after a
// successful read, so every reader outage threw the evidence away with the
// attempt — sixteen Marathon Till 2 batches were lost that way and cannot be
// re-read (docs/CARD-RECON-TILL2-2026-10-07.md).
//
// A typed total is NOT received here: it is Junid's, it is checked against the
// photo while he holds the phone, and it stays on the synchronous extract path.
// The receive takes PHOTOS only, which is all the capture screen sends.
async function handleReceive(db, request, deps = {}) {
  const data = request.data || {};
  if (hasDeclaredTotal(data.declaredTotal)) {
    throw new HttpsError("invalid-argument", "A typed total is checked while you wait — send it with action \"extract\".");
  }
  const chosen = chooseCaptureSource({ photos: data.photos, pdf: data.pdf, maxPhotos: MAX_PHOTOS });
  if (chosen.err) throw new HttpsError("invalid-argument", chosen.err);
  if (chosen.source !== "photo") throw new HttpsError("invalid-argument", "Only a photographed slip is received this way.");
  const picked = normaliseTid(data.pickedTid);
  if (!picked) throw new HttpsError("invalid-argument", "Pick the till first.");
  const decoded = data.photos.map(decodePhoto);

  // THE SAME SETUP GATES the extract path runs before OCR — one registry row,
  // never the whole registry. These are not results of a read: they are "this
  // till cannot be captured from here", and the capture screen never offers
  // such a card, so only an old bundle or a direct call can meet them.
  const terminal = (await db.ref(`${CARD_TERMINALS_PATH}/${picked}`).once("value")).val();
  if (!terminal || !terminal.storeId || !terminal.tillId) {
    return reject(`Terminal ${picked} is not registered under /config/cardTerminals — an admin must map it to its till before slips can be captured.`);
  }
  if (isRetiredTerminal(terminal)) return reject(retiredCaptureRefusal(picked, terminal));
  const walled = await sectionRefusalFor(db, request, picked, terminal);
  if (walled) return reject(walled);
  if (!takesPhoto(terminal)) {
    return reject(`${terminal.label || picked} is set to Email only, so its report is not photographed — it ticks when the email arrives. Junid can change this in Card machines → settings.`);
  }

  const nowMs = (deps.now || Date.now)();
  // THE TRADING DAY. A slip photographed after midnight is the evening's batch
  // (no shop opens before 06:00 SAST), so it is filed on the day before.
  const dayYmd = slipTradingDay(nowMs);
  // A CEILING, not a gate a manager meets: one slip a day per till, retaken a
  // few times at most. Past it the photos are not stored — and Junid already
  // has the earlier ones. (Sonnet review, #707: every received photo can cost
  // nine reads.)
  const counted = await db.ref(`${JOBS_COUNT_PATH}/${picked}/${dayYmd}`)
    .transaction((cur) => (Number.isInteger(cur) && cur >= MAX_JOBS_PER_TILL_DAY ? undefined : (Number.isInteger(cur) ? cur + 1 : 1)));
  if (!counted.committed) {
    return reject(`${terminal.label || picked} has already sent ${MAX_JOBS_PER_TILL_DAY} slip photos today. They are with Junid — nothing more is needed.`);
  }
  const jobRef = db.ref(JOBS_PATH).push();
  const jobId = jobRef.key;
  const bucket = deps.bucket || admin.storage().bucket(STORAGE_BUCKET);
  const photoPaths = [];
  try {
  for (let i = 0; i < decoded.length; i++) {
    const path = `${JOB_PHOTO_PREFIX}/${jobId}/photo-${i}.jpg`;
    await bucket.file(path).save(decoded[i].buffer, {
      resumable: false,
      contentType: "image/jpeg",
      metadata: { cacheControl: "private, max-age=31536000, immutable" },
    });
    photoPaths.push(path);
  }
  // Where the machine stands as the slip arrives (its placement, else its
  // registry row) — the till an Unread row would be shown against.
  const here = tillAt(terminal, nowMs);
  const token = request.auth.token || {};
  const section = readSectionClaim(token.section);
  const job = {
    jobId,
    pickedTid: picked,
    // The FILING store: where /card_batches and the Unread marker file it.
    storeId: terminal.storeId,
    tillId: terminal.tillId,
    placeStoreId: here.storeId || terminal.storeId,
    placeTillId: here.tillId || terminal.tillId,
    label: here.label || terminal.label || null,
    by: request.auth.uid,
    byEmail: token.email || null,
    // The claims the read will need to act as this person: the owner bypass
    // (email + verified) and an enrolled device's section. Nothing else.
    token: {
      email: token.email || null,
      email_verified: token.email_verified === true,
      ...(section ? { section } : {}),
    },
    photoPaths,
    summaryOnly: true,
    receivedAt: nowMs,
    dayYmd,
    status: "queued",
    attempts: 0,
    refusedReads: 0,
    // The arrival trigger takes it at once; the sweep only if that never ran.
    dueAt: nowMs + 2 * 60 * 1000,
  };
  job.dueKey = dueKey(job.dueAt, jobId);
  // A STAFF SLIP (action "slip") is logged IN THE SAME WRITE as its job: the
  // queue has no client read, so this entry is how Junid's report shows the
  // till as sent — with the photo — while it waits to be read.
  const logged = deps.staffSlip ? {
    [`${staffSlipDayPath({ storeId: terminal.storeId, tid: picked, dayYmd })}/${jobId}`]: staffSlipEntry({
      kind: "received", storeId: terminal.storeId, tid: picked, placeStoreId: job.placeStoreId, tillId: job.placeTillId,
      label: job.label, dayYmd, at: nowMs, byUid: request.auth.uid, byEmail: token.email || null,
      photos: photoPaths, jobId,
    }),
  } : {};
  await db.ref().update({
    [`${JOBS_PATH}/${jobId}`]: job,
    [`${DUE_PATH}/${job.dueKey}`]: jobId,
    ...logged,
  });
  } catch (err) {
    // Nothing was kept, so the photo must not count against the day's ceiling.
    await db.ref(`${JOBS_COUNT_PATH}/${picked}/${dayYmd}`)
      .transaction((cur) => (Number.isInteger(cur) && cur > 0 ? cur - 1 : cur)).catch(() => {});
    throw err;
  }
  console.log(`cardBatchCapture: received picked=${picked} job=${jobId} photos=${photoPaths.length}${deps.staffSlip ? ` (staff slip by=${request.auth.uid})` : ""}`);
  return { ok: true, received: true, receipt: { at: nowMs, dayYmd } };
}

const JOBS_COUNT_PATH = "card_batch_jobs_count";
const MAX_JOBS_PER_TILL_DAY = 8;
const sastClock = (ms) => new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(11, 16);

/** A job's stored photos, as the base64 the extract path reads. */
async function loadJobPhotos(paths) {
  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const list = Array.isArray(paths) ? paths : Object.values(paths || {});
  const out = [];
  for (const p of list) {
    const [buf] = await bucket.file(p).download();
    out.push({ base64: buf.toString("base64") });
  }
  return out;
}

/**
 * ONE READ OF A JOB through the phone's own pipeline: handleExtract, then
 * handleSubmit, as the person who submitted it. Throws what they throw.
 */
async function readJobOnce(db, job, photos) {
  const auth = { uid: job.by, token: { ...(job.token || {}) } };
  const extract = await handleExtract(db, {
    auth,
    data: { action: "extract", pickedTid: job.pickedTid, photos, summaryOnly: true, correction: false },
  }, { storedPhotoPaths: Array.isArray(job.photoPaths) ? job.photoPaths : Object.values(job.photoPaths || {}) });
  if (!extract || extract.ok !== true) {
    if (extract && extract.ok === false) console.warn(refusalLogLine(job.pickedTid, extract.reason));
    return { extract };
  }
  const submit = await handleSubmit(db, { auth, data: { action: "submit", draftId: extract.draftId } });
  return { extract, submit };
}

/**
 * RUN ONE JOB, ONCE: claim it, read it, decide what the outcome means
 * (lib/card-read-jobs.cjs), write that down. Never throws for a failed read —
 * a failure is an outcome. `deps` is the test seam: now, loadPhotos, read.
 */
async function processReadJob(db, jobId, deps = {}) {
  const now = deps.now || Date.now;
  const nonce = `${now()}-${Math.random().toString(36).slice(2, 10)}`;
  const jobRef = db.ref(`${JOBS_PATH}/${jobId}`);
  // Null first, then the real value: returning null for null proposes nothing
  // and lets the server hand over the stored job (the cold-null rule).
  const txn = await jobRef.transaction((cur) => (cur === null ? null
    : claimJob(cur, { nowMs: now(), nonce, onArrival: deps.onArrival === true })));
  const job = txn.committed && txn.snapshot ? txn.snapshot.val() : null;
  if (!job || job.claimNonce !== nonce) return { skipped: true };

  // The queue entry follows the job to its lease.
  await db.ref().update({
    ...(job.prevDueKey && job.prevDueKey !== job.dueKey ? { [`${DUE_PATH}/${job.prevDueKey}`]: null } : {}),
    [`${DUE_PATH}/${job.dueKey}`]: jobId,
  });

  // A STAFF SLIP'S CHECK reads the photo for Junid's eyes only (writePhotoRead)
  // and records nothing; every other job reads and records a batch.
  const check = job.mode === "check";
  let outcome;
  try {
    const photos = await (deps.loadPhotos || loadJobPhotos)(job.photoPaths);
    outcome = check
      ? await (deps.check || checkJobOnce)(db, job, photos, deps)
      : classifyRun(await (deps.read || readJobOnce)(db, job, photos));
  } catch (err) {
    console.error(`cardBatchReadJob: job ${jobId} run failed: ${err && err.message}`);
    outcome = classifyRun({ thrown: err });
  }

  const t = now();
  const { final, patch } = nextStep(job, outcome, t);
  const done = { ...job, ...patch };
  if (check) {
    // Never an Unread row and never an email: the typed total IS the record.
    if (final === "recorded") await writePhotoRead(db, done, outcome.read, t);
    if (final === "unread") await writePhotoRead(db, done, { status: "unread", reason: outcome.reason }, t);
  }
  // THE CONSEQUENCES FIRST, THEN "FINISHED". Both are idempotent (a marker
  // merges; a notice is queued only while the marker has none). If this run
  // dies between them, the job is still "reading" under its lease, the sweep
  // takes it again when the lease lapses, and they are simply done again —
  // where the other order would leave a finished job and a day nobody hears
  // about. (Sonnet architect review, #707.)
  if (!check && final === "unread") await markJobUnread(db, done, outcome, t);
  if (!check && final === "recorded") await resolveJobDay(db, done, outcome.batchKey, t);
  if (!check) await noteStaffSlipRead(db, done, outcome, final, t);
  const updates = { [`${DUE_PATH}/${job.dueKey}`]: null };
  for (const [k, v] of Object.entries(patch)) updates[`${JOBS_PATH}/${jobId}/${k}`] = v;
  updates[`${JOBS_PATH}/${jobId}/prevDueKey`] = null;
  if (patch.dueKey) updates[`${DUE_PATH}/${patch.dueKey}`] = jobId;
  // Keyed by time, not attempt number: a "reread" restarts the count and must
  // not write over the first round's history. (Fable review, #707.)
  updates[`${JOBS_PATH}/${jobId}/history/t${t}`] = {
    at: t, attempt: job.attempts, outcome: outcome.kind, reason: outcome.reason ? String(outcome.reason).slice(0, 300) : null,
  };
  await db.ref().update(updates);
  console.log(`cardBatchReadJob: job ${jobId} picked=${job.pickedTid} attempt ${job.attempts} → ${outcome.kind}${final ? ` (${final})` : ` (retry ${new Date(patch.dueAt).toISOString()})`}`);
  return { outcome: outcome.kind, final };
}

/**
 * WHAT THE READER MADE OF A STAFF SLIP, on its log entry (18 Oct 2026). Yasmin's
 * PE Till 2 photo sat behind an empty Gemini balance for hours and Junid's
 * card said only "being read". The entry now says what the last attempt
 * met — Junid's report draws it. Only an entry the receive wrote is touched
 * (cold-null: a deleted entry stays deleted); a log failure never fails the job.
 */
async function noteStaffSlipRead(db, job, outcome, final, nowMs) {
  if (!job || !job.jobId || !job.dayYmd) return;
  let path;
  try { path = `${staffSlipDayPath({ storeId: job.storeId, tid: job.pickedTid, dayYmd: job.dayYmd })}/${job.jobId}`; } catch { return; }
  const read = {
    at: nowMs,
    attempts: Number.isInteger(job.attempts) ? job.attempts : null,
    outcome: final || outcome.kind,
    reason: outcome.reason ? String(outcome.reason).slice(0, 300) : null,
    batchKey: final === "recorded" && outcome.batchKey ? String(outcome.batchKey) : null,
  };
  try {
    await db.ref(path).transaction((cur) => (cur === null ? null : { ...cur, read }));
  } catch (err) {
    console.warn(`cardBatchReadJob: staff-slip read note failed for ${job.jobId}: ${err.message}`);
  }
}

/** The read gave up: that till/day is Unread in Junid's report, and he is emailed once. */
async function markJobUnread(db, job, outcome, nowMs) {
  const where = { storeId: job.storeId, tid: job.pickedTid, dayYmd: job.dayYmd };
  const path = unreadPath(where);
  const txn = await db.ref(path).transaction((cur) => addUnreadFailure(cur, {
    ...where, tillId: job.placeTillId || job.tillId, placeStoreId: job.placeStoreId || job.storeId,
    label: job.label, reason: unreadReason(job, outcome), jobId: job.jobId, photos: job.photoPaths,
    source: "photo-job", nowMs,
  }).marker);
  // THE MARKER THAT WENT IN DECIDES, not a flag from inside the transaction: an
  // unread day with no notice on it gets one; a day already announced, or
  // already answered, does not. A run that died after the marker and before
  // the notice is put right by the next run of the same job.
  const marker = txn && txn.snapshot ? txn.snapshot.val() : null;
  if (marker && marker.status === "unread" && !marker.notice) {
    await db.ref().update({
      [`${NOTICES_PATH}/${noticeKey(where)}`]: noticeRecord(marker, nowMs),
      [`${path}/notice`]: { queuedAt: nowMs },
    });
  }
  // The log keeps it too — the house alarm shape, greppable by marker.
  console.warn(`CARD_RECON_UNREAD ${job.label || job.pickedTid} ${job.dayYmd}: ${unreadReason(job, outcome)}`);
}

/**
 * A later read recorded the batch: an Unread row is answered — on the day the
 * photo arrived AND on the day the batch closed, which differ when a slip is
 * photographed a day late. One leaf read for the close.
 */
async function resolveJobDay(db, job, batchKey, nowMs) {
  const days = new Set([job.dayYmd]);
  if (batchKey && /^[0-9]{1,8}(-r[0-9]{1,3})?$/.test(batchKey)) {
    const closedAt = (await db.ref(`${CARD_BATCHES_PATH}/${job.storeId}/${job.pickedTid}/${batchKey}/slip/closedAt`).once("value")).val();
    if (Number.isFinite(closedAt)) days.add(sastDayYmd(closedAt));
  }
  for (const dayYmd of days) {
    await db.ref(unreadPath({ storeId: job.storeId, tid: job.pickedTid, dayYmd })).transaction((cur) => (cur === null ? null
      : resolveUnreadMarker(cur, { via: "read", batchKey, nowMs })));
  }
}

/**
 * THE SWEEP: every job whose due time has passed, oldest first — a retry, or
 * one whose arrival trigger never ran, or one whose run died under its lease.
 * A queue entry that no longer matches its job is stale and removed.
 */
async function sweepReadJobs(db, deps = {}) {
  const now = deps.now || Date.now;
  const started = now();
  const snap = await db.ref(DUE_PATH).orderByKey().endAt(dueCutoff(started)).limitToFirst(SWEEP_BATCH).once("value");
  const due = snap.val() || {};
  let ran = 0;
  for (const [key, jobId] of Object.entries(due)) {
    // A read can take ~5 min at worst (two model timeouts); none starts unless
    // it can finish inside the function's 540 s.
    if (now() - started > SWEEP_START_BY_MS) break;
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(jobId)) {
      await db.ref(`${DUE_PATH}/${key}`).set(null);
      continue;
    }
    const r = await processReadJob(db, jobId, deps);
    if (r.skipped) {
      const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
      const finished = job && (job.status === "recorded" || job.status === "duplicate" || job.status === "unread");
      if (!job || finished || job.dueKey !== key) {
        // A job still waiting or running must keep ONE queue entry, at its own
        // key — the claim and the queue move are two writes, and a run that
        // died between them left only this stale one. (Sonnet review, #707.)
        if (job && !finished && typeof job.dueKey === "string" && job.dueKey !== key) {
          await db.ref(`${DUE_PATH}/${job.dueKey}`).set(jobId);
        }
        await db.ref(`${DUE_PATH}/${key}`).set(null);
      }
    } else ran++;
  }
  return { due: Object.keys(due).length, ran };
}
const SWEEP_BATCH = 5;
const SWEEP_START_BY_MS = 150 * 1000;

// ─── THE EMAIL TO JUNID — collected and confirmed by the mailbox poller ──────
// The poller on the Mac mini already holds the one identity allowed the email
// channel (assertEmailIntake) and the shop mailbox's credentials; it sends what
// this hands it over SMTP and reports back. A notice it has taken is leased for
// ten minutes, so two ticks never send the same one, and one that failed to
// send is offered again. Nothing here sends mail itself.
const NOTICE_LEASE_MS = 10 * 60 * 1000;
const NOTICE_MAX_ATTEMPTS = 10;
const NOTICE_KEY_RE = /^[A-Za-z0-9_~-]{1,120}$/;

async function listNotices(db, nowMs) {
  const snap = await db.ref(NOTICES_PATH).orderByKey().limitToFirst(20).once("value");
  const all = snap.val() || {};
  const take = Object.entries(all)
    .filter(([k, n]) => NOTICE_KEY_RE.test(k) && n && typeof n === "object"
      && typeof n.subject === "string" && typeof n.text === "string"
      && !(Number.isFinite(n.leaseUntil) && n.leaseUntil > nowMs)
      && !((n.attempts || 0) >= NOTICE_MAX_ATTEMPTS))
    .slice(0, 10);
  if (take.length) {
    await db.ref().update(Object.fromEntries(take.map(([k]) => [`${NOTICES_PATH}/${k}/leaseUntil`, nowMs + NOTICE_LEASE_MS])));
  }
  return {
    ok: true,
    to: NOTIFY_TO,
    notices: take.map(([key, n]) => ({ key, subject: n.subject.slice(0, 200), text: n.text.slice(0, 4000) })),
  };
}

async function recordNoticeResults(db, results, nowMs) {
  if (!Array.isArray(results) || results.length > 20) throw new HttpsError("invalid-argument", "results must be a list of at most 20.");
  let sent = 0, failed = 0;
  for (const r of results) {
    const key = r && r.key;
    if (typeof key !== "string" || !NOTICE_KEY_RE.test(key)) continue;
    const ref = db.ref(`${NOTICES_PATH}/${key}`);
    const notice = (await ref.once("value")).val();
    if (!notice) continue;
    const error = typeof r.error === "string" ? r.error.slice(0, 300) : "send failed";
    const attempts = (notice.attempts || 0) + (r.ok === true ? 0 : 1);
    // SENT, or GIVEN UP: either way it leaves the queue (a dead notice left in
    // place would sit at the front of every read and block the rest), and the
    // Unread row says which — only if that row still exists.
    if (r.ok === true || attempts >= NOTICE_MAX_ATTEMPTS) {
      await ref.set(null);
      if (typeof notice.unreadPath === "string" && notice.unreadPath.startsWith("card_batch_overrides/unread/")) {
        const stamp = r.ok === true
          ? { queuedAt: notice.createdAt || null, sentAt: nowMs, to: NOTIFY_TO }
          : { queuedAt: notice.createdAt || null, failedAt: nowMs, lastError: error };
        await db.ref(notice.unreadPath).transaction((cur) => (cur === null ? null : { ...cur, notice: stamp }));
      }
      if (r.ok === true) sent++; else failed++;
    } else {
      await ref.update({ attempts, lastError: error, lastErrorAt: nowMs, leaseUntil: null });
      failed++;
    }
  }
  return { ok: true, sent, failed };
}

exports.cardBatchCapture = onCall(
  {
    region: "europe-west1",
    secrets: [geminiApiKey, anthropicApiKey],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (request) => {
    const db = admin.database();
    const action = request.data?.action;
    // ── ONE TILL'S SLIP — the per-till scope is its gate, not card_recon ──
    // Before the card_recon check, because the people it is for do not hold
    // card_recon and must not need to; handleSlip refuses everyone outside
    // their own till. Every other action below still requires card_recon.
    if (action === "slipTills") return handleSlipTills(db, request);
    if (action === "slip") {
      const out = await handleSlip(db, request);
      if (out && out.ok === false) console.warn(refusalLogLine(request.data?.pickedTid, out.reason));
      return out;
    }
    await assertCardRecon(request);
    // ── THE MANAGER'S SUBMIT: kept, queued, "Received" — see handleReceive ──
    if (action === "receive") {
      const out = await handleReceive(db, request);
      if (out && out.ok === false) console.warn(refusalLogLine(request.data?.pickedTid, out.reason));
      return out;
    }
    // ── THE POLLER'S MAIL ROUND: notices to Junid, then what became of them ──
    if (action === "notices") {
      await assertEmailIntake(request);
      return listNotices(db, Date.now());
    }
    if (action === "noticeSent") {
      await assertEmailIntake(request);
      return recordNoticeResults(db, request.data?.results, Date.now());
    }
    // ── WHICH PARSER IS LIVE — the poller asks, and re-runs every refusal an
    // older one judged (scripts/cardrecon/intakeCore.mjs → retryCandidates).
    // A number and nothing else.
    if (action === "version") return { ok: true, parserVersion: PARSER_VERSION };
    if (action === "extract") {
      const out = await handleExtract(db, request);
      // Every refusal leaves its reason in the log, not only on the phone —
      // so "it said try again" can be read back exactly afterwards.
      if (out && out.ok === false) {
        console.warn(refusalLogLine(request.data?.pickedTid, out.reason));
      }
      // Every answer says which parser gave it, so the row the poller writes
      // can be re-run when a later one is deployed.
      return out && typeof out === "object" ? { ...out, parserVersion: PARSER_VERSION } : out;
    }
    // ── A TYPED-TOTAL MACHINE — its own action, not a photo capture with the
    // photo missing. Keeping it off `extract` is deliberate: that path's first
    // job is to decide which of two file sources it was handed, and a third
    // shape carrying neither would have to be threaded past every check built
    // for a document. This one reads the registry, confirms the machine really
    // is set to typed entry, and goes straight to the draft `submit` records.
    if (action === "typed") {
      // OWNER ONLY AGAIN (Junid, 7 Oct 2026: "Staff never type numbers. Manual
      // entry is Junid-only."). This supersedes the 1 Oct opening (#658). A
      // typed-only machine that nobody types for is not lost: its card money
      // waits in the POS report, where Junid enters the figure
      // (cardBatchManualEntry) for that till and day.
      if (!mayDeclareTotal(request.auth?.token)) {
        throw new HttpsError("permission-denied", "Only Junid can type in a machine's total.");
      }
      const picked = normaliseTid(request.data?.pickedTid);
      if (!picked) throw new HttpsError("invalid-argument", "Pick the till first.");
      // This one terminal's row, never the whole registry.
      const terminal = (await db.ref(`${CARD_TERMINALS_PATH}/${picked}`).once("value")).val();
      if (!terminal || !terminal.storeId || !terminal.tillId) {
        return reject(`Terminal ${picked} is not registered under /config/cardTerminals — an admin must map it to its till before anything can be captured.`);
      }
      if (isRetiredTerminal(terminal)) return reject(retiredCaptureRefusal(picked, terminal));
      // A till in another section is not this account's to type a figure for.
      const walled = await sectionRefusalFor(db, request, picked, terminal);
      if (walled) { console.warn(refusalLogLine(picked, walled)); return reject(walled); }
      // THE REGISTRY DECIDES, NEVER THE CALLER. A machine that can produce a
      // readable slip must keep producing one: typing a figure for it would
      // put an unverifiable number on the record where evidence was available.
      if (!typesTotal(terminal)) {
        return reject(`${terminal.label || picked} is not set to typed entry, so its total cannot be typed in — photograph its slip. Junid can change this in Card machines → settings.`);
      }
      const out = await handleTypedCapture(db, request, { picked, terminal });
      if (out && out.ok === false) console.warn(refusalLogLine(picked, out.reason));
      return out;
    }
    if (action === "submit") {
      const out = await handleSubmit(db, request);
      return out && typeof out === "object" ? { ...out, parserVersion: PARSER_VERSION } : out;
    }
    throw new HttpsError("invalid-argument", "action must be 'receive', 'slip', 'extract', 'typed', 'submit' or 'version'.");
  },
);

// ─── THE BACKGROUND READ — on arrival, and the sweep behind it ───────────────
// DEPLOY BY NAME: functions:cardBatchReadJob and functions:cardBatchReadRetry.
// Same secret, same memory class as the callable (a job holds the photos).
exports.cardBatchReadJob = onValueCreated(
  {
    ref: `/${JOBS_PATH}/{jobId}`,
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    secrets: [geminiApiKey, anthropicApiKey],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    await processReadJob(admin.database(), event.params.jobId, { onArrival: true });
  },
);

exports.cardBatchReadRetry = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Africa/Johannesburg",
    region: "europe-west1",
    secrets: [geminiApiKey, anthropicApiKey],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const r = await sweepReadJobs(admin.database());
    if (r.due) console.log(`cardBatchReadRetry: ${r.due} due, ${r.ran} run`);
  },
);

// Exported for tests (pure-ish seams).
exports.handleReceive = handleReceive;
exports.handleSlip = handleSlip;
exports.handleSlipTills = handleSlipTills;
exports.carriedSlipsFor = carriedSlipsFor;
exports.syncCarried = syncCarried;
exports.handleTypedCapture = handleTypedCapture;
// The extract → submit pair, for the email-pipeline tests (fake RTDB + bucket).
exports.handleExtract = handleExtract;
exports.handleSubmit = handleSubmit;
exports.processReadJob = processReadJob;
exports.sweepReadJobs = sweepReadJobs;
exports.listNotices = listNotices;
exports.recordNoticeResults = recordNoticeResults;
exports.toExtraction = toExtraction;
exports.sectionRefusalFor = sectionRefusalFor;
// The summary-first gate, exported so it can be tested directly: everything
// else about it lives inside async handlers behind a database.
exports.totalsAgree = totalsAgree;
// The duplicate-batch probe, exported for the same reason. What has to be
// provable about it is WHICH PATHS IT READS — a probe that widened to the store
// node, or to the registry, would make one terminal's batch number collide with
// another's. Two of the six machines joined the estate mid-life, on batches 57
// and 480, and 57 lands inside a sibling terminal's live range in the SAME
// store. See functions/test/card-batch-numbers.test.cjs.
exports.readBatchKeysFor = readBatchKeysFor;
// Exported for the same reason as readBatchKeysFor: what decides whether a
// second report of a batch is a fuller account or a re-send is a rule about
// LIVE data, and it is tested against a fake database rather than by reading it.
exports.readRecordedLinesFor = readRecordedLinesFor;
// Exported for the same reason as readBatchKeysFor: what this asks of the
// database — specifically that its range is NUMERIC, so string-valued legacy
// values cannot crowd out the highest batch — is a fact about a live query and
// is tested by recording the query rather than by reading it.
exports.readLastBatchFor = readLastBatchFor;
exports.resolveWriteFor = resolveWriteFor;
exports.EXTRACTION_SCHEMA = EXTRACTION_SCHEMA;
exports.OCR_MODEL = OCR_MODEL;
exports.EXTRACTION_PROMPT = EXTRACTION_PROMPT;
exports.OCR_FALLBACK_MODEL = OCR_FALLBACK_MODEL;
exports.runSlipOcr = runSlipOcr;
exports.CREDIT_WALL_MODEL = CREDIT_WALL_MODEL;
exports.CLAUDE_EXTRACTION_SCHEMA = CLAUDE_EXTRACTION_SCHEMA;
exports.photoReadLogLine = photoReadLogLine;
exports.refusalLogLine = refusalLogLine;
