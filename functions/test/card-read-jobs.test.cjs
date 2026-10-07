// ─── THE BACKGROUND READ (Junid, 7 Oct 2026) ─────────────────────────────────
// The manager's submit stores the photo and answers "Received"; the read runs
// on the server with retries; a read that never succeeds marks that till/day
// "Unread – needs manual entry" and emails Junid once. Pinned here against the
// fake RTDB (real delete semantics, transactions null-first):
//   • receive answers {ok, received} and NOTHING else, after storing the photo;
//   • every setup gate still refuses before anything is stored;
//   • a transient failure reschedules on the published delays, then gives up;
//   • a refused read is tried three times, then handed over;
//   • a duplicate is done, silently; a recorded read answers an Unread day;
//   • one job is never run twice at once (the claim), and a dead run is picked
//     up by the sweep when its lease lapses;
//   • the notice is queued once, leased while out, and closed on the poller's word.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const {
  JOBS_PATH, DUE_PATH, RETRY_DELAYS_MS, MAX_READ_ATTEMPTS, MAX_REFUSED_READS, REFUSED_RETRY_MS, LEASE_MS,
  dueKey, dueCutoff, dueMsOf, claimJob, classifyRun, nextStep,
} = require("../lib/card-read-jobs.cjs");
const { UNREAD_PATH, NOTICES_PATH, NOTIFY_TO, unreadPath, addUnreadFailure } = require("../lib/card-unread.cjs");
const {
  handleReceive, processReadJob, sweepReadJobs, listNotices, recordNoticeResults,
} = require("../cardRecon/cardRecon.js");

const T0 = Date.parse("2026-10-07T15:03:42Z"); // 17:03 SAST, the first failed Till 2 capture
const MIN = 60 * 1000;
const OWNER = { uid: "owner", token: { email: "gunidmoh@gmail.com", email_verified: true } };
const STAFF = { uid: "mgr1", token: { email: "mgr1@marathon.internal" } };
const HP1X = { label: "Marathon Till 2", mid: "000000004977890", storeId: "pe", tillId: "till-2" };
const PHOTO = Buffer.from("fake-jpeg-bytes").toString("base64");

function world(extra = {}) {
  return makeFakeDb({
    config: { cardTerminals: { "0000HP1X": HP1X, "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3", capture: "email" } } },
    users: { mgr1: { permFlags: { card_recon: true } } },
    ...extra,
  });
}
function fakeBucket() {
  const saved = {};
  return { saved, file: (p) => ({ save: async (buf) => { saved[p] = Buffer.from(buf); } }) };
}
const clockAt = (t) => { let now = t; return { now: () => now, set: (v) => { now = v; } }; };

async function received(db, { as = STAFF, now = T0, photos = [{ base64: PHOTO }], tid = "0000HP1X" } = {}) {
  const bucket = fakeBucket();
  const out = await handleReceive(db, { auth: as, data: { action: "receive", pickedTid: tid, photos } }, { bucket, now: () => now });
  const jobs = (await db.ref(JOBS_PATH).once("value")).val() || {};
  return { out, bucket, jobId: Object.keys(jobs).at(-1), jobs };
}

// ── pure decisions ────────────────────────────────────────────────────────────

test("queue keys sort by due time, and the cutoff takes exactly what is due", () => {
  const a = dueKey(T0, "-Nabc"), b = dueKey(T0 + 1, "-Aaaa"), c = dueKey(T0 + 10 * MIN, "-Zzzz");
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
  assert.ok(a <= dueCutoff(T0) && b > dueCutoff(T0));
  assert.equal(dueMsOf(a), T0);
  assert.equal(dueMsOf("junk"), null);
});

test("claim: a due job is taken once; a running job is left alone until its lease lapses", () => {
  const job = { jobId: "-J", status: "retry", dueAt: T0, attempts: 1, dueKey: dueKey(T0, "-J") };
  const c = claimJob(job, { nowMs: T0, nonce: "n1" });
  assert.equal(c.status, "reading");
  assert.equal(c.attempts, 2);
  assert.equal(c.prevDueKey, job.dueKey);
  assert.equal(c.leaseUntil, T0 + LEASE_MS);
  assert.equal(claimJob(c, { nowMs: T0 + MIN, nonce: "n2" }), undefined, "never doubled while it runs");
  assert.equal(claimJob(c, { nowMs: T0 + LEASE_MS + 1, nonce: "n3" }).claimNonce, "n3", "a dead run is taken over");
  assert.equal(claimJob({ ...job, dueAt: T0 + MIN }, { nowMs: T0, nonce: "x" }), undefined, "not before its time");
  assert.equal(claimJob({ ...job, status: "queued", dueAt: T0 + MIN }, { nowMs: T0, nonce: "x", onArrival: true }).status, "reading",
    "the arrival trigger does not wait for the sweep's due time");
  for (const status of ["recorded", "duplicate", "unread"]) assert.equal(claimJob({ ...job, status }, { nowMs: T0 + 1e9, nonce: "x" }), undefined, status);
});

test("classify: reader outages are transient; a refusal is refused; 'already captured' is a duplicate", () => {
  for (const code of ["unavailable", "resource-exhausted", "deadline-exceeded", "internal"]) {
    assert.equal(classifyRun({ thrown: Object.assign(new Error("x"), { code }) }).kind, "transient", code);
  }
  assert.equal(classifyRun({ thrown: new Error("socket hang up") }).kind, "transient");
  assert.equal(classifyRun({ thrown: Object.assign(new Error("bad"), { code: "invalid-argument" }) }).kind, "refused");
  assert.equal(classifyRun({ extract: { ok: false, reason: "Could not read the slip's batch number confidently" } }).kind, "refused");
  assert.equal(classifyRun({ extract: { ok: false, reason: "Batch #536 for this terminal is already captured. If the earlier…" } }).kind, "duplicate");
  assert.equal(classifyRun({ extract: { ok: true }, submit: { ok: false, reason: "Batch #537 for this terminal was captured by someone else a moment ago." } }).kind, "duplicate");
  assert.deepEqual(classifyRun({ extract: { ok: true }, submit: { ok: true, batchKey: "537" } }), { kind: "recorded", batchKey: "537" });
});

test("the retry schedule: the published delays, then Unread after the last", () => {
  let job = { jobId: "-J", attempts: 1, refusedReads: 0 };
  const seen = [];
  for (let a = 1; a < MAX_READ_ATTEMPTS; a++) {
    job = { ...job, attempts: a };
    const { final, patch } = nextStep(job, { kind: "transient", reason: "503" }, T0);
    assert.equal(final, null);
    seen.push(patch.dueAt - T0);
    assert.equal(patch.dueKey, dueKey(patch.dueAt, "-J"));
  }
  assert.deepEqual(seen, RETRY_DELAYS_MS);
  const last = nextStep({ ...job, attempts: MAX_READ_ATTEMPTS }, { kind: "transient", reason: "503" }, T0);
  assert.equal(last.final, "unread");
  assert.equal(last.patch.dueKey, null);
  // ~8 hours in all — recorded or flagged before the next morning.
  const totalH = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 3600000;
  assert.ok(totalH > 7 && totalH < 9, String(totalH));
});

test("a refused read is tried three times in all, then handed to Junid", () => {
  const a = nextStep({ jobId: "-J", attempts: 1, refusedReads: 0 }, { kind: "refused", reason: "r" }, T0);
  assert.equal(a.final, null);
  assert.equal(a.patch.dueAt, T0 + REFUSED_RETRY_MS);
  const b = nextStep({ jobId: "-J", attempts: 3, refusedReads: MAX_REFUSED_READS - 1 }, { kind: "refused", reason: "r" }, T0);
  assert.equal(b.final, "unread");
});

// ── receive ───────────────────────────────────────────────────────────────────

test("RECEIVED: the photo is stored, a job is queued, and the answer is {ok, received} — nothing else", async () => {
  const db = world();
  const { out, bucket, jobId, jobs } = await received(db);
  assert.deepEqual(out, { ok: true, received: true });
  const job = jobs[jobId];
  assert.equal(job.status, "queued");
  assert.equal(job.pickedTid, "0000HP1X");
  assert.equal(job.storeId, "pe");
  assert.equal(job.placeTillId, "till-2");
  assert.equal(job.dayYmd, "2026-10-07");
  assert.deepEqual(job.photoPaths, [`cardRecon/jobs/${jobId}/photo-0.jpg`]);
  assert.equal(bucket.saved[job.photoPaths[0]].toString(), "fake-jpeg-bytes", "the bytes are kept BEFORE any read");
  const due = (await db.ref(DUE_PATH).once("value")).val();
  assert.deepEqual(due, { [job.dueKey]: jobId });
  assert.equal(job.token.email, "mgr1@marathon.internal");
  assert.equal(job.token.email_verified, false);
});

test("receive refuses, before storing anything, every till the photo path never accepted", async () => {
  const db = world();
  const bucket = fakeBucket();
  const call = (data, as = STAFF) => handleReceive(db, { auth: as, data: { action: "receive", photos: [{ base64: PHOTO }], ...data } }, { bucket, now: () => T0 });
  assert.match((await call({ pickedTid: "0000ZZZZ" })).reason, /not registered/);
  assert.match((await call({ pickedTid: "67365901" })).reason, /Email only/);
  await assert.rejects(call({ pickedTid: "0000HP1X", declaredTotal: "1.00" }, OWNER), /typed total is checked while you wait/);
  await assert.rejects(call({ pickedTid: "" }), /Pick the till first/);
  await assert.rejects(call({ pickedTid: "0000HP1X", photos: [] }), /./);
  assert.deepEqual(bucket.saved, {});
  assert.equal((await db.ref(JOBS_PATH).once("value")).val(), null);
});

test("receive reads ONE registry row, never the whole registry", async () => {
  const reads = [];
  const db = makeFakeDb({ config: { cardTerminals: { "0000HP1X": HP1X } } }, { beforeRead: (p) => { reads.push(p); } });
  await handleReceive(db, { auth: OWNER, data: { pickedTid: "0000HP1X", photos: [{ base64: PHOTO }] } }, { bucket: fakeBucket(), now: () => T0 });
  assert.ok(reads.includes("config/cardTerminals/0000HP1X"));
  assert.ok(!reads.includes("config/cardTerminals"), reads.join(", "));
});

// ── running a job ─────────────────────────────────────────────────────────────

const noPhotos = async () => [{ base64: PHOTO }];
const readAs = (answers) => {
  let i = 0;
  const calls = [];
  const fn = async (db, job, photos) => {
    calls.push({ attempt: job.attempts, photos: photos.length });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { fn, calls };
};
const overloaded = () => Object.assign(new Error("Google's slip reader is overloaded"), { code: "unavailable" });

test("a reader outage reschedules the job, moving its queue entry; nothing is shown to anyone", async () => {
  const db = world();
  const { jobId } = await received(db);
  const r = readAs([overloaded()]);
  const res = await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.deepEqual(res, { outcome: "transient", final: null });
  const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
  assert.equal(job.status, "retry");
  assert.equal(job.attempts, 1);
  assert.equal(job.dueAt, T0 + 1000 + RETRY_DELAYS_MS[0]);
  assert.equal(job.leaseUntil, undefined);
  const hist = Object.values(job.history);
  assert.deepEqual(hist.map((h) => [h.attempt, h.outcome]), [[1, "transient"]]);
  const due = (await db.ref(DUE_PATH).once("value")).val();
  assert.deepEqual(due, { [job.dueKey]: jobId }, "exactly one queue entry, at the new due time");
  assert.equal((await db.ref(UNREAD_PATH).once("value")).val(), null);
});

test("every attempt fails: after the last one the till/day is Unread and ONE notice is queued", async () => {
  const db = world();
  const { jobId } = await received(db);
  const clock = clockAt(T0);
  const r = readAs([overloaded()]);
  await processReadJob(db, jobId, { now: clock.now, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  for (let i = 0; i < MAX_READ_ATTEMPTS + 2; i++) {
    clock.set(clock.now() + 5 * 3600 * 1000);
    await sweepReadJobs(db, { now: clock.now, loadPhotos: noPhotos, read: r.fn });
  }
  assert.equal(r.calls.length, MAX_READ_ATTEMPTS, "never read past the last attempt");
  const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
  assert.equal(job.status, "unread");
  assert.equal((await db.ref(DUE_PATH).once("value")).val(), null, "the queue is empty");
  const marker = (await db.ref(unreadPath({ storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" })).once("value")).val();
  assert.equal(marker.status, "unread");
  assert.equal(marker.tillId, "till-2");
  assert.equal(marker.label, "Marathon Till 2");
  assert.deepEqual(marker.photos, job.photoPaths, "the kept photos travel with the row");
  assert.match(marker.reason, /failed on every attempt \(9 reads/);
  assert.ok(marker.notice.queuedAt);
  const notices = (await db.ref(NOTICES_PATH).once("value")).val();
  assert.deepEqual(Object.keys(notices), ["pe~0000HP1X~2026-10-07"]);
});

test("a second capture of the same day that also fails adds to the row and sends no second email", async () => {
  const db = world();
  const clock = clockAt(T0);
  const run = async () => {
    const { jobId } = await received(db, { now: clock.now() });
    const r = readAs([Object.assign(new Error("Could not read"), { code: "invalid-argument" })]);
    for (let i = 0; i < 3; i++) {
      clock.set(clock.now() + 10 * MIN);
      await processReadJob(db, jobId, { now: clock.now, loadPhotos: noPhotos, read: r.fn, onArrival: true });
    }
  };
  await run();
  await db.ref(`${NOTICES_PATH}/pe~0000HP1X~2026-10-07`).set(null); // the poller sent it
  await run();
  const marker = (await db.ref(unreadPath({ storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" })).once("value")).val();
  assert.equal(marker.failures, 2);
  assert.equal(Object.keys(marker.jobs).length, 2);
  assert.equal((await db.ref(NOTICES_PATH).once("value")).val(), null, "no second notice for a day already unread");
});

test("a recorded read finishes the job and answers an Unread row for that day", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  await db.ref(unreadPath(where)).set(addUnreadFailure(null, { ...where, tillId: "till-2", label: "Marathon Till 2", reason: "earlier", nowMs: T0 }).marker);
  const { jobId } = await received(db);
  const r = readAs([{ extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "537" } }]);
  const res = await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.deepEqual(res, { outcome: "recorded", final: "recorded" });
  const job = (await db.ref(`${JOBS_PATH}/${jobId}`).once("value")).val();
  assert.equal(job.status, "recorded");
  assert.equal(job.batchKey, "537");
  assert.equal((await db.ref(DUE_PATH).once("value")).val(), null);
  const marker = (await db.ref(unreadPath(where)).once("value")).val();
  assert.equal(marker.status, "resolved");
  assert.deepEqual([marker.resolved.via, marker.resolved.batchKey], ["read", "537"]);
});

test("a recorded read on a day with NO Unread row creates none", async () => {
  const db = world();
  const { jobId } = await received(db);
  const r = readAs([{ extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "537" } }]);
  await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.equal((await db.ref(UNREAD_PATH).once("value")).val(), null);
});

test("a duplicate (second photo of a slip already on file) finishes quietly — no row, no email", async () => {
  const db = world();
  const { jobId } = await received(db);
  const r = readAs([{ extract: { ok: false, reason: "Batch #536 for this terminal is already captured. If the earlier capture was wrong, resubmit as a correction — both records are kept." } }]);
  const res = await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.equal(res.final, "duplicate");
  assert.equal((await db.ref(UNREAD_PATH).once("value")).val(), null);
  assert.equal((await db.ref(NOTICES_PATH).once("value")).val(), null);
});

test("a job is never run twice at once: the second caller is turned away by the claim", async () => {
  const db = world();
  const { jobId } = await received(db);
  let inner = null;
  const r = { fn: async () => {
    // While the first run is mid-read, a second one (the sweep) tries the same job.
    inner = await processReadJob(db, jobId, { now: () => T0 + LEASE_MS - 1, loadPhotos: noPhotos, read: async () => { throw new Error("must not run"); } });
    return { extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "537" } };
  } };
  await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.deepEqual(inner, { skipped: true });
});

test("a run that died under its lease is picked up by the sweep once the lease lapses", async () => {
  const db = world();
  const { jobId } = await received(db);
  // Claimed, then the instance died: status reading, lease set, queue entry at the lease end.
  const txn = await db.ref(`${JOBS_PATH}/${jobId}`).transaction((cur) => (cur === null ? null : claimJob(cur, { nowMs: T0, nonce: "dead", onArrival: true })));
  const dead = txn.snapshot.val();
  await db.ref().update({ [`${DUE_PATH}/${dead.prevDueKey}`]: null, [`${DUE_PATH}/${dead.dueKey}`]: jobId });
  const r = readAs([{ extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "537" } }]);
  const early = await sweepReadJobs(db, { now: () => T0 + MIN, loadPhotos: noPhotos, read: r.fn });
  assert.equal(early.due, 0, "not while the lease holds");
  const late = await sweepReadJobs(db, { now: () => T0 + LEASE_MS + MIN, loadPhotos: noPhotos, read: r.fn });
  assert.equal(late.ran, 1);
  assert.equal((await db.ref(`${JOBS_PATH}/${jobId}/status`).once("value")).val(), "recorded");
});

test("the sweep removes a queue entry its job no longer points at, and junk entries", async () => {
  const db = world();
  const { jobId } = await received(db);
  await db.ref(`${JOBS_PATH}/${jobId}/status`).set("recorded");
  await db.ref(`${DUE_PATH}/${dueKey(T0 - MIN, "junk")}`).set("not a/job id");
  await sweepReadJobs(db, { now: () => T0 + 5 * MIN, loadPhotos: noPhotos, read: async () => { throw new Error("must not run"); } });
  assert.equal((await db.ref(DUE_PATH).once("value")).val(), null);
});

test("a photo that cannot be loaded is a transient failure, never a crash", async () => {
  const db = world();
  const { jobId } = await received(db);
  const res = await processReadJob(db, jobId, { now: () => T0, onArrival: true,
    loadPhotos: async () => { throw new Error("No such object"); }, read: async () => { throw new Error("must not run"); } });
  assert.equal(res.outcome, "transient");
});

// ── the email round ─────────────────────────────────────────────────────────────

test("notices: leased while out, closed on the poller's word, retried on its failure", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  await db.ref(unreadPath(where)).set({ ...where, status: "unread", reason: "r", notice: { queuedAt: T0 } });
  await db.ref(`${NOTICES_PATH}/pe~0000HP1X~2026-10-07`).set({ kind: "unread", unreadPath: unreadPath(where), subject: "S", text: "T", createdAt: T0, attempts: 0 });
  const first = await listNotices(db, T0);
  assert.equal(first.to, NOTIFY_TO);
  assert.equal(first.to, "junidmoh@gmail.com");
  assert.deepEqual(first.notices.map((n) => n.key), ["pe~0000HP1X~2026-10-07"]);
  assert.deepEqual((await listNotices(db, T0 + MIN)).notices, [], "leased: a second tick does not send it again");
  // The send failed: offered again at once.
  await recordNoticeResults(db, [{ key: "pe~0000HP1X~2026-10-07", ok: false, error: "535 auth" }], T0 + 2 * MIN);
  const again = await listNotices(db, T0 + 3 * MIN);
  assert.equal(again.notices.length, 1);
  // Sent: the notice goes, the row says when.
  const res = await recordNoticeResults(db, [{ key: "pe~0000HP1X~2026-10-07", ok: true }], T0 + 4 * MIN);
  assert.deepEqual([res.sent, res.failed], [1, 0]);
  assert.equal((await db.ref(NOTICES_PATH).once("value")).val(), null);
  const marker = (await db.ref(unreadPath(where)).once("value")).val();
  assert.equal(marker.notice.sentAt, T0 + 4 * MIN);
  assert.equal(marker.notice.queuedAt, T0);
});

test("notices: unsafe keys from the poller are ignored; a list over 20 is refused", async () => {
  const db = world();
  await db.ref(`${NOTICES_PATH}/ok~1`).set({ subject: "S", text: "T", attempts: 0 });
  const r = await recordNoticeResults(db, [{ key: "../users", ok: true }, { key: "ok~1/subject", ok: true }], T0);
  assert.deepEqual([r.sent, r.failed], [0, 0]);
  assert.ok((await db.ref(`${NOTICES_PATH}/ok~1`).once("value")).val());
  await assert.rejects(recordNoticeResults(db, Array.from({ length: 21 }, () => ({})), T0), /at most 20/);
});

// ── the job runs the phone's own pipeline — nothing reimplemented ─────────────

test("a job is read by handleExtract then handleSubmit — the same code the phone ran — with its stored photos", () => {
  const src = require("node:fs").readFileSync(require.resolve("../cardRecon/cardRecon.js"), "utf8");
  const once = src.slice(src.indexOf("async function readJobOnce("), src.indexOf("async function processReadJob("));
  assert.match(once, /await handleExtract\(db, \{/);
  assert.match(once, /storedPhotoPaths:/);
  assert.match(once, /await handleSubmit\(db, \{ auth, data: \{ action: "submit", draftId: extract\.draftId \} \}\)/);
  // …and handleExtract, handed stored paths, does not store the photos again.
  const extract = src.slice(src.indexOf("async function handleExtract("), src.indexOf("async function handleExtractPdf("));
  assert.match(extract, /const stored = Array\.isArray\(opts\.storedPhotoPaths\)/);
  assert.match(extract, /for \(let i = 0; !stored && i < decoded\.length; i\+\+\)/);
  // The arrival trigger and the sweep are the only callers of the runner.
  const callers = src.match(/processReadJob\(admin\.database\(\)|processReadJob\(db, jobId, deps\)/g) || [];
  assert.equal(callers.length, 2);
});


// ── review fixes (#707) ───────────────────────────────────────────────────────

test("a slip photographed before 06:00 SAST is filed on the evening before", async () => {
  const db = world();
  const { jobs, jobId } = await received(db, { now: Date.parse("2026-10-07T23:30:00Z") }); // 01:30 SAST on the 8th
  assert.equal(jobs[jobId].dayYmd, "2026-10-07");
});

test("a till sends at most 8 slip photos a day — past that nothing is stored and the manager is told it is with Junid", async () => {
  const db = world();
  for (let i = 0; i < 8; i++) assert.equal((await received(db)).out.ok, true);
  const { out, bucket } = await received(db);
  assert.equal(out.ok, false);
  assert.match(out.reason, /already sent 8 slip photos today/);
  assert.deepEqual(bucket.saved, {});
  assert.equal(Object.keys((await db.ref(JOBS_PATH).once("value")).val()).length, 8);
});

test("a job stranded between its claim and its queue move is put back in the queue, not lost", async () => {
  const db = world();
  const { jobId } = await received(db);
  // The claim committed (job now points at its lease key) but the queue move never happened.
  const txn = await db.ref(`${JOBS_PATH}/${jobId}`).transaction((cur) => (cur === null ? null : claimJob(cur, { nowMs: T0, nonce: "x", onArrival: true })));
  const leased = txn.snapshot.val();
  // The sweep meets the OLD key while the lease holds: it must re-point, never just delete.
  await sweepReadJobs(db, { now: () => T0 + 3 * MIN, loadPhotos: noPhotos, read: async () => { throw new Error("must not run"); } });
  const due = (await db.ref(DUE_PATH).once("value")).val();
  assert.deepEqual(due, { [leased.dueKey]: jobId });
  // …and after the lease, the sweep runs it.
  const r = readAs([{ extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "537" } }]);
  await sweepReadJobs(db, { now: () => T0 + LEASE_MS + MIN, loadPhotos: noPhotos, read: r.fn });
  assert.equal((await db.ref(`${JOBS_PATH}/${jobId}/status`).once("value")).val(), "recorded");
});

test("an Unread marker without a notice gets one on the next run (the notice follows the marker)", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  // A run died after writing the marker and before queuing the notice.
  await db.ref(unreadPath(where)).set(addUnreadFailure(null, { ...where, reason: "r", nowMs: T0 }).marker);
  const { jobId } = await received(db);
  const r = readAs([Object.assign(new Error("bad"), { code: "invalid-argument" })]);
  for (let i = 0; i < 3; i++) await processReadJob(db, jobId, { now: () => T0 + (i + 1) * 10 * MIN, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.ok((await db.ref(`${NOTICES_PATH}/pe~0000HP1X~2026-10-07`).once("value")).val());
});

test("a notice that keeps failing leaves the queue after 10 tries and the row says the email failed", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-07" };
  await db.ref(unreadPath(where)).set({ ...where, status: "unread", reason: "r" });
  await db.ref(`${NOTICES_PATH}/k1`).set({ unreadPath: unreadPath(where), subject: "S", text: "T", createdAt: T0, attempts: 9 });
  await recordNoticeResults(db, [{ key: "k1", ok: false, error: "535 auth" }], T0 + MIN);
  assert.equal((await db.ref(`${NOTICES_PATH}/k1`).once("value")).val(), null);
  const m = (await db.ref(unreadPath(where)).once("value")).val();
  assert.equal(m.notice.lastError, "535 auth");
  assert.ok(m.notice.failedAt);
});

test("a sent notice for a row that no longer exists does not create a stub row", async () => {
  const db = world();
  const where = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-06" };
  await db.ref(`${NOTICES_PATH}/k2`).set({ unreadPath: unreadPath(where), subject: "S", text: "T", attempts: 0 });
  await recordNoticeResults(db, [{ key: "k2", ok: true }], T0);
  assert.equal((await db.ref(unreadPath(where)).once("value")).val(), null);
});

test("a recorded read answers the Unread row on the day its batch CLOSED as well as the day it arrived", async () => {
  const db = world({ card_batches: { pe: { "0000HP1X": { 536: { slip: { closedAt: Date.parse("2026-10-06T15:02:29Z") } } } } } });
  const where6 = { storeId: "pe", tid: "0000HP1X", dayYmd: "2026-10-06" };
  await db.ref(unreadPath(where6)).set(addUnreadFailure(null, { ...where6, reason: "r", nowMs: T0 }).marker);
  const { jobId } = await received(db);
  const r = readAs([{ extract: { ok: true, draftId: "d" }, submit: { ok: true, batchKey: "536" } }]);
  await processReadJob(db, jobId, { now: () => T0 + 1000, loadPhotos: noPhotos, read: r.fn, onArrival: true });
  assert.equal((await db.ref(`${unreadPath(where6)}/status`).once("value")).val(), "resolved");
});
