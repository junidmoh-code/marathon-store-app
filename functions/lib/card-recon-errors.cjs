// ─── NO SILENT FAILURES IN CARD RECON (Junid, 27 Nov 2026) ───────────────────
// Every upload / ingest / read failure path writes one record here, so the
// 19:00 watchdog (cardReconWatchdog) can see it and tell Junid. A failure that
// only reaches the function log is a failure nobody hears about — that is how
// Marathon PE Till 2 sat on "photo received — total unreadable" unnoticed.
//
//   /card_recon_errors/{13-digit ms}_{rand} = { at, kind, storeId, tid, dayYmd, jobId, message }
//
// The key starts with the time, so the watchdog reads only the last 24 hours
// with orderByKey().startAt(…) — a bounded read with no index and never the
// whole node. Recording an error NEVER throws: it is the last thing a failing
// path does, and it must not turn one failure into two.
"use strict";

const ERRORS_PATH = "card_recon_errors";
const SAFE = /^[A-Za-z0-9_-]{1,40}$/;

function errorKey(nowMs, rand = Math.random) {
  const ms = String(Math.max(0, Math.floor(Number(nowMs) || 0))).padStart(13, "0");
  return `${ms}_${rand().toString(36).slice(2, 10) || "x"}`;
}

/** The first key of the window that starts at `fromMs` (orderByKey().startAt). */
function errorKeyFrom(fromMs) {
  return String(Math.max(0, Math.floor(Number(fromMs) || 0))).padStart(13, "0");
}

function errorRecord({ kind, storeId = null, tid = null, dayYmd = null, jobId = null, message = "", label = null }, nowMs) {
  const clean = (v) => (typeof v === "string" && SAFE.test(v) ? v : null);
  return {
    at: Math.floor(Number(nowMs) || 0),
    kind: typeof kind === "string" ? kind.slice(0, 60) : "unknown",
    storeId: clean(storeId),
    tid: clean(tid),
    dayYmd: typeof dayYmd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dayYmd) ? dayYmd : null,
    jobId: clean(jobId),
    label: typeof label === "string" ? label.slice(0, 60) : null,
    message: String(message || "").slice(0, 500),
  };
}

/** Write one error record. Never throws; logs if even this fails. */
async function recordCardReconError(db, fields, nowMs = Date.now()) {
  try {
    await db.ref(`${ERRORS_PATH}/${errorKey(nowMs)}`).set(errorRecord(fields, nowMs));
  } catch (err) {
    console.error(`CARD_RECON_ERROR_LOG_FAILED ${fields && fields.kind}: ${err && err.message} — original: ${fields && fields.message}`);
  }
  console.error(`CARD_RECON_ERROR ${fields && fields.kind} ${fields && (fields.label || fields.tid) || ""} ${fields && fields.dayYmd || ""}: ${fields && fields.message}`);
}

module.exports = { ERRORS_PATH, errorKey, errorKeyFrom, errorRecord, recordCardReconError };
