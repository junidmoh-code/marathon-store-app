// ─── DISPLAY CHECKS — feed model unit tests (vitest) ─────────────────────────
// The pure reducer behind the Today feed (PR 5). Pins the three invariants that
// matter: (1) partition keys on STATUS, so a completed tombstone lingering in
// the active index shows in NO section; (2) held checks are excluded from the
// completion denominator; (3) sort is newest-first and never mutates the input.

import { describe, it, expect } from "vitest";
import { deriveFeed, formatSaTime, isNoStock } from "./feedModel";

const open = (over = {}) => ({ key: "p1__M", checkId: "c1", status: "open", createdAt: 1000, ...over });
const held = (over = {}) => ({ key: "p2__L", checkId: "c2", status: "held", heldAt: 900, ...over });
const done = (over = {}) => ({ key: "c3", checkId: "c3", result: "confirmed", completedAt: 1200, ...over });

describe("deriveFeed", () => {
  it("partitions the active index by STATUS field (window #1)", () => {
    const active = [open(), held(), { key: "x__M", checkId: "cX", status: "completed", completedAt: 500 }];
    const f = deriveFeed(active, []);
    expect(f.outstanding.map((r) => r.checkId)).toEqual(["c1"]);
    expect(f.waiting.map((r) => r.checkId)).toEqual(["c2"]);
    // The completed TOMBSTONE in the active index appears in NO section.
    expect(f.completed).toEqual([]);
    expect([...f.outstanding, ...f.waiting].some((r) => r.checkId === "cX")).toBe(false);
  });

  it("held checks are excluded from the completion denominator", () => {
    // 2 open + 2 held + 1 completed → assigned = 2 open + 1 done = 3 (NOT 5)
    const active = [open({ checkId: "o1" }), open({ checkId: "o2" }), held({ checkId: "h1" }), held({ checkId: "h2" })];
    const f = deriveFeed(active, [done()]);
    expect(f.stats.assigned).toBe(3);
    expect(f.stats.done).toBe(1);
    expect(f.stats.outstanding).toBe(2);
    expect(f.stats.waiting).toBe(2);
    expect(f.stats.completionPct).toBe(33); // 1/3
  });

  it("splits completed into confirmed vs no-stock and counts them", () => {
    const f = deriveFeed([], [done({ key: "a", result: "confirmed" }), done({ key: "b", result: "no_stock" })]);
    expect(f.stats.confirmed).toBe(1);
    expect(f.stats.noStock).toBe(1);
    expect(f.stats.done).toBe(2);
  });

  it("sorts newest-first by the section's timestamp and does not mutate input", () => {
    const active = [open({ checkId: "old", createdAt: 100 }), open({ checkId: "new", createdAt: 999 })];
    const snapshot = JSON.stringify(active);
    const f = deriveFeed(active, []);
    expect(f.outstanding.map((r) => r.checkId)).toEqual(["new", "old"]);
    expect(JSON.stringify(active)).toBe(snapshot); // input untouched
  });

  it("100% completion when everything assigned is done, 0% when nothing assigned", () => {
    expect(deriveFeed([], [done()]).stats.completionPct).toBe(100);
    expect(deriveFeed([], []).stats.completionPct).toBe(0);
  });

  it("tolerates null / malformed rows without throwing", () => {
    const f = deriveFeed([null, open(), undefined, "junk"], [null, done()]);
    expect(f.outstanding.length).toBe(1);
    expect(f.completed.length).toBe(1);
  });
});

describe("formatSaTime", () => {
  it("formats an ISO instant to SA HH:MM", () => {
    // 12:32 UTC = 14:32 SAST (UTC+2)
    expect(formatSaTime("2026-07-18T12:32:00.000Z")).toBe("14:32");
  });
  it("accepts epoch-ms and returns SA HH:MM", () => {
    expect(formatSaTime(Date.parse("2026-07-18T12:32:00.000Z"))).toBe("14:32");
  });
  it("returns empty string for null / invalid", () => {
    expect(formatSaTime(null)).toBe("");
    expect(formatSaTime("")).toBe("");
    expect(formatSaTime("not-a-date")).toBe("");
  });
});

describe("isNoStock", () => {
  it("only the explicit no_stock result is no-stock", () => {
    expect(isNoStock({ result: "no_stock" })).toBe(true);
    expect(isNoStock({ result: "confirmed" })).toBe(false);
    expect(isNoStock({})).toBe(false);
    expect(isNoStock(null)).toBe(false);
  });
});
