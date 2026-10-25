// ─── TROPHY TILL 1, 25 OCT 2026 — A MOVED MACHINE AND A FALSE "R0.00" ───────
// Junid reported no card recon for Trophy Till 1 on 24 and 25 Oct. Nothing had
// failed to arrive (docs/CARD-RECON-TROPHY-TILL1-2026-10-25.md). Two things
// made recorded days read as empty, and both are pinned here:
//
//   1. resolveWriteFor left `reprintOpensAt` undefined on its ordinary return,
//      and the PDF path's `!== null` took every report for a re-print — so
//      each opened with "re-printed … recorded as R0.00 for this day".
//   2. The capture side reconciled on the FILING till. 67377843 is filed
//      trophy/till-1 and has stood on Marathon Till 1 since the 5 Oct swap,
//      so its own till's sales came back "rung up on another till".
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = "127.0.0.1:9";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { emailedLines, makeSlipPdfPaged } = require("./fixtures/makeSlipPdf.cjs");
const { handleExtract, handleSubmit, resolveWriteFor } = require("../cardRecon/cardRecon.js");
const { windowTill } = require("../lib/card-terminal-placements.cjs");

const POLLER = { uid: "card-recon-email-poller", token: { email: "gunidmoh@gmail.com" } };
const bucket = () => ({ file() { return { save: async () => {} }; } });
const SWAP = Date.parse("2026-08-20T12:46:00+02:00"); // before the fixture's 29 Aug report

// The live registry shape of the two swapped machines (placements as written
// by apply-terminal-placements-20261005, moved earlier to suit the fixture).
const TERMINALS = {
  "67377843": {
    label: "Marathon Till 1", mid: "100000001178101", storeId: "trophy", tillId: "till-1",
    placements: {
      "at-0": { effectiveFrom: 0, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
      [`at-${SWAP}`]: { effectiveFrom: SWAP, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
    },
  },
};

/** One POS card leg per report line, two minutes after its approval, on `storeId/tillId`. */
function legsFor(report, { storeId, tillId }) {
  const { tsns } = report.truth;
  const out = {};
  tsns.forEach((tsn, i) => {
    const mins = 9 * 60 + 7 + Math.round((i / Math.max(tsns.length - 1, 1)) * ((16 * 60 + 9) - (9 * 60 + 7)));
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    const ss = String((i * 13 + 23) % 60).padStart(2, "0");
    const at = Date.parse(`2026-08-29T${hh}:${mm}:${ss}+02:00`) + 2 * 60 * 1000;
    out[`e${i}`] = { method: "card", kind: "sale", storeId, tillId, amount: 90000 - i * 100, at };
  });
  return out;
}

let n = 0;
async function viaEmail(db, report) {
  n += 1;
  const bytes = makeSlipPdfPaged(report.lines, { perPage: 60 });
  const extract = await handleExtract(db, {
    auth: POLLER,
    data: { action: "extract", channel: "email", pdf: { base64: bytes.toString("base64") },
      intake: { messageId: `<swap-${n}@fnb>`, from: "FNB", subject: "Banking Report", filename: "FNB-Txn-Notification.pdf", receivedAt: 1 } },
  }, { bucket: bucket() });
  if (!extract.ok) return { extract };
  return { extract, submit: await handleSubmit(db, { auth: POLLER, data: { action: "submit", draftId: extract.draftId } }) };
}

const REPRINT = /^The terminal re-printed batch/;
const OFF_TILL = /rung up on another till/;

test("windowTill: the placement in force for the whole window, null when a move cuts it", () => {
  const row = TERMINALS["67377843"];
  assert.deepEqual(windowTill(row, SWAP + 1, SWAP + 1000), { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" });
  assert.deepEqual(windowTill(row, SWAP - 1000, SWAP - 1), { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" });
  assert.equal(windowTill(row, SWAP - 1000, SWAP + 1000), null, "a move inside the window has no single till");
  assert.deepEqual(windowTill(row, SWAP, SWAP + 1), { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" }, "a move AT the open is the new till's");
  assert.deepEqual(windowTill({ storeId: "pine", tillId: "till-1" }, 1, 2), { storeId: "pine", tillId: "till-1", label: null }, "no placements: the row's own till");
  assert.equal(windowTill(row, 5, 5), null);
});

test("resolveWriteFor: an ordinary report says reprintOpensAt null, never undefined", async () => {
  const db = makeFakeDb({});
  const res = await resolveWriteFor(db, { storeId: "pe", tid: "67325636", batchNo: "70", correction: false, lines: [] });
  assert.equal(res.write.ok, true);
  assert.equal(res.reprintOpensAt, null);
  assert.ok("reprintOpensAt" in res);
});

test("a FIRST emailed report carries no re-print sentence (24 Oct: Trophy's R27,858 day said R0.00)", async () => {
  const db = makeFakeDb({ config: { cardTerminals: { "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" } } } });
  const { extract, submit } = await viaEmail(db, emailedLines({}));
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(submit.ok, true, submit.reason);
  const rec = (await db.ref("card_batches/pe/67365901/59").once("value")).val();
  assert.equal(rec.revision, 1);
  assert.ok(!(rec.warnings || []).some((w) => REPRINT.test(w)), `no re-print sentence: ${JSON.stringify(rec.warnings)}`);
});

test("a fuller later report of an open batch carries no re-print sentence either", async () => {
  const db = makeFakeDb({ config: { cardTerminals: { "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" } } } });
  const all = emailedLines({});
  const tsns = all.truth.tsns;
  const first = await viaEmail(db, emailedLines({ tsns: tsns.slice(0, 10), printedAt: "29-08-2026 12:00:00" }));
  assert.equal(first.submit.ok, true, first.submit?.reason ?? first.extract.reason);
  const later = await viaEmail(db, emailedLines({ printedAt: "30-08-2026 16:30:00" }));
  assert.equal(later.extract.ok, true, later.extract.reason);
  assert.equal(later.submit.batchKey, "59-r2");
  const rec = (await db.ref("card_batches/pe/67365901/59-r2").once("value")).val();
  assert.equal(rec.autoSuperseded, true);
  assert.ok(!(rec.warnings || []).some((w) => REPRINT.test(w)), `no re-print sentence: ${JSON.stringify(rec.warnings)}`);
});

test("an unchanged batch re-printed on a later day STILL says so", async () => {
  const db = makeFakeDb({ config: { cardTerminals: { "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" } } } });
  await viaEmail(db, emailedLines({ printedAt: "29-08-2026 16:26:31" }));
  const next = await viaEmail(db, emailedLines({ printedAt: "30-08-2026 16:30:00" }));
  assert.equal(next.submit.ok, true, next.submit?.reason ?? next.extract.reason);
  const rec = (await db.ref("card_batches/pe/67365901/59-r2").once("value")).val();
  assert.ok(rec.warnings.some((w) => REPRINT.test(w)));
});

test("a moved machine is reconciled on the till it stood on — filed where it always was", async () => {
  const report = emailedLines({ tid: "67377843", batchNo: 51 });
  const db = makeFakeDb({
    config: { cardTerminals: TERMINALS },
    // Marathon Till 1's sales — where 67377843 stood that day. Trophy's till
    // took nothing on this machine.
    pos: { paymentEvents: legsFor(report, { storeId: "pe", tillId: "till-1" }) },
  });
  const { extract, submit } = await viaEmail(db, report);
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(submit.ok, true, submit.reason);
  // Filed under its registry row, exactly as before.
  const rec = (await db.ref("card_batches/trophy/67377843/51").once("value")).val();
  assert.ok(rec, "filed under trophy/67377843");
  assert.equal(rec.storeId, "trophy");
  // …but reconciled on pe/till-1.
  assert.equal(rec.expected.cardCents, report.truth.totalCents);
  assert.equal(rec.varianceCents, 0);
  assert.equal(rec.placeStoreId, "pe");
  assert.equal(rec.placeTillId, "till-1");
  assert.ok(!(rec.warnings || []).some((w) => OFF_TILL.test(w)), `no off-till finding: ${JSON.stringify(rec.warnings)}`);
  // The poller is told when the batch closed and where the machine stood.
  assert.equal(submit.placeStoreId, "pe");
  assert.equal(submit.placeTillId, "till-1");
  assert.equal(submit.placeLabel, "Marathon Till 1");
  assert.equal(submit.closedAt, rec.slip.closedAt);
});

test("a batch whose window a move cuts in two keeps the filing till and says so", async () => {
  const report = emailedLines({ tid: "67377843", batchNo: 52 });
  const midDay = Date.parse("2026-08-29T12:00:00+02:00");
  const moved = {
    "67377843": { ...TERMINALS["67377843"], placements: {
      "at-0": { effectiveFrom: 0, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
      [`at-${midDay}`]: { effectiveFrom: midDay, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
    } },
  };
  const db = makeFakeDb({ config: { cardTerminals: moved } });
  const { extract, submit } = await viaEmail(db, report);
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(submit.ok, true, submit.reason);
  const rec = (await db.ref("card_batches/trophy/67377843/52").once("value")).val();
  assert.equal(rec.placeStoreId, undefined, "no single till to stamp");
  assert.equal(rec.warnings.filter((w) => /moved to another till while this batch was open/.test(w)).length, 1, "said once, not once per side");
  assert.equal(submit.placeStoreId, "trophy");
});

test("a move away and back inside one window still says the machine moved (CodeRabbit, #799)", async () => {
  const report = emailedLines({ tid: "67377843", batchNo: 53 });
  const away = Date.parse("2026-08-29T11:00:00+02:00");
  const back = Date.parse("2026-08-29T13:00:00+02:00");
  const row = { ...TERMINALS["67377843"], placements: {
    "at-0": { effectiveFrom: 0, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
    [`at-${away}`]: { effectiveFrom: away, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
    [`at-${back}`]: { effectiveFrom: back, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
  } };
  const db = makeFakeDb({ config: { cardTerminals: { "67377843": row } } });
  const { extract, submit } = await viaEmail(db, report);
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(submit.ok, true, submit.reason);
  const rec = (await db.ref("card_batches/trophy/67377843/53").once("value")).val();
  assert.ok(rec.warnings.some((w) => /moved to another till while this batch was open/.test(w)));
});

test("an unlabelled placement leaves placeLabel null — never the filing row's label (CodeRabbit, #799)", async () => {
  const report = emailedLines({ tid: "67377843", batchNo: 54 });
  const row = { ...TERMINALS["67377843"], placements: {
    [`at-${SWAP}`]: { effectiveFrom: SWAP, storeId: "pe", tillId: "till-1" },
  } };
  const db = makeFakeDb({ config: { cardTerminals: { "67377843": row } } });
  const { submit } = await viaEmail(db, report);
  assert.equal(submit.ok, true, submit.reason);
  assert.equal(submit.placeStoreId, "pe");
  assert.equal(submit.placeLabel, null);
});
