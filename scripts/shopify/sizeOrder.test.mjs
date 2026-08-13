// ── Size-order tests over REAL catalogue size arrays ─────────────────────────
// Every input is a live product's sizes[] lifted verbatim from the 2026-08-13
// read-only census (same convention as nameRewrite.test.mjs). Expected outputs
// are the storefront dropdown order we want frozen.
import { describe, it, expect } from "vitest";
import { sortSizes } from "./sizeOrder.mjs";

describe("sortSizes — real catalogue size arrays", () => {
  it("shoe run with trailing small sizes and a half (p1777899156322 Zoom Vomero)", () => {
    expect(sortSizes(["6", "7", "8", "9", "10", "11", "3", "4", "5", "5.5"])).toEqual([
      "3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11",
    ]);
  });

  it("half size interleaves numerically, not lexically (p1777896688393)", () => {
    // lexical sort would give ["11","5.5","6",…] — 5.5 must land between 5-less run and 6
    expect(sortSizes(["6", "7", "8", "9", "10", "11", "5.5"])).toEqual([
      "5.5", "6", "7", "8", "9", "10", "11",
    ]);
  });

  it("letter sizes sort in garment order, not alphabetically", () => {
    // alphabetical would be L, M, S, XL, XXL, XXXL — garment order is wanted
    expect(sortSizes(["XXL", "XL", "L", "M", "S", "XXXL"])).toEqual([
      "S", "M", "L", "XL", "XXL", "XXXL",
    ]);
  });

  it("full mixed record: shoe run then garment run (p1777895787590 Air Force 1)", () => {
    expect(
      sortSizes(["6", "7", "8", "9", "10", "11", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"])
    ).toEqual(["6", "7", "8", "9", "10", "11", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"]);
  });

  it("scrambled mixed record with letters reversed AND a half (p1782305359662)", () => {
    expect(
      sortSizes(["XXL", "XL", "L", "M", "S", "5.5", "3", "4", "5", "6", "7", "9", "8", "10", "11"])
    ).toEqual(["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "S", "M", "L", "XL", "XXL"]);
  });

  it("one garment size out of place (p1782546875056 Portugal tracksuit)", () => {
    expect(sortSizes(["S", "M", "L", "XL", "XXL", "XXXL", "6"])).toEqual([
      "6", "S", "M", "L", "XL", "XXL", "XXXL",
    ]);
  });

  it("fitted-cap head sizes are plain numerics (p1785568547550 Ny fitted caps)", () => {
    expect(sortSizes(["58", "55", "60", "56", "57", "59", "61", "62", "63"])).toEqual([
      "55", "56", "57", "58", "59", "60", "61", "62", "63",
    ]);
  });

  it("one-size sentinel alone passes through untouched", () => {
    expect(sortSizes(["_"])).toEqual(["_"]);
  });

  it("the one live record mixing the sentinel with a real size puts One Size last (p1785573539811)", () => {
    expect(sortSizes(["_", "S"])).toEqual(["S", "_"]);
  });

  it("unrecognised tokens keep their original relative order, after known sizes", () => {
    expect(sortSizes(["Free", "M", "Custom", "S"])).toEqual(["S", "M", "Free", "Custom"]);
  });

  it("garment aliases: 2XL/3XL rank with XXL/XXXL, original spelling preserved", () => {
    expect(sortSizes(["3XL", "M", "2XL", "XL"])).toEqual(["M", "XL", "2XL", "3XL"]);
  });

  it("does not mutate its input", () => {
    const input = ["6", "3", "5.5"];
    sortSizes(input);
    expect(input).toEqual(["6", "3", "5.5"]);
  });
});
