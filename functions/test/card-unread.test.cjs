// ─── "UNREAD – NEEDS MANUAL ENTRY" MARKERS ───────────────────────────────────
// lib/card-unread.cjs: the marker a till-day gets when its slip could not be
// turned into a record. Pinned: the path (and that it refuses an unsafe one),
// the SAST day, the merge (a second failure adds to the first, never replaces
// it), that a resolved day stays resolved, that ONE notice is queued on the
// transition only, and that the email carries no card data.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  UNREAD_PATH, sastDayYmd, sastDayStartMs, unreadPath, noticeKey,
  addUnreadFailure, resolveUnreadMarker, noticeFor, noticeRecord,
} = require("../lib/card-unread.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-10-07T15:06:05Z"); // 17:06 SAST
const base = { storeId: "pe", tid: "0000HP1X", tillId: "till-2", label: "Marathon Till 2", dayYmd: "2026-10-07" };

test("the day is the SAST day: 23:30 SAST on the 6th is the 6th, 00:30 SAST on the 7th is the 7th", () => {
  assert.equal(sastDayYmd(Date.parse("2026-10-06T21:30:00Z")), "2026-10-06");
  assert.equal(sastDayYmd(Date.parse("2026-10-06T22:30:00Z")), "2026-10-07");
  assert.equal(sastDayStartMs("2026-10-07"), Date.parse("2026-10-06T22:00:00Z"));
  assert.equal(sastDayStartMs("2026-02-30"), null, "a day that does not exist is refused, not rolled over");
  assert.equal(sastDayStartMs("7 Oct"), null);
});

test("the path is filing store / terminal / day under the owner-only overrides node", () => {
  assert.equal(unreadPath(base), `${UNREAD_PATH}/pe/0000HP1X/2026-10-07`);
  assert.equal(UNREAD_PATH, "card_batch_overrides/unread");
  assert.equal(noticeKey(base), "pe~0000HP1X~2026-10-07");
});

test("an unsafe path is refused, never written", () => {
  for (const bad of [{ storeId: "pe/x" }, { tid: "HP.1X" }, { dayYmd: "2026/10/07" }, { storeId: "" }, { tid: undefined }]) {
    assert.throws(() => unreadPath({ ...base, ...bad }), /unsafe marker path/, JSON.stringify(bad));
  }
});

test("a first failure makes an unread marker and says it became unread", () => {
  const { marker, becameUnread } = addUnreadFailure(null, {
    ...base, reason: "Google's slip reader timed out.", jobId: "-J1", photos: ["cardRecon/jobs/-J1/photo-0.jpg"],
    source: "photo-job", nowMs: NOW,
  });
  assert.equal(becameUnread, true);
  assert.equal(marker.status, "unread");
  assert.equal(marker.failures, 1);
  assert.equal(marker.firstAt, NOW);
  assert.deepEqual(marker.photos, ["cardRecon/jobs/-J1/photo-0.jpg"]);
  assert.equal(marker.jobs["-J1"].reason, "Google's slip reader timed out.");
});

test("a second failure the same day MERGES: photos and jobs accumulate, the first time is kept, no second notice", () => {
  const one = addUnreadFailure(null, { ...base, reason: "r1", jobId: "-J1", photos: ["a.jpg"], nowMs: NOW }).marker;
  const { marker, becameUnread } = addUnreadFailure(one, { ...base, reason: "r2", jobId: "-J2", photos: ["b.jpg", "a.jpg"], nowMs: NOW + 60000 });
  assert.equal(becameUnread, false);
  assert.equal(marker.failures, 2);
  assert.equal(marker.firstAt, NOW);
  assert.equal(marker.lastAt, NOW + 60000);
  assert.deepEqual(marker.photos, ["a.jpg", "b.jpg"]);
  assert.deepEqual(Object.keys(marker.jobs).sort(), ["-J1", "-J2"]);
  assert.equal(marker.reason, "r2", "the latest reason is the one shown");
});

test("a RESOLVED day stays resolved when another capture of it fails", () => {
  const one = addUnreadFailure(null, { ...base, reason: "r1", nowMs: NOW }).marker;
  const done = resolveUnreadMarker(one, { via: "manual", batchKey: "537", byEmail: "gunidmoh@gmail.com", nowMs: NOW + 1 });
  assert.equal(done.status, "resolved");
  const { marker, becameUnread } = addUnreadFailure(done, { ...base, reason: "dup", jobId: "-J9", nowMs: NOW + 2 });
  assert.equal(marker.status, "resolved");
  assert.equal(becameUnread, false);
  assert.equal(marker.resolved.batchKey, "537");
  assert.ok(marker.jobs["-J9"], "the failure is still listed");
});

test("resolving twice keeps the first answer; resolving nothing is nothing", () => {
  const one = addUnreadFailure(null, { ...base, reason: "r1", nowMs: NOW }).marker;
  const a = resolveUnreadMarker(one, { via: "read", batchKey: "537", nowMs: NOW + 1 });
  const b = resolveUnreadMarker(a, { via: "manual", batchKey: "537-r2", nowMs: NOW + 2 });
  assert.equal(b.resolved.via, "read");
  assert.equal(resolveUnreadMarker(null, { via: "manual", nowMs: NOW }), null);
});

test("an RTDB-sparse photo list (object with numeric keys) still merges as a list", () => {
  const was = { ...base, status: "unread", photos: { 0: "a.jpg", 2: "c.jpg" }, failures: 1, firstAt: NOW };
  const { marker } = addUnreadFailure(was, { ...base, reason: "r", photos: ["d.jpg"], nowMs: NOW + 1 });
  assert.deepEqual(marker.photos, ["a.jpg", "c.jpg", "d.jpg"]);
});

test("the marker survives a real-RTDB write: no undefined anywhere, nulls dropped, read back intact", async () => {
  const db = makeFakeDb();
  const { marker } = addUnreadFailure(null, { ...base, reason: "r1", nowMs: NOW });
  await db.ref(unreadPath(base)).set(marker); // the fake THROWS on undefined, as the SDK does
  const back = (await db.ref(unreadPath(base)).once("value")).val();
  assert.equal(back.status, "unread");
  assert.equal(back.jobs, undefined, "an empty jobs map is not stored");
  assert.equal(back.photos, undefined, "no photos is not stored as []");
  // …and merging onto that read-back shape (photos/jobs absent) still works.
  const again = addUnreadFailure(back, { ...base, reason: "r2", photos: ["x.jpg"], nowMs: NOW + 5 }).marker;
  assert.deepEqual(again.photos, ["x.jpg"]);
});

test("the email names the till, day and reason — and nothing from a slip", () => {
  const { marker } = addUnreadFailure(null, { ...base, reason: "Google's slip reader timed out twice.", photos: ["a.jpg"], nowMs: NOW });
  const { subject, text } = noticeFor(marker);
  assert.match(subject, /Marathon Till 2/);
  assert.match(subject, /unread, needs manual entry/);
  assert.match(subject, /7 Oct 2026/);
  assert.match(text, /0000HP1X/);
  assert.match(text, /timed out twice/);
  assert.match(text, /Unread – needs manual entry/);
  assert.doesNotMatch(text, /\*{4}|\bR\d|PAN|auth code/i);
  const rec = noticeRecord(marker, NOW);
  assert.equal(rec.unreadPath, unreadPath(base));
  assert.equal(rec.attempts, 0);
});
