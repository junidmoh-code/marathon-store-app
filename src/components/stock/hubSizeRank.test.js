// Ordering contract for the hub refill queues, exercised against the REAL
// implementation — importing it rather than restating it is the whole point.
// The previous version of this suite reimplemented sizeRank, so every assertion
// could pass while Hub2RefillQueue behaved differently. (CodeRabbit #291.)
import { describe, it, expect } from "vitest";
import { sizeRank } from "./hubSizeRank.js";

const sorted = (a) => [...a].sort((x, y) => sizeRank(x) - sizeRank(y));

describe("hub queue size ordering", () => {
  it("clothing letter order is unchanged", () => {
    expect(sorted(["XL", "S", "XXXL", "M", "L"])).toEqual(["S", "M", "L", "XL", "XXXL"]);
  });

  it("shoe sizes sort numerically instead of tying at 99", () => {
    expect(sorted(["9", "6", "11", "7", "10"])).toEqual(["6", "7", "9", "10", "11"]);
  });

  it("the half size lands between 5 and 6", () => {
    expect(sorted(["6", "5_5", "5"])).toEqual(["5", "5_5", "6"]);
  });

  it("letters still sort before numbers on a mixed card", () => {
    expect(sorted(["8", "M"])).toEqual(["M", "8"]);
  });

  it("a PARTIALLY numeric token is not treated as a number", () => {
    // parseFloat alone accepts these and would interleave them with real sizes:
    // "7W" would rank as 7, landing between shoe sizes 6 and 8.
    expect(sizeRank("7W")).toBe(999);
    expect(sizeRank("5_5_extra")).toBe(999);
    expect(sizeRank("ONE_SIZE")).toBe(999);
    expect(sorted(["7W", "8"])).toEqual(["8", "7W"]);
  });

  it("null / undefined / empty never rank first", () => {
    for (const v of [null, undefined, ""]) expect(sizeRank(v)).toBe(999);
  });
});

describe("sizes 12 and 13 (run extension 2026-08-08)", () => {
  it("sort numerically after 11 — never lexically before 2", () => {
    expect(sorted(["2", "13", "11", "12", "3"])).toEqual(["2", "3", "11", "12", "13"]);
    expect(sizeRank("12")).toBeGreaterThan(sizeRank("11"));
    expect(sizeRank("13")).toBeGreaterThan(sizeRank("12"));
  });
});
