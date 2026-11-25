// ─── MARATHON PE TILL 2: THE TYPED TOTAL STANDS FOR THE SLIP'S DAY (25 Nov 2026) ─
// The Standard Bank PAX on PE Till 2 settles ITSELF at 18:50 (every batch from
// #569, 13 Nov 2026). Yasmin photographs the report at ~17:10, before that, so
// the photo is YESTERDAY's batch: read and filed on yesterday (clean), while
// the day she sent it on sat on "staff slip — being read" until the next
// afternoon. The figures below are the real 25 Nov read: batch #581, opened
// 2026/11/23 18:50:04, closed 2026/11/24 18:50:05, printed 2026/11/25 17:10,
// R31,845.00 over 49 — "500 - Reconciled, in balance".
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { handleSlip, processReadJob } = require("../cardRecon/cardRecon.js");
const { typedStandsFor, TYPED_STANDS_AFTER_MS } = require("../lib/card-sb-photo.cjs");

const TID = "0000HP1X";
const TERMINALS = {
  [TID]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "000000004977890", bank: "standard-bank", source: "photo" },
};
const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const SAST = (s) => Date.parse(`${s}+02:00`);
const SENT = SAST("2026-11-25T17:12:07");
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };
const leg = (at, cents) => ({ at: SAST(at), amount: cents, method: "card", kind: "sale", storeId: "pe", tillId: "till-2" });
// 24 Nov's batch window (23 18:50 → 24 18:50) and today's money so far.
const EVENTS = {
  y1: leg("2026-11-24T10:00:00", 2000000), y2: leg("2026-11-24T15:00:00", 1184500),
  t1: leg("2026-11-25T09:30:00", 3000000), t2: leg("2026-11-25T16:40:00", 2819000),
};

const world = () => makeFakeDb({
  config: { cardTerminals: TERMINALS },
  users: { [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } } },
  pos: { paymentEvents: EVENTS },
  network: { stores: { pe: { tills: { "till-2": { name: "Till 2" } } } } },
});
const bucket = () => ({ file() { return { save: async () => {}, delete: async () => {} }; } });
const send = (db, total, at = SENT) => handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: TID, photos: [PHOTO], ...(total === undefined ? {} : { declaredTotal: total }) } }, { now: () => at, bucket: bucket() });
const node = async (db, p) => (await db.ref(p).once("value")).val();
const jobs = async (db) => Object.values((await node(db, "card_batch_jobs")) || {});
const run = (db, jobId, deps, at = SENT + 12000) => processReadJob(db, jobId, {
  now: () => at, onArrival: true, loadPhotos: async () => [PHOTO], loadPhotoBuffers: async () => [Buffer.from(PHOTO.base64, "base64")], bucket: bucket(), ...deps,
});
const report = (over = {}) => ({
  mid: "000000004977890", tid: TID, batchNo: "581",
  opened: "2026/11/23 18:50:04", closed: "2026/11/24 18:50:05", printed: "2026/11/25 17:10:47",
  txnCount: 49, purchases: "R31,845.00", cash: "R0.00", refunds: "R0.00", total: "R31,845.00",
  reconLine: "500 - Reconciled, in balance",
  confidence: { mid: 0.99, tid: 0.99, batchNo: 0.99, opened: 0.99, closed: 0.99, txnCount: 0.99, purchases: 0.99, refunds: 0.99, total: 0.99 },
  transactions: [],
  ...over,
});
const reads = (parsed) => async () => ({ parsed, model: "t", attempts: 1, tokensIn: 1, tokensOut: 1 });
const live = (recs) => Object.entries(recs || {}).filter(([, r]) => !r.displacedBy);

test("typedStandsFor: an earlier day's report, a duplicate, or a photo unread after five minutes — never without a typed total", () => {
  const base = { typedCents: 5819000, receivedAt: SENT, nowMs: SENT + 1000, jobDayYmd: "2026-11-25" };
  assert.equal(typedStandsFor({ ...base, final: "recorded", recordedCloseYmd: "2026-11-24", batchKey: "581" }).kind, "earlier-report");
  assert.match(typedStandsFor({ ...base, final: "recorded", recordedCloseYmd: "2026-11-24", batchKey: "581" }).warning, /^FROM TYPED TOTAL — .*batch #581.*2026-11-24/);
  assert.equal(typedStandsFor({ ...base, final: "recorded", recordedCloseYmd: "2026-11-25" }), null, "the day's own report: nothing typed stands");
  assert.equal(typedStandsFor({ ...base, final: "duplicate" }).kind, "earlier-report");
  assert.equal(typedStandsFor({ ...base, final: null }), null, "still inside five minutes");
  assert.equal(typedStandsFor({ ...base, final: null, nowMs: SENT + TYPED_STANDS_AFTER_MS }).kind, "not-read-yet");
  assert.equal(typedStandsFor({ ...base, final: "unread" }), null, "the unreadable photo has its own fallback");
  assert.equal(typedStandsFor({ ...base, typedCents: null, final: "duplicate" }), null);
});

test("Yasmin's 25 Nov slip: #581 is filed on 24 Nov (clean) AND her typed total stands as 25 Nov's figure, from typed total", async () => {
  const db = world();
  assert.equal((await send(db, "58,190.00")).ok, true);
  const [job] = await jobs(db);
  assert.equal(job.typedCents, 5819000);
  assert.equal((await run(db, job.jobId, { ocr: reads(report()) })).final, "recorded");
  const recs = await node(db, `card_batches/pe/${TID}`);
  assert.equal(recs["581"].varianceCents, 0, "24 Nov: the report and the till agree");
  const typed = live(recs).filter(([k]) => k !== "581");
  assert.equal(typed.length, 1, "one typed record, for 25 Nov");
  const [, rec] = typed[0];
  assert.equal(rec.capturedVia, "typed");
  assert.equal(rec.slip.totalCents, 5819000);
  assert.equal(rec.expected.cardCents, 5819000, "today's two legs, R58,190.00");
  assert.equal(rec.varianceCents, 0);
  assert.deepEqual({ ...rec.fromTypedTotal, jobId: undefined }, { why: "earlier-report", jobId: undefined });
  assert.ok(rec.warnings.some((w) => /^FROM TYPED TOTAL/.test(w)), rec.warnings.join(" | "));
  assert.ok(Array.isArray(rec.photos) && rec.photos.length >= 1, "the photo stays viewable on the record");
  assert.equal(rec.photoRead, undefined, "not flagged 'photo not read' — the photo WAS read");
  // The log entry says which day the read batch was filed on.
  const day = await node(db, `card_batch_overrides/staff_slips/pe/${TID}/2026-11-25`);
  const [entry] = Object.values(day);
  assert.equal(entry.read.batchKey, "581");
  assert.equal(entry.read.filedDayYmd, "2026-11-24");
});

test("the typed figure gives a red verdict when it is short by more than R5 — same rules as any record", async () => {
  const db = world();
  await send(db, "58,000.00");
  const [job] = await jobs(db);
  await run(db, job.jobId, { ocr: reads(report()) });
  const [, rec] = live(await node(db, `card_batches/pe/${TID}`)).find(([k]) => k !== "581");
  assert.equal(rec.varianceCents, -19000);
});

test("tomorrow's report of 25 Nov (#582, closed 25 Nov 18:50) takes over the typed figure — one card, never two", async () => {
  const db = world();
  await send(db, "58,190.00");
  const [first] = await jobs(db);
  await run(db, first.jobId, { ocr: reads(report()) });
  const typedKey = live(await node(db, `card_batches/pe/${TID}`)).find(([k]) => k !== "581")[0];
  const NEXT = SAST("2026-11-26T17:11:00");
  await send(db, "40,000.00", NEXT);
  const second = (await jobs(db)).find((j) => j.jobId !== first.jobId);
  await run(db, second.jobId, { ocr: reads(report({ batchNo: "582", opened: "2026/11/24 18:50:05", closed: "2026/11/25 18:50:04", printed: "2026/11/26 17:10:30", txnCount: 2, purchases: "R58,190.00", total: "R58,190.00" })) }, NEXT + 12000);
  const recs = await node(db, `card_batches/pe/${TID}`);
  // The typed figure took batch #582's number; the real #582 takes it over as
  // a revision of that chain (planSbFiling "over") — the record in force.
  assert.equal(typedKey, "582");
  assert.equal(recs["582-r2"].supersedes, "582");
  assert.equal(recs["582-r2"].capturedVia, "photo");
  assert.equal(recs["582-r2"].varianceCents, 0);
});

test("a photo the reader cannot get to within five minutes: the typed total stands; the reader keeps trying", async () => {
  const db = world();
  await send(db, "58,190.00");
  const [job] = await jobs(db);
  const down = async () => { const e = new Error("reader unavailable"); e.code = "unavailable"; throw e; };
  const early = await run(db, job.jobId, { ocr: down }, SENT + 60000);
  assert.equal(early.final, null);
  assert.equal(await node(db, `card_batches/pe/${TID}`), null, "inside five minutes nothing typed stands");
  const j2 = (await jobs(db))[0];
  const late = await run(db, job.jobId, { ocr: down, onArrival: false }, Math.max(j2.dueAt + 1, SENT + TYPED_STANDS_AFTER_MS + 1000));
  assert.equal(late.final, null, "still retrying");
  const recs = live(await node(db, `card_batches/pe/${TID}`));
  assert.equal(recs.length, 1);
  assert.equal(recs[0][1].fromTypedTotal.why, "not-read-yet");
  assert.equal(recs[0][1].slip.totalCents, 5819000);
});

test("no typed total: #581 is filed on 24 Nov and nothing is invented for 25 Nov", async () => {
  const db = world();
  await send(db);
  const [job] = await jobs(db);
  await run(db, job.jobId, { ocr: reads(report()) });
  assert.deepEqual(Object.keys(await node(db, `card_batches/pe/${TID}`)), ["581"]);
});

test("the same report photographed again: a duplicate, and the typed figure is written once", async () => {
  const db = world();
  await send(db, "58,190.00");
  await send(db, "58,190.00", SENT + 60000);
  const [a, b] = await jobs(db);
  await run(db, a.jobId, { ocr: reads(report()) });
  assert.equal((await run(db, b.jobId, { ocr: reads(report()) }, SENT + 72000)).final, "duplicate");
  assert.equal(live(await node(db, `card_batches/pe/${TID}`)).length, 2, "#581 and one typed figure for 25 Nov");
});
