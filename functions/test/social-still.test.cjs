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

  test("a lookbook held for the house models' approval is deliberate: the current style posted, no alarm (Junid, 30 Oct)", () => {
    const log = { ...okLog, posted: "current", fallback: true, gate: "models-pending", reason: "Junid has not approved the new house models yet" };
    const prior = "2026-10-18"; // the lookbook day before: held too, so no "two days running"
    const v = base({ enabled: true, slot: STILL_SLOT, log, recent: { [prior]: { ...log }, [D]: log } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.equal(v.still.gate, "models-pending");
  });

  test("a lookbook that fell back because the model's face could not be read is a fault: still seen (review of #822)", () => {
    const log = { ...okLog, posted: "current", fallback: true, gate: "models", reason: "the model reference could not be read: 404" };
    const v = base({ enabled: true, slot: STILL_SLOT, log, recent: { [D]: log } }, "16:30", [landed("story"), landed("feed")]);
    assert.equal(v.severity, "degraded");
    assert.match(v.reasons.join(";"), /fell back to the current style \(models: the model reference could not be read: 404\)/);
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

describe("the rhythm: exactly one reel and one photo post (2026-10-18)", () => {
  const nowMs = at("2026-10-19", "16:00");
  const base = {
    nowMs, autopilotLog: null, posts: [], publisherTickAt: nowMs - 60000,
    twins: { reelAlsoPostsToStory: true, storyAlsoPostsToFeed: true }, autopilotEnabled: true,
    rhythm: { reels: 1, stills: 1 },
  };
  const still = (log) => ({ enabled: true, slot: STILL_SLOT, log, recent: { "2026-10-19": log } });
  const lookbook = { startedAt: at("2026-10-19", "07:00"), finishedAt: at("2026-10-19", "07:05"), planned: "lookbook", posted: "lookbook", fallback: false };

  test("one reel slot and a still: no rhythm reason; the posted format is reported", () => {
    const v = assessSocialDay({ ...base, policy: { reels: ["19:00"], photos: [], stories: [] }, still: still(lookbook) });
    assert.ok(!v.reasons.some((r) => /rhythm/.test(r)), v.reasons.join("; "));
    assert.deepEqual(v.counts.rhythm, { reelsPlanned: 1, stillsPlanned: 1, reelsMade: 0, stillsMade: 0, reelsExpected: 1, stillsExpected: 1, stillFormat: "lookbook", stillFallback: false });
  });

  test("the 12:00 reel switched back on is reported, not paged", () => {
    const v = assessSocialDay({ ...base, nowMs: at("2026-10-19", "08:00"), policy: { reels: ["12:00", "19:00"], photos: [], stories: [] }, still: still(lookbook) });
    assert.ok(v.reasons.includes("the policy asks for 2 reels a day; the rhythm is 1 reel + 1 photo post"), v.reasons.join("; "));
  });

  test("a switched-off still is reported", () => {
    const v = assessSocialDay({ ...base, policy: { reels: ["19:00"], photos: [], stories: [] }, still: { enabled: false } });
    assert.ok(v.reasons.some((r) => r.startsWith("the daily photo post is switched off")));
    assert.equal(v.counts.rhythm.stillFormat, null);
  });

  test("two reels actually made is reported even when the policy says one", () => {
    const reel = (id) => ({ id, format: "reel", status: "approved", createdAt: at("2026-10-19", "06:01"), scheduledAt: at("2026-10-19", "19:00") });
    const v = assessSocialDay({ ...base, policy: { reels: ["19:00"], photos: [], stories: [] }, posts: [reel("a"), reel("b")], still: still(lookbook) });
    assert.ok(v.reasons.includes("2 reels were made today; the rhythm is 1"), v.reasons.join("; "));
    assert.equal(v.counts.rhythm.reelsMade, 2);
  });

  test("a lookbook day that fell back reports current + fallback", () => {
    const fb = { ...lookbook, posted: "current", fallback: true, gate: "text", reason: "lettering on a sign" };
    const v = assessSocialDay({ ...base, policy: { reels: ["19:00"], photos: [], stories: [] }, still: still(fb) });
    assert.equal(v.counts.rhythm.stillFormat, "current");
    assert.equal(v.counts.rhythm.stillFallback, true);
  });
});

describe("one picture, one generation, one queue item per product (2026-10-18)", () => {
  const { buildStoryTwin } = require("../lib/social-twin.cjs");
  const { queuedPids } = require("../lib/social-still.cjs");

  test("a twin carries no cost of its own: the generation is its lead's", () => {
    const reel = { format: "reel", costUSD: 0.15744, media: [{ type: "image", url: "U" }] };
    const st = buildStoryTwin(reel, { twinId: "T", reelId: "R", fallbackCaption: "x — online now." });
    assert.equal(st.costUSD, 0);
    assert.equal(st.costOn, "R");
    const story = { format: "story", costUSD: 0.15792, media: [{ type: "image", url: "S" }] };
    const ft = buildFeedTwin(story, { twinId: "F", storyId: "S", caption: "c", captionSource: "ai" });
    assert.equal(ft.costUSD, 0);
    assert.equal(ft.costOn, "S");
  });

  test("a product waiting in the queue is excluded; posted, discarded and sample are not", () => {
    const set = queuedPids([
      { status: "approved", products: [{ pid: "a" }, { pid: "b" }] },
      { status: "draft", products: [{ pid: "c" }] },
      { status: "posting", products: [{ pid: "d" }] },
      { status: "posted", products: [{ pid: "x" }] },
      { status: "discarded", products: [{ pid: "y" }] },
      { status: "sample", products: [{ pid: "z" }] },
      null, { status: "approved" },
    ]);
    assert.deepEqual([...set].sort(), ["a", "b", "c", "d"]);
  });
});

describe("the stylist on the still", () => {
  const still = require("../lib/social-still.cjs");
  test("the styling note is the caption's last paragraph, once", () => {
    assert.equal(still.withStylingNote("New in.\n\nShop now", "Tonal base, white sneaker."), "New in.\n\nShop now\n\nTonal base, white sneaker.");
    assert.equal(still.withStylingNote("New in. Tonal base, white sneaker.", "Tonal base, white sneaker."), "New in. Tonal base, white sneaker.");
    assert.equal(still.withStylingNote("New in.", null), "New in.");
  });
  test("the look is recorded on the post and the day's log, without undefined", () => {
    const look = { key: "earth-tone-street", name: "Earth Tone Street", note: "Olive and cream.", score: 91.2, source: "model", header: ["EARTH TONE", "STREET"] };
    const rec = still.buildLookbookRecord({
      rows: [{ pid: "a", slot: "tee", price: 300, displayName: "x" }], total: { value: 300 }, urls: { story: "s", feed: "f", master: "m" },
      nowMs: 1, link: "l", storyCaption: "c", platforms: {}, look,
    });
    assert.deepEqual(rec.look, { key: "earth-tone-street", name: "Earth Tone Street", note: "Olive and cream.", score: 91.2, source: "model" });
    const log = still.stillLogEntry({ planned: "lookbook", posted: "lookbook", nowMs: 1, look, stylistCostUSD: 0.000412 });
    assert.equal(log.look.key, "earth-tone-street");
    assert.equal(log.stylistCostUSD, 0.00041);
    assert.equal(still.stillLogEntry({ planned: "current", posted: "current", nowMs: 1 }).look, null);
  });
});

describe("the styling note above the hashtags", () => {
  const still = require("../lib/social-still.cjs");
  test("goes above a closing hashtag block, and never past Instagram's ceiling", () => {
    assert.equal(still.withStylingNote("New in.\n\n#marathonclub #durban", "Tonal base, white sneaker."), "New in.\n\nTonal base, white sneaker.\n\n#marathonclub #durban");
    const long = "x".repeat(2190);
    assert.equal(still.withStylingNote(long, "Tonal base, white sneaker."), long);
  });
});
