import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resumeUpdating, isMirrorStale, markMirrorFeedOk, resetMirrorFreshness, mirrorFeedOkAt,
  setSavedShowing, isSavedShowing, subscribeFreshness, RESUME_SAFE_MS, _resetResumeFreshnessForTests,
  markMirrorPass, mirrorPassSince, PASS_SHOW_AFTER_MS,
} from "../resumeFreshness";

beforeEach(() => _resetResumeFreshnessForTests());

describe("the Updating… marker", () => {
  it("a serving mirror is stale until its first feed read, and again past the safe limit", () => {
    expect(isMirrorStale(null, 5)).toBe(true);
    expect(isMirrorStale(1000, 1000 + RESUME_SAFE_MS)).toBe(false);
    expect(isMirrorStale(1000, 1001 + RESUME_SAFE_MS)).toBe(true);
  });
  it("shows for a stale serving mirror WHILE A PASS IS CATCHING IT UP, never for a device reading live, always for a saved copy", () => {
    const passing = { passSince: 0, nowMs: PASS_SHOW_AFTER_MS };
    expect(resumeUpdating({ serving: true, feedOkAt: null, savedShowing: false, ...passing })).toBe(true);
    expect(resumeUpdating({ serving: true, feedOkAt: PASS_SHOW_AFTER_MS - 1, savedShowing: false, ...passing })).toBe(false);
    expect(resumeUpdating({ serving: false, feedOkAt: null, savedShowing: false, ...passing })).toBe(false);
    expect(resumeUpdating({ serving: false, feedOkAt: null, nowMs: 1, savedShowing: true })).toBe(true);
  });
  // Junid's recording (27 Nov): the pill never went away. Stale between passes
  // (a pass error spaces passes 5 min apart; a feed that cannot be read never
  // freshens) is NOT "updating" — nothing is in flight.
  it("stale with no pass running: no marker (the stuck pill)", () => {
    expect(resumeUpdating({ serving: true, feedOkAt: null, nowMs: 10 * 60 * 1000, savedShowing: false, passSince: null })).toBe(false);
    expect(resumeUpdating({ serving: true, feedOkAt: 1, nowMs: 1 + 4 * 60 * 1000, savedShowing: false })).toBe(false);
  });
  it("a short pass never blinks it; a long one does, and it comes down when the pass ends", () => {
    expect(resumeUpdating({ serving: true, feedOkAt: null, nowMs: 100 + PASS_SHOW_AFTER_MS - 1, savedShowing: false, passSince: 100 })).toBe(false);
    expect(resumeUpdating({ serving: true, feedOkAt: null, nowMs: 100 + PASS_SHOW_AFTER_MS, savedShowing: false, passSince: 100 })).toBe(true);
  });
  it("markMirrorPass tracks the pass and re-notifies once it has run long enough to show", () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      subscribeFreshness(() => { n += 1; });
      markMirrorPass(true, 500);
      expect(mirrorPassSince()).toBe(500);
      expect(n).toBe(1);
      vi.advanceTimersByTime(PASS_SHOW_AFTER_MS + 25);
      expect(n).toBe(2);
      markMirrorPass(false);
      expect(mirrorPassSince()).toBe(null);
      expect(n).toBe(3);
      vi.advanceTimersByTime(5000);
      expect(n).toBe(3);                              // no stray re-ask after the pass ended
    } finally { vi.useRealTimers(); }
  });
  it("the feed mark and saved flags notify subscribers", () => {
    let n = 0;
    subscribeFreshness(() => { n += 1; });
    markMirrorFeedOk(42); expect(mirrorFeedOkAt()).toBe(42);
    setSavedShowing("users/u1", true); expect(isSavedShowing()).toBe(true);
    setSavedShowing("users/u1", true);             // no change, no notify
    setSavedShowing("users/u1", false); expect(isSavedShowing()).toBe(false);
    resetMirrorFreshness(); expect(mirrorFeedOkAt()).toBe(null);
    expect(n).toBe(4);
  });
});
