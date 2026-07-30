// Ordering contract for the Source → Hub 2 refill queue once FOOTWEAR requests
// can reach it. Letters must be untouched (clothing is the queue's day job);
// numeric sizes must stop tying at 99 and render in real order.
import { describe, it, expect } from "vitest";

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i >= 0) return i;
  const n = Number.parseFloat(String(s).replace("_", "."));
  return Number.isFinite(n) ? 100 + n : 999;
};
const sorted = (a) => [...a].sort((x, y) => sizeRank(x) - sizeRank(y));

describe("Hub 2 queue size ordering", () => {
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

  it("an unrecognised size sorts last rather than first", () => {
    expect(sorted(["ONE_SIZE", "7"])).toEqual(["7", "ONE_SIZE"]);
  });
});
