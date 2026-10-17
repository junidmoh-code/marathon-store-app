// ─── THE STAFF SLIP, AS JUNID'S REPORT READS IT ──────────────────────────────
// A slip sent under the per-till scope is recorded as a TYPED total with its
// PHOTO attached, saying who sent it and when. The photo is then read in the
// background (a "check" job on the received-photo queue) only to tell Junid
// when the slip prints something other than what was typed. A blurry photo, or
// a reader that never answers, is not an error: no Unread row, no email.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertSent } = require("./helpers/slip-receipt.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, processReadJob } = require("../cardRecon/cardRecon.js");
const { MAX_READ_ATTEMPTS } = require("../lib/card-read-jobs.cjs");

const MT2 = "0000AA2X";
const TERMINALS = {
  [MT2]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2",
    placements: { "at-1789733243057": { effectiveFrom: 1789733243057, storeId: "pe", tillId: "till-2", label: "Marathon Till 2" } } },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const SAST = (s) => Date.parse(`${s}+02:00`);
const NOW = SAST("2026-10-16T18:30:00");
const B544 = { batchKey: "544", batchNo: 544, revision: 1, capturedVia: "photo",
  slip: { openedAt: SAST("2026-10-14T17:02:11"), closedAt: SAST("2026-10-15T16:59:43"), totalCents: 2137500, format: "printed", windowSource: "printed" } };
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };

function world(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } } },
    card_batches: { pe: { [MT2]: { 544: B544 } } },
    ...extra,
  });
}
const bucket = () => ({ file() { return { save: async () => {} }; } });
const send = (db, total, now = NOW) => handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: MT2, photos: [PHOTO], declaredTotal: total } }, { now: () => now, bucket: bucket() });
// The Unread rows and the notices to Junid — the staff-slip log beside them is not one.
const unreadOrNotice = async (db) => { const o = (await db.ref("card_batch_overrides").once("value")).val() || {}; delete o.staff_slips; return Object.keys(o).length ? o : null; };
const node = async (db, p) => (await db.ref(p).once("value")).val();
const jobs = async (db) => Object.values((await node(db, "card_batch_jobs")) || {});
// The reader, faked at its seam: what Gemini would have returned for the slip.
const reads = (total, tid = MT2) => async () => ({ parsed: { tid, batchNo: "545", total, confidence: {} }, tokensIn: 1, tokensOut: 1, model: "gemini-test", attempts: 1 });
const run = (db, jobId, deps, now = NOW + 60000) => processReadJob(db, jobId, { now: () => now, onArrival: true, loadPhotos: async () => [PHOTO], ...deps });

test("the record: typed total + the photo, who sent it and when — and a check job queued for the photo", async () => {
  const db = world();
  await send(db, "21,375.00");
  const rec = await node(db, `card_batches/pe/${MT2}/545`);
  assert.equal(rec.capturedVia, "typed");
  assert.equal(rec.slip.totalCents, 2137500);
  assert.equal(rec.declaredTotal.via, "staff-slip");
  assert.equal(rec.declaredTotal.byEmail, "yasmin@marathon.internal");
  assert.ok(Number.isFinite(rec.submittedAt));
  assert.equal((Array.isArray(rec.photos) ? rec.photos : Object.values(rec.photos)).length, 1);
  assert.equal(rec.photoRead, undefined, "nothing is claimed about the photo until it is read");
  const [job] = await jobs(db);
  assert.equal(job.mode, "check");
  assert.equal(job.batchKey, "545");
  assert.equal(job.typedCents, 2137500);
  assert.deepEqual(job.photoPaths, Array.isArray(rec.photos) ? rec.photos : Object.values(rec.photos));
  assert.equal(await node(db, `card_batch_jobs_due/${job.dueKey}`), job.jobId);
});

test("the slip reads R21,370 against a typed R21,375: flagged on the record, nothing new recorded", async () => {
  const db = world();
  await send(db, "21,375.00");
  const [job] = await jobs(db);
  const r = await run(db, job.jobId, { ocr: reads("R21,370.00") });
  assert.equal(r.final, "recorded");
  const pr = await node(db, `card_batches/pe/${MT2}/545/photoRead`);
  assert.equal(pr.status, "read");
  assert.equal(pr.readCents, 2137000);
  assert.equal(pr.typedCents, 2137500);
  assert.equal(pr.differs, true);
  assert.equal(pr.tidMatches, true);
  assert.deepEqual(Object.keys(await node(db, `card_batches/pe/${MT2}`)).sort(), ["544", "545"], "the check never records a batch");
  assert.equal(await unreadOrNotice(db), null, "no Unread row, no email");
  assert.equal((await node(db, `card_batch_jobs/${job.jobId}`)).status, "recorded");
});

test("a slip that reads the same as typed is not flagged", async () => {
  const db = world();
  await send(db, "0");
  const [job] = await jobs(db);
  await run(db, job.jobId, { ocr: reads("R0.00") });
  const pr = await node(db, `card_batches/pe/${MT2}/545/photoRead`);
  assert.equal(pr.readCents, 0);
  assert.equal(pr.typedCents, 0);
  assert.equal(pr.differs, false);
});

test("a blurry photo (no total read) is not an error and not a flag", async () => {
  const db = world();
  await send(db, "1,000.00");
  const [job] = await jobs(db);
  const r = await run(db, job.jobId, { ocr: reads("") });
  assert.equal(r.final, "recorded");
  const pr = await node(db, `card_batches/pe/${MT2}/545/photoRead`);
  assert.equal(pr.status, "no-total");
  assert.equal(pr.differs, false);
  assert.equal(await unreadOrNotice(db), null);
});

test("a reader that never answers: retried like any photo, then 'unread' on the record — still no Unread row, no email", async () => {
  const db = world();
  await send(db, "1,000.00");
  const [job] = await jobs(db);
  const down = async () => { const e = new Error("gemini HTTP 503"); e.httpStatus = 503; e.code = "unavailable"; throw e; };
  let t = NOW + 60000;
  let r;
  for (let i = 0; i < MAX_READ_ATTEMPTS; i++) {
    // The sweep takes it again once it is due (claimJob), so the clock jumps a day each time.
    r = await processReadJob(db, job.jobId, { now: () => t, onArrival: i === 0, loadPhotos: async () => [PHOTO], ocr: down });
    t += 24 * 60 * 60 * 1000;
  }
  assert.equal(r.final, "unread");
  const pr = await node(db, `card_batches/pe/${MT2}/545/photoRead`);
  assert.equal(pr.status, "unread");
  assert.equal(pr.differs, false);
  assert.equal(await unreadOrNotice(db), null, "the typed total is the record — nothing for Junid to enter");
  assert.equal((await node(db, `card_batches/pe/${MT2}/545`)).slip.totalCents, 100000, "the record is untouched");
});

test("sent twice in one batch window: the second is a correction (545-r2), both kept, each checked", async () => {
  const db = world();
  assertSent(await send(db, "100.00"));
  assertSent(await send(db, "120.00", NOW + 10 * 60 * 1000));
  const recs = await node(db, `card_batches/pe/${MT2}`);
  assert.deepEqual(Object.keys(recs).sort(), ["544", "545", "545-r2"]);
  assert.equal(recs["545"].slip.totalCents, 10000, "the first is kept");
  const r2 = recs["545-r2"];
  assert.equal(r2.slip.totalCents, 12000);
  assert.equal(r2.revision, 2);
  assert.equal(r2.supersedes, "545");
  assert.equal(r2.autoSuperseded, false, "a correction, not a later report");
  assert.equal(r2.slip.openedAt, recs["545"].slip.openedAt, "the same trading period as the entry it replaces");
  assert.ok(r2.warnings.some((w) => /replaces the total sent earlier today/.test(w)));
  assert.deepEqual((await jobs(db)).map((j) => j.batchKey).sort(), ["545", "545-r2"]);
});

test("a deleted record (a test) is not annotated by a late check", async () => {
  const db = world();
  await send(db, "5.00");
  const [job] = await jobs(db);
  await db.ref(`card_batches/pe/${MT2}/545`).set(null);
  await run(db, job.jobId, { ocr: reads("R5.00") });
  assert.equal(await node(db, `card_batches/pe/${MT2}/545`), null);
});

test("the machine's real report of the slip's filing number takes over as a later report; the slip is kept beneath it", async () => {
  const { resolveWriteFor } = require("../cardRecon/cardRecon.js");
  const db = world();
  await send(db, "21,000.00");                        // filed as #545, typed
  const real = { format: "printed", windowSource: "printed", emptyBatch: false, totalCents: 2100000, printedAt: NOW + 3600000 };
  const { write } = await resolveWriteFor(db, { storeId: "pe", tid: MT2, batchNo: "545", correction: false, lines: [], totalCents: 2100000, incoming: real });
  assert.equal(write.ok, true, write.reason);
  assert.equal(write.key, "545-r2");
  assert.equal(write.autoSuperseded, true);
  // …but a second TYPED entry is not a real report, and is not let through this way.
  const again = await resolveWriteFor(db, { storeId: "pe", tid: MT2, batchNo: "545", correction: false, lines: [], totalCents: 1, incoming: { format: "typed" } });
  assert.equal(again.write.ok, false);
});
