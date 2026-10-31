// ─── CONCRETE'S STANDARD BANK TILLS, BY PHOTO + TYPED TOTAL (31 Oct 2026) ────
// No Standard Bank report reader exists yet, so Concrete's evening slip is a
// photo AND the typed card total, sent from the Card Slip screen by the person
// granted the till. The typed total is the record and reconciles against the
// till's own POS card legs; the photo is read in the background with the
// STANDARD BANK prompt, and nothing a reader does — fail, misread the TID's O
// for a 0, find no total — can refuse the slip or replace the typed figure.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const {
  handleSlip, handleSlipTills, processReadJob, extractionPromptFor, EXTRACTION_PROMPT, STANDARD_BANK_EXTRACTION_PROMPT,
} = require("../cardRecon/cardRecon.js");

const C1 = "00000F2Y";
const C2 = "00000F1Y";
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

function world() {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [STAFF.uid]: { cardSlipTills: { concrete: { "till-1": true, "till-2": true } } } },
    pos: { paymentEvents: EVENTS },
  });
}
const bucket = () => ({ file() { return { save: async () => {}, delete: async () => {} }; } });
const send = (db, tid, total) => handleSlip(db, { auth: STAFF, data: { action: "slip", pickedTid: tid, photos: [PHOTO], declaredTotal: total } }, { now: () => NOW, bucket: bucket() });
const node = async (db, p) => (await db.ref(p).once("value")).val();
const jobs = async (db) => Object.values((await node(db, "card_batch_jobs")) || {});
const run = (db, jobId, deps) => processReadJob(db, jobId, { now: () => NOW + 60000, onArrival: true, loadPhotos: async () => [PHOTO], ...deps });

test("the prompt follows the bank: FNB's is untouched, Standard Bank gets its own", () => {
  assert.equal(extractionPromptFor(undefined), EXTRACTION_PROMPT);
  assert.equal(extractionPromptFor("fnb"), EXTRACTION_PROMPT);
  assert.equal(extractionPromptFor("standard-bank"), STANDARD_BANK_EXTRACTION_PROMPT);
  assert.match(EXTRACTION_PROMPT, /^These photographs show ONE printed card-terminal Batch Report from an FNB/);
  assert.match(STANDARD_BANK_EXTRACTION_PROMPT, /Standard Bank/);
  assert.doesNotMatch(STANDARD_BANK_EXTRACTION_PROMPT, /FNB\)/);
});

test("the Card Slip list: both Concrete tills, typed, and nothing else", async () => {
  const db = world();
  const r = await handleSlipTills(db, { auth: STAFF }, { now: () => NOW });
  assert.deepEqual(r.tills.map((t) => [t.tid, t.storeId, t.tillId, t.label, t.typed]), [
    [C1, "concrete", "till-1", "Concrete Till 1", true],
    [C2, "concrete", "till-2", "Concrete Till 2", true],
  ]);
});

test("Concrete Till 1: photo + typed total is the record, reconciled against Till 1's own card legs", async () => {
  const db = world();
  const r = await send(db, C1, "1,650.00");
  assert.equal(r.ok, true);
  assert.equal(r.received, true);
  const recs = await node(db, `card_batches/concrete/${C1}`);
  const [rec] = Object.values(recs);
  assert.equal(rec.capturedVia, "typed");
  assert.equal(rec.slip.totalCents, 165000);
  assert.equal(rec.storeId, "concrete");
  assert.equal(rec.tillId, "till-1");
  // R450 + R1,200 on Till 1; Till 2's R300 and the cash are not in it.
  assert.equal(rec.expected.cardCents, 165000);
  assert.equal(rec.varianceCents, 0);
  const [job] = await jobs(db);
  assert.equal(job.mode, "check");
  assert.equal(job.bank, "standard-bank");
});

test("the background read uses the Standard Bank prompt, and an O-for-0 TID is the same machine", async () => {
  const db = world();
  await send(db, C1, "1,650.00");
  const [job] = await jobs(db);
  let asked = null;
  const ocr = async (_photos, opts) => { asked = opts; return { parsed: { tid: "0000OF2Y", batchNo: "", total: "R1,650.00", confidence: {} }, model: "t", attempts: 1 }; };
  const out = await run(db, job.jobId, { ocr });
  assert.equal(out.final, "recorded");
  assert.deepEqual(asked, { bank: "standard-bank" });
  const [key] = Object.keys(await node(db, `card_batches/concrete/${C1}`));
  const pr = await node(db, `card_batches/concrete/${C1}/${key}/photoRead`);
  assert.equal(pr.tidMatches, true);
  assert.equal(pr.readTid, "0000OF2Y", "what the paper printed is kept, for the till-swap check");
  assert.equal(pr.differs, false);
});

test("a photo printing the OTHER Concrete machine's TID is flagged, never re-filed", async () => {
  const db = world();
  await send(db, C1, "1,650.00");
  const [job] = await jobs(db);
  await run(db, job.jobId, { ocr: async () => ({ parsed: { tid: "0000OF1Y", total: "R1,650.00", confidence: {} }, model: "t", attempts: 1 }) });
  const recs = await node(db, `card_batches/concrete/${C1}`);
  const [key] = Object.keys(recs);
  assert.equal(recs[key].photoRead.tidMatches, false);
  assert.equal(recs[key].photoRead.readTid, "0000OF1Y");
  assert.equal(await node(db, `card_batches/concrete/${C2}`), null);
});

test("a reader that cannot read a Standard Bank slip never refuses it: the typed total stands", async () => {
  const db = world();
  await send(db, C2, "300.00");
  const [job] = await jobs(db);
  const ocr = async () => ({ parsed: { tid: "", batchNo: "", total: "", confidence: {} }, model: "t", attempts: 1 });
  await run(db, job.jobId, { ocr });
  const recs = await node(db, `card_batches/concrete/${C2}`);
  const [key] = Object.keys(recs);
  assert.equal(recs[key].slip.totalCents, 30000);
  assert.equal(recs[key].expected.cardCents, 30000);
  assert.equal(recs[key].photoRead.status, "no-total");
  const o = (await node(db, "card_batch_overrides")) || {};
  delete o.staff_slips;
  assert.deepEqual(o, {}, "no Unread row, no notice");
});

test("the same account is refused for Trophy Till 2 and any till outside its grant", async () => {
  const db = world();
  for (const tid of ["0000Z4M6", "0000HP1X"]) {
    await assert.rejects(send(db, tid, "100.00"), (e) => e.code === "permission-denied", tid);
  }
  assert.equal(await node(db, "card_batches/trophy"), null);
  assert.equal(await node(db, "card_batches/pe"), null);
});

test("an FNB slip check carries no bank and reads with FNB's prompt, exactly as before", async () => {
  const db = makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { u2: { cardSlipTills: { trophy: { "till-2": true } } } },
    pos: { paymentEvents: {} },
  });
  await handleSlip(db, { auth: { uid: "u2", token: {} }, data: { action: "slip", pickedTid: "0000Z4M6", photos: [PHOTO], declaredTotal: "0" } }, { now: () => NOW, bucket: bucket() });
  const [job] = await jobs(db);
  assert.equal("bank" in job, false);
  let asked = "unset";
  await run(db, job.jobId, { ocr: async (_p, opts) => { asked = opts; return { parsed: { tid: "0000Z4M6", total: "R0.00", confidence: {} }, model: "t", attempts: 1 }; } });
  assert.deepEqual(asked, { bank: undefined });
});
