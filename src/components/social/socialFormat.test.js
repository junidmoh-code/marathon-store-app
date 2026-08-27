// ── FORMAT: WHERE A POST GOES, NOT WHAT IS IN IT ─────────────────────────────
// `kind` says what a post is ABOUT — an outfit, a pairing, a single product.
// `format` says WHERE it lands, which decides its canvas, its media type and
// whether it needs a video at all.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { FORMATS, DEFAULT_FORMAT, formatOf, needsVideo, STORY_ALSO_POSTS_TO_FEED } from "./socialCore.js";
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
    // "ensureReelVideo" is the import at the top of the file, which is of
    // course before the claim and makes this pass or fail for the wrong reason.
    const claimAt = src.indexOf("if (!(await claim(post.id)))");
    const encodeAt = src.indexOf("await ensureReelVideo(");
    expect(claimAt).toBeGreaterThan(-1);
    expect(encodeAt).toBeGreaterThan(claimAt);
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
    expect(core).not.toMatch(/buildFeedTwin|twinWriteUpdates/);
  });
});
