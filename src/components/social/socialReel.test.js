// ── A REEL IS ffmpeg, LOCALLY, FREE ──────────────────────────────────────────
// Owner's rule: "Turning a product photo into a video means ffmpeg, locally,
// free... Do NOT use Higgsfield or any AI video service for this. If you find
// yourself reaching for it, you have misread the requirement."
//
// The encode itself needs a binary, so what is asserted here is everything that
// can be decided without one: the argument list, the filter chain, and the
// properties that make Instagram accept the file. The real encode was verified
// on the Mac mini — 1080x1920, h264 high, yuv420p, color_range tv, 15.000s,
// 450 frames, aac, 2.9 MB, 5.1 seconds to encode.
import { describe, it, expect } from "vitest";
import {
  motionFilterComplex, ffmpegArgs, reelPhases, reelDuration,
  REEL_W, REEL_H, REEL_SECONDS, REEL_FPS, REEL_ZOOM, REEL_KEYFRAMES,
} from "../../../scripts/social/reel.mjs";

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
    expect(motionFilterComplex()).toContain(`s=${REEL_W}x${REEL_H}`);
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
    expect(motionFilterComplex()).toContain("out_range=tv");
    expect(argStr).toContain("-color_range tv");
  });

  it("puts the moov atom first so Meta can start reading immediately", () => {
    expect(argStr).toContain("+faststart");
  });
});

describe("the still is fitted, never stretched", () => {
  it("scales with force_original_aspect_ratio and pads the remainder", () => {
    const f = motionFilterComplex();
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).toMatch(/pad=1080:1920/);
  });
  it("never asks ffmpeg to distort", () => {
    // A bare scale=W:H with no aspect flag is the squash.
    expect(motionFilterComplex()).not.toMatch(/scale=1080:1920(?!:force)/);
  });
});

describe("the move is a drift, not an effect", () => {
  it("never zooms past a sane depth", () => {
    expect(REEL_ZOOM).toBeGreaterThan(1);
    expect(REEL_ZOOM).toBeLessThanOrEqual(1.15);
  });
  it("upscales before panning, because zoompan judders on a still otherwise", () => {
    expect(motionFilterComplex()).toContain(`scale=${REEL_W * 4}:${REEL_H * 4}`);
  });
  it("upscales ONCE, before the split, not per branch", () => {
    // Four branches sharing one 4x scale rather than paying for it four times.
    const f = motionFilterComplex();
    expect(f.split(`scale=${REEL_W * 4}:${REEL_H * 4}`).length - 1).toBe(1);
  });
});

// ── LENGTH ───────────────────────────────────────────────────────────────────
// Six seconds was a GIF, not a reel: watch time is the signal Instagram reads
// and six seconds accumulates almost none. Fifteen is the floor of the 15–30s
// band and 2.5x what it was. It is not longer because the source is ONE
// photograph — the 45–60s bracket that wins in the published studies is
// content with cuts and speech in it, and a minute of slow pan on a still gets
// abandoned, which is the completion signal those studies are really measuring.
describe("length", () => {
  it("is 15 seconds, and the keyframes agree with the constant", () => {
    expect(REEL_SECONDS).toBe(15);
    expect(reelDuration()).toBe(REEL_SECONDS);
  });

  it("is long enough to accumulate watch time and short enough to finish", () => {
    expect(REEL_SECONDS).toBeGreaterThanOrEqual(12);
    expect(REEL_SECONDS).toBeLessThanOrEqual(30);
  });

  it("the phases add up to exactly the duration, to the frame", () => {
    const frames = reelPhases().reduce((n, p) => n + p.frames, 0);
    expect(frames).toBe(REEL_SECONDS * REEL_FPS);
  });

  it("-t matches what the keyframes describe", () => {
    expect(ffmpegArgs("/in.jpg", "/out.mp4")).toContain(String(reelDuration()));
  });
});

// ── FOUR MOVES, NOT ONE ──────────────────────────────────────────────────────
// A single slow zoom is fine over six seconds and becomes wallpaper over
// fifteen: the eye stops registering a constant rate of change, which is
// exactly when someone scrolls.
describe("there is more than one camera move", () => {
  it("has a branch per phase and concatenates them", () => {
    const phases = reelPhases();
    expect(phases.length).toBeGreaterThanOrEqual(3);
    const f = motionFilterComplex();
    expect(f.split("zoompan=").length - 1).toBe(phases.length);
    expect(f).toContain(`concat=n=${phases.length}:v=1:a=0`);
    expect(f).toContain(`split=${phases.length}`);
  });

  it("the phases are not all the same move", () => {
    // The whole point. If every phase had the same start and end, this would
    // be the old single creep wearing four hats.
    const kinds = new Set(reelPhases().map((p) =>
      `${(p.to.zoom - p.from.zoom).toFixed(3)}|${(p.to.x - p.from.x).toFixed(3)}|${(p.to.y - p.from.y).toFixed(3)}`));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it("at least one phase pushes in and at least one pulls back — properly", () => {
    // The thresholds are not decorative. At ±0.02 the mutation proof could
    // delete the whole pull-back and survive on the 0.03 nudge at the end,
    // which on screen is not a move at all. A real push and a real release.
    const d = reelPhases().map((p) => p.to.zoom - p.from.zoom);
    expect(Math.max(...d), "no phase pushes in").toBeGreaterThan(0.06);
    expect(Math.min(...d), "no phase pulls back").toBeLessThan(-0.06);
  });

  it("comes back out to near the full frame after the deepest push", () => {
    // The shape is push in / drift / RELEASE / settle. Without the release it
    // is fifteen seconds of the same crop, which is the thing being fixed.
    const zooms = REEL_KEYFRAMES.map((k) => k.zoom);
    const peak = zooms.indexOf(Math.max(...zooms));
    expect(Math.min(...zooms.slice(peak)), "never returns near the full frame").toBeLessThanOrEqual(1.05);
  });

  it("at least one phase actually moves sideways or up", () => {
    expect(reelPhases().some((p) => Math.abs(p.to.x - p.from.x) > 0.005 || Math.abs(p.to.y - p.from.y) > 0.005)).toBe(true);
  });

  // ── NO DEAD PHASES ─────────────────────────────────────────────────────────
  // The mutation proof found this hole: three separate breakages all survived
  // because every one of them produced a phase in which NOTHING moves — a
  // three-and-a-half second freeze in the middle of the reel. Freezes are the
  // exact failure this change exists to remove, and the old tests were happy
  // as long as the OTHER phases differed from each other.
  it("EVERY phase moves — a frozen phase is the wallpaper this replaced", () => {
    for (const [i, p] of reelPhases().entries()) {
      const moved = Math.abs(p.to.zoom - p.from.zoom) > 0.005
        || Math.abs(p.to.x - p.from.x) > 0.005
        || Math.abs(p.to.y - p.from.y) > 0.005;
      expect(moved, `phase ${i} (${p.seconds}s) does not move at all`).toBe(true);
    }
  });

  it("has four moves, one per gap between keyframes", () => {
    expect(REEL_KEYFRAMES.length).toBe(5);
    expect(reelPhases().length).toBe(REEL_KEYFRAMES.length - 1);
    expect(reelPhases().length).toBeGreaterThanOrEqual(4);
  });

  it("no single move is allowed to dominate the reel", () => {
    // A phase covering half the runtime is a slow creep wearing a costume.
    for (const p of reelPhases()) {
      expect(p.seconds, `a ${p.seconds}s phase in a ${REEL_SECONDS}s reel`).toBeLessThanOrEqual(REEL_SECONDS * 0.4);
    }
  });
});

// ── CONTINUITY ───────────────────────────────────────────────────────────────
// A jump between phases reads as a glitch, and it is silent: the file encodes
// fine and just looks broken. Keyframes make it structurally impossible —
// each phase ends where the next begins because they share the keyframe — and
// this asserts the model has not been quietly replaced by per-phase deltas.
describe("no phase jumps", () => {
  it("every phase begins exactly where the previous one ended", () => {
    const phases = reelPhases();
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].from).toBe(phases[i - 1].to);   // the SAME keyframe object
    }
  });

  it("the motion is driven by the frame counter, never by the previous frame", () => {
    // z='min(zoom+step,max)' accumulates and cannot be made to arrive at an
    // exact value on an exact frame — four moves that have to meet cannot be
    // built on it.
    const f = motionFilterComplex();
    expect(f).not.toMatch(/z='min\(zoom\+/);
    expect(f).toMatch(/z='[\d.]+(\+\(-?[\d.]+\)\*on\/\d+)?'/);
  });

  it("starts at the full frame — the first thing seen is the whole picture", () => {
    expect(REEL_KEYFRAMES[0].zoom).toBe(1);
    expect(REEL_KEYFRAMES[0].x).toBe(0);
    expect(REEL_KEYFRAMES[0].y).toBe(0);
  });

  it("never zooms below 1, which would show the padding", () => {
    for (const k of REEL_KEYFRAMES) expect(k.zoom).toBeGreaterThanOrEqual(1);
  });
});

// ── THE MOVE MUST NOT CROP THE BRANDING ──────────────────────────────────────
// social-design.cjs reserves safeTop 250px and safeBottom 320px on a reel and
// draws the wordmark and the shop line there. A zoom of Z crops h*(1-1/Z)/2
// from each edge and a y offset crops h*|y| more from one of them. A reel that
// crops its own branding is worse than a reel that moves less.
describe("the move stays inside the design's safe area", () => {
  const SAFE_TOP = 250, SAFE_BOTTOM = 320, SAFE_SIDE = 40;

  it("no keyframe eats into the top or bottom safe margin", () => {
    for (const k of REEL_KEYFRAMES) {
      const edge = (REEL_H * (1 - 1 / k.zoom)) / 2;
      const top = edge + Math.max(0, k.y) * REEL_H;
      const bottom = edge + Math.max(0, -k.y) * REEL_H;
      expect(top, `top at zoom ${k.zoom} y ${k.y}`).toBeLessThan(SAFE_TOP);
      expect(bottom, `bottom at zoom ${k.zoom} y ${k.y}`).toBeLessThan(SAFE_BOTTOM);
    }
  });

  it("no keyframe crops more off a side than the layout leaves there", () => {
    for (const k of REEL_KEYFRAMES) {
      const edge = (REEL_W * (1 - 1 / k.zoom)) / 2;
      expect(edge + Math.abs(k.x) * REEL_W, `side at zoom ${k.zoom} x ${k.x}`).toBeLessThan(SAFE_TOP - SAFE_SIDE);
    }
  });
});

// ── THE INPUT IS ONE FRAME ───────────────────────────────────────────────────
describe("the still is fed as a single frame", () => {
  it("does not loop the input", () => {
    // zoompan emits `d` frames PER INPUT FRAME. With -loop 1 every branch
    // would re-emit its whole phase for every frame handed to it.
    expect(ffmpegArgs("/in.jpg", "/out.mp4")).not.toContain("-loop");
  });

  it("maps the built video and the silent audio explicitly", () => {
    const a = ffmpegArgs("/in.jpg", "/out.mp4");
    expect(a).toContain("-filter_complex");
    expect(a.join(" ")).toContain("-map [v]");
    expect(a.join(" ")).toContain("-map 1:a");
  });
});
