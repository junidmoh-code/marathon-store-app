// ─── THE 4–7 OCTOBER OUTAGE, REPLAYED ────────────────────────────────────────
// The generator was switched off in the deployed build. It wrote no run record
// and no posts, the queue was empty, nothing failed, the publisher ticked
// every two minutes, and every day was graded "degraded", which does not page.
// These tests pin each of the three ways that state now pages.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  assessSocialDay, alarmMessage, passedSlots, pushKeyPrefixForMs, PUBLISH_GRACE_MS,
} = require("../lib/social-health.cjs");

const MIN = 60000;
const MIDNIGHT = Date.UTC(2026, 9, 6, 22, 0);          // 00:00 SAST 7 Oct
const at = (h, m = 0) => MIDNIGHT + (h * 60 + m) * MIN;
const POLICY = { reels: ["12:00", "19:00"] };            // the live policy since #614
const ok = { instagram: { state: "ok" }, facebook: { state: "ok" } };
const RAN = { startedAt: at(6), finishedAt: at(6, 2), created: 2, skipped: 0 };
const landed = (format, h, m = 1) => ({ status: "posted", format, createdAt: at(6), scheduledAt: at(h), postedAt: at(h, m), results: ok });
const queued = (format, h) => ({ status: "approved", format, createdAt: at(6), scheduledAt: at(h) });
// What the 06:00 run made: a reel and its story for each slot, waiting.
const MADE = [queued("reel", 12), queued("story", 12), queued("reel", 19), queued("story", 19)];

function day(over) {
  const nowMs = over.nowMs || at(12, 25);
  return assessSocialDay({
    policy: POLICY, autopilotLog: RAN, posts: MADE, publisherTickAt: nowMs - MIN,
    twins: { reelAlsoPostsToStory: true, storyAlsoPostsToFeed: true }, autopilotEnabled: true,
    ...over, nowMs,
  });
}

test("REPLAY 7 Oct 12:25: generator off, empty queue, publisher alive: SILENT, and it names the switch", () => {
  const v = day({ autopilotLog: null, autopilotEnabled: false, posts: [] });
  assert.equal(v.severity, "silent");
  const msg = alarmMessage(v);
  assert.match(msg, /12:00 reel has not landed/);
  assert.match(msg, /12:00 story has not landed/);
  assert.match(msg, /switched OFF .*SOCIAL_AUTOPILOT_ENABLED/);
  assert.doesNotMatch(msg, /no record of running/, "the switch is the cause, not a missing run");
});

test("no run record by 07:25 pages even before any slot is due (the generator did not run)", () => {
  const v = day({ nowMs: at(7, 25), autopilotLog: null, posts: [] });
  assert.equal(v.severity, "silent");
  assert.match(alarmMessage(v), /no record of running today/);
  assert.equal(v.counts.missedSlots, 0);
});

test("the 19:00 reel and its story landed, 12:00 did not: SILENT, naming only 12:00", () => {
  const v = day({ nowMs: at(19, 25), posts: [queued("reel", 12), queued("story", 12), landed("reel", 19), landed("story", 19, 2)] });
  assert.equal(v.severity, "silent");
  assert.match(v.reasons[0], /the 12:00 reel has not landed; the 12:00 story has not landed/);
});

test("both slots met: ok", () => {
  const v = day({ nowMs: at(19, 25), posts: [landed("reel", 12), landed("story", 12, 2), landed("reel", 19), landed("story", 19, 2)] });
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
});

test("inside the grace window a slot is not yet owed", () => {
  const v = day({ nowMs: at(12) + PUBLISH_GRACE_MS - MIN });
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
});

test("a reel that published but failed on every platform does not meet its slot", () => {
  const bad = { ...landed("reel", 12), results: { instagram: { state: "failed" }, facebook: { state: "failed" } } };
  const v = day({ posts: [bad, landed("story", 12, 2), queued("reel", 19), queued("story", 19)] });
  assert.equal(v.severity, "silent");
  assert.match(v.reasons[0], /12:00 reel has not landed/);
});

test("with the story twin switched off, a reel slot owes no story", () => {
  const v = day({ posts: [landed("reel", 12), queued("reel", 19)], twins: { reelAlsoPostsToStory: false, storyAlsoPostsToFeed: true } });
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
});

test("passedSlots ignores malformed times and sorts", () => {
  const s = passedSlots({ reels: ["19:00", "bad", "08:30"] }, MIDNIGHT, at(23), {});
  assert.deepEqual(s.reel, ["08:30", "19:00"]);
  assert.deepEqual(s.story, ["08:30", "19:00"]);
});

test("pushKeyPrefixForMs orders with real push keys", () => {
  // Real keys from /social_posts on 7 Oct (scheduled for 19:00 SAST and 12:00 the next day).
  const real = ["-P3M90oTO0k6juFFmReL", "-P3M9IpdDIViqxqGNUFd"];
  const before = pushKeyPrefixForMs(Date.UTC(2026, 9, 7, 16, 0));
  const after = pushKeyPrefixForMs(Date.UTC(2026, 9, 7, 17, 0));
  for (const k of real) { assert.ok(k >= before, `${k} >= ${before}`); assert.ok(k < after, `${k} < ${after}`); }
  assert.equal(before.length, 8);
});

test("a late reel covers its own slot; an early Post now covers the first open slot", () => {
  const late = day({ nowMs: at(19, 25), posts: [landed("reel", 13, 10), landed("story", 13, 11), landed("reel", 19), landed("story", 19, 2)] });
  assert.equal(late.ok, true, JSON.stringify(late.reasons));
  const early = day({ nowMs: at(12, 25), posts: [landed("reel", 10), landed("story", 10, 1), queued("reel", 19), queued("story", 19)] });
  assert.equal(early.ok, true, JSON.stringify(early.reasons));
});

test("a slot already past when the policy was saved is not owed", () => {
  const v = day({ nowMs: at(14, 25), policy: { reels: ["10:00", "12:00"], updatedAt: at(14) },
    // The run made two; the 10:00 one was slotted for tomorrow.
    posts: [landed("reel", 12, 5), landed("story", 12, 6), queued("reel", 34), queued("story", 34)] });
  assert.equal(v.ok, true, JSON.stringify(v.reasons));
});

test("a failed publish carries its own reason into the alarm", () => {
  const f = { status: "failed", format: "reel", createdAt: at(6), scheduledAt: at(12),
    results: { instagram: { state: "error", error: "Error validating access token: Session has expired" } } };
  const v = day({ posts: [f, queued("story", 12), queued("reel", 19), queued("story", 19)] });
  assert.match(alarmMessage(v), /in failed \(latest: instagram: Error validating access token/);
});
