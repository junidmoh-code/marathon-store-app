// lib/card-sb-photo.cjs — where a read Standard Bank report is filed (7 Nov 2026).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planSbFiling, isSyntheticRecord, typedCheck } = require("../lib/card-sb-photo.cjs");

const SAST = (s) => Date.parse(`${s}+02:00`);
const rec = (batchNo, closed, over = {}) => ({ batchNo, revision: 1, capturedVia: "photo", slip: { closedAt: SAST(closed) }, ...over });
const portal = (batchNo, day) => rec(batchNo, `${day}T23:59:59`, { capturedVia: "simplyblu-portal" });
const staffTyped = (batchNo, closed) => rec(batchNo, closed, { capturedVia: "typed", declaredTotal: { via: "staff-slip", cents: 1 } });
const CLOSE = SAST("2026-11-07T17:05:00");

test("synthetic: the portal's day and a staff-typed total; never a photo, an email or Junid's manual entry", () => {
  assert.equal(isSyntheticRecord(portal(1, "2026-11-03")), true);
  assert.equal(isSyntheticRecord(staffTyped(1, "2026-11-03T18:50:00")), true);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00")), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "pdf" })), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "manual" })), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "typed", declaredTotal: { byEmail: "gunidmoh@gmail.com" } })), false);
});

test("nothing on file: the printed number, as every report", () => {
  assert.deepEqual(planSbFiling({ printedBatchNo: 564, closedAt: CLOSE }), { batchNo: 564, correction: false, mode: "normal" });
});

test("the same day's portal record is taken over as a revision of ITS batch, whatever number the paper prints", () => {
  const p = planSbFiling({ printedBatchNo: 12, closedAt: CLOSE, dayRecords: [{ key: "9", record: portal(9, "2026-11-07") }] });
  assert.equal(p.mode, "over");
  assert.equal(p.batchNo, 9);
  assert.equal(p.correction, true);
  assert.equal(p.supersedes, "9");
  assert.match(p.note, /\(it prints batch #12\)/);
});

test("the same day's staff-typed record is taken over too (the photo outranks staff)", () => {
  const p = planSbFiling({ printedBatchNo: 564, closedAt: CLOSE, dayRecords: [{ key: "564", record: staffTyped(564, "2026-11-07T18:50:00") }] });
  assert.equal(p.mode, "over");
  assert.equal(p.batchNo, 564);
  assert.match(p.note, /typed on the Card Slip/);
});

test("this report already on file for the day (filed under another number) → its own chain decides", () => {
  const filed = rec(563, "2026-11-07T17:05:00", { printedBatchNo: 561 });
  const p = planSbFiling({ printedBatchNo: 561, closedAt: CLOSE, dayRecords: [{ key: "563", record: filed }] });
  assert.deepEqual(p, { batchNo: 563, correction: false, mode: "normal" });
});

test("a portal day already taken over by a photo is not taken over again (its chain is the photo's)", () => {
  const p = planSbFiling({ printedBatchNo: 561, closedAt: SAST("2026-11-03T17:08:38"), dayRecords: [
    { key: "561", record: portal(561, "2026-11-03") },
    { key: "561-r2", record: rec(561, "2026-11-03T17:08:38", { revision: 2 }) },
  ] });
  assert.deepEqual(p, { batchNo: 561, correction: false, mode: "normal" });
});

test("the printed number belongs to ANOTHER day's synthetic record → the next free number", () => {
  const p = planSbFiling({ printedBatchNo: 3, closedAt: CLOSE, printedInForce: { key: "3", record: portal(3, "2026-11-01") }, highestOnFile: 8 });
  assert.equal(p.mode, "renumbered");
  assert.equal(p.batchNo, 9);
  assert.match(p.note, /prints batch #3; that number is already used by the SimplyBLU portal's record for 2026-11-01, so this report is filed as #9/);
});

test("the printed number belongs to another day's REAL report → normal (the duplicate / re-print rules decide)", () => {
  const p = planSbFiling({ printedBatchNo: 3, closedAt: CLOSE, printedInForce: { key: "3", record: rec(3, "2026-11-01T17:00:00") }, highestOnFile: 8 });
  assert.equal(p.mode, "normal");
  assert.equal(p.batchNo, 3);
});

test("typed check: the read figure is the record; a difference is flagged, a match is not", () => {
  assert.equal(typedCheck(null, 100), null);
  assert.deepEqual(typedCheck(100, 100), { typedCents: 100, readCents: 100, differs: false });
  assert.deepEqual(typedCheck(100, 150), { typedCents: 100, readCents: 150, differs: true });
  assert.deepEqual(typedCheck(100, null), { typedCents: 100, readCents: null, differs: false });
});
