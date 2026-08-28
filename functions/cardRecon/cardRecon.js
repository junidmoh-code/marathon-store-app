// ─── cardBatchCapture CALLABLE — the FNB batch slip becomes evidence ─────────
// Managers photograph the terminal's own Batch Report (detail roll + summary);
// this callable OCRs it, refuses anything it could not read soundly, computes
// what the POS tender ledger says the card takings for that till over the
// slip's Opened→Closed window should have been, and records slip + expectation
// + variance append-only at /pos/card_batches. NOBODY TYPES THE CARD TOTAL —
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
  normaliseTid, normaliseBatchNo, resolveBatchWrite,
  dedupeLines, validateExtraction, buildBatchRecord,
} = require("../lib/card-recon.cjs");
const { computeExpectedCard } = require("../lib/card-expected.cjs");
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
    cashCents: parsed.cash ? parseRandsToCents(parsed.cash) : 0,
    refundsCents: parsed.refunds != null && parsed.refunds !== "" ? Math.abs(parseRandsToCents(parsed.refunds) ?? NaN) || 0 : 0,
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
  for (let rev = 1; ; rev++) {
    const key = rev === 1 ? String(batchNo) : `${batchNo}-r${rev}`;
    const exists = (await db.ref(`${base}/${key}/batchKey`).once("value")).exists();
    if (!exists) break;
    keys.push(key);
  }
  return keys;
}

async function handleExtract(db, request) {
  const { photos, pickedTid, summaryOnly } = request.data || {};
  if (!Array.isArray(photos) || !photos.length) {
    throw new HttpsError("invalid-argument", "At least one photo is required.");
  }
  if (photos.length > MAX_PHOTOS) {
    throw new HttpsError("invalid-argument", `Too many photos — ${MAX_PHOTOS} at most.`);
  }
  const picked = normaliseTid(pickedTid);
  if (!picked) throw new HttpsError("invalid-argument", "Pick the till first.");
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
  });

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
    warnings: verdict.warnings.length ? verdict.warnings : null,
    photoPaths,
    // JSON round-trip strips the undefined values RTDB refuses.
    extraction: JSON.parse(JSON.stringify(extraction)),
    terminal: { storeId: terminal.storeId, tillId: terminal.tillId, label: terminal.label ?? null },
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
      lines: extraction.lines,
      summaryOnly: !!summaryOnly,
      warnings: verdict.warnings,
      expectedCardCents: expected.cardCents,
      expectedByKind: expected.byKind,
      varianceCents: extraction.totalCents - expected.cardCents,
      cashiers: expected.cashiers,
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

  // Recompute expected at the moment of record — the authoritative figure.
  const expected = await computeExpectedCard(db, {
    storeId: terminal.storeId, tillId: terminal.tillId,
    startMs: extraction.openedAt, endMs: extraction.closedAt,
  });

  // Re-resolve the key against NOW's children, then guarantee append-only with
  // a transaction on the exact key: existing data aborts, never overwritten.
  const tidRef = db.ref(`${CARD_BATCHES_PATH}/${terminal.storeId}/${extraction.tid}`);
  const existingKeys = await readBatchKeysFor(db, terminal.storeId, extraction.tid, batchNo);
  const write = resolveBatchWrite({ existingKeys, batchNo, correction: !!draft.correction });
  if (!write.ok) return reject(write.reason);

  const record = buildBatchRecord({
    extraction, terminal, tid: extraction.tid,
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
  });

  const txn = await tidRef.child(write.key).transaction((cur) => {
    if (cur !== null) return undefined; // exists → abort, never overwrite
    return JSON.parse(JSON.stringify(record));
  });
  if (!txn.committed) {
    return reject(`Batch #${batchNo} for this terminal was captured by someone else a moment ago.`);
  }
  await draftRef.remove().catch(() => {});

  return {
    ok: true,
    batchKey: write.key,
    revision: write.revision,
    slipTotalCents: extraction.totalCents,
    expectedCardCents: expected.cardCents,
    varianceCents: record.varianceCents,
    linesCaptured: record.linesCaptured,
    cashiers: expected.cashiers,
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
exports.EXTRACTION_SCHEMA = EXTRACTION_SCHEMA;
exports.OCR_MODEL = OCR_MODEL;
