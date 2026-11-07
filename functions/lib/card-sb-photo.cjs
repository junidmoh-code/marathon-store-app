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
 * Where a read Standard Bank report is filed.
 *
 * @param printedBatchNo  the batch number the report prints (integer)
 * @param closedAt        when the report's batch closed (epoch ms)
 * @param dayRecords      [{key, record}] — every record of this terminal whose
 *                        slip closed on the same SAST day (an indexed range read)
 * @param printedInForce  {key, record} | null — the record in force under the
 *                        printed number, whatever day it closed
 * @param highestOnFile   the terminal's highest batch number on file, or null
 * @returns {{ batchNo, correction, mode, supersedes?, note? }}
 *   mode "normal"     — file under the printed number, as every report is
 *   mode "over"       — a revision of the same day's synthetic record (correction)
 *   mode "renumbered" — the printed number belongs to another day's synthetic
 *                       record; filed under the next free number
 */
function planSbFiling({ printedBatchNo, closedAt, dayRecords = [], printedInForce = null, highestOnFile = null }) {
  const printed = Number(printedBatchNo);
  if (!Number.isInteger(printed) || printed < 0) return { batchNo: printedBatchNo, correction: false, mode: "normal" };
  const day = sastYmd(closedAt);
  const sameDay = inForceByBatch(dayRecords).filter((r) => sastYmd(Number(r.record.slip && r.record.slip.closedAt)) === day);

  // 1. THIS REPORT IS ALREADY ON FILE for the day — under its own number, or
  //    under the number it was filed as. The ordinary duplicate / fuller-report
  //    rules decide (resolveWriteFor): a second photo of the same slip is a
  //    duplicate, never a second card.
  const own = sameDay.find((r) => !isSyntheticRecord(r.record) && printedOf(r.record) === printed);
  if (own) return { batchNo: batchOf(own.record), correction: false, mode: "normal" };

  // 2. THE DAY IS HELD BY A SYNTHETIC RECORD (the portal's day, a staff-typed
  //    total): the machine's own report takes it over as a revision of that
  //    record's batch, so the day stays one card. The old record is kept.
  const synth = sameDay.filter((r) => isSyntheticRecord(r.record))
    .sort((a, b) => (a.record.capturedVia === "simplyblu-portal" ? -1 : 1) - (b.record.capturedVia === "simplyblu-portal" ? -1 : 1))[0];
  if (synth) {
    const portal = synth.record.capturedVia === "simplyblu-portal";
    const what = portal ? `the SimplyBLU portal's figure for ${day}` : `the total typed on the Card Slip for ${day}`;
    const filed = batchOf(synth.record);
    return {
      batchNo: filed, correction: true, mode: "over", supersedes: synth.key,
      note: `Recorded from the photographed Standard Bank report${filed === printed ? "" : ` (it prints batch #${printed})`}. It replaces ${what} (${synth.key}), which is kept unchanged.`,
    };
  }

  // 3. THE PRINTED NUMBER IS TAKEN BY ANOTHER DAY'S SYNTHETIC RECORD — the
  //    portal numbered its days on from the last real batch, so the machine's
  //    own count can meet one. That record is never touched: this report gets
  //    the next free number, and says what it printed.
  if (printedInForce && printedInForce.record && isSyntheticRecord(printedInForce.record)) {
    const otherDay = sastYmd(Number(printedInForce.record.slip && printedInForce.record.slip.closedAt));
    if (otherDay !== day) {
      const top = Math.max(Number.isInteger(highestOnFile) ? highestOnFile : 0, printed);
      return {
        batchNo: top + 1, correction: false, mode: "renumbered",
        note: `The report prints batch #${printed}; that number is already used by ${printedInForce.record.capturedVia === "simplyblu-portal" ? "the SimplyBLU portal's record" : "a typed total"} for ${otherDay || "another day"}, so this report is filed as #${top + 1}.`,
      };
    }
  }
  return { batchNo: printed, correction: false, mode: "normal" };
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
