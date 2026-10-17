// ─── THE DAILY STILL: RECORD SHAPE, DAY LOG, AND THE WATCHDOG'S VIEW ─────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildLookbookRecord, stillLogEntry, STILL_SLOT } = require("../lib/social-still.cjs");
const { buildFeedTwin, twinWriteUpdates } = require("../lib/social-twin.cjs");
const { assessSocialDay, assessStill, passedSlots } = require("../lib/social-health.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");

const SAST = 2 * 3600000;
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) - SAST;
const ROWS = [
  { pid: "h1", slot: "hat", displayName: "Lacoste Beanie", price: 180 },
  { pid: "t1", slot: "tee", displayName: "Nike Tee", price: 300 },
  { pid: "b1", slot: "bottoms", displayName: "Diesel Jeans", price: 750 },
  { pid: "s1", slot: "sneakers", displayName: "Nike Versair", price: 750 },
];

describe("the lookbook record", () => {
  const rec = buildLookbookRecord({
    rows: ROWS, total: { value: 1980, text: "R1,980" }, urls: { story: "S", feed: "F", master: "M" },
    scheduledAt: at("2026-10-18", "15:30"), platforms: { instagram: true, facebook: true, tiktok: false },
    engine: "nbpro", costUSD: 0.17004, nowMs: 1, link: "https://marathonclub.co.za", storyCaption: "One fit, head to toe.",
  });

  test("a story with a 1080x1350 feed render: the existing twin makes the feed post", () => {
    assert.equal(rec.format, "story");
    assert.equal(rec.kind, "lookbook");
    assert.equal(rec.status, "approved");
    const twin = buildFeedTwin(rec, { twinId: "T", storyId: "P", caption: "A real caption", captionSource: "ai" });
    assert.equal(twin.format, "feed");
    assert.deepEqual(twin.media, [{ type: "image", url: "F" }]);
    assert.equal(twin.scheduledAt, rec.scheduledAt);
  });

  test("survives the write through a real-shaped RTDB, prices and total intact", async () => {
    const db = new FakeRtdb();
    const twin = buildFeedTwin(rec, { twinId: "T", storyId: "P", caption: "c", captionSource: "ai" });
    await db.ref().update(twinWriteUpdates("social_posts", "P", rec, "T", twin));
    const back = (await db.ref("social_posts/P").once("value")).val();
    assert.equal(back.twinId, "T");
    assert.deepEqual(back.products.map((p) => p.price), [180, 300, 750, 750]);
    assert.equal(back.total, 1980);
  });
});

describe("the day's still log", () => {
  test("a lookbook day that posted the current style is a fallback; nulls are explicit", () => {
    const e = stillLogEntry({ planned: "lookbook", posted: "current", gate: "text", reason: "VOGUE on a sign", nowMs: 5 });
    assert.equal(e.fallback, true);
    assert.equal(e.postId, null);
    assert.ok("twinId" in e && e.twinId === null);
    assert.equal(stillLogEntry({ planned: "current", posted: "current", nowMs: 5 }).fallback, false);
    assert.equal(stillLogEntry({ planned: "lookbook", posted: "lookbook", nowMs: 5 }).fallback, false);
  });
});

describe("the watchdog and the still", () => {
  const D = "2026-10-20";
  const base = (still, nowHHMM = "16:30", extraPosts = []) => assessSocialDay({
    nowMs: at(D, nowHHMM),
    policy: { reels: ["12:00", "19:00"] },
    autopilotLog: { startedAt: at(D, "06:00"), finishedAt: at(D, "06:02"), created: 2, skipped: 0 },
    posts: [
      ...["reel", "story"].map((format, i) => ({ id: `r${i}`, format, status: "posted", createdAt: at(D, "06:01"), scheduledAt: at(D, "12:00"), postedAt: at(D, "12:01"), results: { instagram: { state: "ok" } } })),
      // the 19:00 reel and its story, made at 06:00 and not yet due
      ...["reel", "story"].map((format, i) => ({ id: `e${i}`, format, status: "approved", createdAt: at(D, "06:01"), scheduledAt: at(D, "19:00") })),
      ...extraPosts,
    ],
    publisherTickAt: at(D, nowHHMM) - 60000,
    twins: { reelAlsoPostsToStory: true, storyAlsoPostsToFeed: true },
    still,
  });
  const landed = (format) => ({ id: `s-${format}`, format, status: "posted", createdAt: at(D, "07:02"), scheduledAt: at(D, "15:30"), postedAt: at(D, "15:31"), results: { instagram: { state: "ok" } } });
  const okLog = { startedAt: at(D, "07:00"), finishedAt: at(D, "07:03"), planned: "lookbook", posted: "lookbook", fallback: false };

  test("the 15:30 still is a slot on both surfaces", () => {
    const s = passedSlots({ reels: [] }, at(D, "00:00"), at(D, "16:00"), {}, { enabled: true, slot: STILL_SLOT, log: okLog });
    assert.deepEqual(s.story, ["15:30"]);
    assert.deepEqual(s.feed, ["15:30"]);
  });

  test("a lookbook that posted on both surfaces is a clean day, reported per day", () => {
    const v = base({ enabled: true, slot: STILL_SLOT, log: okLog, recent: { [D]: okLog } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.deepEqual(v.still, { planned: "lookbook", posted: "lookbook", fallback: false, gate: null, reason: null });
  });

  test("a fallback posts and is still SEEN: degraded, with the gate and reason", () => {
    const log = { ...okLog, posted: "current", fallback: true, gate: "text", reason: "the hero contains text: VOGUE" };
    const v = base({ enabled: true, slot: STILL_SLOT, log, recent: { [D]: log } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.severity, "degraded");
    assert.match(v.reasons.join(";"), /today's lookbook fell back to the current style \(text: the hero contains text: VOGUE\)/);
    assert.equal(v.still.fallback, true);
  });

  test("the day after a fallback (a current day) still says so", () => {
    const prev = { ...okLog, posted: "current", fallback: true, gate: "outfit", reason: "no eligible outfit" };
    const today = { ...okLog, planned: "current", posted: "current" };
    const v = base({ enabled: true, slot: STILL_SLOT, log: today, recent: { "2026-10-19": prev, [D]: today } }, "16:30", [landed("story"), landed("feed")]);
    assert.match(v.reasons.join(";"), /the last lookbook \(2026-10-19\) fell back/);
    assert.equal(v.severity, "degraded");
  });

  test("two lookbook days running that both fell back PAGE (≤48 h after the first)", () => {
    const fb = { ...okLog, posted: "current", fallback: true, gate: "text", reason: "x" };
    const v = base({ enabled: true, slot: STILL_SLOT, log: fb, recent: { "2026-10-18": fb, "2026-10-19": { ...okLog, planned: "current", posted: "current" }, [D]: fb } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.severity, "silent");
    assert.match(v.reasons.join(";"), /two lookbook days running \(2026-10-18 and 2026-10-20\)/);
  });

  test("no still record by 07:40 pages; at 07:20 it is not yet owed", () => {
    assert.equal(assessStill({ enabled: true, log: null, recent: { "2026-10-19": okLog } }, { nowMs: at(D, "07:20"), dayStart: at(D, "00:00"), saDate: D }).silent, false);
    assert.equal(assessStill({ enabled: true, log: null, recent: { "2026-10-19": okLog } }, { nowMs: at(D, "07:45"), dayStart: at(D, "00:00"), saDate: D }).silent, true);
  });

  test("a still that made nothing pages; a missed 15:30 slot pages", () => {
    const none = { ...okLog, posted: null, fallback: false, reason: "cap reached" };
    assert.equal(base({ enabled: true, slot: STILL_SLOT, log: none, recent: {} }).severity, "silent");
    const v = base({ enabled: true, slot: STILL_SLOT, log: okLog, recent: { [D]: okLog } }, "16:30", []);
    assert.equal(v.severity, "silent");
    assert.match(v.reasons[0], /15:30/);
  });

  test("a lookbook that worked today is not shadowed by the one before that fell back", () => {
    const prev = { ...okLog, posted: "current", fallback: true, gate: "text", reason: "x" };
    const v = base({ enabled: true, slot: STILL_SLOT, log: okLog, recent: { "2026-10-18": prev, [D]: okLog } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.ok, true, v.reasons.join("; "));
  });

  test("a lookbook day where the fallback ALSO failed counts as a fallback", () => {
    assert.equal(stillLogEntry({ planned: "lookbook", posted: null, nowMs: 1 }).fallback, true);
  });

  test("deploy day: no still has ever run, so nothing is owed and nothing pages", () => {
    const v = base({ enabled: true, slot: STILL_SLOT, log: null, recent: {} }, "16:30");
    assert.equal(v.ok, true, v.reasons.join("; "));
  });

  test("no daily still configured: nothing owed, nothing reported", () => {
    const v = base({ enabled: false, slot: STILL_SLOT, log: null, recent: {} }, "16:30");
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.equal(v.still, null);
  });
});
