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
const SB_READER_VERSION = 1;

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
  SB_READER_VERSION, DAY_MS, isSyntheticRecord, inForceByBatch, planSbFiling, typedCheck, sastYmd,
};
