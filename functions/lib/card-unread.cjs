// ─── "UNREAD — NEEDS MANUAL ENTRY": ONE TILL, ONE DAY ────────────────────────
// A slip that reached the server and could not be turned into a record, or a
// day whose slip never reached it, is NOT silence. It is a row in Junid's Card
// recon report saying so, with what is known about why, until he types the
// figures in (cardBatchManualEntry) or a later read records the batch.
//
// WHERE: /card_batch_overrides/unread/{storeId}/{tid}/{dayYmd}
//   storeId — the terminal's FILING store (the registry row's own storeId),
//             the same key /card_batches files under, so one reader finds both;
//   tid     — the terminal;
//   dayYmd  — the SAST trading day ("2026-10-07").
//
// WHY UNDER /card_batch_overrides: that node is already live, top-level,
// owner-only for read AND write (verified against the live rules 7 Oct 2026),
// and was empty. Putting the markers there costs no rules paste, and no staff
// login can read them — managers see nothing back (Junid, 7 Oct 2026). Only
// the Admin SDK writes here.
//
// THE EMAIL. A day that turns unread queues ONE notice at
// /card_batch_overrides/notices/{key}. The mailbox poller on the Mac mini
// collects notices through the cardBatchCapture callable (it already holds the
// one identity that may) and sends them to Junid over the shop mailbox's SMTP —
// email only, by instruction. A notice the poller has not sent stays queued and
// the marker says so; nothing is lost if the mini is off.
//
// PURE: no IO, no clock. Every caller passes `nowMs` and the existing row.

"use strict";

const OVERRIDES_PATH = "card_batch_overrides";
const UNREAD_PATH = `${OVERRIDES_PATH}/unread`;
const NOTICES_PATH = `${OVERRIDES_PATH}/notices`;
const MANUAL_AUDIT_PATH = `${OVERRIDES_PATH}/manual_audit`;
// Junid's own inbox — the address every card-recon alarm already goes to
// (install-cardrecon-alarm.mjs). gunidmoh@ is his Firebase admin login, not a
// mailbox he reads for alerts. Decided HERE, server-side: the poller only
// delivers, so a typo in the mini's .env cannot send a notice elsewhere.
const NOTIFY_TO = "junidmoh@gmail.com";

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A marker remembers this many jobs and photos — the abuse ceiling, not the
// expectation (one or two captures a day).
const MAX_JOBS_KEPT = 20;
const MAX_PHOTOS_KEPT = 28;
const REASON_MAX = 600;

/** The SAST calendar day an instant falls in, "YYYY-MM-DD". */
function sastDayYmd(ms) {
  const d = new Date(ms + SAST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** SAST midnight that opens `dayYmd`, in epoch ms, or null for a malformed day. */
function sastDayStartMs(dayYmd) {
  if (!isDayYmd(dayYmd)) return null;
  const ms = Date.parse(`${dayYmd}T00:00:00+02:00`);
  return Number.isFinite(ms) && sastDayYmd(ms) === dayYmd ? ms : null;
}

function isDayYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// RTDB refuses . $ # [ ] / in a key. A TID is [A-Z0-9]{4,16} and a store id
// is a slug, but both arrive from data, so the path is checked, never trusted.
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function unreadPath({ storeId, tid, dayYmd }) {
  if (!SAFE_KEY.test(String(storeId || "")) || !SAFE_KEY.test(String(tid || "")) || !isDayYmd(dayYmd)) {
    throw new Error(`card-unread: refusing an unsafe marker path (${storeId}/${tid}/${dayYmd})`);
  }
  return `${UNREAD_PATH}/${storeId}/${tid}/${dayYmd}`;
}

/** One notice per till-day; the key is the marker's own coordinates. */
function noticeKey({ storeId, tid, dayYmd }) {
  unreadPath({ storeId, tid, dayYmd }); // same safety check
  return `${storeId}~${tid}~${dayYmd}`;
}

const clip = (s, n = REASON_MAX) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);

// RTDB hands an array back as an object when it is sparse; both are lists here.
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [])
  .filter((x) => typeof x === "string" && x);

/**
 * The marker after one more failure is added to `existing` (null for a new
 * one). A day already RESOLVED stays resolved — Junid's entry or a later
 * recorded read is the answer for that day, and a failed duplicate capture
 * must not reopen it — but the failure is still listed on it.
 *
 * @returns {{marker:object, becameUnread:boolean}} becameUnread is true only
 *   on the transition into "unread" — that is when ONE notice is queued.
 */
function addUnreadFailure(existing, { storeId, tid, tillId, placeStoreId = null, label, dayYmd, reason, jobId = null, photos = [], source, nowMs }) {
  const was = existing && typeof existing === "object" ? existing : null;
  const jobs = { ...(was && was.jobs && typeof was.jobs === "object" ? was.jobs : {}) };
  if (jobId) jobs[jobId] = { at: nowMs, reason: clip(reason) };
  const keptJobs = Object.fromEntries(Object.entries(jobs)
    .sort((a, b) => Number(a[1] && a[1].at) - Number(b[1] && b[1].at)).slice(-MAX_JOBS_KEPT));
  const photoList = [...new Set([...asList(was && was.photos), ...asList(photos)])].slice(-MAX_PHOTOS_KEPT);
  const resolved = !!(was && was.status === "resolved");
  const marker = {
    storeId, tid,
    // WHERE THE MACHINE STOOD that day — a terminal filed under one store can
    // stand in another (67325636 is filed pe and has stood at Trophy since 5
    // Oct), and the report files the row under the store it stood in.
    placeStoreId: placeStoreId || (was && was.placeStoreId) || storeId,
    tillId: tillId || (was && was.tillId) || null,
    label: label || (was && was.label) || null,
    dayYmd,
    status: resolved ? "resolved" : "unread",
    reason: clip(reason) || (was && was.reason) || "The slip could not be read.",
    source: source || (was && was.source) || "photo-job",
    firstAt: (was && Number.isFinite(was.firstAt)) ? was.firstAt : nowMs,
    lastAt: nowMs,
    failures: ((was && Number.isInteger(was.failures)) ? was.failures : 0) + 1,
    jobs: Object.keys(keptJobs).length ? keptJobs : null,
    photos: photoList.length ? photoList : null,
    notice: (was && was.notice) || null,
    resolved: (was && was.resolved) || null,
  };
  return { marker, becameUnread: !resolved && !(was && was.status === "unread") };
}

/** The marker once the day is answered — by Junid's figures or a later read. */
function resolveUnreadMarker(existing, { via, batchKey = null, byEmail = null, nowMs }) {
  if (!existing || typeof existing !== "object") return null;
  if (existing.status === "resolved") return existing;
  return { ...existing, status: "resolved", resolved: { at: nowMs, via, batchKey, byEmail } };
}

const fmtDay = (dayYmd) => {
  const ms = sastDayStartMs(dayYmd);
  if (ms === null) return dayYmd;
  return new Date(ms + SAST_OFFSET_MS + 12 * 60 * 60 * 1000)
    .toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/**
 * The email for one till-day. Plain text, no figures from the slip and no card
 * data — the reason and where to act. Junid is the only recipient.
 */
function noticeFor(marker) {
  const till = marker.label || `${marker.storeId} ${marker.tillId || ""}`.trim();
  const subject = `Card recon: ${till} — ${fmtDay(marker.dayYmd)} slip unread, needs manual entry`;
  const text = [
    `${till} (terminal ${marker.tid}) has no recorded batch for ${fmtDay(marker.dayYmd)}.`,
    "",
    `Why: ${marker.reason}`,
    "",
    marker.photos && marker.photos.length
      ? `The slip photo${marker.photos.length === 1 ? " is" : "s are"} kept with the row.`
      : "No slip photo is on file for this day.",
    "",
    "Open the POS → Reports → Card recon, find the row marked \"Unread – needs manual entry\" and type the batch figures in.",
    "",
    "The manager was not told anything — the till screen only ever says Received.",
  ].join("\n");
  return { subject, text };
}

/** The queued notice for a marker that just became unread. */
function noticeRecord(marker, nowMs) {
  const { subject, text } = noticeFor(marker);
  return {
    kind: "unread",
    unreadPath: unreadPath(marker),
    subject, text,
    createdAt: nowMs,
    attempts: 0,
  };
}

module.exports = {
  OVERRIDES_PATH, UNREAD_PATH, NOTICES_PATH, MANUAL_AUDIT_PATH, NOTIFY_TO,
  SAST_OFFSET_MS, DAY_MS,
  sastDayYmd, sastDayStartMs, isDayYmd, unreadPath, noticeKey,
  addUnreadFailure, resolveUnreadMarker, noticeFor, noticeRecord,
};
