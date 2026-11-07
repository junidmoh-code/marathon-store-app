// ─── STANDARD BANK TILLS ARE PHOTOGRAPHED (7 Nov 2026) ──────────────────────
// Concrete Till 1/2 (and every till whose terminal's row says Standard Bank):
// the Card Slip screen sends PHOTOS of the machine's printed end-of-day report
// — several for a long roll — and, optionally, the typed card total. The
// photos are read in the background with the STANDARD BANK prompt and the
// READ figure is the record; a typed total is Junid's cross-check, and the
// record only when the photo cannot be read at all. With no typed total, an
// unreadable photo is "photo received — total unreadable", never "awaiting".
// (Until 7 Nov the typed total was the record and the photo only a check.)
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const {
  handleSlip, handleSlipTills, processReadJob, extractionPromptFor, EXTRACTION_PROMPT, STANDARD_BANK_EXTRACTION_PROMPT,
} = require("../cardRecon/cardRecon.js");
const { MAX_REFUSED_READS, REFUSED_RETRY_MS } = require("../lib/card-read-jobs.cjs");

const C1 = "00000F2Y";
const C2 = "00000F1Y";
// Concrete's rows still say capture "typed" (31 Oct): the bank decides now.
const SB = { mid: "0005377331", capture: "typed", bank: "standard-bank", activeFrom: Date.parse("2026-10-30T00:00:00+02:00") };
const TERMINALS = {
  [C1]: { ...SB, storeId: "concrete", tillId: "till-1", label: "Concrete Till 1" },
  [C2]: { ...SB, storeId: "concrete", tillId: "till-2", label: "Concrete Till 2" },
  "0000Z4M6": { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", mid: "000000004977890" },
  "0000HP1X": { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "000000004977890" },
};
const STAFF = { uid: "u-concrete", token: { email: "staff@marathon.internal" } };
const SAST = (s) => Date.parse(`${s}+02:00`);
const NOW = SAST("2026-10-31T17:40:00");
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg bytes")]).toString("base64") };
// Concrete Till 1's card legs today (and one on Till 2, which must not count).
const leg = (at, cents, tillId = "till-1") => ({ at: SAST(at), amount: cents, method: "card", kind: "sale", storeId: "concrete", tillId });
const EVENTS = {
  e1: leg("2026-10-31T10:05:00", 45000), e2: leg("2026-10-31T13:20:00", 120000), e3: leg("2026-10-31T15:00:00", 30000, "till-2"),
  e4: { ...leg("2026-10-31T11:00:00", 99900), method: "cash" },
};

function world(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [STAFF.uid]: { cardSlipTills: { concrete: { "till-1": true, "till-2": true } } } },
    pos: { paymentEvents: EVENTS },
    network: { stores: { concrete: { tills: { "till-1": { name: "Till 1" }, "till-2": { name: "Till 2" } } } } },
    ...extra,
  });
}
const bucket = () => ({ file() { return { save: async () => {}, delete: async () => {} }; } });
const send = (db, tid, total, photos = [PHOTO]) => handleSlip(db, { auth: STAFF, data: { action: "slip", pickedTid: tid, photos, ...(total === undefined ? {} : { declaredTotal: total }) } }, { now: () => NOW, bucket: bucket() });
const node = async (db, p) => (await db.ref(p).once("value")).val();
const jobs = async (db) => Object.values((await node(db, "card_batch_jobs")) || {});
const run = (db, jobId, deps, at = NOW + 60000) => processReadJob(db, jobId, {
  now: () => at, onArrival: true, loadPhotos: async () => [PHOTO], loadPhotoBuffers: async () => [Buffer.from(PHOTO.base64, "base64")], bucket: bucket(), ...deps,
});
// The report as the reader returns it (Yasmin's real #561 layout, Concrete's figures).
const report = (over = {}) => ({
  mid: "000000005377331", tid: "0000OF2Y", batchNo: "12",
  opened: "2026/10/30 17:05:00", closed: "2026/10/31 17:10:00", printed: "2026/10/31 17:10:02",
  txnCount: 2, purchases: "R1,650.00", cash: "R0.00", refunds: "R0.00", total: "R1,650.00",
  reconLine: "500 - Reconciled, in balance",
  confidence: { mid: 0.99, tid: 0.99, batchNo: 0.99, opened: 0.99, closed: 0.99, txnCount: 0.99, purchases: 0.99, refunds: 0.99, total: 0.99 },
  transactions: [],
  ...over,
});
const reads = (parsed) => async (_photos, opts) => ({ parsed: typeof parsed === "function" ? parsed(opts) : parsed, model: "t", attempts: 1, tokensIn: 1, tokensOut: 1 });
// Run a job until it is finished (refused reads come back after 3 min each).
async function runToEnd(db, jobId, deps) {
  let at = NOW + 60000, out;
  for (let i = 0; i < 12; i++) {
    out = await run(db, jobId, { ...deps, onArrival: i === 0 }, at);
    if (out.final) return out;
    at += Math.max(REFUSED_RETRY_MS, 2 * 60 * 60 * 1000) + 1000;
  }
  return out;
}

test("the prompt follows the bank: FNB's is untouched, Standard Bank gets its own", () => {
  assert.equal(extractionPromptFor(undefined), EXTRACTION_PROMPT);
  assert.equal(extractionPromptFor("fnb"), EXTRACTION_PROMPT);
  assert.equal(extractionPromptFor("standard-bank"), STANDARD_BANK_EXTRACTION_PROMPT);
  assert.match(EXTRACTION_PROMPT, /^These photographs show ONE printed card-terminal Batch Report from an FNB/);
  assert.match(STANDARD_BANK_EXTRACTION_PROMPT, /Standard Bank/);
  assert.match(STANDARD_BANK_EXTRACTION_PROMPT, /Batch Report \(#N\)/, "built from the real paper's layout");
  assert.doesNotMatch(STANDARD_BANK_EXTRACTION_PROMPT, /FNB/);
});

test("the Card Slip list: both Concrete tills, photo first, no typed-only till", async () => {
  const db = world();
  const r = await handleSlipTills(db, { auth: STAFF }, { now: () => NOW });
  assert.deepEqual(r.tills.map((t) => [t.tid, t.storeId, t.tillId, t.label, t.typed, t.photoFirst]), [
    [C1, "concrete", "till-1", "Concrete Till 1", false, true],
    [C2, "concrete", "till-2", "Concrete Till 2", false, true],
  ]);
});

test("Concrete Till 1: photos are kept at once and read — the READ figure is the record", async () => {
  const db = world();
  const r = await send(db, C1, undefined, [PHOTO, PHOTO, PHOTO]);
  assert.equal(r.ok, true);
  assert.ok(r.receipt && Number.isFinite(r.receipt.at), "Sent only with the server's receipt");
  assert.equal(await node(db, `card_batches/concrete/${C1}`), null, "nothing recorded before the read");
  const [job] = await jobs(db);
  assert.equal(job.mode, undefined, "a read that records, not a check");
  assert.equal(job.bank, "standard-bank");
  assert.equal(job.photoPaths.length, 3, "a long roll in pieces");
  let asked = null;
  const out = await run(db, job.jobId, { ocr: reads((o) => { asked = o; return report(); }) });
  assert.equal(out.final, "recorded");
  assert.deepEqual(asked, { bank: "standard-bank" });
  const rec = await node(db, `card_batches/concrete/${C1}/12`);
  assert.equal(rec.capturedVia, "photo");
  assert.equal(rec.tid, C1, "the O-for-0 TID is the registry's spelling");
  assert.equal(rec.slip.totalCents, 165000);
  // R450 + R1,200 on Till 1; Till 2's R300 and the cash are not in it.
  assert.equal(rec.expected.cardCents, 165000);
  assert.equal(rec.varianceCents, 0);
  assert.equal(rec.photoReport.bank, "standard-bank");
  assert.equal(rec.typedCheck, undefined, "nothing typed, nothing to check");
});

test("a typed total beside the photo is a cross-check: a mismatch is flagged on the record, the read stands", async () => {
  const db = world();
  await send(db, C1, "1,600.00");
  const [job] = await jobs(db);
  assert.equal(job.typedCents, 160000);
  await run(db, job.jobId, { ocr: reads(report()) });
  const rec = await node(db, `card_batches/concrete/${C1}/12`);
  assert.equal(rec.slip.totalCents, 165000, "the photo's figure is the record");
  assert.deepEqual({ ...rec.typedCheck }, { typedCents: 160000, readCents: 165000, differs: true, via: "staff-slip" });
  assert.ok(rec.warnings.some((w) => /typed on the Card Slip \(R ?1,600\.00\) is not what the photographed report reads/.test(w)), rec.warnings.join(" | "));
});

test("a photo printing the OTHER Concrete machine's TID is refused by name, never re-filed", async () => {
  const db = world();
  await send(db, C1);
  const [job] = await jobs(db);
  const out = await runToEnd(db, job.jobId, { ocr: reads(report({ tid: "0000OF1Y" })) });
  assert.equal(out.final, "unread");
  assert.equal(await node(db, `card_batches/concrete/${C2}`), null);
  assert.equal(await node(db, `card_batches/concrete/${C1}`), null);
  const marker = await node(db, `card_batch_overrides/unread/concrete/${C1}/2026-10-31`);
  assert.equal(marker.photoReceived, true);
  assert.match(marker.reason, /^Photo received — total unreadable\. .*prints TID 0000[O0]F1Y.*Concrete Till 2/);
});

test("an unreadable photo with NO typed total: 'photo received — total unreadable', and Junid is told", async () => {
  const db = world();
  await send(db, C2);
  const [job] = await jobs(db);
  const out = await runToEnd(db, job.jobId, { ocr: reads({ tid: "", batchNo: "", total: "", confidence: {} }) });
  assert.equal(out.final, "unread");
  const marker = await node(db, `card_batch_overrides/unread/concrete/${C2}/2026-10-31`);
  assert.equal(marker.status, "unread");
  assert.equal(marker.photoReceived, true);
  assert.match(marker.reason, /^Photo received — total unreadable\./);
  assert.ok(marker.notice, "the Unread notice is queued for Junid");
  assert.ok(Array.isArray(marker.photos) && marker.photos.length === 1, "the photo is kept and linked");
});

test("an unreadable photo WITH a typed total: the typed total stands, flagged 'photo not read'", async () => {
  const db = world();
  await send(db, C2, "300.00");
  const [job] = await jobs(db);
  const out = await runToEnd(db, job.jobId, { ocr: reads({ tid: "", batchNo: "", total: "", confidence: {} }) });
  assert.equal(out.final, "unread");
  const recs = await node(db, `card_batches/concrete/${C2}`);
  const [key] = Object.keys(recs);
  const rec = recs[key];
  assert.equal(rec.capturedVia, "typed");
  assert.equal(rec.slip.totalCents, 30000);
  assert.equal(rec.expected.cardCents, 30000);
  assert.equal(rec.photoRead.status, "unread");
  assert.ok(rec.warnings.some((w) => /^PHOTO NOT READ/.test(w)));
  assert.ok(Array.isArray(rec.photos) && rec.photos.length >= 1, "the photo is on the record");
  const unread = await node(db, `card_batch_overrides/unread/concrete/${C2}/2026-10-31`);
  assert.equal(unread === null || unread.status === "resolved", true, "no open Unread row: the day has its figure");
});

test("a second photo of the same report is a duplicate — one card, never two", async () => {
  const db = world();
  await send(db, C1);
  await send(db, C1);
  const [a, b] = await jobs(db);
  assert.equal((await run(db, a.jobId, { ocr: reads(report()) })).final, "recorded");
  assert.equal((await run(db, b.jobId, { ocr: reads(report()) })).final, "duplicate");
  assert.deepEqual(Object.keys(await node(db, `card_batches/concrete/${C1}`)), ["12"]);
});

test("the same account is refused for Trophy Till 2 and any till outside its grant", async () => {
  const db = world();
  for (const tid of ["0000Z4M6", "0000HP1X"]) {
    await assert.rejects(send(db, tid, "100.00"), (e) => e.code === "permission-denied", tid);
  }
  assert.equal(await node(db, "card_batches/trophy"), null);
  assert.equal(await node(db, "card_batches/pe"), null);
});

test("an FNB till's staff slip is unchanged: one photo only, and its check reads with FNB's prompt", async () => {
  const FNB = { "67000001": { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", mid: "1" } };
  const db = makeFakeDb({
    config: { cardTerminals: FNB },
    users: { u2: { cardSlipTills: { trophy: { "till-2": true } } } },
    pos: { paymentEvents: {} },
    network: { stores: { trophy: { tills: { "till-2": { name: "Till 2" } } } } },
  });
  const slip = (photos) => handleSlip(db, { auth: { uid: "u2", token: {} }, data: { action: "slip", pickedTid: "67000001", photos, declaredTotal: "0" } }, { now: () => NOW, bucket: bucket() });
  await assert.rejects(slip([PHOTO, PHOTO]), /Take one photo/);
  await slip([PHOTO]);
  const [job] = await jobs(db);
  assert.equal(job.mode, "check");
  assert.equal("bank" in job, false);
  let asked = "unset";
  await run(db, job.jobId, { ocr: async (_p, opts) => { asked = opts; return { parsed: { tid: "67000001", total: "R0.00", confidence: {} }, model: "t", attempts: 1 }; } });
  assert.deepEqual(asked, { bank: undefined });
});

test("Concrete's paper prints 0000OF2Y: a reader unsure of O-or-0 is not a refusal — the registry settles it (live, 7 Nov 2026)", async () => {
  const db = world();
  await send(db, C1);
  const [job] = await jobs(db);
  const out = await run(db, job.jobId, { ocr: reads(report({ confidence: { ...report().confidence, tid: 0.4 } })) });
  assert.equal(out.final, "recorded");
  assert.equal((await node(db, `card_batches/concrete/${C1}/12`)).slip.totalCents, 165000);
});

test("…but a low-confidence TID that is NOT this till's is still refused", async () => {
  const db = world();
  await send(db, C1);
  const [job] = await jobs(db);
  const out = await run(db, job.jobId, { ocr: reads(report({ tid: "0000ZZ9Q", confidence: { ...report().confidence, tid: 0.4 } })) });
  assert.equal(out.final, null);
  assert.equal(await node(db, `card_batches/concrete/${C1}`), null);
});

