// ─── DISPLAY CHECKS — feed model unit tests (vitest) ─────────────────────────
// The pure reducer behind the Today feed (PR 5). Pins the three invariants that
// matter: (1) partition keys on STATUS, so a completed tombstone lingering in
// the active index shows in NO section; (2) held checks are excluded from the
// completion denominator; (3) sort is newest-first and never mutates the input.

import { describe, it, expect } from "vitest";
import { deriveFeed, formatSaTime, isNoStock, isOnlinePick, complianceOnly } from "./feedModel";

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

// ── Website order picks (kind online_pick) are LISTED, never SCORED ──────────
describe("online_pick records stay out of every compliance figure", () => {
  const pickOpen = { key: "online__9__0", checkId: "online__9__0", status: "open", createdAt: 3000, kind: "online_pick", ref: "WEB-9" };
  const pickDone = { key: "online__9__1", checkId: "online__9__1", status: "completed", result: "not_found", completedAt: 4000, kind: "online_pick" };
  const pickHanded = { ...pickDone, key: "online__9__2", result: "handed" };

  it("listed in outstanding / completed so staff can act on them", () => {
    const f = deriveFeed([open(), pickOpen], [pickDone]);
    expect(f.outstanding.map((r) => r.key)).toContain("online__9__0");
    expect(f.completed.map((r) => r.key)).toContain("online__9__1");
  });

  it("…but every stat is the display checks' alone", () => {
    const base = deriveFeed([open()], [{ key: "x", result: "confirmed", completedAt: 2000 }]).stats;
    const mixed = deriveFeed([open(), pickOpen], [{ key: "x", result: "confirmed", completedAt: 2000 }, pickDone, pickHanded]).stats;
    expect(mixed).toEqual(base);
    // a not_found pick is not a no-stock, a handed pick is not a confirmation
    expect(mixed.noStock).toBe(0);
    expect(mixed.confirmed).toBe(1);
  });

  it("a feed of ONLY picks scores nothing (0 assigned, 0%), not 100% or 0-of-N", () => {
    expect(deriveFeed([pickOpen], [pickDone]).stats).toMatchObject({ assigned: 0, done: 0, outstanding: 0, completionPct: 0, confirmed: 0, noStock: 0 });
  });

  it("complianceOnly drops picks (what AnalyticsView feeds deriveFeed) and isOnlinePick keys on kind only", () => {
    expect(complianceOnly([open(), pickOpen, null, pickDone]).map((r) => r.key)).toEqual(["p1__M"]);
    expect(complianceOnly(undefined)).toEqual([]);
    expect(isOnlinePick({ kind: "online_pick" })).toBe(true);
    expect(isOnlinePick({ key: "online__1__0" })).toBe(false);
    expect(isOnlinePick(null)).toBe(false);
  });
});
