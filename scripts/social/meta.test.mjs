// ── META PUBLISHING — THE PURE PARTS ─────────────────────────────────────────
// Runs in the main vitest suite, like every other scripts/ test in this repo.
//
// isRetryable had no test, and that is exactly where a live bug was hiding:
// Meta's throttling arrives as HTTP 400 with a code, not as 429, so a throttled
// evening was classed permanent and parked the week's post after one attempt.
import { describe, it, expect, afterEach } from "vitest";
import {
  GRAPH_VERSION, CONTAINER_MAX_WAIT_MS, REQUEST_TIMEOUT_MS,
  isVideo, igContainerPayload, fbStoryEndpoint, igCarouselPayload, metaError, isRetryable, waitForContainer,
  fbStoryResultId, fbStoryPermalink, STORY_PERMALINK_ATTEMPTS,
} from "./meta.mjs";

describe("isRetryable — Meta's throttling is an HTTP 400", () => {
  // The real codes, from Meta's error reference. Every one of these arrives
  // with HTTP 400 and none of them matches a "rate limit" keyword search.
  for (const [code, what] of [[4, "Application request limit"], [17, "User request limit"], [32, "Page request limit"], [613, "calls exceeded the rate limit"]]) {
    it(`code ${code} (${what}) is retryable despite the 400`, () => {
      expect(isRetryable(400, "some opaque message", code)).toBe(true);
    });
  }

  it("token failures are permanent — retrying cannot re-mint a token", () => {
    for (const code of [190, 200, 10, 803]) {
      expect(isRetryable(400, "Invalid OAuth access token", code), `code ${code}`).toBe(false);
    }
  });

  it("5xx and 429 are retryable with no code at all", () => {
    expect(isRetryable(500, "server error")).toBe(true);
    expect(isRetryable(503, "unavailable")).toBe(true);
    expect(isRetryable(429, "too many")).toBe(true);
  });

  it("a genuine content rejection is permanent", () => {
    // "that image is the wrong aspect ratio" will fail identically forever.
    expect(isRetryable(400, "Unsupported post request", 100)).toBe(false);
    expect(isRetryable(400, "The image is too large")).toBe(false);
  });

  it("a permanent code beats a retryable-sounding message", () => {
    expect(isRetryable(400, "please try again later", 190)).toBe(false);
  });

  it("the keyword fallback still catches an uncoded transient", () => {
    for (const m of ["Rate limit exceeded", "Please reduce the amount of data", "temporarily unavailable", "Unknown error"]) {
      expect(isRetryable(400, m), m).toBe(true);
    }
  });

  it("the [190] marker in a formatted message is honoured", () => {
    expect(isRetryable(400, "Error validating access token [190/460]")).toBe(false);
  });
});

describe("metaError", () => {
  it("surfaces message, user title and codes rather than a bare status", () => {
    const body = JSON.stringify({ error: { message: "Invalid parameter", error_user_title: "Aspect ratio", error_user_msg: "must be between 4:5 and 1.91:1", code: 100, error_subcode: 2207009 } });
    const out = metaError(400, body);
    expect(out).toMatch(/Invalid parameter/);
    expect(out).toMatch(/Aspect ratio/);
    expect(out).toMatch(/must be between/);
    expect(out).toMatch(/100\/2207009/);
  });
  it("falls back to the raw body when it is not Meta JSON", () => {
    expect(metaError(502, "<html>bad gateway</html>")).toMatch(/HTTP 502/);
  });
  it("does not throw on an empty or odd body", () => {
    for (const b of ["", null, undefined, "{}", "{\"error\":null}"]) {
      expect(() => metaError(400, b)).not.toThrow();
    }
  });
});

describe("container payloads", () => {
  it("a photo carries image_url, a video carries REELS + video_url", () => {
    expect(igContainerPayload({ url: "https://x/a.jpg", type: "image" }, { caption: "hi" }))
      .toEqual({ image_url: "https://x/a.jpg", caption: "hi" });
    const v = igContainerPayload({ url: "https://x/a.mp4", type: "video" }, { caption: "hi" });
    expect(v.media_type).toBe("REELS");
    expect(v.video_url).toBe("https://x/a.mp4");
  });

  it("a carousel CHILD never carries a caption — Meta rejects it", () => {
    const child = igContainerPayload({ url: "https://x/a.jpg", type: "image" }, { caption: "hi", carouselChild: true });
    expect(child.is_carousel_item).toBe("true");
    expect(child.caption).toBe(undefined);
  });

  it("video is decided by the record's type, never by the URL", () => {
    // A generated .jpg URL with type video, and a .mp4 URL with type image:
    // the record wins both ways round.
    expect(isVideo({ url: "https://x/a.jpg", type: "video" })).toBe(true);
    expect(isVideo({ url: "https://x/a.mp4", type: "image" })).toBe(false);
  });

  it("a carousel refuses fewer than 2 and more than 10", () => {
    expect(() => igCarouselPayload(["a"], "c")).toThrow(/at least 2/);
    expect(() => igCarouselPayload([], "c")).toThrow(/at least 2/);
    expect(() => igCarouselPayload(null, "c")).toThrow(/at least 2/);
    expect(() => igCarouselPayload(Array(11).fill("a"), "c")).toThrow(/at most 10/);
    expect(() => igCarouselPayload(["a", "b"], "c")).not.toThrow();
  });
});

describe("waitForContainer", () => {
  // A fake graph is not reachable from outside the module, so these exercise
  // the bounded-wait contract through the exported function using a token that
  // never resolves would need network. Instead the CONSTANTS are pinned: the
  // loop is bounded by a deadline, and there is a per-request timeout so a
  // hung socket cannot hold the launchd job open indefinitely.
  it("the wait is bounded, and so is each individual request", () => {
    expect(CONTAINER_MAX_WAIT_MS > 0 && CONTAINER_MAX_WAIT_MS <= 10 * 60 * 1000).toBeTruthy();
    expect(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 120000).toBeTruthy();
    expect(typeof waitForContainer).toBe("function");
  });
});

describe("the API version is pinned", () => {
  it("never 'latest' — Meta deprecates on a schedule", () => {
    expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
  });
});

// ── STORIES ARE A DIFFERENT MEDIA TYPE, NOT A DIFFERENT SHAPE ────────────────
// A story is media_type=STORIES whether it carries a photo or a video. It is
// not "a feed post that happens to be 9:16", and getting that wrong publishes
// a 1080x1920 image to the feed where Instagram crops it.
describe("story containers", () => {
  const img = { type: "image", url: "https://example.test/i.jpg" };
  const vid = { type: "video", url: "https://example.test/v.mp4" };

  it("a photo story is STORIES with an image_url", () => {
    expect(igContainerPayload(img, { format: "story" }))
      .toEqual({ media_type: "STORIES", image_url: img.url });
  });

  it("a video story is STORIES with a video_url — not REELS", () => {
    const p = igContainerPayload(vid, { format: "story" });
    expect(p.media_type).toBe("STORIES");
    expect(p.video_url).toBe(vid.url);
  });

  it("carries NO caption, and drops one that was passed", () => {
    // Meta ignores the field on a story. Left to be "ignored", a caption that
    // was written, reviewed and approved vanishes silently — so it is dropped
    // here, visibly, where a test can hold it.
    for (const item of [img, vid]) {
      expect(igContainerPayload(item, { format: "story", caption: "a real caption" }).caption)
        .toBeUndefined();
    }
  });

  it("leaves the feed and reel payloads exactly as they were", () => {
    expect(igContainerPayload(img, { caption: "hi" })).toEqual({ image_url: img.url, caption: "hi" });
    const reel = igContainerPayload(vid, { caption: "hi" });
    expect(reel.media_type).toBe("REELS");
    expect(reel.video_url).toBe(vid.url);
    expect(reel.caption).toBe("hi");
  });

  it("a story is never a carousel child", () => {
    const p = igContainerPayload(img, { format: "story", carouselChild: true });
    expect(p.is_carousel_item).toBeUndefined();
  });
});

describe("Facebook stories use their own endpoints, not the Page feed", () => {
  it("a photo story goes to photo_stories", () => {
    expect(fbStoryEndpoint({ type: "image", url: "x" })).toBe("photo_stories");
  });
  it("a video story goes to video_stories", () => {
    expect(fbStoryEndpoint({ type: "video", url: "x" })).toBe("video_stories");
  });
});

// ── THE SHAPE THAT MADE FACEBOOK STORIES LOOK LIKE FEED POSTS ────────────────
// Facebook's story endpoints answer { success, post_id }; every other endpoint
// in this file answers { id }. Reading `.id` off a story response silently
// yields undefined — a published story recorded as having no id, which is
// indistinguishable from a broken one. Verified live 2026-08-27.
describe("fbStoryResultId — a story response is not shaped like anything else", () => {
  it("reads post_id, which is the only key a story response carries", () => {
    expect(fbStoryResultId({ success: true, post_id: "3024988904507445" })).toBe("3024988904507445");
  });

  it("still accepts a bare id, so a future response shape does not break it", () => {
    expect(fbStoryResultId({ id: "123" })).toBe("123");
  });

  it("prefers post_id when Meta sends both", () => {
    expect(fbStoryResultId({ id: "wrong", post_id: "right" })).toBe("right");
  });

  it("always returns a string — a numeric id must not become a number", () => {
    // post ids exceed Number.MAX_SAFE_INTEGER territory in shape if not in
    // value; storing one as a number is how ids start losing digits.
    expect(fbStoryResultId({ success: true, post_id: 3024988904507445 })).toBe("3024988904507445");
  });

  it("REFUSES a response with no id rather than storing undefined", () => {
    // This is the whole point of the function. A success with no usable id is
    // a state we cannot record honestly, so it must be an error, not a post
    // whose Facebook id is the string "undefined".
    for (const bad of [{ success: true }, {}, null, undefined, { post_id: "" }, { post_id: null }]) {
      expect(() => fbStoryResultId(bad), JSON.stringify(bad)).toThrow(/no post id/i);
    }
  });
});

describe("publishFacebookStory is wired up — the skip is gone", () => {
  it("the publisher no longer refuses Facebook stories", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
    // The old guard threw a notConnected error for every story. If this string
    // ever comes back, Facebook has silently stopped getting stories again.
    expect(src).not.toMatch(/Facebook stories are not wired up yet/);
    expect(src).toMatch(/publishFacebookStory\(/);
  });

  it("a story is never sent to the Page feed path", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
    // sendFacebook must return from the story branch BEFORE it reaches
    // publishFacebook — the feed call must come after the story call in the
    // function body, with a return in between.
    const fn = src.slice(src.indexOf("async function sendFacebook"), src.indexOf("async function sendTikTok"));
    const story = fn.indexOf("publishFacebookStory(");
    const feed = fn.indexOf("publishFacebook({");
    expect(story).toBeGreaterThan(-1);
    expect(feed).toBeGreaterThan(story);
    expect(fn.slice(story, feed)).toMatch(/return/);
  });
});

describe("a Facebook story carries no caption", () => {
  it("sendFacebook does not build a caption on the story path", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function sendFacebook"), src.indexOf("async function sendTikTok"));
    const story = fn.indexOf("publishFacebookStory(");
    // captionFor must be called only AFTER the story branch has returned.
    expect(fn.slice(0, story)).not.toMatch(/captionFor\(/);
  });
});

// ── THE PERMALINK RACE THAT ONLY VIDEO STORIES LOSE ─────────────────────────
// Measured live 2026-08-27: a photo story was in GET /{page}/stories
// immediately; a video story published in the same minute was NOT on the first
// read and WAS moments later. One attempt would have recorded every video
// story with a null permalink — indistinguishable from a story that failed.
describe("fbStoryPermalink retries, and still never throws", () => {
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const listing = (postId) => ({ data: [{ post_id: postId, url: `https://facebook.com/stories/x/${postId}/`, status: "published" }] });

  // The real fetch is put back after every test in here — a leaked stub turns
  // an unrelated failure in another file into a mystery.
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("returns the url on the first read when it is already there", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return ok(listing("123")); };
    const url = await fbStoryPermalink({
      pageId: "P", token: "t", postId: "123",
      sleep: async () => { throw new Error("must not sleep when the first read works"); },
    });
    expect(url).toBe("https://facebook.com/stories/x/123/");
    expect(calls).toBe(1);
  });

  it("keeps reading until the story shows up — the video case", async () => {
    let n = 0;
    globalThis.fetch = async () => { n++; return ok(n < 3 ? { data: [] } : listing("456")); };
    const slept = [];
    const url = await fbStoryPermalink({ pageId: "P", token: "t", postId: "456", sleep: async (ms) => { slept.push(ms); } });
    expect(url).toBe("https://facebook.com/stories/x/456/");
    expect(n).toBe(3);
    expect(slept.length).toBe(2);   // it waited between reads, it did not spin
  });

  it("gives up after a bounded number of attempts and returns null", async () => {
    let n = 0;
    globalThis.fetch = async () => { n++; return ok({ data: [] }); };
    const url = await fbStoryPermalink({ pageId: "P", token: "t", postId: "789", sleep: async () => {} });
    expect(url).toBe(null);
    expect(n).toBe(STORY_PERMALINK_ATTEMPTS);
  });

  it("never returns ANOTHER story's url", async () => {
    // The listing is newest-first, so "take the first row" would hand back
    // whatever was posted most recently — including something posted by hand
    // from the Facebook app seconds earlier.
    globalThis.fetch = async () => ok({ data: [
      { post_id: "999", url: "https://facebook.com/stories/x/999/", status: "published" },
      { post_id: "111", url: "https://facebook.com/stories/x/111/", status: "published" },
    ] });
    expect(await fbStoryPermalink({ pageId: "P", token: "t", postId: "111", sleep: async () => {} }))
      .toBe("https://facebook.com/stories/x/111/");
  });
});
