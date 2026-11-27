// Junid's rule – do not weaken or delete without his written instruction.
//
// ─── TILL 2 MUST NEVER BREAK AGAIN (Junid, 27 Nov 2026) ──────────────────────
// Marathon PE Till 2 and Trophy Till 2 (Standard Bank PAX A8900) and Pine
// (FNB, emailed reports) — and every other till. These tests run in CI on
// every PR (.github/workflows/card-recon-tests.yml) and fail the build if any
// of these stop being true:
//   1. a slip photo submitted for PE Till 2, Trophy Till 2, Pine or any other
//      till is ALWAYS accepted and stored;
//   2. the bottom total is extracted from every real fixture (PE Till 2's PAX
//      reports, Pine's FNB reports — fixtures/*.json, sanitised, real figures);
//   3. no slip is rejected for any reason other than "no total found";
//   4. an unreadable photo with a typed total reconciles green or red, never stuck.
// Plus the 19:00 watchdog's decisions (lib/card-recon-watchdog.cjs).
//
// What happened: on 26 Nov 2026 PE Till 2's report (total R67,440.00, read)
// was refused three times because its TID was under a thumb and the batch did
// not "follow on" from a #583 on file. The day went "photo received — total
// unreadable". Every gate that did that is now a note on the record.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, processReadJob, toExtraction } = require("../cardRecon/cardRecon.js");
const { REFUSED_RETRY_MS } = require("../lib/card-read-jobs.cjs");
const { readSlipPdfLines } = require("../lib/card-recon-pdf.cjs");
const { hasTotal, bottomTotalCents, tidForReport, repairForTotalRule, NO_TOTAL_REASON } = require("../lib/card-total-rule.cjs");
const { assessWatchdog, watchdogNotice, WATCHDOG_TO } = require("../lib/card-recon-watchdog.cjs");
const { errorKey, errorKeyFrom } = require("../lib/card-recon-errors.cjs");

const PAX = require("./fixtures/till2-pax-reads.json").reads;
const PINE = require("./fixtures/pine-fnb-reports.sanitised.json").reports;

const SAST = (s) => Date.parse(`${s}+02:00`);
const NOW = SAST("2026-11-26T17:41:40");
const HP1X = "0000HP1X", Z4M6 = "0000Z4M6", PINE_T = "67364485", PE1 = "67377843", TYPED_T = "00000F1Y";
const SB = { mid: "000000004977890", bank: "standard-bank", source: "photo" };
const TERMINALS = {
  [HP1X]: { ...SB, storeId: "pe", tillId: "till-2", label: "Marathon Till 2" },
  [Z4M6]: { ...SB, storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed" },
  [PINE_T]: { storeId: "pine", tillId: "till-1", label: "Pine Till 1", mid: "100000001178101", capture: "email" },
  [PE1]: { storeId: "pe", tillId: "till-1", label: "Marathon Till 1", mid: "100000002453164", capture: "both" },
  [TYPED_T]: { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2", capture: "typed" },
};
const STAFF = { uid: "u-staff", token: { email: "staff@marathon.internal" } };
const SCOPE = { pe: { "till-1": true, "till-2": true }, trophy: { "till-2": true }, pine: { "till-1": true }, concrete: { "till-2": true } };
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };
const leg = (at, cents, storeId = "pe", tillId = "till-2") => ({ at: SAST(at), amount: cents, method: "card", kind: "sale", storeId, tillId });

function world({ events = {}, batches = {} } = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [STAFF.uid]: { cardSlipTills: SCOPE } },
    pos: { paymentEvents: events },
    card_batches: batches,
  });
}
const savedPaths = [];
const bucket = () => ({ file(p) { return { save: async () => { savedPaths.push(p); }, delete: async () => {} }; } });
const send = (db, tid, total, at = NOW) => handleSlip(db, { auth: STAFF, data: { action: "slip", pickedTid: tid, photos: [PHOTO], ...(total === undefined ? {} : { declaredTotal: total }) } }, { now: () => at, bucket: bucket() });
const node = async (db, p) => (await db.ref(p).once("value")).val();
const jobs = async (db) => Object.values((await node(db, "card_batch_jobs")) || {});
const reads = (parsed) => async () => ({ parsed, model: "t", attempts: 1, tokensIn: 1, tokensOut: 1 });
async function runToEnd(db, jobId, deps, at = NOW + 60000) {
  let out;
  for (let i = 0; i < 12; i++) {
    out = await processReadJob(db, jobId, {
      now: () => at, onArrival: i === 0, loadPhotos: async () => [PHOTO],
      loadPhotoBuffers: async () => [Buffer.from(PHOTO.base64, "base64")], bucket: bucket(), ...deps,
    });
    if (out.final) return out;
    at += Math.max(REFUSED_RETRY_MS, 2 * 60 * 60 * 1000) + 1000;
  }
  return out;
}
const live = (recs) => Object.values(recs || {}).filter((r) => r && !r.displacedBy);
// The 26 Nov 2026 photo, as the live reader answered it (fixture).
const READ_26NOV = PAX.find((r) => r.key === "job-26nov").parsed;

// ── 1. THE PHOTO IS ALWAYS ACCEPTED AND STORED ──────────────────────────────
for (const [tid, label] of [[HP1X, "PE Till 2"], [Z4M6, "Trophy Till 2"], [PINE_T, "Pine (email-only FNB)"], [PE1, "PE Till 1 (FNB)"], [TYPED_T, "a typed-total till"]]) {
  test(`1 · ${label}: a slip photo with no typed total is accepted, stored, logged and queued for the reader`, async () => {
    const db = world();
    savedPaths.length = 0;
    const out = await send(db, tid);
    assert.equal(out.ok, true, out.reason);
    assert.ok(out.receipt && Number.isFinite(out.receipt.at), "Sent only on the server's receipt");
    const [job] = await jobs(db);
    assert.ok(job, "a read job exists");
    assert.equal(job.pickedTid, tid);
    assert.ok(job.photoPaths.length === 1 && savedPaths.includes(job.photoPaths[0]), "the photo bytes were stored");
    const log = await node(db, `card_batch_overrides/staff_slips/${TERMINALS[tid].storeId}/${tid}/${job.dayYmd}`);
    assert.ok(log && Object.keys(log).length === 1, "the submission is recorded");
  });
  test(`1 · ${label}: a typed total that is not a number never costs the photo`, async () => {
    const db = world();
    const out = await send(db, tid, "12abc");
    assert.equal(out.ok, true, out.reason);
    assert.equal((await jobs(db)).length, 1, "the photo is kept and queued");
  });
}

// ── 2. THE BOTTOM TOTAL FROM EVERY REAL FIXTURE ──────────────────────────────
test("2 · PE Till 2 PAX reports: the reader's answer for every real photo yields its bottom total", () => {
  assert.ok(PAX.length >= 23, "every stored PE Till 2 report photo from 1–26 Nov 2026");
  for (const r of PAX) {
    const ex = toExtraction(r.parsed);
    assert.ok(hasTotal(ex), `${r.key}: no total`);
    if (r.recordedCents !== null) assert.equal(ex.totalCents, r.recordedCents, `${r.key}: read ${ex.totalCents}, recorded ${r.recordedCents}`);
  }
  assert.equal(toExtraction(READ_26NOV).totalCents, 6744000, "26 Nov: R67,440.00 at the bottom of the roll");
});

test("2 · PE Till 2 PAX reports: each one, sent as a slip and read, is RECORDED with that total", async () => {
  for (const r of PAX) {
    const db = world();
    assert.equal((await send(db, HP1X)).ok, true);
    const [job] = await jobs(db);
    const out = await runToEnd(db, job.jobId, { ocr: reads(r.parsed) });
    assert.equal(out.final, "recorded", `${r.key}: ${(await node(db, `card_batch_jobs/${job.jobId}`)).lastReason}`);
    const recs = live(await node(db, `card_batches/pe/${HP1X}`));
    assert.equal(recs.length, 1, r.key);
    assert.equal(recs[0].slip.totalCents, r.recordedCents ?? 6744000, r.key);
  }
});

test("2 · Pine FNB reports: the parser and the bottom-total reader both give every real report's total", () => {
  assert.ok(PINE.length >= 23, "every Pine report from 1–25 Nov 2026");
  for (const r of PINE) {
    const read = readSlipPdfLines(r.lines);
    assert.equal(read.ok, true, `${r.key}: ${read.reason}`);
    assert.equal(read.extraction.totalCents, r.recordedCents, r.key);
    assert.equal(bottomTotalCents(r.lines), r.recordedCents, `${r.key}: bottom total`);
  }
});

test("2 · Pine FNB reports with the header torn off (no Terminal, Batch or Merchant lines): the bottom total still reads, routed by the mailbox subject", () => {
  for (const r of PINE) {
    const torn = r.lines.filter((l) => !/^(Merchant|Terminal|Batch):|^Banking Report/.test(l));
    assert.equal(bottomTotalCents(torn), r.recordedCents, r.key);
    assert.equal(tidForReport({ subject: `Banking Report for Batch ${r.key} of Terminal ${PINE_T}`, rows: torn, terminals: TERMINALS }), PINE_T);
  }
  // A customer's proof of payment names none of our terminals: never routed.
  assert.equal(tidForReport({ subject: "Proof of payment", rows: ["Total ZAR 550.00"], terminals: TERMINALS }), null);
});

// ── 3. NO REJECTION EXCEPT "NO TOTAL FOUND" ──────────────────────────────────
const faults = {
  "no TID (thumb over it)": { tid: "", confidence: { ...READ_26NOV.confidence, tid: 0 } },
  "another machine's TID": { tid: Z4M6, confidence: { ...READ_26NOV.confidence, tid: 0.99 } },
  "an unregistered TID": { tid: "9999ZZZZ", confidence: { ...READ_26NOV.confidence, tid: 0.99 } },
  "a wrong MID": { mid: "000000000000001" },
  "no batch number": { batchNo: "" },
  "batch out of sequence (#9999)": { batchNo: "9999" },
  "no Opened/Closed": { opened: "", closed: "" },
  "Closed before Opened": { opened: "2026/11/26 17:00:00", closed: "2026/11/25 17:00:00" },
  "purchases not summing to the total": { purchases: "R1.00" },
  "transaction count mismatch": { txnCount: 999 },
  "every header field unreadable": { mid: "", tid: "", batchNo: "", opened: "", closed: "", printed: "", txnCount: null, purchases: "", refunds: "", cash: "", confidence: { total: 0.2 } },
};
for (const [name, over] of Object.entries(faults)) {
  test(`3 · ${name}: still RECORDED under the till it was sent for, the reason kept as a note`, async () => {
    const db = world();
    await send(db, HP1X);
    const [job] = await jobs(db);
    const out = await runToEnd(db, job.jobId, { ocr: reads({ ...READ_26NOV, ...over }) });
    assert.equal(out.final, "recorded", (await node(db, `card_batch_jobs/${job.jobId}`)).lastReason);
    const recs = live(await node(db, `card_batches/pe/${HP1X}`));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].slip.totalCents, 6744000);
    assert.equal(await node(db, `card_batches/trophy/${Z4M6}`), null, "never filed on another machine");
    assert.equal(await node(db, `card_batch_overrides/unread/pe/${HP1X}/2026-11-26`), null, "never 'total unreadable'");
  });
}

test("3 · the 26 Nov 2026 photo, re-read: R67,440.00 against 26 Nov's card sales only — GREEN, not 25+26 Nov together", async () => {
  const db = world({
    events: { y: leg("2026-11-25T12:00:00", 5819000), t1: leg("2026-11-26T10:00:00", 4000000), t2: leg("2026-11-26T17:22:00", 2744000) },
    batches: { pe: { [HP1X]: { 581: { batchKey: "581", batchNo: 581, revision: 1, capturedVia: "photo", tid: HP1X, storeId: "pe", tillId: "till-2",
      slip: { openedAt: SAST("2026-11-23T18:50:04"), closedAt: SAST("2026-11-24T18:50:05"), totalCents: 3184500, format: "printed", windowSource: "printed" } } } } },
  });
  await send(db, HP1X);
  const [job] = await jobs(db);
  assert.equal((await runToEnd(db, job.jobId, { ocr: reads(READ_26NOV) })).final, "recorded");
  const rec = live(await node(db, `card_batches/pe/${HP1X}`)).find((r) => r.batchKey !== "581");
  assert.equal(rec.slip.totalCents, 6744000);
  assert.equal(rec.expected.cardCents, 6744000, "26 Nov's two legs, not 25 Nov's R58,190 too");
  assert.equal(rec.varianceCents, 0);
});

test("3 · NO total at all: the ONE refusal — and it says so", async () => {
  const db = world();
  await send(db, HP1X);
  const [job] = await jobs(db);
  const out = await runToEnd(db, job.jobId, { ocr: reads({ ...READ_26NOV, total: "", purchases: "" }) });
  assert.equal(out.final, "unread");
  assert.equal((await node(db, `card_batch_jobs/${job.jobId}`)).lastReason, NO_TOTAL_REASON);
});

test("3 · the photo path's only refusals after the read are 'no total', the total-rule verdict, and an identical duplicate", () => {
  const src = fs.readFileSync(path.join(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  const body = src.slice(src.indexOf("async function handleExtract("), src.indexOf("async function handleExtractPdf("));
  const afterRead = body.slice(body.indexOf("const extraction = toExtraction(ocr.parsed);"));
  const sites = afterRead.match(/return reject\([^)]*\)/g) || [];
  assert.deepEqual(sites.sort(), [
    "return reject(NO_TOTAL_REASON)",
    "return reject(verdict.reason)",
    "return reject(write.reason)",
  ].sort(), `a new refusal was added after the read: ${sites.join(" | ")} — Junid's total rule allows none`);
  assert.doesNotMatch(afterRead, /if \(!sbSequence\.ok\) return reject/);
});

test("3 · the total-rule repair: till from the submission, a filing number, the day's window", () => {
  const { extraction, notes } = repairForTotalRule({ tid: "", batchNo: "", openedAt: null, closedAt: null, totalCents: 100 }, {
    picked: HP1X, dayYmd: "2026-11-26", dayCloseMs: SAST("2026-11-26T18:50:00"), onFile: { batchNo: 581, closedAt: SAST("2026-11-24T18:50:05") },
  });
  assert.equal(extraction.tid, HP1X);
  assert.equal(extraction.batchNo, "582");
  assert.equal(extraction.closedAt, SAST("2026-11-26T18:50:00"));
  assert.equal(extraction.openedAt, SAST("2026-11-25T18:50:00"), "that day's period only — never back to the last record (25 Nov had no report)");
  assert.equal(notes.length, 3);
  assert.ok(notes.every((n) => /^NOTE \(not a rejection/.test(n)));
});

// ── 4. UNREADABLE PHOTO + TYPED TOTAL → GREEN OR RED, NEVER STUCK ───────────
const TODAY = { t1: leg("2026-11-26T10:00:00", 4000000), t2: leg("2026-11-26T16:00:00", 2744000) };
for (const [typed, verdict] of [["67,440.00", "green"], ["67,443.00", "green"], ["60,000.00", "red"], ["0", "red"]]) {
  test(`4 · unreadable PE Till 2 photo, typed ${typed}: the typed total stands — ${verdict}, from typed total, photo kept`, async () => {
    const db = world({ events: TODAY, batches: { pe: { [HP1X]: { 581: {
      batchKey: "581", batchNo: 581, revision: 1, capturedVia: "photo", tid: HP1X, storeId: "pe", tillId: "till-2",
      slip: { openedAt: SAST("2026-11-23T18:50:04"), closedAt: SAST("2026-11-25T18:50:05"), totalCents: 3184500, format: "printed", windowSource: "printed" },
    } } } } });
    await send(db, HP1X, typed);
    const [job] = await jobs(db);
    await runToEnd(db, job.jobId, { ocr: reads({ ...READ_26NOV, total: "", purchases: "" }) });
    const recs = live(await node(db, `card_batches/pe/${HP1X}`)).filter((r) => r.batchKey !== "581");
    assert.equal(recs.length, 1, "one record for the day — never stuck");
    const rec = recs[0];
    assert.ok(Number.isInteger(rec.varianceCents), "a verdict, never 'awaiting'");
    assert.equal(Math.abs(rec.varianceCents) <= 500 ? "green" : "red", verdict, `variance ${rec.varianceCents}`);
    assert.equal(rec.capturedVia, "typed");
    assert.ok(rec.fromTypedTotal, "the source is 'typed total'");
    assert.ok(Array.isArray(rec.photos) && rec.photos.length >= 1, "the photo stays viewable");
    assert.equal(await node(db, `card_batch_overrides/unread/pe/${HP1X}/2026-11-26`), null, "never 'unreadable — enter figures' when a typed total exists");
  });
}

// ── THE 19:00 WATCHDOG ───────────────────────────────────────────────────────
const AT_19 = SAST("2026-11-26T19:00:00");
const EV = { a: leg("2026-11-26T10:00:00", 100000), b: leg("2026-11-26T11:00:00", 50000, "pine", "till-1") };
test("watchdog: everything answered → no email at all", () => {
  const v = assessWatchdog({ nowMs: AT_19, terminals: TERMINALS, events: EV, perTid: {
    [HP1X]: { staffSlips: { j: { at: 1, read: { outcome: "recorded" } } } },
    [PINE_T]: { records: { 156: { slip: { closedAt: SAST("2026-11-26T17:20:00") } } } },
  } });
  assert.deepEqual(v.lines, []);
  assert.equal(watchdogNotice(v, AT_19), null);
});
test("watchdog: card sales and no slip; a slip with no total and no typed total; ingest errors — one line each, one email to gunidmoh@", () => {
  const v = assessWatchdog({ nowMs: AT_19, terminals: TERMINALS, events: EV, perTid: {
    [HP1X]: { staffSlips: { j: { at: 1, read: { outcome: "unread" } } }, unread: { status: "unread" } },
  }, errors: { [errorKey(AT_19 - 3600e3)]: { at: AT_19 - 3600e3, kind: "slip-upload-refused", tid: Z4M6, message: "x" } } });
  assert.equal(v.lines.length, 3, v.lines.join("\n"));
  assert.match(v.lines.join("\n"), /Marathon Till 2: a slip arrived today but no total was read/);
  assert.match(v.lines.join("\n"), /Pine Till 1: R ?500\.00 of card sales today, but no slip or report has arrived/);
  assert.match(v.lines.join("\n"), /Trophy Till 2: 1 upload\/ingest error/);
  const n = watchdogNotice(v, AT_19);
  assert.equal(n.to, WATCHDOG_TO);
  assert.equal(WATCHDOG_TO, "gunidmoh@gmail.com");
  assert.equal(n.kind, "watchdog");
  assert.match(n.subject, /3 problems/);
});
test("watchdog: a typed total counts as the day's figure; a till with no card sales is never named", () => {
  const v = assessWatchdog({ nowMs: AT_19, terminals: TERMINALS, events: { a: EV.a }, perTid: {
    [HP1X]: { staffSlips: { j: { at: 1, cents: 0, read: { outcome: "unread" } } } },
  } });
  assert.deepEqual(v.lines, []);
});
test("watchdog: the error window is read by KEY — 13-digit time first, no index, never the whole node", () => {
  assert.equal(errorKeyFrom(AT_19).length, 13);
  assert.ok(errorKey(AT_19) > errorKeyFrom(AT_19 - 1) && errorKey(AT_19 - 86400e3 - 1) < errorKeyFrom(AT_19 - 86400e3));
});
