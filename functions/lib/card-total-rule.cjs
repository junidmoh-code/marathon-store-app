// ─── JUNID'S TOTAL RULE (27 Nov 2026) ────────────────────────────────────────
// "The ONLY figure that matters is the batch TOTAL printed at the bottom of the
// slip/report. Read that number and reconcile it against the POS card total for
// that till and day. Nothing else is required for a slip to count."
//
// A slip is READ the moment its bottom total is found. It is UNREADABLE only
// when no total can be found at all (then the typed total stands, if there is
// one). Which till a slip belongs to comes from the submission — the till it was
// sent for, or the mailbox mapping for an emailed report — never from matching
// the code printed on the slip.
//
// So none of these may refuse a slip any more. Each is kept as a NOTE on the
// record, for Junid's eyes:
//   • TID / MID / terminal code missing, unreadable or not the till it was sent for
//   • batch number missing, unexpected or out of sequence
//   • transaction lines not read, or not summing to the total
//   • transaction count mismatch
//   • header fields (Opened/Closed, confidence) unreadable
//
// THIS FILE IS PURE: no IO, no clock. cardRecon.js does the reads and hands
// them in.
//
// Why Till 2 kept breaking: every one of the gates above was added for a good
// reason, one at a time, and each one turned a slip whose total was perfectly
// readable into "photo received — total unreadable". On 26 Nov 2026 Marathon PE
// Till 2's report (#584) printed its TID line faintly and did not follow on from
// a #583 on file, so the batch-chain proof refused it three times and the day
// went Unread — with the total sitting right there on the paper.
"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_SPAN_MS = 7 * DAY_MS;

const NO_TOTAL_REASON = "No batch total could be found on the slip — the bottom TOTAL line is not readable. "
  + "If a card total was typed with it, that figure stands; otherwise Junid enters the figure from the photo.";

/** The prefix every non-blocking finding carries on the record. */
const NOTE_PREFIX = "NOTE (not a rejection — Junid's total rule):";

const note = (text) => `${NOTE_PREFIX} ${String(text || "").trim()}`;

/** The one question that may refuse a slip: was a bottom total found? */
function hasTotal(ex) {
  return !!ex && Number.isInteger(ex.totalCents) && ex.totalCents >= 0;
}

/**
 * Repairs everything EXCEPT the total so the existing pipeline can file the
 * slip: the till it was sent for, a filing batch number, and a window on the
 * slip's own trading day. Returns { extraction, notes } — a new object; the
 * input is not changed.
 *
 *   picked        the till the slip was submitted for (its registry TID)
 *   dayYmd        the submission's trading day (YYYY-MM-DD, SAST)
 *   dayCloseMs    that day's batch close (the FNB cut-off, 18:50 SAST)
 *   onFile        { batchNo } of the till's latest record (for a filing number)
 *   otherTill     label of the machine the printed TID belongs to, if any
 */
function repairForTotalRule(ex, { picked, dayYmd = null, dayCloseMs = null, onFile = null, otherTill = null, keepTid = false } = {}) {
  const out = { ...(ex || {}) };
  const filedNo = onFile && Number.isInteger(onFile.batchNo) ? onFile.batchNo : null;
  const notes = [];
  // ── THE TILL: the submission decides ──
  if (!keepTid && picked) {
    if (!out.tid) {
      notes.push(note(`The terminal ID could not be read off the slip, so it is filed under the till it was sent for (${picked}).`));
      out.tid = picked;
      out.tidFrom = "submission";
    } else if (out.tid !== picked) {
      notes.push(note(`The slip prints terminal ID ${out.tid}${otherTill ? ` (registered to ${otherTill})` : ""}, not ${picked} — it is filed under the till it was sent for. Check the photo if this till's figure looks wrong.`));
      out.printedTid = out.tid;
      out.tid = picked;
      out.tidFrom = "submission";
    }
  }
  // ── THE WINDOW: the slip's own trading day when the header did not read ──
  // "Reconcile it against the POS card total for that till and day" (Junid):
  // the day's batch period, 18:50 the evening before → 18:50 that day (no
  // shop trades past the cut-off), never "everything since the last record" —
  // a day whose report never came would otherwise be counted again here.
  const opened = Number(out.openedAt);
  const closed = Number(out.closedAt);
  const closedOk = Number.isInteger(closed) && closed > 0;
  const openedOk = Number.isInteger(opened) && opened > 0 && closedOk && opened < closed && closed - opened <= MAX_OPEN_SPAN_MS;
  if (!closedOk || !openedOk) {
    const closeAt = closedOk ? closed : (Number.isFinite(dayCloseMs) ? dayCloseMs : null);
    if (closeAt !== null) {
      notes.push(note(closedOk
        ? "The slip's Opened time did not read cleanly, so it is reconciled against the 24 hours before its Closed time."
        : `The slip's Opened/Closed times did not read cleanly, so it is reconciled against ${dayYmd || "the day it was sent"}'s card sales (18:50 the evening before to 18:50).`));
      out.openedAt = closeAt - DAY_MS;
      out.closedAt = closeAt;
      out.windowSource = "total-rule";
    }
  }
  // ── THE BATCH NUMBER: a filing number when none was read ──
  const printed = out.batchNo === undefined || out.batchNo === null ? "" : String(out.batchNo).trim();
  if (!/^[0-9]{1,8}$/.test(printed.replace(/^#/, "").replace(/^0+(?=\d)/, ""))) {
    const n = filedNo !== null ? filedNo + 1 : 1;
    notes.push(note(`The batch number did not read off the slip, so it is filed as #${n} (a filing number, not the machine's).`));
    out.batchNo = String(n);
    out.batchFrom = "filing";
  }
  return { extraction: out, notes };
}

/**
 * validateExtraction under the total rule. `validate` is lib/card-recon.cjs
 * validateExtraction (passed in so this file stays dependency-free).
 *
 *   • No total → the ONLY refusal: { ok:false, noTotal:true, reason }.
 *   • Strict passes → exactly what strict says.
 *   • Strict refuses → the reason becomes a NOTE. The detail lines are dropped
 *     (the record is summary-only: the total is the figure) and the slip passes.
 *
 * Mutates `ex.lines` to [] when it relaxes (the caller records what it is given).
 */
function totalRuleVerdict(ex, validate, opts = {}) {
  if (!hasTotal(ex)) return { ok: false, noTotal: true, reason: NO_TOTAL_REASON };
  const strict = validate(ex, opts);
  if (strict && strict.ok) return { ...strict, relaxed: false };
  const notes = [note(strict && strict.reason)];
  const summary = validate({ ...ex, lines: [] }, { ...opts, summaryOnly: true });
  if (summary && !summary.ok && summary.reason !== (strict && strict.reason)) notes.push(note(summary.reason));
  ex.lines = [];
  return { ok: true, relaxed: true, summaryOnly: true, warnings: [...notes, ...((summary && summary.ok && summary.warnings) || [])] };
}

/**
 * A write the duplicate guard refused (lib resolveWriteFor). "Already captured,
 * identical" is a duplicate — the figure is on file, nothing is lost. "Already
 * captured but different" (or a totals-only record a later report disagrees
 * with) is NOT a rejection under the total rule: it becomes a correction, both
 * kept, the newer in force.
 */
function isDisagreeingDuplicate(reason) {
  const r = String(reason || "");
  return /does not agree with it/.test(r) || /states a different total/.test(r);
}

// ─── THE BOTTOM TOTAL OF A REPORT'S TEXT (an emailed or uploaded PDF) ───────
// When the strict PDF parser refuses (a header field it could not find, a
// line it could not parse), the total rule still asks one question: is there a
// TOTAL at the bottom? Read from the BOTTOM up: the last line that is a TOTAL
// label followed by an amount. "SUBTOTAL", "TOTALS" (a heading) and a TOTAL
// that is a count ("Total transactions 12") do not count.
const AMOUNT_AT_END = /(?:ZAR|R)?\s*(-?\(?\s*[0-9]{1,3}(?:[ ,][0-9]{3})*(?:\.[0-9]{2})|-?\(?\s*[0-9]+\.[0-9]{2})\)?\s*$/i;
function bottomTotalCents(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => String(r || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (!/(^|[^A-Z])TOTAL(?![A-Z])/i.test(row) || /SUB\s*-?TOTAL/i.test(row)) continue;
    if (/TOTAL\s+(TRANSACTIONS?|TXNS?|COUNT|ITEMS?)\b/i.test(row)) continue;
    const m = row.match(AMOUNT_AT_END);
    if (!m) continue;
    const neg = /^-|\(/.test(m[1].trim());
    const digits = m[1].replace(/[^0-9.]/g, "");
    const cents = Math.round(Number(digits) * 100);
    if (!Number.isFinite(cents)) continue;
    return neg ? -cents : cents;
  }
  return null;
}

/**
 * Which registered terminal a report belongs to when the strict parser could
 * not say: the till it was submitted for, else the mailbox mapping — the
 * "… of Terminal NNNN" subject line FNB sends, else a registered TID that
 * appears in the text. Exactly one match, or null.
 */
function tidForReport({ picked = null, subject = null, rows = [], terminals = {} }) {
  if (picked) return picked;
  const known = Object.keys(terminals || {});
  const fromSubject = String(subject || "").match(/Terminal\s+([A-Z0-9]{6,12})/i);
  if (fromSubject && known.includes(fromSubject[1].toUpperCase())) return fromSubject[1].toUpperCase();
  const text = (Array.isArray(rows) ? rows : []).join(" ").toUpperCase();
  const hits = known.filter((t) => new RegExp(`(^|[^A-Z0-9])${t}([^A-Z0-9]|$)`).test(text));
  return hits.length === 1 ? hits[0] : null;
}

module.exports = {
  NO_TOTAL_REASON, NOTE_PREFIX, note, hasTotal, repairForTotalRule, totalRuleVerdict, isDisagreeingDuplicate,
  bottomTotalCents, tidForReport,
};
