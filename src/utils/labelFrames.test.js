// ─── THREE-FRAME AGREEMENT — single-frame noise dies here, proven ────────────
import { describe, it, expect } from "vitest";
import { mergeFrameTokens } from "./labelFrames";

describe("tokens must appear in at least two of three frames", () => {
  it("a token seen in only ONE frame is dropped", () => {
    const out = mergeFrameTokens([
      ["CLOUDNOVA", "MONO", "WHITE", "GLARE1"],
      ["CLOUDNOVA", "MONO", "WHITE"],
      ["CLOUDNOVA", "MONO", "WHITE", "SMUDGE"],
    ]);
    expect(out).toEqual(["CLOUDNOVA", "MONO", "WHITE"]);
  });

  it("a token seen in two frames survives a third frame that missed it", () => {
    const out = mergeFrameTokens([
      ["CLOUDNOVA", "MONO"],
      ["CLOUDNOVA", "MONO", "UNDYED"],
      ["CLOUDNOVA", "UNDYED"],
    ]);
    expect(out).toEqual(["CLOUDNOVA", "MONO", "UNDYED"]);
  });

  it("one usable frame passes through unchanged — degraded, never a dead end", () => {
    expect(mergeFrameTokens([["CLOUDNOVA", "MONO"]])).toEqual(["CLOUDNOVA", "MONO"]);
    expect(mergeFrameTokens([["CLOUDNOVA", "MONO"], [], []])).toEqual(["CLOUDNOVA", "MONO"]);
  });

  it("padding and whitespace-only tokens are normalised before agreement (review pin)", () => {
    const out = mergeFrameTokens([
      [" MONO ", "CLOUDNOVA", "  "],
      ["MONO", " CLOUDNOVA"],
    ]);
    expect(out).toEqual(["CLOUDNOVA", "MONO"]);
  });

  it("empty input is empty output", () => {
    expect(mergeFrameTokens([])).toEqual([]);
    expect(mergeFrameTokens([[], []])).toEqual([]);
  });
});
