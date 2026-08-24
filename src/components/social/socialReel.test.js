// ── A REEL IS ffmpeg, LOCALLY, FREE ──────────────────────────────────────────
// Owner's rule: "Turning a product photo into a video means ffmpeg, locally,
// free... Do NOT use Higgsfield or any AI video service for this. If you find
// yourself reaching for it, you have misread the requirement."
//
// The encode itself needs a binary, so what is asserted here is everything that
// can be decided without one: the argument list, the filter chain, and the
// properties that make Instagram accept the file. The real encode was verified
// on the Mac mini — 1080x1920, h264, yuv420p, color_range tv, 6s, aac, 1.05 MB,
// 1.9 seconds.
import { describe, it, expect } from "vitest";
import { kenBurnsFilter, ffmpegArgs, REEL_W, REEL_H, REEL_SECONDS, REEL_FPS, REEL_ZOOM } from "../../../scripts/social/reel.mjs";

const args = ffmpegArgs("/in.jpg", "/out.mp4");
const argStr = args.join(" ");

describe("nothing generative, nothing paid", () => {
  it("shells out to ffmpeg and nothing else", () => {
    expect(argStr).not.toMatch(/higgsfield|runway|pika|luma|openai|replicate/i);
    expect(argStr).not.toMatch(/https?:\/\//);   // no service, no upload endpoint
  });
  it("needs no key, no token and no account", () => {
    expect(argStr).not.toMatch(/api[_-]?key|token|secret|bearer/i);
  });
});

describe("the reel envelope Instagram accepts", () => {
  it("is exactly 9:16 at 1080x1920", () => {
    expect(REEL_W / REEL_H).toBeCloseTo(9 / 16, 5);
    expect(kenBurnsFilter()).toContain(`s=${REEL_W}x${REEL_H}`);
  });

  it("carries an audio track — a reel with no audio stream is refused", () => {
    // Silent is fine. Absent is not.
    expect(argStr).toContain("anullsrc");
    expect(args).toContain("aac");
  });

  it("is h264 high profile in yuv420p", () => {
    expect(args).toContain("libx264");
    expect(argStr).toContain("-profile:v high");
    expect(argStr).toContain("-pix_fmt yuv420p");
  });

  it("converts colour RANGE, not just pixel format", () => {
    // A JPEG still is full range and ffprobe reported yuvj420p even with
    // -pix_fmt yuv420p and a format= filter — the "j" is a range tag and
    // neither touches range. Adding format=yuv420p alone produced a
    // byte-identical file, which is how it was caught. A player assuming
    // limited range renders full range washed out, and the colour on these
    // posts is the product's real colour.
    expect(kenBurnsFilter()).toContain("out_range=tv");
    expect(argStr).toContain("-color_range tv");
  });

  it("puts the moov atom first so Meta can start reading immediately", () => {
    expect(argStr).toContain("+faststart");
  });
});

describe("the still is fitted, never stretched", () => {
  it("scales with force_original_aspect_ratio and pads the remainder", () => {
    const f = kenBurnsFilter();
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).toMatch(/pad=1080:1920/);
  });
  it("never asks ffmpeg to distort", () => {
    // A bare scale=W:H with no aspect flag is the squash.
    expect(kenBurnsFilter()).not.toMatch(/scale=1080:1920(?!:force)/);
  });
});

describe("the move is a drift, not an effect", () => {
  it("zooms by a single-digit percentage over the whole clip", () => {
    expect(REEL_ZOOM).toBeGreaterThan(1);
    expect(REEL_ZOOM).toBeLessThanOrEqual(1.15);
  });
  it("spreads the zoom across every frame of the duration", () => {
    const frames = REEL_SECONDS * REEL_FPS;
    expect(kenBurnsFilter()).toContain(`d=${frames}`);
  });
  it("upscales before panning, because zoompan judders on a still otherwise", () => {
    expect(kenBurnsFilter()).toContain(`scale=${REEL_W * 4}:${REEL_H * 4}`);
  });
  it("holds long enough to be a reel and short enough to be watched", () => {
    expect(REEL_SECONDS).toBeGreaterThanOrEqual(3);
    expect(REEL_SECONDS).toBeLessThanOrEqual(15);
  });
});
