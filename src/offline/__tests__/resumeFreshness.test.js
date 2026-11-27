import { describe, it, expect, beforeEach } from "vitest";
import {
  resumeUpdating, isMirrorStale, markMirrorFeedOk, resetMirrorFreshness, mirrorFeedOkAt,
  setSavedShowing, isSavedShowing, subscribeFreshness, RESUME_SAFE_MS, _resetResumeFreshnessForTests,
} from "../resumeFreshness";

beforeEach(() => _resetResumeFreshnessForTests());

describe("the Updating… marker", () => {
  it("a serving mirror is stale until its first feed read, and again past the safe limit", () => {
    expect(isMirrorStale(null, 5)).toBe(true);
    expect(isMirrorStale(1000, 1000 + RESUME_SAFE_MS)).toBe(false);
    expect(isMirrorStale(1000, 1001 + RESUME_SAFE_MS)).toBe(true);
  });
  it("shows for a stale serving mirror, never for a device reading live, always for a saved copy", () => {
    expect(resumeUpdating({ serving: true, feedOkAt: null, nowMs: 1, savedShowing: false })).toBe(true);
    expect(resumeUpdating({ serving: true, feedOkAt: 1, nowMs: 2, savedShowing: false })).toBe(false);
    expect(resumeUpdating({ serving: false, feedOkAt: null, nowMs: 1, savedShowing: false })).toBe(false);
    expect(resumeUpdating({ serving: false, feedOkAt: null, nowMs: 1, savedShowing: true })).toBe(true);
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
