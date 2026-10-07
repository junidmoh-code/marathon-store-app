// ─── JUNID TYPES THE FIGURES (cardBatchManualEntry) ──────────────────────────
// Junid, 7 Oct 2026: any till, any day — no slip, unread, or wrong; source
// "manual"; an audit trail of the original values; zero variance is clean;
// nobody else. Pinned against the fake RTDB, which deletes and refuses
// undefined the way the real one does.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { planManualEntry, mayEnterManually } = require("../lib/card-manual-entry.cjs");
const { handleManualEntry, handleReread, cardBatchManualEntry } = require("../cardRecon/cardBatchManual.js");
const { unreadPath, addUnreadFailure, MANUAL_AUDIT_PATH } = require("../lib/card-unread.cjs");
const { JOBS_PATH, DUE_PATH } = require("../lib/card-read-jobs.cjs");

const NOW = Date.parse("2026-10-07T17:00:00Z"); // 19:00 SAST
const SAST = (iso) => Date.parse(`${iso}+02:00`);
const OWNER = { uid: "junid", token: { email: "gunidmoh@gmail.com", email_verified: true } };
const MOVE_18_SEP = 1789733243057;
const HP1X = {
  label: "Marathon Till 2", storeId: "pe", tillId: "till-2", tillChangedAt: MOVE_18_SEP,
  placements: { [`at-${MOVE_18_SEP}`]: { effectiveFrom: MOVE_18_SEP, label: "Marathon Till 2", storeId: "pe", tillId: "till-2" } },
};
const plan = (input, over = {}) => planManualEntry({ input: { tid: "0000HP1X", dayYmd: "2026-10-07", total: "17,365.00", batchNo: "537", ...input }, nowMs: NOW, ...over });
const expectedStub = (cents) => async (db, q) => ({ cardCents: cents, legs: 3, byKind: null, cashiers: [], query: q });

// ── who ────────────────────────────────────────────────────────────────────────

// A timeout: with the gate gone this would reach the real database and hang —
// a missing gate must FAIL, not stall the suite.
test("Junid's verified login only — an unverified token claiming the address, or anyone else, is refused", { timeout: 5000 }, async () => {
  assert.equal(mayEnterManually(OWNER.token), true);
  assert.equal(mayEnterManually({ email: "gunidmoh@gmail.com" }), false);
  assert.equal(mayEnterManually({ email: "junidmoh@gmail.com", email_verified: true }), false);
  assert.equal(mayEnterManually({ email: "mgr@marathon.internal", email_verified: true, card_recon: true }), false);
  assert.equal(mayEnterManually(null), false);
  for (const auth of [{ uid: "m", token: { email: "mgr@x.com", email_verified: true } }, { uid: "g", token: { email: "gunidmoh@gmail.com" } }]) {
    await assert.rejects(cardBatchManualEntry.run({ auth, data: { tid: "0000HP1X", dayYmd: "2026-10-07", total: "1.00", batchNo: "1" } }),
      /Only Junid can enter batch figures by hand/);
  }
});

// ── the plan ───────────────────────────────────────────────────────────────────

test("the figures: total required and parsed strictly; parts must add up; no signs", () => {
  assert.match(plan({ total: "" }).reason, /Type the batch total/);
  assert.match(plan({ total: "seventeen" }).reason, /is not an amount/);
  assert.match(plan({ total: "-5.00" }).reason, /without a sign/);
  assert.match(plan({ total: "2,000,000.00" }).reason, /more than any terminal/);
  assert.match(plan({ purchases: "100.00", refunds: "10.00", total: "100.00" }).reason, /do not add up/);
  assert.equal(plan({ purchases: "110.00", refunds: "10.00", total: "100.00" }).ok, true);
  assert.match(plan({ refunds: "10.00" }).reason, /Type the purchases figure too/);
  assert.match(plan({ txnCount: "3.5" }).reason, /whole number/);
  assert.equal(plan({ total: 1736500 }).ok, false, "a JSON number skips the shape check — refused");
});

test("a new entry needs its batch number; a future day is refused", () => {
  assert.match(plan({ batchNo: "" }).reason, /Type the batch number/);
  assert.match(plan({ dayYmd: "2026-10-08" }).reason, /has not happened yet/);
  assert.match(plan({ dayYmd: "7 Oct" }).reason, /Pick the day/);
});

test("the default window: closes 18:00 SAST that day (or now), opens at the previous settlement — an estimate", () => {
  const p = plan({ dayYmd: "2026-10-06" }, { prevClosedAt: SAST("2026-10-05T17:04:07") });
  assert.equal(p.extraction.closedAt, SAST("2026-10-06T18:00:00"));
  assert.equal(p.extraction.openedAt, SAST("2026-10-05T17:04:07"));
  assert.equal(p.extraction.windowSource, "manual");
  assert.equal(p.extraction.format, "manual");
  assert.match(p.warnings.join(" "), /previous settlement/);
  // Today, before 18:00: the close is now.
  const early = planManualEntry({ input: { tid: "0000HP1X", dayYmd: "2026-10-07", total: "1.00", batchNo: "537" }, nowMs: SAST("2026-10-07T16:00:00") });
  assert.equal(early.extraction.closedAt, SAST("2026-10-07T16:00:00"));
  // No settlement within a week: the 24 hours before the close, said so.
  const lone = plan({ dayYmd: "2026-10-06" });
  assert.equal(lone.extraction.closedAt - lone.extraction.openedAt, 24 * 3600 * 1000);
  assert.match(lone.warnings.join(" "), /24 hours before the close/);
});

test("typed times are his: both typed → manual-times; a close on another day is refused", () => {
  const p = plan({ dayYmd: "2026-10-06", openedAt: SAST("2026-10-05T17:04:05"), closedAt: SAST("2026-10-06T17:02:29") });
  assert.equal(p.extraction.windowSource, "manual-times");
  assert.match(plan({ dayYmd: "2026-10-06", closedAt: SAST("2026-10-07T09:00:00") }).reason, /must close on 2026-10-06/);
  assert.match(plan({ dayYmd: "2026-10-06", openedAt: SAST("2026-10-06T18:30:00"), closedAt: SAST("2026-10-06T17:00:00") }).reason, /before the Closed time/);
  assert.match(plan({ dayYmd: "2026-10-06", openedAt: SAST("2026-09-25T17:00:00"), closedAt: SAST("2026-10-06T17:00:00") }).reason, /longer than 7 days/);
});

test("a correction takes the batch it corrects, keeps its window, and carries the original figures", () => {
  const replaced = { batchKey: "536", tid: "0000HP1X", batchNo: 536, capturedVia: "photo", varianceCents: 30000,
    slip: { totalCents: 1736500, purchasesCents: 1736500, refundsCents: 0, cashCents: 0, txnCount: 32,
      openedAt: SAST("2026-10-05T17:04:05"), closedAt: SAST("2026-10-06T17:02:29"), windowSource: "printed" } };
  const p = plan({ dayYmd: "2026-10-06", batchNo: "", replaces: "536", total: "17,665.00" }, { replaced });
  assert.equal(p.ok, true);
  assert.equal(p.batchNo, 536);
  assert.equal(p.correction, true);
  assert.equal(p.extraction.openedAt, replaced.slip.openedAt);
  assert.equal(p.extraction.closedAt, replaced.slip.closedAt);
  assert.equal(p.extraction.windowSource, "printed", "an untouched window keeps how it was known");
  assert.deepEqual(p.manual.original, {
    batchKey: "536", capturedVia: "photo", totalCents: 1736500, purchasesCents: 1736500, refundsCents: 0, cashCents: 0,
    txnCount: 32, openedAt: replaced.slip.openedAt, closedAt: replaced.slip.closedAt, windowSource: "printed", varianceCents: 30000,
  });
  assert.match(p.warnings.join(" "), /replaces 536 \(photo, total R17,365\.00\) — that record is kept unchanged/);
  assert.match(plan({ dayYmd: "2026-10-06", replaces: "536" }, { replaced, replacedIsLatest: false }).reason, /newer capture/);
  assert.match(plan({ dayYmd: "2026-10-06", replaces: "536" }, { replaced: { ...replaced, tid: "67365901" } }).reason, /another terminal/);
  assert.match(plan({ dayYmd: "2026-10-06", replaces: "536" }, { replaced: null }).reason, /not on file/);
});

// ── the handler ────────────────────────────────────────────────────────────────

function world(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: { "0000HP1X": HP1X } },
    card_batches: { pe: { "0000HP1X": {
      536: { batchNo: 536, batchKey: "536", revision: 1, storeId: "pe", tillId: "till-2", terminalLabel: "Marathon Till 2", tid: "0000HP1X",
        capturedVia: "photo", varianceCents: 0, photos: ["cardRecon/d1/photo-0.jpg"],
        slip: { openedAt: SAST("2026-10-05T17:04:05"), closedAt: SAST("2026-10-06T17:02:29"), totalCents: 1736500, purchasesCents: 1736500, refundsCents: 0, cashCents: 0, txnCount: 32, windowSource: "printed" } },
      509: { batchNo: 509, batchKey: "509", revision: 1, storeId: "pe", tillId: "till-1", terminalLabel: "PE Till 1", tid: "0000HP1X",
        capturedVia: "photo", slip: { openedAt: SAST("2026-09-09T17:10:06"), closedAt: SAST("2026-09-10T17:14:36"), totalCents: 2125000, windowSource: "printed" } },
    } } },
    ...extra,
  });
}

test("an UNREAD day, entered: an ordinary record marked manual, the row answered, the audit written", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  await db.ref(unreadPath(where)).set(addUnreadFailure(null, { ...where, tillId: "till-2", label: "Marathon Till 2",
    reason: "timed out twice", jobId: "-Jjob00000001", photos: ["cardRecon/jobs/-Jjob00000001/photo-0.jpg"], nowMs: NOW - 3600000 }).marker);
  const out = await handleManualEntry(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-07", reason: "unread", total: "12,040.00", batchNo: "537" } },
    { now: () => NOW, computeExpectedCard: expectedStub(1204000) });
  assert.deepEqual(out, { ok: true, batchKey: "537", supersedes: null });
  const rec = (await db.ref("card_batches/pe/0000HP1X/537").once("value")).val();
  assert.equal(rec.capturedVia, "manual");
  assert.equal(rec.slip.format, "manual");
  assert.equal(rec.slip.windowSource, "manual");
  assert.equal(rec.slip.totalCents, 1204000);
  assert.equal(rec.slip.openedAt, SAST("2026-10-06T17:02:29"), "opens at the previous settlement (#536's close)");
  assert.equal(rec.slip.closedAt, SAST("2026-10-07T18:00:00"));
  assert.equal(rec.linesCaptured, false);
  assert.equal(rec.tillId, "till-2");
  assert.equal(rec.declaredTotal.byEmail, "gunidmoh@gmail.com");
  assert.equal(rec.manual.reason, "unread");
  assert.equal(rec.manual.unreadPath, unreadPath(where));
  assert.deepEqual(rec.photos, ["cardRecon/jobs/-Jjob00000001/photo-0.jpg"], "the kept photo goes with the figures");
  // THE RULE: a zero variance is clean whatever the source — the record's own
  // figure is exactly zero, the same field every capture carries.
  assert.equal(rec.varianceCents, 0);
  const marker = (await db.ref(unreadPath(where)).once("value")).val();
  assert.equal(marker.status, "resolved");
  assert.deepEqual([marker.resolved.via, marker.resolved.batchKey], ["manual", "537"]);
  const audit = Object.values((await db.ref(MANUAL_AUDIT_PATH).once("value")).val());
  assert.equal(audit.length, 1);
  assert.equal(audit[0].before, undefined, "no original on a new entry (null is not stored)");
  assert.equal(audit[0].after.totalCents, 1204000);
});

test("a WRONG batch, corrected: the original is kept, the correction supersedes it, the audit has both figures", async () => {
  const db = world();
  const out = await handleManualEntry(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-06", reason: "wrong", replaces: "536", total: "17,665.00", note: "R300 sale on the slip, missed by OCR" } },
    { now: () => NOW, computeExpectedCard: expectedStub(1766500) });
  assert.deepEqual(out, { ok: true, batchKey: "536-r2", supersedes: "536" });
  const original = (await db.ref("card_batches/pe/0000HP1X/536").once("value")).val();
  assert.equal(original.slip.totalCents, 1736500, "the original record is untouched");
  const rec = (await db.ref("card_batches/pe/0000HP1X/536-r2").once("value")).val();
  assert.equal(rec.supersedes, "536");
  assert.equal(rec.revision, 2);
  assert.equal(rec.autoSuperseded, false, "a person's correction, not a fuller report");
  assert.equal(rec.slip.windowSource, "printed");
  assert.equal(rec.manual.original.totalCents, 1736500);
  assert.equal(rec.manual.note, "R300 sale on the slip, missed by OCR");
  assert.deepEqual(rec.photos, ["cardRecon/d1/photo-0.jpg"], "the corrected record's photo stays with it");
  const audit = Object.values((await db.ref(MANUAL_AUDIT_PATH).once("value")).val())[0];
  assert.deepEqual([audit.before.totalCents, audit.after.totalCents, audit.supersedes], [1736500, 1766500, "536"]);
});

test("a batch already on file is refused with the way to correct it — never overwritten", async () => {
  const db = world();
  const out = await handleManualEntry(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-06", total: "1.00", batchNo: "536" } },
    { now: () => NOW, computeExpectedCard: expectedStub(0) });
  assert.match(out.reason, /already on file .*Correct these figures/);
  assert.equal((await db.ref("card_batches/pe/0000HP1X/536/slip/totalCents").once("value")).val(), 1736500);
});

test("before a terminal's first placement, the record stamps the till it stood on then (0000HP1X was PE Till 1)", async () => {
  const db = world();
  let asked = null;
  const out = await handleManualEntry(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-09-12", reason: "no-slip", total: "20,000.00", batchNo: "511" } },
    { now: () => NOW, computeExpectedCard: async (d, q) => { asked = q; return { cardCents: 2000000, legs: 1, byKind: null, cashiers: [] }; } });
  assert.equal(out.ok, true);
  const rec = (await db.ref("card_batches/pe/0000HP1X/511").once("value")).val();
  assert.deepEqual([rec.storeId, rec.tillId, rec.terminalLabel], ["pe", "till-1", "PE Till 1"]);
  assert.deepEqual([asked.storeId, asked.tillId], ["pe", "till-1"], "the ledger is read on that till");
  // The window opened at #509's close — two days earlier, inside the week.
  assert.equal(rec.slip.openedAt, SAST("2026-09-10T17:14:36"));
});

test("after a placement, the ledger is read where the machine stood", async () => {
  const db = world({ config: { cardTerminals: {
    "67325636": { label: "Trophy Till 1", storeId: "pe", tillId: "till-1",
      placements: { "at-1": { effectiveFrom: 1, storeId: "pe", tillId: "till-1" }, "at-1791197160000": { effectiveFrom: 1791197160000, storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" } } },
  } } });
  let asked = null;
  await handleManualEntry(db, { auth: OWNER, data: { tid: "67325636", dayYmd: "2026-10-06", total: "1,000.00", batchNo: "70" } },
    { now: () => NOW, computeExpectedCard: async (d, q) => { asked = q; return { cardCents: 0, legs: 0, byKind: null, cashiers: [] }; } });
  assert.deepEqual([asked.storeId, asked.tillId], ["trophy", "till-1"]);
  const rec = (await db.ref("card_batches/pe/67325636/70").once("value")).val();
  assert.equal(rec.storeId, "pe", "filed where every batch of this terminal is filed");
});

test("an unknown terminal or a malformed key is refused before anything is read or written", async () => {
  const db = world();
  assert.match((await handleManualEntry(db, { auth: OWNER, data: { tid: "0000ZZZZ", dayYmd: "2026-10-06", total: "1.00", batchNo: "1" } }, { now: () => NOW })).reason, /not registered/);
  assert.match((await handleManualEntry(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-06", total: "1.00", replaces: "../../users" } }, { now: () => NOW })).reason, /not one this report wrote/);
});

test("reread: an Unread day's kept photo goes back to the background reader", async () => {
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  const db = world({
    [JOBS_PATH]: { "-Jjob00000001": { jobId: "-Jjob00000001", status: "unread", attempts: 9, refusedReads: 0, photoPaths: ["cardRecon/jobs/-Jjob00000001/photo-0.jpg"] } },
  });
  await db.ref(unreadPath(where)).set(addUnreadFailure(null, { ...where, reason: "402", jobId: "-Jjob00000001", nowMs: NOW - 1000 }).marker);
  const out = await handleReread(db, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-07" } }, { now: () => NOW });
  assert.deepEqual(out, { ok: true, queued: "-Jjob00000001" });
  const job = (await db.ref(`${JOBS_PATH}/-Jjob00000001`).once("value")).val();
  assert.deepEqual([job.status, job.attempts, job.dueAt], ["retry", 0, NOW]);
  assert.equal((await db.ref(`${DUE_PATH}/${job.dueKey}`).once("value")).val(), "-Jjob00000001");
  // Nothing to read again for a day no photo ever reached.
  const empty = world();
  await empty.ref(unreadPath(where)).set(addUnreadFailure(null, { ...where, reason: "no upload", nowMs: NOW }).marker);
  assert.match((await handleReread(empty, { auth: OWNER, data: { tid: "0000HP1X", dayYmd: "2026-10-07" } }, { now: () => NOW })).reason, /nothing to read again/);
});

test("no close typed: the next recorded batch's opening that day IS this batch's close", () => {
  const p = plan({ dayYmd: "2026-09-24" }, { nextOpenedAt: SAST("2026-09-24T16:15:16"), prevClosedAt: SAST("2026-09-23T17:00:00") });
  assert.equal(p.extraction.closedAt, SAST("2026-09-24T16:15:16"));
  // A next batch that opened on ANOTHER day says nothing about this one.
  const q = plan({ dayYmd: "2026-09-24" }, { nextOpenedAt: SAST("2026-09-25T09:00:00") });
  assert.equal(q.extraction.closedAt, SAST("2026-09-24T18:00:00"));
});

test("a typed Opened alone is his window too ('manual-times')", () => {
  const p = plan({ dayYmd: "2026-10-06", openedAt: SAST("2026-10-05T17:04:05") });
  assert.equal(p.extraction.windowSource, "manual-times");
  assert.equal(p.extraction.openedAt, SAST("2026-10-05T17:04:05"));
});

test("a batch number out of sequence is said on the record, never refused", () => {
  const p = plan({ batchNo: "53" }, { prevBatchNo: 536 });
  assert.equal(p.ok, true);
  assert.match(p.warnings.join(" "), /does not follow this terminal's previous batch \(#536\)/);
  assert.doesNotMatch(plan({ batchNo: "537" }, { prevBatchNo: 536 }).warnings.join(" "), /does not follow/);
});
