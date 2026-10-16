// ─── AN EMPTY BATCH RE-PRINTED ON A LATER DAY IS THAT DAY'S REPORT ──────────
// Marathon Till 3 (67365901) took no card from 14 to 16 Oct 2026. At each
// evening's settlement it re-printed its last batch — "Batch 92 … Total ZAR
// 0.00" — with that day's print time:
//
//     14-10-2026 16:51:45   recorded as #92 (an empty batch)
//     14-10-2026 16:51:51   a second copy, same evening
//     15-10-2026 16:48:41   + 16:48:52
//     16-10-2026 16:57:18   + 16:57:27
//
// Every copy after the first was refused "Batch #92 … is already captured".
// The store app ticks a till on such a re-send, so it showed PE Till 3 as in on
// 16 Oct; /card_batches had nothing closing that day, so Junid's Card Recon
// showed "Speedpoint —, POS R0.00, awaiting a slip" for the same till.
//
// The fix: the FIRST later-day copy is recorded as a later report of #92
// (92-r2, then 92-r3), R0.00, from the report on file to that print. The record
// shapes below are the live 91 and 92 records, read 16 Oct 2026; the report
// lines are the real 92 report's (no card data is printed on an empty batch).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { makeSlipPdf } = require("./fixtures/makeSlipPdf.cjs");
const { handleExtract, handleSubmit } = require("../cardRecon/cardRecon.js");
const { emptyReprintOpensAt } = require("../lib/card-recon.cjs");

const TID = "67365901";
const POLLER = { uid: "card-recon-email-poller", token: { email: "gunidmoh@gmail.com" } };
const TERMINALS = { [TID]: { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" } };
const bucket = () => ({ file() { return { save: async () => {} }; } });

/** The real empty report of batch 92, printed at `printed` ("DD-MM-YYYY HH:MM:SS", SAST). */
function batch92(printed) {
  const base = require("./fixtures/real-report-empty-lines.json");
  return base.map((l) => l
    .replace("Banking Report for Batch 81", "Banking Report for Batch 92")
    .replace(/^21-09-2026 17:15:31$/, printed)
    .replace(/^Batch: 81$/, "Batch: 92"));
}

// The live records, as read on 16 Oct 2026 (figures and window only).
const SAST = (y, m, d, hh, mm, ss) => Date.UTC(y, m - 1, d, hh - 2, mm, ss);
const B91 = {
  batchKey: "91", batchNo: 91, revision: 1, autoSuperseded: false, linesCaptured: true, lineCount: 0,
  slip: { openedAt: 1791384968001, closedAt: 1791902184001, printedAt: 1791902184000, totalCents: 0, purchasesCents: 0, txnCount: 0, format: "emailed", windowSource: "empty-batch" },
};
const B92 = {
  batchKey: "92", batchNo: 92, revision: 1, autoSuperseded: false, linesCaptured: true, lineCount: 0,
  slip: { openedAt: 1791989505000, closedAt: 1791989505001, printedAt: 1791989505000, totalCents: 0, purchasesCents: 0, txnCount: 0, format: "emailed", windowSource: "empty-batch" },
};

function liveDb(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    card_batches: { pe: { [TID]: { 91: B91, 92: B92 } } },
    ...extra,
  });
}

let n = 0;
async function viaEmail(db, lines) {
  n += 1;
  const extract = await handleExtract(db, {
    auth: POLLER,
    data: { action: "extract", channel: "email", pdf: { base64: makeSlipPdf(lines).toString("base64") },
      intake: { messageId: `<reprint-${n}@fnb>`, from: "FNB", subject: "Banking Report for Batch 92 of Terminal 67365901", filename: "FNB-Txn-Notification.pdf", receivedAt: 1 } },
  }, { bucket: bucket() });
  if (!extract.ok) return { extract };
  const submit = await handleSubmit(db, { auth: POLLER, data: { action: "submit", draftId: extract.draftId } });
  return { extract, submit };
}

const rec = async (db, key) => (await db.ref(`card_batches/pe/${TID}/${key}`).once("value")).val();

test("the 14 Oct second copy is still a re-send — same day, nothing new", async () => {
  const db = liveDb();
  const { extract } = await viaEmail(db, batch92("14-10-2026 16:51:51"));
  assert.equal(extract.ok, false);
  assert.match(extract.reason, /Batch #92 for this terminal is already captured/);
  assert.equal(await rec(db, "92-r2"), null);
});

test("15 and 16 Oct: the first copy each day is recorded R0.00 for that day; the second is a re-send", async () => {
  const db = liveDb();

  const d15 = await viaEmail(db, batch92("15-10-2026 16:48:41"));
  assert.equal(d15.extract.ok, true, d15.extract.reason);
  assert.equal(d15.submit.ok, true, d15.submit.reason);
  assert.equal(d15.submit.batchKey, "92-r2");
  const r2 = await rec(db, "92-r2");
  assert.equal(r2.autoSuperseded, true, "a later report of the batch, never a correction");
  assert.equal(r2.supersedes, "92");
  assert.equal(r2.slip.totalCents, 0);
  assert.equal(r2.slip.windowSource, "empty-batch");
  // From the report on file (92's close) to this print: no gap, no overlap.
  assert.equal(r2.slip.openedAt, B92.slip.closedAt);
  assert.equal(r2.slip.closedAt, SAST(2026, 10, 15, 16, 48, 41) + 1);
  assert.equal(r2.expected.cardCents, 0);
  assert.equal(r2.varianceCents, 0);
  assert.ok(r2.warnings.some((w) => /re-printed batch #92 on a later day/.test(w)));

  const d15b = await viaEmail(db, batch92("15-10-2026 16:48:52"));
  assert.equal(d15b.extract.ok, false);
  assert.match(d15b.extract.reason, /already captured/);

  const d16 = await viaEmail(db, batch92("16-10-2026 16:57:18"));
  assert.equal(d16.submit.ok, true, d16.submit?.reason || d16.extract.reason);
  assert.equal(d16.submit.batchKey, "92-r3");
  const r3 = await rec(db, "92-r3");
  assert.equal(r3.supersedes, "92-r2");
  assert.equal(r3.slip.openedAt, r2.slip.closedAt);
  assert.equal(r3.slip.closedAt, SAST(2026, 10, 16, 16, 57, 18) + 1);
  assert.equal(r3.slip.totalCents, 0);

  const d16b = await viaEmail(db, batch92("16-10-2026 16:57:27"));
  assert.equal(d16b.extract.ok, false);
  assert.match(d16b.extract.reason, /already captured/);
});

test("card money rung on the till since the last report is that day's variance, never hidden", async () => {
  // A R250 card sale on PE Till 3 at 10:00 on 15 Oct. The terminal says R0.
  const db = liveDb({
    pos: { paymentEvents: { e1: { method: "card", storeId: "pe", tillId: "till-3", amount: 25000, at: SAST(2026, 10, 15, 10, 0, 0) } } },
  });
  const { submit } = await viaEmail(db, batch92("15-10-2026 16:48:41"));
  assert.equal(submit.ok, true);
  const r2 = await rec(db, "92-r2");
  assert.equal(r2.slip.totalCents, 0);
  assert.equal(r2.expected.cardCents, 25000);
  assert.equal(r2.varianceOnTillCents, -25000, "R0 on the slip against R250 in POS is a shortfall");
});

test("only an EMPTY batch on file is continued this way", async () => {
  // Batch 92 on file with a transaction — an R0 copy of it later is not this case.
  const busy = { ...B92, slip: { ...B92.slip, totalCents: 18000, purchasesCents: 18000, txnCount: 1, windowSource: "transactions-to-print" },
    lines: { 1: { tsn: 1, amountCents: 18000, rrn: "x" } }, lineCount: 1 };
  const db = makeFakeDb({ config: { cardTerminals: TERMINALS }, card_batches: { pe: { [TID]: { 91: B91, 92: busy } } } });
  const { extract } = await viaEmail(db, batch92("15-10-2026 16:48:41"));
  assert.equal(extract.ok, false);
  assert.equal(await rec(db, "92-r2"), null);
});

test("emptyReprintOpensAt: the SA day decides, at midnight SAST, not UTC", () => {
  const closedAt = SAST(2026, 10, 14, 16, 51, 45) + 1;
  const slip = { windowSource: "empty-batch", totalCents: 0, closedAt };
  const empty = (printedAt) => ({ emptyBatch: true, totalCents: 0, lines: [], printedAt });
  assert.equal(emptyReprintOpensAt(slip, empty(SAST(2026, 10, 14, 23, 59, 59))), null, "same SA day");
  assert.equal(emptyReprintOpensAt(slip, empty(SAST(2026, 10, 15, 0, 0, 1))), closedAt, "next SA day");
  assert.equal(emptyReprintOpensAt(slip, { ...empty(SAST(2026, 10, 15, 9, 0, 0)), totalCents: 100 }), null, "not R0");
  assert.equal(emptyReprintOpensAt(slip, { ...empty(SAST(2026, 10, 15, 9, 0, 0)), emptyBatch: false }), null, "not empty");
  assert.equal(emptyReprintOpensAt({ ...slip, windowSource: "typed-span" }, empty(SAST(2026, 10, 15, 9, 0, 0))), null, "on file is not an empty batch");
  assert.equal(emptyReprintOpensAt({ ...slip, totalCents: 5 }, empty(SAST(2026, 10, 15, 9, 0, 0))), null, "on file is not R0");
  assert.equal(emptyReprintOpensAt(null, empty(SAST(2026, 10, 15, 9, 0, 0))), null);
});
