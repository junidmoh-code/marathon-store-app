import { describe, it, expect } from "vitest";
import { matchWebLine, siblingKeys, LOOKBACK_MS } from "./webSales.mjs";

const T = Date.parse("2026-10-10T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

describe("matchWebLine", () => {
  it("an exact sale after the order explains it, once", () => {
    const r = matchWebLine(
      [{ pid: "p1", size: "8", qty: 1, createdAt: T }, { pid: "p1", size: "8", qty: 1, createdAt: T + 1 }],
      [{ productId: "p1", size: "8", qty: 1, ts: iso(T + 3600e3) }],
    );
    expect(r.map((x) => x.match)).toEqual(["exact", "none"]);
  });
  it("a till sale rung up to 7 days BEFORE the order counts; older does not", () => {
    expect(matchWebLine([{ pid: "p1", size: "8", qty: 1, createdAt: T }], [{ productId: "p1", size: "8", qty: 1, ts: iso(T - LOOKBACK_MS + 1000) }])[0].match).toBe("exact");
    expect(matchWebLine([{ pid: "p1", size: "8", qty: 1, createdAt: T }], [{ productId: "p1", size: "8", qty: 1, ts: iso(T - LOOKBACK_MS - 1000) }])[0].match).toBe("none");
  });
  it("normalises size keys on both sides (5.5 vs 5_5)", () => {
    expect(matchWebLine([{ pid: "p1", size: "5_5", qty: 1, createdAt: T }], [{ productId: "p1", size: "5.5", qty: 1, ts: iso(T) }])[0].match).toBe("exact");
  });
  it("a loose pass never steals the sale another line needs exactly", () => {
    const r = matchWebLine(
      [{ pid: "p1", size: "7", qty: 1, createdAt: T }, { pid: "p1", size: "8", qty: 1, createdAt: T + 1 }],
      [{ productId: "p1", size: "8", qty: 1, ts: iso(T + 10) }],
    );
    expect(r.map((x) => x.match)).toEqual(["none", "exact"]);
  });
  it("wrong size, then sibling record by style code or word-set name", () => {
    const meta = new Map([["p1", siblingKeys({ name: "Birkenstock Arizona Taupe Suede" })], ["p2", siblingKeys({ name: "birkenstock arizona suede taupe" })], ["p3", siblingKeys({ name: "x", styleCode: "AB1" })], ["p4", siblingKeys({ name: "y", styleCode: "ab1 " })]]);
    expect(matchWebLine([{ pid: "p1", size: "8", qty: 1, createdAt: T }], [{ productId: "p1", size: "9", qty: 1, ts: iso(T) }], meta)[0].match).toBe("wrongSize");
    expect(matchWebLine([{ pid: "p1", size: "8", qty: 1, createdAt: T }], [{ productId: "p2", size: "8", qty: 1, ts: iso(T) }], meta)[0].match).toBe("sibling");
    expect(matchWebLine([{ pid: "p3", size: "8", qty: 1, createdAt: T }], [{ productId: "p4", size: "8", qty: 1, ts: iso(T) }], meta)[0].match).toBe("sibling");
  });
  it("a multi-unit sale covers several lines", () => {
    const r = matchWebLine(
      [{ pid: "p1", size: "8", qty: 1, createdAt: T }, { pid: "p1", size: "8", qty: 1, createdAt: T + 1 }],
      [{ productId: "p1", size: "8", qty: 2, ts: iso(T + 10) }],
    );
    expect(r.map((x) => x.match)).toEqual(["exact", "exact"]);
  });
});
