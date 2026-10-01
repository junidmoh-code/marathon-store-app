// ─── SOCIAL HEALTH — REPLAYING THE DAY NOBODY NOTICED ────────────────────────
// The anchor test in this file is REAL_2026_08_27: the exact production state
// of the day the engine stopped producing, replayed through the assessor. Any
// change that lets that day come back "ok" has removed the only thing this
// module is for.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  assessSocialDay, alarmMessage, policyTotal, landedSomewhere,
  PUBLISH_GRACE_MS, HEARTBEAT_STALE_MS,
} = require("../lib/social-health.cjs");

const MIN = 60000;
// 2026-08-27 21:30 SAST, when the scan runs.
const NOW = Date.UTC(2026, 7, 27, 19, 30);
const SAST_MIDNIGHT = Date.UTC(2026, 7, 26, 22, 0);   // 00:00 SAST on the 27th
const at = (hourSast) => SAST_MIDNIGHT + hourSast * 3600000;

const POLICY = { reels: ["08:00", "18:00"], photos: ["11:00"], stories: ["09:00", "13:00", "17:00"] };
const okResults = { instagram: { state: "ok" }, facebook: { state: "ok" } };

// ── WHAT THIS POLICY ACTUALLY OWES EACH SURFACE ──────────────────────────────
// Six slots, but not six posts: every story's picture is also a feed post and
// every reel is also a story, so the day owes 2 reels, 4 feed posts (1 photo +
// 3 story twins) and 5 stories (3 stories + 2 reel twins).
//
// The default fixture below carries exactly those records, because "a healthy
// day says nothing" has to be a day that really is healthy. A fixture holding
// one post passed only while nothing looked at the surfaces.
const OWED = { reel: 2, feed: 4, story: 5 };
function healthyDayPosts() {
  const out = [];
  let n = 0;
  for (const [format, count] of Object.entries(OWED)) {
    for (let i = 0; i < count; i++) {
      out.push({
        id: `${format}${i}`, status: "posted", format,
        createdAt: at(6) + (++n) * 1000,
        scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults,
      });
    }
  }
  return out;
}

function day(over = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(over, k);
  return assessSocialDay({
    nowMs: has("nowMs") ? over.nowMs : NOW,
    policy: has("policy") ? over.policy : POLICY,
    autopilotLog: has("autopilotLog") ? over.autopilotLog
      : { startedAt: at(6), finishedAt: at(6) + 3 * MIN, created: 6, skipped: 0 },
    posts: has("posts") ? over.posts : healthyDayPosts(),
    twins: has("twins") ? over.twins : undefined,
    publisherTickAt: has("publisherTickAt") ? over.publisherTickAt : NOW - 2 * MIN,
  });
}

describe("a healthy day says nothing", () => {
  test("everything generated, something published, publisher ticking", () => {
    const v = day();
    assert.equal(v.ok, true);
    assert.equal(v.severity, "ok");
    assert.deepEqual(v.reasons, []);
    assert.equal(alarmMessage(v), null);
  });

  test("the SA date is the SA date, not UTC's", () => {
    // 00:30 SAST on the 28th is 22:30 UTC on the 27th. Getting this wrong
    // would file every late-evening verdict under the wrong day.
    const v = assessSocialDay({
      nowMs: Date.UTC(2026, 7, 27, 22, 30), policy: null, autopilotLog: null,
      posts: [], publisherTickAt: Date.UTC(2026, 7, 27, 22, 29),
    });
    assert.equal(v.saDate, "2026-08-28");
  });
});

// ── THE ANCHOR ───────────────────────────────────────────────────────────────
describe("REAL_2026_08_27 — the day that reported success and produced nothing", () => {
  // Production, exactly: the autopilot ran on time and skipped all six items
  // (Gemini 429, credits depleted); the publisher was alive and ticking; one
  // leftover backlog post published at 11:00 and both platforms returned ok;
  // no post was in failed; nothing was overdue.
  const REAL = {
    autopilotLog: { startedAt: at(6), finishedAt: at(6) + 10000, created: 0, skipped: 6, estCostUSD: 0 },
    posts: [
      { id: "backlog", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
      { id: "future", status: "approved", scheduledAt: at(18) + 86400000 },
    ],
    publisherTickAt: NOW - 2 * MIN,
  };

  test("it is caught, and it is caught on GENERATION", () => {
    const v = day(REAL);
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(" "), /generator made nothing/);
  });

  test("a publish-only check would have gone green — this is why generation is checked", () => {
    // The proof that check 3 alone was never enough: something DID publish.
    assert.equal(day(REAL).counts.publishedToday, 1);
    assert.equal(day(REAL).reasons.some((r) => /nothing has published/.test(r)), false);
  });

  // ── THIS TEST USED TO ASSERT "degraded", AND THAT IS WHY IT HAPPENED AGAIN ──
  // Only "silent" pages (socialHealthScan does not email on degraded, owner
  // ruling 2026-08-31). So this exact shape — generator dead, backlog still
  // draining, mini still ticking — was recorded, shown, and never sent. It ran
  // that way for six days from 2026-09-13 with the same cause, Gemini's
  // prepayment credits, and the only two days that paged did so because they
  // tripped a DIFFERENT check as well.
  //
  // "A post did go out" is the backlog, not the engine. A generator that made
  // nothing cannot make tomorrow, and that is down.
  test("it is SILENT — a generator that made nothing is down, backlog or no backlog", () => {
    assert.equal(day(REAL).severity, "silent");
  });

  test("…and the day's own published post does not soften it", () => {
    // The distinction that got this wrong: check 3 is satisfied (something
    // published) and check 1 is not. One passing check must not downgrade a
    // failing one.
    assert.equal(day(REAL).counts.publishedToday, 1);
    assert.equal(day(REAL).severity, "silent");
  });

  // ── THE REASON REACHES THE READER, NOT JUST THE SYMPTOM ────────────────────
  // "made nothing — all 6 skipped" is the same sentence for depleted credits,
  // a revoked key and an empty style library. The autopilot now records WHY on
  // its own run record, because the Cloud Logging line that held it is not
  // readable by the service account that diagnoses this machine.
  test("the skip reason travels into the alarm when the autopilot recorded one", () => {
    const v = day({
      ...REAL,
      autopilotLog: {
        ...REAL.autopilotLog,
        skipReasons: ["6x AI credits depleted or rate-limited (429) — check Gemini billing"],
      },
    });
    assert.match(v.reasons.join(" "), /check Gemini billing/);
  });

  test("a run with no recorded reasons still reads cleanly — no \"(undefined)\"", () => {
    const withoutList = day(REAL).reasons.join(" ");
    assert.match(withoutList, /generator made nothing — all 6 skipped$|generator made nothing — all 6 skipped\b/);
    assert.doesNotMatch(withoutList, /undefined|\(\)/);
    // And rubbish in that field is ignored rather than rendered.
    for (const junk of [[], {}, "", 7, [""], [null]]) {
      const v = day({ ...REAL, autopilotLog: { ...REAL.autopilotLog, skipReasons: junk } });
      assert.doesNotMatch(v.reasons.join(" "), /undefined|\(\)/);
    }
  });

  test("the message names the day and the reason in one line", () => {
    const m = alarmMessage(day(REAL));
    assert.match(m, /2026-08-27/);
    assert.match(m, /generator made nothing/);
    assert.ok(m.length < 300, "an alert must fit on a phone");
  });
});

// ── THE DAY WINDOW IS SAST, AND THAT IS NOT A DETAIL ─────────────────────────
// The SA day runs 22:00 UTC to 22:00 UTC. Assessing against the UTC day
// instead moves the boundary by two hours, which silently disowns everything
// that happened between midnight and 02:00 SAST — a publish in that window
// stops counting as today's and the watchdog cries silence on a day that was
// fine. Caught by the mutation proof: the earlier "saDate is not UTC's" test
// only exercised sa-time.cjs, never this module's own window arithmetic.
describe("the SAST day window", () => {
  const EARLY = Date.UTC(2026, 7, 26, 23, 0);   // 01:00 SAST on the 27th

  test("a 01:00 SAST publish belongs to TODAY, not to yesterday", () => {
    const v = day({ posts: [
      { id: "x", status: "posted", scheduledAt: at(11), postedAt: EARLY, results: okResults },
    ] });
    assert.equal(v.counts.publishedToday, 1);
    assert.equal(v.reasons.some((r) => /nothing has published/.test(r)), false);
  });

  test("a 00:30 SAST slot is one of TODAY's due posts", () => {
    const v = day({ posts: [
      { id: "ok", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
      { id: "early", status: "posted", scheduledAt: Date.UTC(2026, 7, 26, 22, 30), postedAt: EARLY, results: okResults },
    ] });
    assert.equal(v.counts.dueToday, 2);
  });

  test("yesterday's 23:00 SAST publish is NOT today's", () => {
    // The other side of the same boundary: 21:00 UTC on the 26th is 23:00 SAST
    // on the 26th, which is yesterday under either reading — but it must not
    // be counted, and a window anchored anywhere else could let it in.
    const v = day({ posts: [
      { id: "due", status: "approved", scheduledAt: at(11) },
      { id: "y", status: "posted", scheduledAt: Date.UTC(2026, 7, 26, 21, 0), postedAt: Date.UTC(2026, 7, 26, 21, 0), results: okResults },
    ] });
    assert.equal(v.counts.publishedToday, 0);
    assert.match(v.reasons.join(" "), /nothing has published today/);
  });
});

describe("1. generation", () => {
  test("no autopilot record at all is an alarm", () => {
    assert.match(day({ autopilotLog: null }).reasons.join(" "), /no record of running/);
  });

  test("a recorded error is quoted", () => {
    const v = day({ autopilotLog: { startedAt: at(6), finishedAt: at(6) + MIN, error: "gemini HTTP 429" } });
    assert.match(v.reasons.join(" "), /gemini HTTP 429/);
  });

  test("a partial run is named with both numbers", () => {
    const v = day({ autopilotLog: { startedAt: at(6), finishedAt: at(6) + MIN, created: 2, skipped: 4 } });
    assert.match(v.reasons.join(" "), /made 2 of 6/);
  });

  test("a run still going is NOT an alarm; one abandoned for 40 minutes is", () => {
    const running = day({ nowMs: at(6) + 5 * MIN, autopilotLog: { startedAt: at(6) }, posts: [], publisherTickAt: at(6) + 4 * MIN });
    assert.equal(running.reasons.some((r) => /never finished/.test(r)), false);
    const abandoned = day({ autopilotLog: { startedAt: at(6) } });
    assert.match(abandoned.reasons.join(" "), /never finished/);
  });

  test("an empty policy asks for nothing, so generation cannot be late", () => {
    const v = day({ policy: { reels: [], photos: [], stories: [] }, autopilotLog: null });
    assert.equal(v.reasons.some((r) => /generator/.test(r)), false);
  });

  test("policyTotal counts RTDB's object form as well as arrays", () => {
    assert.equal(policyTotal({ reels: ["08:00"], photos: { 0: "11:00" }, stories: null }), 2);
    assert.equal(policyTotal(null), 0);
  });
});

describe("2. publishing", () => {
  test("an approved post past its grace period is an alarm", () => {
    const v = day({ posts: [{ id: "x", status: "approved", scheduledAt: NOW - PUBLISH_GRACE_MS - MIN }] });
    assert.match(v.reasons.join(" "), /past due and still unpublished/);
  });

  test("a post that just came due is NOT — the publisher ticks every two minutes", () => {
    const v = day({ posts: [
      { id: "ok", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
      { id: "x", status: "approved", scheduledAt: NOW - MIN },
    ] });
    assert.equal(v.reasons.some((r) => /past due/.test(r)), false);
  });

  test("a stranded post from a PREVIOUS day is still counted", () => {
    // A check that forgot yesterday would let a permanent stoppage read as a
    // run of unremarkable days.
    const v = day({ posts: [
      { id: "ok", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
      { id: "old", status: "approved", scheduledAt: at(11) - 3 * 86400000 },
    ] });
    assert.match(v.reasons.join(" "), /past due/);
  });

  test("a failed post is an alarm on its own", () => {
    const v = day({ posts: [
      { id: "ok", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
      { id: "f", status: "failed", scheduledAt: at(9) },
    ] });
    assert.match(v.reasons.join(" "), /in failed/);
  });

  test("discarded and draft posts are never 'due'", () => {
    for (const status of ["discarded", "draft", "posting"]) {
      const v = day({ posts: [
        { id: "ok", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN, results: okResults },
        { id: "d", status, scheduledAt: at(1) },
      ] });
      assert.equal(v.reasons.some((r) => /past due/.test(r)), false, status);
    }
  });
});

describe("3. silence", () => {
  test("due today and nothing published is the loudest verdict", () => {
    const v = day({ posts: [{ id: "x", status: "approved", scheduledAt: at(11) }] });
    assert.match(v.reasons.join(" "), /nothing has published today/);
    assert.equal(v.severity, "silent");
  });

  test("a quiet MORNING is not an outage — the first slot has not passed", () => {
    const v = day({
      nowMs: at(7), posts: [{ id: "x", status: "approved", scheduledAt: at(11) }],
      autopilotLog: { startedAt: at(6), finishedAt: at(6) + MIN, created: 6, skipped: 0 },
      publisherTickAt: at(7) - MIN,
    });
    assert.equal(v.reasons.some((r) => /nothing has published/.test(r)), false);
  });

  // Caught in review. A discarded post still carries the slot it was going to
  // take, and counting it made the day look OWED — so a day on which nothing
  // was ever going to publish reported "nothing has published today". A false
  // alarm is what teaches you to ignore the real one.
  test("a DISCARDED post with a past slot today owes nothing", () => {
    const v = day({ posts: [{ id: "d", status: "discarded", scheduledAt: at(9) }], policy: { reels: [], photos: [], stories: [] }, autopilotLog: null });
    assert.equal(v.counts.dueToday, 0);
    assert.equal(v.reasons.some((r) => /nothing has published/.test(r)), false);
  });

  test("a DRAFT with a past slot today owes nothing either", () => {
    const v = day({ posts: [{ id: "x", status: "draft", scheduledAt: at(9) }], policy: { reels: [], photos: [], stories: [] }, autopilotLog: null });
    assert.equal(v.counts.dueToday, 0);
    assert.equal(v.reasons.some((r) => /nothing has published/.test(r)), false);
  });

  test("an APPROVED post with a past slot today still owes", () => {
    const v = day({ posts: [{ id: "a", status: "approved", scheduledAt: at(9) }] });
    assert.equal(v.counts.dueToday, 1);
    assert.match(v.reasons.join(" "), /nothing has published today/);
  });

  test("a FAILED post counts as owed — it was going to publish and did not", () => {
    const v = day({ posts: [{ id: "f", status: "failed", scheduledAt: at(9) }] });
    assert.equal(v.counts.dueToday, 1);
    assert.match(v.reasons.join(" "), /nothing has published today/);
  });

  test("a day with nothing scheduled at all raises no silence alarm", () => {
    const v = day({ posts: [], policy: { reels: [], photos: [], stories: [] }, autopilotLog: null });
    assert.equal(v.reasons.some((r) => /nothing has published/.test(r)), false);
  });

  test("a 'posted' post whose every platform FAILED does not count as published", () => {
    // The status is the publisher's own bookkeeping. Two failures must not be
    // able to buy a green night.
    const v = day({ posts: [{
      id: "x", status: "posted", scheduledAt: at(11), postedAt: at(11) + MIN,
      results: { instagram: { state: "failed" }, facebook: { state: "failed" } },
    }] });
    assert.match(v.reasons.join(" "), /nothing has published today/);
  });

  test("one platform ok out of two DOES count as published", () => {
    assert.equal(landedSomewhere({ results: { instagram: { state: "ok" }, facebook: { state: "failed" } } }), true);
    assert.equal(landedSomewhere({ results: {} }), false);
    assert.equal(landedSomewhere({}), false);
    assert.equal(landedSomewhere(null), false);
  });

  test("yesterday's publish does not count as today's", () => {
    const v = day({ posts: [
      { id: "x", status: "approved", scheduledAt: at(11) },
      { id: "y", status: "posted", scheduledAt: at(11) - 86400000, postedAt: at(11) - 86400000, results: okResults },
    ] });
    assert.match(v.reasons.join(" "), /nothing has published today/);
  });
});

describe("4. heartbeat", () => {
  test("a stale tick is an alarm, and it says how long", () => {
    const v = day({ publisherTickAt: NOW - HEARTBEAT_STALE_MS - 5 * MIN });
    assert.match(v.reasons.join(" "), /has not ticked for 20 minutes/);
    assert.equal(v.severity, "silent");
  });

  test("never having ticked is an alarm", () => {
    assert.match(day({ publisherTickAt: null }).reasons.join(" "), /never recorded a tick/);
  });

  // Caught in review: comparing THROUGH NaN made every non-numeric heartbeat
  // read as a fresh tick. `nowMs - NaN > STALE` is false, so no reason was
  // pushed and publisherDead stayed false — a silent pass, in the one check
  // whose whole purpose is to fire before a day is lost.
  test("a heartbeat that is not a number is treated as NO heartbeat", () => {
    // [] and "" are in here deliberately: both coerce to 0 through Number(),
    // which would have been read as "ticked at the epoch" rather than as no
    // heartbeat — the right alarm for the wrong reason, and a coercion that
    // could just as easily land somewhere that reads healthy.
    for (const bad of ["soon", NaN, {}, [], true, false, "", "  ", Infinity, -Infinity, "2026-08-27T10:00:00Z"]) {
      const v = day({ publisherTickAt: bad });
      assert.match(v.reasons.join(" "), /never recorded a tick/, JSON.stringify(bad));
      assert.equal(v.severity, "silent", JSON.stringify(bad));
    }
  });

  test("a numeric STRING is still a real heartbeat", () => {
    // RTDB round-trips are not always typed the way they were written; a
    // timestamp that arrives as "1787836263000" is a timestamp.
    const v = day({ publisherTickAt: String(NOW - 2 * MIN) });
    assert.equal(v.reasons.some((r) => /tick/.test(r)), false);
  });

  test("a recent tick says nothing", () => {
    assert.equal(day({ publisherTickAt: NOW - 3 * MIN }).reasons.some((r) => /tick/.test(r)), false);
  });

  test("a dead publisher is SILENT even on a day that already published", () => {
    // The damage has not happened yet — that is the point of catching it here.
    const v = day({ publisherTickAt: NOW - 60 * MIN });
    // The whole day published — the default fixture is a healthy one — and it
    // is STILL silent, which is the point: the damage has not happened yet.
    assert.ok(v.counts.publishedToday > 0);
    assert.equal(v.severity, "silent");
  });
});

describe("the assessor never throws on rubbish", () => {
  test("missing, null and malformed inputs still produce a verdict", () => {
    const inputs = [
      { nowMs: NOW, policy: null, autopilotLog: null, posts: null, publisherTickAt: null },
      { nowMs: NOW, policy: {}, autopilotLog: {}, posts: [null, undefined, {}], publisherTickAt: "nonsense" },
      { nowMs: NOW, policy: { reels: "x" }, autopilotLog: { created: "a" }, posts: [{ scheduledAt: "soon" }], publisherTickAt: NaN },
    ];
    for (const i of inputs) {
      const v = assessSocialDay(i);
      assert.equal(typeof v.ok, "boolean");
      assert.ok(Array.isArray(v.reasons));
      assert.ok(["ok", "degraded", "silent"].includes(v.severity));
    }
  });
});

// ─── 1b. WHAT THE DAY OWES EACH SURFACE — THE 2026-09-19 RHYTHM ──────────────
// Two reels a day, each also posted as a story from the same encoded video.
// Check 1 asks whether the PICTURES were made; this asks whether the POSTS
// exist, and since the rhythm changed those are different questions: two reel
// slots owe two reels AND two stories, and the stories cost nothing.
//
// A run that made both pictures and twinned neither satisfies check 1
// completely and leaves the account with no stories on it. That is the shape
// this section exists for.
const { dayObligation } = require("../lib/social-health.cjs");

describe("the new rhythm's obligation", () => {
  const TWO_REELS = { reels: ["12:00", "19:00"], photos: [], stories: [] };
  const TWINS = { reelAlsoPostsToStory: true, storyAlsoPostsToFeed: true };
  const ranAt6 = { startedAt: at(6), finishedAt: at(6) + 3 * MIN, created: 2, skipped: 0 };
  // Posted, not approved: these fixtures are about SURFACES, and leaving them
  // approved with a slot in the past would also trip checks 2 and 3 and make
  // every assertion below pass or fail for the wrong reason.
  const post = (format, over = {}) => ({
    id: `${format}${Math.random()}`, status: "posted", format,
    createdAt: at(6) + 60000, scheduledAt: at(12), postedAt: at(12) + MIN,
    results: okResults, ...over,
  });
  const newDay = (posts, over = {}) =>
    day({ policy: TWO_REELS, twins: TWINS, autopilotLog: ranAt6, posts, publisherTickAt: NOW - 2 * MIN, ...over });

  test("two reel slots owe two reels AND two stories", () => {
    const o = dayObligation(TWO_REELS, TWINS);
    assert.equal(o.generations, 2);
    assert.deepEqual(o.byFormat, { reel: 2, feed: 0, story: 2 });
  });

  test("a full day of two reels and their two stories says nothing about surfaces", () => {
    const v = newDay([post("reel"), post("reel"), post("story"), post("story")]);
    assert.equal(v.reasons.some((r) => /owes/.test(r)), false);
    assert.deepEqual(v.counts.owed, { reel: 2, feed: 0, story: 2 });
    assert.deepEqual(v.counts.madeByFormat, { reel: 2, story: 2, feed: 0 });
  });

  // ── THE FAILURE CHECK 1 CANNOT SEE ────────────────────────────────────────
  test("two pictures made and NEITHER twinned is caught, and it PAGES", () => {
    const v = newDay([post("reel"), post("reel")]);
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(" "), /owes 0 of 2 stories/);
    // Owner brief: "it must alarm if either is missed." Two reels a day means
    // a missing surface is half the day, not a rounding error.
    assert.equal(v.severity, "silent");
  });

  test("ONE missing reel is caught too — and its story goes with it", () => {
    const v = newDay([post("reel"), post("story")]);
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(" "), /1 of 2 reels/);
    assert.match(v.reasons.join(" "), /1 of 2 stories/);
    assert.equal(v.severity, "silent");
  });

  // ── THE RETIRED SLOTS MUST NOT ALARM ──────────────────────────────────────
  test("the retired photo slot owes nothing and cannot alarm", () => {
    const v = newDay([post("reel"), post("reel"), post("story"), post("story")]);
    assert.equal(v.counts.owed.feed, 0);
    assert.equal(v.reasons.some((r) => /feed/.test(r)), false);
  });

  test("a day with NO feed post and NO standalone story is a healthy day", () => {
    assert.equal(newDay([post("reel"), post("reel"), post("story"), post("story")]).ok, true);
  });

  test("putting a photo time back turns its obligation straight back on", () => {
    // The off switch is config, not code. This is the proof that re-enabling
    // it is one entry in the Policy tab.
    const withPhoto = { reels: ["12:00", "19:00"], photos: ["15:00"], stories: [] };
    assert.deepEqual(dayObligation(withPhoto, TWINS).byFormat, { reel: 2, feed: 1, story: 2 });
  });

  test("switching the reel twin off removes the story obligation with it", () => {
    // A watchdog that goes on demanding posts nobody is making any more is a
    // watchdog you turn off.
    const off = { reelAlsoPostsToStory: false, storyAlsoPostsToFeed: true };
    assert.deepEqual(dayObligation(TWO_REELS, off).byFormat, { reel: 2, feed: 0, story: 0 });
    const v = newDay([post("reel"), post("reel")], { twins: off });
    assert.equal(v.reasons.some((r) => /owes/.test(r)), false);
  });

  // ── COUNTED BY createdAt, NOT BY scheduledAt ──────────────────────────────
  test("a reclaimed run that schedules TOMORROW still counts as made today", () => {
    // A retry at 13:00 assigns the 12:00 reel to tomorrow's 12:00. Counting by
    // slot would report a missing reel on a day the generator did its job.
    const tomorrow = at(12) + 86400000;
    const v = newDay([
      post("reel", { scheduledAt: tomorrow }), post("reel", { scheduledAt: tomorrow }),
      post("story", { scheduledAt: tomorrow }), post("story", { scheduledAt: tomorrow }),
    ]);
    assert.equal(v.reasons.some((r) => /owes/.test(r)), false);
  });

  test("yesterday's posts do not pay for today's obligation", () => {
    const yday = at(6) - 86400000;
    const v = newDay([
      post("reel", { createdAt: yday }), post("reel", { createdAt: yday }),
      post("story", { createdAt: yday }), post("story", { createdAt: yday }),
    ]);
    assert.match(v.reasons.join(" "), /owes 0 of 2 reels/);
  });

  test("a discarded post does not pay for it either", () => {
    const v = newDay([
      post("reel"), post("reel"),
      post("story", { status: "discarded" }), post("story", { status: "discarded" }),
    ]);
    assert.match(v.reasons.join(" "), /0 of 2 stories/);
  });

  // ── IT DOES NOT FIRE WHILE THE RUN IS STILL GOING ─────────────────────────
  test("a run still in flight is not accused of being short", () => {
    const inFlight = { startedAt: NOW - 60000, created: 1 };   // no finishedAt
    const v = newDay([post("reel")], { autopilotLog: inFlight });
    assert.equal(v.reasons.some((r) => /owes/.test(r)), false);
  });

  test("a run that made NOTHING is check 1's business, not this one", () => {
    // Otherwise a dead engine reports the same failure twice in one sentence.
    const none = { startedAt: at(6), finishedAt: at(6) + 5000, created: 0, skipped: 2 };
    const v = newDay([], { autopilotLog: none });
    assert.match(v.reasons.join(" "), /generator made nothing/);
    assert.equal(v.reasons.some((r) => /owes/.test(r)), false);
  });

  test("dayObligation survives rubbish", () => {
    for (const junk of [null, undefined, {}, { reels: "no" }, { reels: null }]) {
      const o = dayObligation(junk, TWINS);
      assert.equal(Number.isFinite(o.generations), true);
      for (const v of Object.values(o.byFormat)) assert.equal(Number.isFinite(v), true);
    }
  });

  test("an RTDB object-shaped list counts as a list", () => {
    // RTDB hands arrays back as objects often enough that this is not academic.
    const asObject = { reels: { 0: "12:00", 1: "19:00" }, photos: null, stories: null };
    assert.deepEqual(dayObligation(asObject, TWINS).byFormat, { reel: 2, feed: 0, story: 2 });
  });
});
