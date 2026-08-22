// ── META PUBLISHING — THE PURE PARTS ─────────────────────────────────────────
// Runs in the main vitest suite, like every other scripts/ test in this repo.
//
// isRetryable had no test, and that is exactly where a live bug was hiding:
// Meta's throttling arrives as HTTP 400 with a code, not as 429, so a throttled
// evening was classed permanent and parked the week's post after one attempt.
import { describe, it, expect } from "vitest";
import {
  GRAPH_VERSION, CONTAINER_MAX_WAIT_MS, REQUEST_TIMEOUT_MS,
  isVideo, igContainerPayload, igCarouselPayload, metaError, isRetryable, waitForContainer,
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
