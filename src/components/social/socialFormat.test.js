// ── FORMAT: WHERE A POST GOES, NOT WHAT IS IN IT ─────────────────────────────
// `kind` says what a post is ABOUT — an outfit, a pairing, a single product.
// `format` says WHERE it lands, which decides its canvas, its media type and
// whether it needs a video at all.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { FORMATS, DEFAULT_FORMAT, formatOf, needsVideo, videoSourceOf, mediaForSurface, STORY_ALSO_POSTS_TO_FEED, REEL_ALSO_POSTS_TO_STORY } from "./socialCore.js";
import { hasVideo, stillOf } from "../../../scripts/social/reel-media.mjs";

const require = createRequire(import.meta.url);
const D = require("../../../functions/lib/social-design.cjs");

describe("the format vocabulary", () => {
  it("is feed, story and reel", () => {
    expect(FORMATS).toEqual(["feed", "story", "reel"]);
  });

  it("a post written before format existed still reads as a feed post", () => {
    // Every post already in the queue predates this field.
    expect(formatOf({})).toBe("feed");
    expect(formatOf({ format: undefined })).toBe(DEFAULT_FORMAT);
  });

  it("an unrecognised format falls back rather than throwing", () => {
    expect(formatOf({ format: "tiktok-live" })).toBe("feed");
    expect(formatOf(null)).toBe("feed");
  });

  it("ONLY a reel needs a video", () => {
    // A feed post and a story both accept a still. Encoding one for them would
    // spend CPU and bandwidth on a slideshow of a single frame.
    expect(needsVideo({ format: "reel" })).toBe(true);
    expect(needsVideo({ format: "story" })).toBe(false);
    expect(needsVideo({ format: "feed" })).toBe(false);
    expect(needsVideo({})).toBe(false);
  });

  it("each format has a canvas, and the two vertical ones match", () => {
    for (const f of FORMATS) expect(D.canvasFor(f)).toBeTruthy();
    expect(D.canvasFor("story").h).toBe(D.canvasFor("reel").h);
    expect(D.canvasFor("feed").h).not.toBe(D.canvasFor("story").h);
  });
});

describe("a reel's video is made once and reused", () => {
  const still = { type: "image", url: "https://example.test/still.jpg" };
  const video = { type: "video", url: "https://example.test/reel.mp4" };

  it("knows when a post already has a usable video", () => {
    expect(hasVideo({ media: [video] })).toBe(true);
    expect(hasVideo({ media: [still] })).toBe(false);
    expect(hasVideo({ media: [{ type: "video" }] })).toBe(false);   // no url
    expect(hasVideo({})).toBe(false);
  });

  it("finds the still a reel is built from", () => {
    expect(stillOf({ media: [still, video] })).toBe(still);
    expect(stillOf({ media: [video] })).toBeNull();
    expect(stillOf({})).toBeNull();
  });
});

describe("the publisher's contract with formats", () => {
  const src = require("node:fs").readFileSync(
    new URL("../../../scripts/social/publish.mjs", import.meta.url), "utf8");

  it("encodes a reel INSIDE the claim, so two ticks cannot race", () => {
    // Anchored on the CALL, not the identifier: the first occurrence of
    // "resolveVideoFor" is its own declaration above main(), which is of
    // course before the claim and would make this pass or fail for the wrong
    // reason.
    //
    // resolveVideoFor, not ensureReelVideo: the encode now lives behind that
    // one helper, because a reel and its story twin must share ONE file and
    // that decision needs a single place. The property being protected is
    // unchanged — nothing encodes until the post is claimed — so the test
    // follows the call rather than the name.
    const claimAt = src.indexOf("if (!(await claim(post.id)))");
    const resolveAt = src.indexOf("await resolveVideoFor(item)");
    expect(claimAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(claimAt);
  });

  it("there is exactly ONE encode call site, and it is inside that helper", () => {
    // Two call sites is how a reel and its twin end up with two files. The
    // import line is excluded by anchoring on the call.
    const calls = src.match(/await ensureReelVideo\(/g) || [];
    expect(calls.length).toBe(1);
    const helperAt = src.indexOf("async function resolveVideoFor(");
    const mainAt = src.indexOf("async function main()");
    const encodeAt = src.indexOf("await ensureReelVideo(");
    expect(helperAt).toBeGreaterThan(-1);
    expect(encodeAt).toBeGreaterThan(helperAt);
    expect(encodeAt).toBeLessThan(mainAt);
  });

  it("a story twin's video is taken from the REEL's record, not re-encoded", () => {
    // The whole cost argument for two-reels-a-day rests on this: the mp4 is
    // stored on the post that owns it, and the twin reuses that file.
    expect(src).toMatch(/videoSourceOf\(item\)/);
    expect(src).toMatch(/POSTS\}\/\$\{r\.ownerId\}\/media/);
  });

  it("FAILS a reel that cannot be encoded — never falls back to the still", () => {
    // Publishing a 9:16 card to the feed because a reel would not encode puts
    // the wrong thing in the wrong place, quietly. Better a loud failure.
    const i = src.indexOf("reel video:");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toMatch(/status: "failed"/);
  });

  it("passes the post's format to Instagram", () => {
    expect(src).toMatch(/format: post\.format \|\| "feed"/);
  });
});

// ── THE FEED-TWIN FLAG IS IN TWO PLACES, SO IT IS PINNED ─────────────────────
// The decision is the backend's; socialCore.js only MIRRORS it so the Policy
// tab can describe the day honestly. A screen promising feed copies the
// backend is not making is worse than a screen that says nothing, and the two
// literals can only be kept together by something that fails when they part.
// Same guard the plist and SLOT_DAYS already live under.
describe("STORY_ALSO_POSTS_TO_FEED does not drift", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the browser's mirror matches the backend's default", () => {
    const fn = read("../../../functions/index.js");
    // The backend default is "on unless the env says false".
    const backend = /const STORY_ALSO_POSTS_TO_FEED = process\.env\.STORY_ALSO_POSTS_TO_FEED !== "false";/.test(fn);
    expect(backend, "functions/index.js must default the flag ON via env").toBe(true);
    expect(STORY_ALSO_POSTS_TO_FEED).toBe(true);
  });

  it("the backend flag is an ENV switch, never a bare literal", () => {
    // It shipped as `= true` in the first draft, which documented an off
    // switch that did not exist.
    const fn = read("../../../functions/index.js");
    expect(fn).not.toMatch(/const STORY_ALSO_POSTS_TO_FEED = true;/);
    expect(fn).toMatch(/process\.env\.STORY_ALSO_POSTS_TO_FEED/);
  });

  it("the browser never creates a twin — it only describes one", () => {
    const core = read("./socialCore.js");
    expect(core).not.toMatch(/buildFeedTwin|buildStoryTwin|twinWriteUpdates/);
  });
});

// ── THE SAME DRIFT GUARD, FOR THE REEL'S STORY TWIN ──────────────────────────
// Two reels a day, each also a story from the same encoded file. The Policy
// tab reads the mirror to say so; if the backend stops making story twins and
// the mirror does not follow, the screen promises stories nobody is posting.
describe("REEL_ALSO_POSTS_TO_STORY does not drift", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the mirror and the backend flag agree", () => {
    const fn = read("../../../functions/index.js");
    const backend = /const REEL_ALSO_POSTS_TO_STORY = process\.env\.REEL_ALSO_POSTS_TO_STORY !== "false";/.test(fn);
    expect(backend).toBe(true);           // the backend default is ON
    expect(REEL_ALSO_POSTS_TO_STORY).toBe(true);
  });

  it("the backend flag is still an ENV switch, not a hardcoded literal", () => {
    // The off switch documented in SOCIAL-SETUP must exist. A bare `true`
    // would document a switch that does nothing.
    const fn = read("../../../functions/index.js");
    expect(fn).not.toMatch(/const REEL_ALSO_POSTS_TO_STORY = true;/);
    expect(fn).toMatch(/process\.env\.REEL_ALSO_POSTS_TO_STORY/);
  });
});

// ── A STORY TWIN GOES OUT AS THE REEL'S VIDEO, NOT AS A STILL ────────────────
// needsVideo used to be "is this a reel", full stop. A reel's story twin is
// NOT a reel and would have been sent as its cover image — a still where a
// video was promised, quietly, on a live account.
describe("videoSourceOf and the story twin", () => {
  it("an ordinary story is still a still", () => {
    expect(needsVideo({ format: "story" })).toBe(false);
    expect(videoSourceOf({ format: "story" })).toBeNull();
  });

  it("a story that names a reel needs that reel's video", () => {
    const twin = { format: "story", videoFrom: "-Pabc123" };
    expect(videoSourceOf(twin)).toBe("-Pabc123");
    expect(needsVideo(twin)).toBe(true);
  });

  it("a reel needs a video whether or not it names a source", () => {
    expect(needsVideo({ format: "reel" })).toBe(true);
  });

  it("a videoFrom that is not a usable id is not a source", () => {
    // Anything but a non-empty string: a half-written record must fall back to
    // "this is an ordinary still", never to "encode something unnamed".
    for (const junk of ["", null, undefined, 0, 7, true, {}, []]) {
      expect(videoSourceOf({ format: "story", videoFrom: junk })).toBeNull();
      expect(needsVideo({ format: "story", videoFrom: junk })).toBe(false);
    }
  });

  it("a story twin's video is NOT swapped by mediaForSurface", () => {
    // mediaForSurface only ever swaps a single IMAGE for its sibling render.
    // A video must reach the platform untouched.
    const media = [{ type: "video", url: "https://s/reel.mp4" }];
    expect(mediaForSurface({ format: "story", media, videoFrom: "-Pabc123" })).toBe(media);
  });
});

// ── THE PUBLISHER SENDS THE RENDER MADE FOR THE SURFACE ──────────────────────
describe("mediaForSurface", () => {
  const STORY = "https://s/story.jpg", FEED = "https://s/feed.jpg";
  const artwork = { story: { url: STORY, width: 1080, height: 1920 }, feed: { url: FEED, width: 1080, height: 1350 } };

  it("a feed twin sends the 1080x1350 file", () => {
    expect(mediaForSurface({ format: "feed", media: [{ type: "image", url: FEED }], artwork })).toEqual([{ type: "image", url: FEED }]);
  });
  it("sends the feed file even if the twin's media still pointed at the story's", () => {
    expect(mediaForSurface({ format: "feed", media: [{ type: "image", url: STORY }], artwork })[0].url).toBe(FEED);
  });
  it("a story sends the 1080x1920 file", () => {
    expect(mediaForSurface({ format: "story", media: [{ type: "image", url: STORY }], artwork })[0].url).toBe(STORY);
  });
  it("a record written before artwork existed is sent exactly as it was", () => {
    const media = [{ type: "image", url: STORY }];
    expect(mediaForSurface({ format: "feed", media })).toBe(media);
  });
  it("a picture replaced by hand is sent as replaced, not swapped back", () => {
    const media = [{ type: "image", url: "https://s/replacement.jpg" }];
    expect(mediaForSurface({ format: "feed", media, artwork })).toBe(media);
    expect(mediaForSurface({ format: "story", media, artwork })).toBe(media);
  });
  it("never swaps a video or a carousel", () => {
    const video = [{ type: "video", url: "https://s/v.mp4" }];
    expect(mediaForSurface({ format: "reel", media: video, artwork: { reel: { url: FEED } } })).toBe(video);
    const carousel = [{ type: "image", url: "a" }, { type: "image", url: "b" }];
    expect(mediaForSurface({ format: "feed", media: carousel, artwork })).toBe(carousel);
  });
});
