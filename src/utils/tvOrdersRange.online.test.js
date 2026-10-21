import { describe, it, expect } from "vitest";
import { keyInTvOnlineOrdersRange, keyInTvOrdersRange, tvRowsOf, TV_ONLINE_ORDER_KEY_RANGES } from "./tvOrdersRange";

describe("website orders reach the TV by their code — and nothing else does", () => {
  it.each(["KQZ", "AAA", "ZZZ", "QZZ", "QZZ-2", "ZZZ-1", "ZZZ-2-1", "RAA", "KQZ-2", "KQZ-2-1", "KQZ-2r1", "KQZ-1-b"])("%s is on the board", (k) => {
    expect(keyInTvOnlineOrdersRange(k)).toBe(true);
  });
  it.each(["R123-abc", "R9", "P001", "C001", "042", "KIZ", "KOZ", "KQ", "KQZA", "SHDW-1", ""])("%s is not a website order", (k) => {
    expect(keyInTvOnlineOrdersRange(k)).toBe(false);
  });
  it("every refill cart key (R + digits) falls BELOW the R… code range, server-side", () => {
    for (const k of ["R000-x", "R123-Thabo", "R999-zzz"]) {
      expect(TV_ONLINE_ORDER_KEY_RANGES.some(([a, b]) => k >= a && k <= b)).toBe(false);
    }
  });
  it("tvRowsOf keeps numeric customer orders and codes, drops carts and prefixed stores", () => {
    const rows = tvRowsOf({ "042": 1, KQZ: 2, "KQZ-1": 3, "R123-x": 4, P001: 5 });
    expect(Object.keys(rows).sort()).toEqual(["042", "KQZ", "KQZ-1"]);
    expect(keyInTvOrdersRange("042")).toBe(true);
  });
});
