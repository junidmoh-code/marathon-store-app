// ─── JUNID TYPES A TILL'S BATCH FIGURES IN — ANY TILL, ANY DAY ───────────────
// Junid, 7 Oct 2026: "In the POS recon report, Junid's login can type the batch
// figures for any till and day, whether no slip arrived, it was unread, or it
// was wrong. Mark the source as 'manual', keep an audit trail of the original
// values, and apply the zero-variance-is-clean rule. Hide manual entry from
// every other login."
//
// WHAT IT BECOMES: an ordinary /card_batches record, built by the same
// buildBatchRecord every other capture uses, filed under the terminal's own
// filing key — so the POS report reads it exactly as it reads a photographed
// or emailed one: same segments, same legs, same verdict from the money alone
// (a zero variance is CLEAN whatever the source — POS matcher.reconVerdict).
// What marks it:
//   capturedVia: "manual"        — the source, for ever
//   slip.format: "manual"        — no document behind it
//   slip.windowSource:
//     "manual-times"  both Opened and Closed were typed — the window is his
//     "manual"        the close is typed or defaulted, the open is the
//                     previous settlement — an estimate, and the report says so
//     (a CORRECTION keeps the record it replaces' window and windowSource,
//      unless he typed new times)
//   declaredTotal                — the figure was typed, by whom, when
//   manual { reason, note, byEmail, at, dayYmd, original, unreadPath }
//     original = the figures of the record replaced, or null — the audit
//     trail of the original values. The record replaced is never touched
//     (append-only); the correction lands beside it as {batchNo}-rN.
//
// A CORRECTION ("it was wrong") is a revision of the batch Junid picked, and
// only if that is the latest revision of it — correcting r1 while r2 exists
// would silently ignore r2's figures.
//
// PURE: no IO, no clock.

"use strict";

const { parseRandsToCents, formatCents, normaliseTid } = require("./card-recon.cjs");
const { sastDayYmd, sastDayStartMs, isDayYmd, DAY_MS } = require("./card-unread.cjs");

const MANUAL_EMAIL = "gunidmoh@gmail.com";
const MAX_TOTAL_CENTS = 100000000; // R1,000,000 — a slipped finger, not a batch
const MAX_WINDOW_MS = 7 * DAY_MS;
// With no close typed, a manual batch closes at 18:00 SAST on its day: after
// every shop's evening settlement (17:00–17:20 on the real slips) and before
// any trading the next morning.
const DEFAULT_CLOSE_HOUR_SAST = 18;
const REASONS = ["no-slip", "unread", "wrong"];

/** Junid's own VERIFIED token, and nothing a permission flag grants. */
function mayEnterManually(token) {
  return !!token && token.email === MANUAL_EMAIL && token.email_verified === true;
}

const amount = (raw, label, { required = false } = {}) => {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return required ? { err: `Type the ${label}.` } : { cents: null };
  }
  if (typeof raw !== "string") return { err: `The ${label} did not arrive as text — type it again.` };
  const cents = parseRandsToCents(raw.trim());
  if (!Number.isInteger(cents)) return { err: `"${raw.trim().slice(0, 30)}" is not an amount — type the ${label} as it would print, e.g. 12,345.67.` };
  if (cents < 0) return { err: `The ${label} is typed without a sign — refunds are subtracted for you.` };
  if (cents > MAX_TOTAL_CENTS) return { err: `${formatCents(cents)} is more than any terminal takes in a batch — check the ${label}.` };
  return { cents };
};

const ms = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/**
 * The typed form → what to record, or a refusal in plain words.
 *
 * @param {object} p
 * @param {object} p.input       { tid, dayYmd, reason, note, total, purchases, refunds, cash, txnCount, batchNo, openedAt, closedAt, replaces }
 * @param {number} p.nowMs       the server's clock
 * @param {object|null} p.replaced  the record named by `replaces`, read by the caller, or null
 * @param {boolean} p.replacedIsLatest  is it the latest revision of its batch?
 * @param {number|null} p.prevClosedAt  this terminal's last settlement before the close, or null
 * @returns {{ok:true, extraction:object, batchNo:number, correction:boolean, warnings:string[], manual:object}
 *          | {ok:false, reason:string}}
 */
function planManualEntry({ input, nowMs, replaced = null, replacedIsLatest = true, prevClosedAt = null, prevBatchNo = null, nextOpenedAt = null }) {
  const i = input || {};
  const tid = normaliseTid(i.tid);
  if (!tid) return { ok: false, reason: "Pick the till first." };
  if (!isDayYmd(i.dayYmd) || sastDayStartMs(i.dayYmd) === null) return { ok: false, reason: "Pick the day the figures are for." };
  const dayStart = sastDayStartMs(i.dayYmd);
  if (dayStart > nowMs) return { ok: false, reason: "That day has not happened yet." };
  const reason = REASONS.includes(i.reason) ? i.reason : (i.replaces ? "wrong" : "no-slip");
  const note = typeof i.note === "string" && i.note.trim() ? i.note.trim().slice(0, 500) : null;

  const total = amount(i.total, "batch total", { required: true });
  if (total.err) return { ok: false, reason: total.err };
  const purchases = amount(i.purchases, "purchases figure");
  if (purchases.err) return { ok: false, reason: purchases.err };
  const refunds = amount(i.refunds, "refunds figure");
  if (refunds.err) return { ok: false, reason: refunds.err };
  const cash = amount(i.cash, "cash figure");
  if (cash.err) return { ok: false, reason: cash.err };
  // The slip's own arithmetic, when the parts were typed: purchases + cash −
  // refunds = TOTAL. A typed part that does not add up is a typo; refusing it
  // is cheaper than a variance chased for a week.
  if (purchases.cents !== null) {
    const sum = purchases.cents + (cash.cents ?? 0) - (refunds.cents ?? 0);
    if (sum !== total.cents) {
      return { ok: false, reason: `Those figures do not add up: ${formatCents(purchases.cents)} purchases + ${formatCents(cash.cents ?? 0)} cash − ${formatCents(refunds.cents ?? 0)} refunds is ${formatCents(sum)}, not the ${formatCents(total.cents)} total.` };
    }
  } else if (refunds.cents !== null || cash.cents !== null) {
    return { ok: false, reason: "Type the purchases figure too, or leave refunds and cash empty — the parts must add up to the total." };
  }
  let txnCount = null;
  if (i.txnCount !== undefined && i.txnCount !== null && String(i.txnCount).trim() !== "") {
    txnCount = Number(String(i.txnCount).trim());
    if (!Number.isInteger(txnCount) || txnCount < 0 || txnCount > 5000) return { ok: false, reason: "The transaction count is a whole number." };
  }

  // ── WHICH BATCH ──────────────────────────────────────────────────────────
  let batchNo;
  let correction = false;
  if (i.replaces) {
    if (!replaced) return { ok: false, reason: "The batch being corrected is not on file any more — reload the report." };
    if (!replacedIsLatest) return { ok: false, reason: `Batch #${replaced.batchNo} has a newer capture than the one you opened — correct that one, so its figures are not skipped.` };
    if (replaced.tid !== tid) return { ok: false, reason: "That batch belongs to another terminal." };
    batchNo = Number(replaced.batchNo);
    correction = true;
  } else {
    batchNo = Number(String(i.batchNo ?? "").trim());
    if (!Number.isInteger(batchNo) || batchNo < 1 || batchNo > 99999999) {
      return { ok: false, reason: "Type the batch number (the report suggests the next one in sequence)." };
    }
  }

  // ── THE WINDOW ───────────────────────────────────────────────────────────
  const typedOpen = ms(i.openedAt);
  const typedClose = ms(i.closedAt);
  // With no close typed: the batch it corrects keeps its close; otherwise the
  // NEXT recorded batch's printed opening that day is exactly where this one
  // settled (the machine closes one batch as it opens the next); failing that,
  // 18:00 SAST. (Sonnet review, #707: real closes run 17:00–17:40.)
  const nextOpenToday = Number.isFinite(nextOpenedAt) && sastDayYmd(nextOpenedAt) === i.dayYmd ? nextOpenedAt : null;
  let closedAt = typedClose
    ?? (correction && Number.isFinite(replaced.slip?.closedAt) ? replaced.slip.closedAt : null)
    ?? nextOpenToday
    ?? Math.min(nowMs, dayStart + DEFAULT_CLOSE_HOUR_SAST * 60 * 60 * 1000);
  if (sastDayYmd(closedAt) !== i.dayYmd) {
    return { ok: false, reason: `The batch must close on ${i.dayYmd}, the day it is entered for — the report files a batch on the day it closed.` };
  }
  if (closedAt > nowMs) return { ok: false, reason: "The close time has not happened yet." };
  let openedAt;
  let windowSource;
  const notes = [];
  if (typedOpen) {
    // A typed Opened is his, stated — the report starts the window there
    // (dayRows.ownStart reads "manual-times"), whatever the close was.
    openedAt = typedOpen;
    windowSource = "manual-times";
  } else if (correction && !typedClose && Number.isFinite(replaced.slip?.openedAt)) {
    // A correction keeps the window it corrects — only the figures change.
    openedAt = replaced.slip.openedAt;
    windowSource = replaced.slip.windowSource || "printed";
  } else if (Number.isFinite(prevClosedAt) && prevClosedAt < closedAt && closedAt - prevClosedAt <= MAX_WINDOW_MS) {
    openedAt = prevClosedAt;
    windowSource = "manual";
    notes.push("The window opens at this terminal's previous settlement — no Opened time was typed.");
  } else {
    openedAt = closedAt - DAY_MS;
    windowSource = "manual";
    notes.push("The window is the 24 hours before the close — no Opened time was typed and no earlier settlement is on file within a week.");
  }
  if (!(openedAt < closedAt)) return { ok: false, reason: "The Opened time must be before the Closed time." };
  if (closedAt - openedAt > MAX_WINDOW_MS) return { ok: false, reason: "No batch runs longer than 7 days — check the Opened time." };

  const extraction = {
    tid,
    mid: null,
    batchNo: String(batchNo),
    openedAt, closedAt, printedAt: null,
    openedText: null, closedText: null,
    txnCount,
    purchasesCents: purchases.cents,
    cashCents: cash.cents,
    refundsCents: refunds.cents,
    totalCents: total.cents,
    reconLine: null,
    format: "manual",
    windowSource,
    confidence: null,
    lines: [],
  };
  const original = correction ? {
    batchKey: replaced.batchKey || null,
    capturedVia: replaced.capturedVia || null,
    totalCents: replaced.slip?.totalCents ?? null,
    purchasesCents: replaced.slip?.purchasesCents ?? null,
    refundsCents: replaced.slip?.refundsCents ?? null,
    cashCents: replaced.slip?.cashCents ?? null,
    txnCount: replaced.slip?.txnCount ?? null,
    openedAt: replaced.slip?.openedAt ?? null,
    closedAt: replaced.slip?.closedAt ?? null,
    windowSource: replaced.slip?.windowSource ?? null,
    varianceCents: Number.isInteger(replaced.varianceCents) ? replaced.varianceCents : null,
  } : null;
  // A NUMBER OUT OF SEQUENCE is said, not refused: terminals are replaced and
  // numbers restart, but #5 typed for #50 is likelier. (Sonnet review, #707.)
  if (!correction && Number.isInteger(prevBatchNo) && (batchNo <= prevBatchNo || batchNo > prevBatchNo + 30)) {
    notes.push(`Batch #${batchNo} does not follow this terminal's previous batch (#${prevBatchNo}) — check the number against the slip.`);
  }
  const why = { "no-slip": "no slip arrived", unread: "the slip could not be read", wrong: "the recorded figures were wrong" }[reason];
  const warnings = [
    `Entered by hand by Junid for ${i.dayYmd} (${why}). There is no slip reading behind these figures.`,
    ...(original ? [`This replaces ${original.batchKey || `batch #${batchNo}`} (${original.capturedVia || "capture"}, total ${Number.isInteger(original.totalCents) ? formatCents(original.totalCents) : "unread"}) — that record is kept unchanged.`] : []),
    ...notes,
  ];
  return {
    ok: true, extraction, batchNo, correction, warnings,
    manual: { reason, note, dayYmd: i.dayYmd, original },
  };
}

module.exports = { MANUAL_EMAIL, DEFAULT_CLOSE_HOUR_SAST, REASONS, mayEnterManually, planManualEntry };
