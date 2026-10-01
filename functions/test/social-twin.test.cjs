// ─── THE FEED TWIN ───────────────────────────────────────────────────────────
// Two properties carry this feature, and both are ways it could go wrong
// silently rather than loudly: the twin must share the PICTURE and the SLOT,
// and it must NOT share the CAPTION.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { wantsFeedTwin, buildFeedTwin, twinWriteUpdates, primaryCaptionFields, hasFeedArtwork, TWIN_ROLE } = require("../lib/social-twin.cjs");

const SLOT = Date.UTC(2026, 7, 28, 7, 0);   // 09:00 SAST
const IMG = { url: "https://storage/aiStudio/social/posts/S1/0.jpg", type: "image" };

const story = (over = {}) => ({
  status: "approved",
  kind: "single",
  format: "story",
  media: [IMG],
  caption: "Black mesh daypack.",          // the plain line a story carries
  captionSource: "not-needed",
  link: "https://shop/x",
  platforms: { instagram: true, facebook: true, tiktok: false },
  scheduledAt: SLOT,
  products: [{ pid: "p1", name: "n", displayName: "d", handle: "h", slot: null }],
  style: "house",
  costUSD: 0.134,
  createdAt: 1, updatedAt: 1, updatedBy: "cron:socialDailyAutopilot",
  ...over,
});

const twinOf = (s = story(), over = {}) => buildFeedTwin(s, {
  twinId: "T1", storyId: "S1",
  caption: "The one that keeps selling out. Link in bio.",
  captionSource: "model",
  ...over,
});

describe("wantsFeedTwin", () => {
  test("a one-image story is twinned", () => {
    assert.equal(wantsFeedTwin("story", [IMG], true), true);
  });

  test("nothing else is — a feed post or a reel is already on the feed", () => {
    assert.equal(wantsFeedTwin("feed", [IMG], true), false);
    assert.equal(wantsFeedTwin("reel", [IMG], true), false);
    assert.equal(wantsFeedTwin(undefined, [IMG], true), false);
  });

  test("a MULTI-image post is never twinned", () => {
    // There is no story carousel. If one ever reached here, twinning it would
    // build a feed record out of media the story never had.
    assert.equal(wantsFeedTwin("story", [IMG, IMG], true), false);
    assert.equal(wantsFeedTwin("story", [], true), false);
    assert.equal(wantsFeedTwin("story", null, true), false);
  });

  test("the switch is a real switch, and only `true` turns it on", () => {
    assert.equal(wantsFeedTwin("story", [IMG], false), false);
    for (const v of [undefined, null, 1, "yes", {}]) {
      assert.equal(wantsFeedTwin("story", [IMG], v), false, String(v));
    }
  });
});

describe("the twin shares the picture and the slot", () => {
  test("the SAME media, by identity — never a copy, never a re-render", () => {
    const s = story();
    const t = twinOf(s);
    assert.deepEqual(t.media, s.media);
    assert.equal(t.media[0].url, IMG.url);
  });

  test("the same slot — both places on the same tick, not hours apart", () => {
    assert.equal(twinOf().scheduledAt, SLOT);
  });

  test("the same platforms — Instagram and Facebook both", () => {
    assert.deepEqual(twinOf().platforms, { instagram: true, facebook: true, tiktok: false });
  });

  test("the same products and link", () => {
    const s = story();
    assert.deepEqual(twinOf(s).products, s.products);
    assert.equal(twinOf(s).link, s.link);
  });

  test("a field added to a post record in future rides along automatically", () => {
    // The twin inherits by spread ON PURPOSE, so nobody has to remember to
    // add tomorrow's field here as well.
    const t = twinOf(story({ somethingNew: "carried" }));
    assert.equal(t.somethingNew, "carried");
  });
});

describe("the twin does NOT share the caption", () => {
  test("it carries the model's caption, the story's plain line is gone", () => {
    const t = twinOf();
    assert.equal(t.caption, "The one that keeps selling out. Link in bio.");
    assert.notEqual(t.caption, story().caption);
    assert.equal(t.captionSource, "model");
  });

  test("captionSource never stays 'not-needed' — the feed DOES show one", () => {
    assert.notEqual(twinOf().captionSource, "not-needed");
  });

  test("an absent caption note is ABSENT, not null or undefined", () => {
    // undefined throws on an RTDB write; null would invent a note.
    const t = twinOf(story(), { captionNote: undefined });
    assert.equal("captionNote" in t, false);
  });

  test("a caption note the story carried is not inherited blindly", () => {
    const t = twinOf(story({ captionNote: "the story's own note" }), { captionNote: undefined });
    assert.equal("captionNote" in t, false);
  });

  test("a real caption note is kept", () => {
    assert.equal(twinOf(story(), { captionNote: "model refused, used fallback" }).captionNote,
      "model refused, used fallback");
  });
});

describe("the twin is a feed post, and knows what it came from", () => {
  test("format is feed, not story", () => {
    assert.equal(twinOf().format, "feed");
  });

  test("provenance points back at the story", () => {
    const t = twinOf();
    assert.equal(t.twinOf, "S1");
    assert.equal(t.twinRole, TWIN_ROLE);
  });

  test("a twin is NEVER itself twinned", () => {
    // The story record gets a twinId stamped on it; inheriting that would
    // point the twin at itself.
    const t = twinOf(story({ twinId: "T1" }));
    assert.equal("twinId" in t, false);
  });

  test("it refuses to build without both ids", () => {
    assert.throws(() => buildFeedTwin(story(), { twinId: "T1", caption: "x" }), /both ids/);
    assert.throws(() => buildFeedTwin(story(), { storyId: "S1", caption: "x" }), /both ids/);
    assert.throws(() => buildFeedTwin(null, { twinId: "T1", storyId: "S1" }), /no story record/);
  });
});

describe("both records are written in ONE update", () => {
  test("the map carries the story, the twin, and the back-reference", () => {
    const s = story();
    const t = twinOf(s);
    const u = twinWriteUpdates("social_posts", "S1", s, "T1", t);
    assert.deepEqual(Object.keys(u).sort(), ["social_posts/S1", "social_posts/T1"]);
    assert.equal(u["social_posts/S1"].twinId, "T1");
    assert.equal(u["social_posts/T1"].format, "feed");
  });

  // ── THE ONE THAT WOULD HAVE THROWN AT RUNTIME ────────────────────────────
  // RTDB rejects an update map containing both a path and a descendant of it.
  // The back-reference was originally its own key, `social_posts/S1/twinId`,
  // sitting next to `social_posts/S1` — so every twinned generation would have
  // thrown at the write, cleaned up the picture it had just paid for, and lost
  // the post. Caught in review before it ever ran.
  test("NO key is an ancestor of another — RTDB rejects that map outright", () => {
    const u = twinWriteUpdates("social_posts", "S1", story(), "T1", twinOf());
    const keys = Object.keys(u);
    for (const a of keys) {
      for (const b of keys) {
        if (a === b) continue;
        assert.equal(b.startsWith(a + "/"), false, `${b} is a descendant of ${a}`);
      }
    }
  });

  test("the back-reference lives INSIDE the story record", () => {
    const u = twinWriteUpdates("social_posts", "S1", story(), "T1", twinOf());
    assert.equal("social_posts/S1/twinId" in u, false);
    assert.equal(u["social_posts/S1"].twinId, "T1");
  });

  test("adding twinId does not mutate the caller's record", () => {
    const s = story();
    twinWriteUpdates("social_posts", "S1", s, "T1", twinOf());
    assert.equal("twinId" in s, false);
  });

  test("with no twin it is a plain single-record write", () => {
    const s = story();
    const u = twinWriteUpdates("social_posts", "S1", s, null, null);
    assert.deepEqual(Object.keys(u), ["social_posts/S1"]);
  });

  test("a twin id with no twin record writes neither — never a dangling pointer", () => {
    const u = twinWriteUpdates("social_posts", "S1", story(), "T1", null);
    assert.deepEqual(Object.keys(u), ["social_posts/S1"]);
    assert.equal("twinId" in u["social_posts/S1"], false);
  });
});

describe("what the day adds up to", () => {
  test("the default policy puts 6 on the feed and 3 on stories", () => {
    // 2 reels + 1 photo + 3 stories generated; each story also a feed record.
    const policy = { reels: 2, photos: 1, stories: 3 };
    const generated = policy.reels + policy.photos + policy.stories;
    const twins = policy.stories;
    const feedPosts = policy.reels + policy.photos + twins;
    const feedPhotos = policy.photos + twins;
    assert.equal(generated, 6, "six pictures paid for");
    assert.equal(feedPosts, 6, "six posts on the feed");
    assert.equal(feedPhotos, 4, "four of them photos");
    assert.equal(policy.reels, 2, "two of them reels");
    assert.equal(policy.stories, 3, "three stories");
  });
});

// ── THREE FIELDS, ONE CAPTION ────────────────────────────────────────────────
// The bug this exists to stop: a twinned story wrote the plain line into
// `caption` while `captionSource` and `captionNote` still described the TWIN's
// model-written caption. The record then read "ai" beside a caption the model
// never wrote, and on a model failure carried a note about a failure that had
// nothing to do with it.
describe("primaryCaptionFields", () => {
  const twinWrote = { fallback: "Black mesh daypack.", caption: "Sold out twice.", captionSource: "ai", captionNote: null };

  test("a story keeps the plain line AND says so in all three fields", () => {
    const f = primaryCaptionFields("story", twinWrote);
    assert.equal(f.caption, "Black mesh daypack.");
    assert.equal(f.captionSource, "not-needed");
    assert.equal(f.captionNote, null);
  });

  test("a story never inherits the twin's failure note", () => {
    const f = primaryCaptionFields("story", { ...twinWrote, captionSource: "fallback", captionNote: "model refused" });
    assert.equal(f.captionSource, "not-needed");
    assert.equal(f.captionNote, null);
  });

  test("captionSource is never 'ai' on a record that shows no caption", () => {
    for (const src of ["ai", "fallback", "model", undefined]) {
      assert.equal(primaryCaptionFields("story", { ...twinWrote, captionSource: src }).captionSource, "not-needed");
    }
  });

  test("a feed post or reel keeps what the model actually produced", () => {
    for (const format of ["feed", "reel"]) {
      const f = primaryCaptionFields(format, twinWrote);
      assert.equal(f.caption, "Sold out twice.", format);
      assert.equal(f.captionSource, "ai", format);
    }
  });

  test("a real note survives on a feed post", () => {
    const f = primaryCaptionFields("feed", { ...twinWrote, captionSource: "fallback", captionNote: "model refused" });
    assert.equal(f.captionNote, "model refused");
  });

  test("an absent note is null, never undefined — undefined throws on an RTDB write", () => {
    const f = primaryCaptionFields("feed", { fallback: "x", caption: "y", captionSource: "ai" });
    assert.equal(f.captionNote, null);
    assert.equal(f.captionSource, "ai");
  });
});

// ── THE TWIN POSTS THE FEED RENDER, NEVER THE CROPPED STORY FILE ─────────────
describe("the twin's picture is the 1080x1350 render", () => {
  const FEED = { url: "https://storage/aiStudio/social/posts/S1/feed.jpg", width: 1080, height: 1350 };
  const withArt = () => story({ artwork: { story: { url: IMG.url, width: 1080, height: 1920 }, feed: FEED } });

  test("a story with a feed render gives its twin that file", () => {
    const t = twinOf(withArt());
    assert.deepEqual(t.media, [{ type: "image", url: FEED.url }]);
    assert.deepEqual(t.artwork.feed, FEED);
  });

  test("the story itself keeps the 1080x1920 file", () => {
    const s = withArt();
    twinOf(s);
    assert.deepEqual(s.media, [IMG]);
  });

  test("hasFeedArtwork decides whether a twin may be written at all", () => {
    assert.equal(hasFeedArtwork(withArt()), true);
    assert.equal(hasFeedArtwork(story()), false);
    assert.equal(hasFeedArtwork({ artwork: { feed: { url: "" } } }), false);
    assert.equal(hasFeedArtwork(null), false);
  });

  test("an older record with no artwork is twinned exactly as before", () => {
    assert.deepEqual(twinOf(story()).media, [IMG]);
  });
});

// ─── THE STORY TWIN — ONE REEL, TWO SURFACES, ONE FILE ───────────────────────
// Owner brief, 2026-09-19: two reels a day, each also posted as a story, using
// THE SAME encoded video. Three properties carry it, and each is a way it
// could go wrong quietly rather than loudly:
//
//   1. the twin points at the reel for its video, and never at a URL;
//   2. the twin does NOT copy the reel's caption (nothing can show it);
//   3. the twin shares the SLOT, so both go out on one tick.
const {
  wantsStoryTwin, buildStoryTwin, STORY_TWIN_ROLE,
} = require("../lib/social-twin.cjs");

describe("the story twin", () => {
  const STILL = { url: "https://storage/aiStudio/social/posts/R1/0.jpg", type: "image" };
  const reel = (over = {}) => ({
    status: "approved",
    kind: "pairing",
    format: "reel",
    media: [STILL],
    caption: "Two pieces that go together. Link in bio.",
    captionSource: "ai",
    captionNote: "trimmed to 2200",
    link: "https://shop/x",
    platforms: { instagram: true, facebook: true, tiktok: false },
    scheduledAt: SLOT,
    products: [{ pid: "p1", name: "n", displayName: "d", handle: "h", slot: null }],
    style: "house",
    costUSD: 0.134,
    createdAt: 1, updatedAt: 1, updatedBy: "cron:socialDailyAutopilot",
    ...over,
  });
  const build = (r = reel(), over = {}) =>
    buildStoryTwin(r, { twinId: "T1", reelId: "R1", fallbackCaption: "Black mesh daypack.", ...over });

  describe("when it is wanted", () => {
    test("a reel with one still, and the feature on", () => {
      assert.equal(wantsStoryTwin("reel", [STILL], true), true);
    });

    test("never when the feature is off — and off means off, not falsy-ish", () => {
      assert.equal(wantsStoryTwin("reel", [STILL], false), false);
      for (const notOn of [undefined, null, 0, "", "true", 1, {}]) {
        assert.equal(wantsStoryTwin("reel", [STILL], notOn), false);
      }
    });

    test("never for a story, a feed post, or a missing format", () => {
      for (const f of ["story", "feed", undefined, null, "reel "]) {
        assert.equal(wantsStoryTwin(f, [STILL], true), false);
      }
    });

    test("never for a carousel — there is no such thing as a story carousel", () => {
      assert.equal(wantsStoryTwin("reel", [STILL, STILL], true), false);
      assert.equal(wantsStoryTwin("reel", [], true), false);
      assert.equal(wantsStoryTwin("reel", null, true), false);
    });

    test("never from media that is not a still — there is nothing to encode", () => {
      assert.equal(wantsStoryTwin("reel", [{ type: "video", url: "x" }], true), false);
      assert.equal(wantsStoryTwin("reel", [null], true), false);
    });
  });

  describe("what the twin carries", () => {
    test("it is a story, and it says which reel it copies", () => {
      const t = build();
      assert.equal(t.format, "story");
      assert.equal(t.twinOf, "R1");
      assert.equal(t.twinRole, STORY_TWIN_ROLE);
    });

    test("videoFrom is the reel's ID, never a URL", () => {
      // At generation no video exists — the encode happens on the Mac mini at
      // publish time. A URL here could only ever be a stale guess.
      const t = build();
      assert.equal(t.videoFrom, "R1");
      assert.doesNotMatch(String(t.videoFrom), /^https?:/);
    });

    test("it shares the SLOT — both go out on one tick, not hours apart", () => {
      assert.equal(build().scheduledAt, SLOT);
    });

    test("it shares the products, the link and the platforms", () => {
      const t = build();
      assert.deepEqual(t.products, reel().products);
      assert.equal(t.link, reel().link);
      assert.deepEqual(t.platforms, reel().platforms);
    });

    test("it does NOT copy the reel's caption — nothing can show a story's", () => {
      const t = build();
      assert.equal(t.caption, "Black mesh daypack.");
      assert.notEqual(t.caption, reel().caption);
      // "not-needed", not "fallback": fallback means the model failed, and
      // nothing failed here — the twin was never going to ask for one.
      assert.equal(t.captionSource, "not-needed");
      assert.equal("captionNote" in t, false);
    });

    test("it never inherits artwork — a reel has no second render", () => {
      const t = build(reel({ artwork: { story: { url: "s" }, feed: { url: "f" } } }));
      assert.equal("artwork" in t, false);
    });

    test("a twin is never itself twinned", () => {
      assert.equal("twinId" in build(reel({ twinId: "SOMETHING" })), false);
    });

    test("a field nobody thought of is inherited, not dropped", () => {
      // The inherit-by-default contract: adding a field to a post record must
      // not silently leave the twin without it.
      assert.equal(build(reel({ signalSource: "tills" })).signalSource, "tills");
    });

    test("it refuses to build without both ids", () => {
      assert.throws(() => buildStoryTwin(reel(), { twinId: "T1" }), /both ids/);
      assert.throws(() => buildStoryTwin(reel(), { reelId: "R1" }), /both ids/);
      assert.throws(() => buildStoryTwin(null, { twinId: "T1", reelId: "R1" }), /no reel record/);
    });
  });

  describe("it is written with the reel, atomically", () => {
    test("one update map, and neither path is an ancestor of the other", () => {
      // RTDB REJECTS an update containing both a path and a descendant of it.
      const r = reel();
      const u = twinWriteUpdates("social_posts", "R1", r, "T1", build(r));
      assert.deepEqual(Object.keys(u).sort(), ["social_posts/R1", "social_posts/T1"]);
      assert.equal(u["social_posts/R1"].twinId, "T1");
      assert.equal(u["social_posts/T1"].videoFrom, "R1");
      for (const a of Object.keys(u)) {
        for (const b of Object.keys(u)) {
          if (a !== b) assert.ok(!b.startsWith(`${a}/`), `${b} is under ${a}`);
        }
      }
    });

    test("the twin does not point at itself once the reel is stamped", () => {
      const r = reel();
      const u = twinWriteUpdates("social_posts", "R1", r, "T1", build(r));
      assert.equal("twinId" in u["social_posts/T1"], false);
    });
  });
});
