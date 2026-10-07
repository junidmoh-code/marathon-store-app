// ─── READING A SLIP IN THE BACKGROUND ────────────────────────────────────────
// Junid, 7 Oct 2026: the manager submits the slip, gets "Received", and leaves.
// The read happens on the server, after they have gone, and is retried for
// hours before it gives up. The manager is never shown the outcome.
//
// WHY. Marathon Till 2 cannot email; its slip is a photo, and the old path read
// it while the manager waited. Every reader outage (429, 402, 503, a hung call)
// ended the capture on the spot AND threw the photo away, so 16 of its batches
// were never recorded and none can be re-read (docs/CARD-RECON-TILL2-2026-10-07.md).
// Now the photo is stored first and the read is a job.
//
// THE JOB:      /card_batch_jobs/{jobId}      — Admin SDK only (no client rule
//               reaches a top-level node the rules do not name).
// THE QUEUE:    /card_batch_jobs_due/{dueKey} = jobId, where dueKey is
//               "{13-digit due ms}_{jobId}". Keys sort by due time, so the
//               retry sweep is an orderByKey().endAt(now) read — the one query
//               RTDB answers without an .indexOn, so no rules paste.
//
// THE PIPELINE IS THE OLD ONE. A job runs handleExtract then handleSubmit —
// the same functions the phone called — with the submitter's uid and token
// claims carried on the job. Nothing about reading, validating, filing or
// computing the variance is re-implemented here; this module only decides
// what an outcome MEANS for the job (retry, give up, done).
//
// PURE: no IO, no clock.

"use strict";

const JOBS_PATH = "card_batch_jobs";
const DUE_PATH = "card_batch_jobs_due";
const JOB_PHOTO_PREFIX = "cardRecon/jobs";

// A transient failure (the reader overloaded, out of credit, rate-limited, hung)
// is retried after each of these delays — 2 min to 4 h, ~8 h in all, so a slip
// photographed at close is either recorded or flagged before the next morning.
// The first attempt is the trigger on arrival; then one per delay.
const RETRY_DELAYS_MS = [2, 5, 10, 20, 40, 60, 120, 240].map((m) => m * 60 * 1000);
const MAX_READ_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;
// A read that came back but was REFUSED (low confidence, wrong TID, sums that
// do not add up) is model output, which varies run to run: the 2 Oct Till 2
// slip read its batch number at 0.5, then at 0.99 a minute later. Read again a
// couple of times, then hand it to Junid — the photo will not improve.
const MAX_REFUSED_READS = 3;
const REFUSED_RETRY_MS = 3 * 60 * 1000;
// A job is held while one run works on it. Longer than any run can last (the
// trigger's 540 s), so a live run is never doubled; a crashed one is picked up
// by the sweep once this passes.
const LEASE_MS = 10 * 60 * 1000;

const pad13 = (ms) => String(Math.max(0, Math.floor(ms))).padStart(13, "0");
/** The queue key for a job due at `ms`. */
function dueKey(ms, jobId) { return `${pad13(ms)}_${jobId}`; }
/** The highest key the sweep may take at `nowMs` ("_" then the push-id alphabet sorts below "~"). */
function dueCutoff(nowMs) { return `${pad13(nowMs)}_~`; }
/** The due time a queue key carries, or null. */
function dueMsOf(key) {
  const m = /^(\d{13})_/.exec(String(key || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Take the job for this run, or refuse (undefined aborts the transaction).
 * Claimable: waiting and due, or "reading" under a lease that has run out (a
 * run that died). `nonce` lets the caller recognise its own claim afterwards.
 */
function claimJob(cur, { nowMs, nonce, onArrival = false }) {
  if (!cur || typeof cur !== "object") return undefined;
  const due = Number.isFinite(cur.dueAt) ? cur.dueAt : 0;
  // The arrival trigger takes a QUEUED job at once; the sweep waits for its due
  // time, which the receive sets a little ahead so the two do not race for it.
  const waiting = (cur.status === "queued" && onArrival) || ((cur.status === "queued" || cur.status === "retry") && due <= nowMs);
  const orphaned = cur.status === "reading" && !(Number.isFinite(cur.leaseUntil) && cur.leaseUntil > nowMs);
  if (!waiting && !orphaned) return undefined;
  const leaseUntil = nowMs + LEASE_MS;
  return {
    ...cur,
    status: "reading",
    claimNonce: nonce,
    leaseUntil,
    attempts: (Number.isInteger(cur.attempts) ? cur.attempts : 0) + 1,
    lastClaimAt: nowMs,
    // While it runs, the queue entry sits at the lease's end: a run that dies
    // leaves the job findable by the sweep the moment the lease lapses.
    prevDueKey: cur.dueKey || null,
    dueAt: leaseUntil,
    dueKey: dueKey(leaseUntil, cur.jobId),
  };
}

const TRANSIENT_CODES = new Set(["unavailable", "resource-exhausted", "deadline-exceeded", "internal", "unknown", "aborted", "cancelled"]);
const DUPLICATE_RE = /already captured|captured by someone else a moment ago/i;

/**
 * What one run's result means. Exactly one of:
 *   recorded   — the batch is on file (batchKey)
 *   duplicate  — that batch was already on file: a second photo of the same
 *                slip, or a slip the email path got first. Nothing to do.
 *   transient  — the reader or the server failed; the photo is fine.
 *   refused    — the reader answered and the answer was refused.
 */
function classifyRun({ thrown = null, extract = null, submit = null }) {
  if (thrown) {
    const code = typeof thrown.code === "string" ? thrown.code.replace(/^functions\//, "") : null;
    const reason = String(thrown.message || thrown).slice(0, 600);
    if (code && !TRANSIENT_CODES.has(code)) return { kind: "refused", reason };
    return { kind: "transient", reason };
  }
  const refusal = (r) => (typeof r?.reason === "string" && r.reason.trim() ? r.reason.trim() : "The slip was refused with no reason given.");
  if (extract && extract.ok === false) {
    const reason = refusal(extract);
    return DUPLICATE_RE.test(reason) ? { kind: "duplicate", reason } : { kind: "refused", reason };
  }
  if (submit && submit.ok === true) return { kind: "recorded", batchKey: submit.batchKey || null };
  if (submit && submit.ok === false) {
    const reason = refusal(submit);
    return DUPLICATE_RE.test(reason) ? { kind: "duplicate", reason } : { kind: "refused", reason };
  }
  return { kind: "transient", reason: "The read stopped before it produced an answer." };
}

/**
 * The job after a run. `job.attempts` already counts this run (claimJob).
 * Returns the patch to write, and `final` — "recorded" | "duplicate" | "unread"
 * when the job is finished, null while it will be tried again.
 */
function nextStep(job, outcome, nowMs) {
  const attempts = Number.isInteger(job.attempts) ? job.attempts : 1;
  const refusedReads = (Number.isInteger(job.refusedReads) ? job.refusedReads : 0) + (outcome.kind === "refused" ? 1 : 0);
  const base = {
    leaseUntil: null, claimNonce: null, refusedReads,
    lastOutcome: outcome.kind, lastReason: outcome.reason || null, lastRunAt: nowMs,
  };
  if (outcome.kind === "recorded") {
    return { final: "recorded", patch: { ...base, status: "recorded", batchKey: outcome.batchKey, dueAt: null, dueKey: null, doneAt: nowMs } };
  }
  if (outcome.kind === "duplicate") {
    return { final: "duplicate", patch: { ...base, status: "duplicate", dueAt: null, dueKey: null, doneAt: nowMs } };
  }
  const outOfReads = attempts >= MAX_READ_ATTEMPTS || (outcome.kind === "refused" && refusedReads >= MAX_REFUSED_READS);
  if (outOfReads) {
    return { final: "unread", patch: { ...base, status: "unread", dueAt: null, dueKey: null, doneAt: nowMs } };
  }
  const wait = outcome.kind === "refused" ? REFUSED_RETRY_MS : RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const dueAt = nowMs + wait;
  return { final: null, patch: { ...base, status: "retry", dueAt, dueKey: dueKey(dueAt, job.jobId) } };
}

/** The sentence Junid reads on the Unread row and in the email. */
function unreadReason(job, outcome) {
  const n = Number.isInteger(job.attempts) ? job.attempts : 1;
  const tries = `${n} read${n === 1 ? "" : "s"} over ${spanText((job.lastRunAt || job.receivedAt) - job.receivedAt)}`;
  if (outcome.kind === "refused") return `The slip photo was read and refused ${job.refusedReads || 1} time${(job.refusedReads || 1) === 1 ? "" : "s"}: ${outcome.reason}`;
  return `Google's slip reader failed on every attempt (${tries}). Last error: ${outcome.reason}`;
}
function spanText(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return "a minute";
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

module.exports = {
  JOBS_PATH, DUE_PATH, JOB_PHOTO_PREFIX,
  RETRY_DELAYS_MS, MAX_READ_ATTEMPTS, MAX_REFUSED_READS, REFUSED_RETRY_MS, LEASE_MS,
  dueKey, dueCutoff, dueMsOf, claimJob, classifyRun, nextStep, unreadReason,
};
