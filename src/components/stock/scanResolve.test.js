import { describe, it, expect } from "vitest";
import { realSizesOf, resolveScan, forgivingBarcodeCandidates } from "./scanResolve";

const sneaker  = { id: "s1", name: "Air Max", sizes: ["7", "8", "9.5"] };
const clothing = { id: "c1", name: "Nike Tee", sizes: ["S", "M", "L", "XL"] };
const oneSize  = { id: "o1", name: "Cap", sizes: [] };
const placeholder = { id: "o2", name: "Bag", sizes: ["_", "", " "] }; // only junk sizes

describe("realSizesOf", () => {
  it("keeps real sizes, drops '_'/blank placeholders", () => {
    expect(realSizesOf(sneaker)).toEqual(["7", "8", "9.5"]);
    expect(realSizesOf(clothing)).toEqual(["S", "M", "L", "XL"]);
    expect(realSizesOf(oneSize)).toEqual([]);
    expect(realSizesOf(placeholder)).toEqual([]);
    expect(realSizesOf(null)).toEqual([]);
  });
});

describe("resolveScan", () => {
  it("per-size barcode (index carries size) → add straight with that size", () => {
    expect(resolveScan(sneaker, "9.5")).toEqual({ kind: "add", size: "9.5" });
    expect(resolveScan(clothing, "M")).toEqual({ kind: "add", size: "M" });
  });
  it("sized product + NO size in the index → prompt (never silently '_')", () => {
    expect(resolveScan(clothing, undefined)).toEqual({ kind: "prompt" });
    expect(resolveScan(clothing, null)).toEqual({ kind: "prompt" });
    expect(resolveScan(clothing, "_")).toEqual({ kind: "prompt" });   // "_" is not a real size
    expect(resolveScan(clothing, "")).toEqual({ kind: "prompt" });
  });
  it("genuinely unsized product + no size → one-size ('_' cell is correct)", () => {
    expect(resolveScan(oneSize, undefined)).toEqual({ kind: "onesize" });
    expect(resolveScan(placeholder, null)).toEqual({ kind: "onesize" });
  });
});

describe("forgivingBarcodeCandidates (typed leading-zero tolerance)", () => {
  it("zero-pads the stripped number, excludes the exact code, never substring", () => {
    const c = forgivingBarcodeCandidates("1385");
    expect(c).toContain("01385");
    expect(c).toContain("00001385");
    expect(c).not.toContain("1385");     // exact code excluded (already tried)
    expect(c).not.toContain("13850");    // never a substring/suffix match
    expect(c.every(x => /^\d+$/.test(x))).toBe(true);
  });
  it("strips leading zeros first so '00001385' and '1385' share candidates", () => {
    expect(forgivingBarcodeCandidates("00001385")).toContain("1385");
  });
  it("non-numeric input → no candidates (names/junk skip)", () => {
    expect(forgivingBarcodeCandidates("abc")).toEqual([]);
    expect(forgivingBarcodeCandidates("")).toEqual([]);
  });
});
