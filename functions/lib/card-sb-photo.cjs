// ─── A STANDARD BANK TILL'S PHOTOGRAPHED REPORT IS THE RECORD (7 Nov 2026) ───
// Junid, 7 Nov 2026: SimplyBLU does not email the Standard Bank machines'
// batch reports, and the portal's transaction list was not the till's money
// (Marathon's merchant 4977890 showed NO rows from 3 Nov — Marathon PE Till 2
// was recorded R0.00 against R33,440 of card sales on 3 Nov — and Concrete's
// fell short of the till on 3 and 6 Nov). So for every till whose terminal's
// row says `bank: "standard-bank"` (card-terminals.cjs isPhotoPrimary), the
// machine's PRINTED end-of-day report, photographed in the store app and read
// in the background, is the day's record — as Marathon PE Till 2's was through
// 2 Nov (batches 554–560, every one equal to the till).
//
// WHAT THE PAPER IS. The PAX A8900 prints the same "Batch Report (#N)" layout
// as an FNB speedpoint: MID, TID, S/N, Transactions:N, Opened/Closed/Printed,
// a reconciliation line, a Payment Type Summary block and a TOTALS block
// (Purchases, Cash, (Refunds), TOTAL). Read from Yasmin's real photos of
// 0000HP1X #561 (3 Nov, R33,440.00) and #556–#560, kept on the Mac mini only.
//
// THIS FILE decides only what is new for these tills, PURE (no IO, no clock):
//   • planSbFiling — which batch number the read report is filed under, when
//     the number it prints is already taken by a SYNTHETIC record: the
//     SimplyBLU portal's day record (3–6 Nov) or a staff-typed figure. The
//     portal numbered its days on from the last real batch, so a real report
//     of the SAME day usually prints the SAME number — it takes that record
//     over as a revision. A synthetic record of ANOTHER day is never touched:
//     the report is filed under the next free number and says which it printed.
//   • typedCheck — what a staff member typed beside the photo, as a cross-check
//     for Junid's eyes only; the read figure is the record.

"use strict";

// Bumped when the Standard Bank read changes in a way worth re-reading an
// Unread photo for. Stamped on every job and record this path writes.
const SB_READER_VERSION = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const sastYmd = (ms) => (Number.isFinite(ms) ? new Date(ms + SAST_OFFSET_MS).toISOString().slice(0, 10) : null);

/** A record nobody read off the machine's paper: the portal's day, or a staff member's typed total. */
function isSyntheticRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.capturedVia === "simplyblu-portal") return true;
  if (rec.capturedVia === "typed" && rec.declaredTotal && rec.declaredTotal.via === "staff-slip") return true;
  return false;
}

const batchOf = (rec) => Number(rec && rec.batchNo);
const printedOf = (rec) => (Number.isInteger(rec && rec.printedBatchNo) ? rec.printedBatchNo : batchOf(rec));
const revOf = (rec) => Number(rec && rec.revision) || 1;

/** The record in force for each batch number among `records` ([{key, record}]) — its highest revision. */
function inForceByBatch(records) {
  const best = new Map();
  for (const r of records || []) {
    if (!r || !r.record || !Number.isFinite(batchOf(r.record))) continue;
    const b = batchOf(r.record);
    const cur = best.get(b);
    if (!cur || revOf(r.record) > revOf(cur.record)) best.set(b, r);
  }
  return [...best.values()];
}

/**
 * Where a read Standard Bank report is filed, and which synthetic records it
 * displaces. Built against Marathon PE Till 2's real paper: the machine did not
 * settle on 4 Nov, so its #561 is 3 Nov, #562 spans 3–5 Nov and #563 5–6 Nov —
 * while the portal had numbered 3, 4 and 5 Nov as 561, 562 and 563.
 *
 * THE PRINTED NUMBER IS KEPT whenever it can be: the record is filed under the
 * number on the paper, so the machine's count and the record's stay the same
 * for every later batch. Where that number's chain holds a synthetic record of
 * a day the report's window touches (from the day the batch opened to the day
 * it closed), or one already displaced, the report takes it over as a
 * revision of that chain. A synthetic record of a day outside the report's
 * window is never touched — the report then gets the next free number.
 *
 * EVERY OTHER SYNTHETIC RECORD OF A DAY THE REPORT COVERS is DISPLACED
 * (`displacedBy` written on it after the report is recorded): its day's money
 * is in this report, so drawing it too would count the day twice. A displaced
 * record is kept exactly as it was; readers skip it.
 *
 * @param printedBatchNo  the batch number the report prints (integer)
 * @param openedAt/closedAt the report's batch window (epoch ms)
 * @param windowRecords   [{key, record}] — the terminal's records that closed
 *                        from the SAST day the batch opened to the day it
 *                        closed (one indexed range read, at most 7 days)
 * @param printedInForce  {key, record} | null — the record in force under the
 *                        printed number, whatever day it closed
 * @param highestOnFile   the terminal's highest batch number on file, or null
 * @returns {{ batchNo, correction, mode, supersedes?, displace: string[], note? }}
 *   mode "normal"     — file under the printed number, as every report is
 *   mode "over"       — a revision of the printed number's synthetic chain
 *   mode "renumbered" — the printed number belongs to a synthetic record of a
 *                       day outside this report; filed under the next free number
 */
function planSbFiling({ printedBatchNo, openedAt = null, closedAt, windowRecords = [], dayRecords = null, printedInForce = null, highestOnFile = null }) {
  const printed = Number(printedBatchNo);
  if (!Number.isInteger(printed) || printed < 0) return { batchNo: printedBatchNo, correction: false, mode: "normal", displace: [] };
  const day = sastYmd(closedAt);
  const openDay = sastYmd(openedAt) || day;
  const closeDayOf = (r) => sastYmd(Number(r.record.slip && r.record.slip.closedAt));
  const live = inForceByBatch(windowRecords.length ? windowRecords : (dayRecords || [])).filter((r) => !r.record.displacedBy);
  // A day this report's money covers: it closed after the day the batch
  // opened, up to and including the day it closed.
  const covers = (d) => !!d && d <= day && (d > openDay || d === day);
  // A day the report's window touches at all (it opened that day): enough to
  // take over the PRINTED number's own synthetic chain, so the machine's count
  // and the record's stay aligned whatever order the photos are read in. Never
  // enough to displace another record — that day's money may belong to the
  // report before this one.
  const overlaps = (d) => !!d && d >= openDay && d <= day;
  const portalWord = (rec) => (rec.capturedVia === "simplyblu-portal" ? "the SimplyBLU portal's record" : "the total typed on the Card Slip");

  // 1. THIS REPORT IS ALREADY ON FILE for the day — the ordinary duplicate /
  //    fuller-report rules decide (resolveWriteFor): a second photo of the
  //    same slip is a duplicate, never a second card.
  const own = live.find((r) => closeDayOf(r) === day && !isSyntheticRecord(r.record) && printedOf(r.record) === printed);
  if (own) return { batchNo: batchOf(own.record), correction: false, mode: "normal", displace: [] };

  const covered = live.filter((r) => isSyntheticRecord(r.record) && covers(closeDayOf(r)));
  const chain = printedInForce && printedInForce.record ? printedInForce : null;
  let plan;
  if (!chain) {
    plan = { batchNo: printed, correction: false, mode: "normal" };
  } else {
    const rec = chain.record;
    const synthetic = isSyntheticRecord(rec) || !!rec.displacedBy;
    if (!synthetic) {
      // A real report already holds this number: the re-send / re-print rules decide.
      plan = { batchNo: printed, correction: false, mode: "normal" };
    } else if (rec.displacedBy || overlaps(closeDayOf(chain))) {
      const what = rec.displacedBy ? `${chain.key} (already displaced)` : `${portalWord(rec)} for ${closeDayOf(chain)} (${chain.key})`;
      plan = {
        batchNo: printed, correction: true, mode: "over", supersedes: chain.key,
        note: `Recorded from the photographed Standard Bank report #${printed}. It replaces ${what}, which is kept unchanged.`,
      };
    } else {
      const top = Math.max(Number.isInteger(highestOnFile) ? highestOnFile : 0, printed);
      plan = {
        batchNo: top + 1, correction: false, mode: "renumbered",
        note: `The report prints batch #${printed}; that number is already used by ${portalWord(rec)} for ${closeDayOf(chain) || "another day"}, so this report is filed as #${top + 1}.`,
      };
    }
  }
  plan.displace = covered.filter((r) => !(plan.mode === "over" && r.key === plan.supersedes)).map((r) => r.key);
  if (plan.displace.length) {
    const days = covered.filter((r) => plan.displace.includes(r.key)).map((r) => `${closeDayOf(r)} (${r.key})`);
    plan.note = `${plan.note ? `${plan.note} ` : ""}This report's window covers ${days.join(", ")}, so ${plan.displace.length === 1 ? "that synthetic record is" : "those synthetic records are"} displaced by it — kept unchanged, no longer drawn as a card.`;
  }
  return plan;
}

// ─── A FADED TID LINE, PROVEN BY THE TILL'S OWN SEQUENCE (7 Nov 2026) ───────
// Marathon PE Till 2's 7 Nov report (#564, R71,015.00) was photographed twice
// — by Yasmin at 16:41 and by Junid at 21:54 — and refused both times, three
// reads each: "No terminal ID could be read off the slip". The PAX printer had
// left the MID/TID/S/N lines under the shop name almost blank; the rest of the
// paper (batch number, Opened/Closed, every total) printed crisply.
//
// The till is still proven, by the machine's own chain: a PAX batch opens the
// moment the one before it closes, and its number is the next one up. #564
// opened 2026/11/06 17:05:55; this till's #563 — read off its own paper, TID
// and all — closed 2026/11/06 17:05:58 (the paper's seconds are the machine's
// clock; the two lines are a few seconds apart, never minutes). No other
// machine's report can carry that number AND open within minutes of that
// close. So, for a Standard Bank photo-primary till ONLY, when NO TID was read
// at all (a DIFFERENT TID still refuses — that is the wrong slip), the report
// is filed under the picked till when:
//   • the picked till holds a REAL report (read off paper or a PDF — never the
//     portal's day, a typed or manual figure, or a displaced record) whose printed
//     number is exactly one below this one, and
//   • that report closed within SEQUENCE_JOIN_MS of this one opening.
// Anything less refuses by name. FNB is never asked: its TID gate is unchanged.
const SEQUENCE_JOIN_MS = 5 * 60 * 1000;

/**
 * Does the picked till's own chain prove an unprinted TID?
 * @param printedBatchNo the number the report prints
 * @param openedAt       the report's Opened time (epoch ms)
 * @param candidates     [{key, record}] — the picked TID's records that closed
 *                       within SEQUENCE_JOIN_MS of openedAt (one indexed read)
 * @param label          the till's name, for the sentences
 * @returns {{ok: true, prevKey, note} | {ok: false, reason}}
 */
function sequenceTidProof({ printedBatchNo, openedAt, candidates = [], label = "this till" }) {
  const printed = Number(printedBatchNo);
  const faint = "The terminal-ID line on this slip is too faint to read";
  if (!Number.isInteger(printed) || printed < 1 || !Number.isFinite(openedAt)) {
    return { ok: false, reason: `${faint}, and its batch number or Opened time could not be read either, so the slip cannot be proven to be ${label}'s. Retake the photo; if the top lines are blank on the paper, the printer needs a clean or a new roll.` };
  }
  const real = inForceByBatch(candidates).filter((r) => r.record && !r.record.displacedBy && !isSyntheticRecord(r.record)
    // A typed or manual record's number is a filing number, never the machine's.
    && !["typed", "manual"].includes(r.record.capturedVia));
  const joined = real.find((r) => printedOf(r.record) === printed - 1
    && Number.isFinite(Number(r.record.slip && r.record.slip.closedAt))
    && Math.abs(openedAt - Number(r.record.slip.closedAt)) <= SEQUENCE_JOIN_MS);
  if (!joined) {
    return { ok: false, reason: `${faint}, and batch #${printed} does not follow on from a report already read for ${label} (no #${printed - 1} closing when this one opened), so it cannot be proven to be ${label}'s. Retake the photo in better light; if the top lines are blank on the paper, the printer needs a clean or a new roll.` };
  }
  const closedText = new Date(Number(joined.record.slip.closedAt) + SAST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
  return {
    ok: true, prevKey: joined.key,
    note: `The terminal-ID line on this slip printed too faintly to read. It is filed under ${label} because batch #${printed} follows that till's own #${printed - 1} (${joined.key}), which closed ${closedText} — the moment this batch opened. The printer's top lines are fading: clean the print head or change the roll.`,
  };
}

/**
 * A staff member's typed total beside the photo, against what the photo read.
 * The read figure is the record; a difference is Junid's to see, never staff's.
 */
function typedCheck(typedCents, readCents) {
  if (!Number.isInteger(typedCents)) return null;
  const differs = Number.isInteger(readCents) && readCents !== typedCents;
  return { typedCents, readCents: Number.isInteger(readCents) ? readCents : null, differs };
}

module.exports = {
  SB_READER_VERSION, DAY_MS, SEQUENCE_JOIN_MS, isSyntheticRecord, inForceByBatch, planSbFiling, sequenceTidProof, typedCheck, sastYmd,
};
