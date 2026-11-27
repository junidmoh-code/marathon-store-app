// ─── A PARKED STALE BUNDLE COST ABOUT $400/MONTH ─────────────────────────────
//
// A device reading from a local mirror has no whole-node subscriptions to make
// a wrong bundle obvious, so its quiet-window reload is FORCED: it keeps trying
// past a busy moment instead of one attempt per version.
//
// Forced never means "during the day" (Junid, 27 Nov 2026): it used to reload
// 30 s after any deploy, mid-use, which is what made staff come back to a cold
// start. These pin both halves.
import { describe, test, expect } from "vitest";
import {
  shouldAutoReload, setForcedUpdateMode, isForcedUpdateMode, FORCED_MAX_ATTEMPTS,
} from "../../update/updateChecker";

const IDLE = 4 * 60_000;
const night = {
  updateAvailable: true, busy: false, msSinceActivity: IDLE,
  alreadyAttempted: false, tvQuiet: true,
};
const day = { ...night, tvQuiet: false };

describe("no device reloads by itself while the shops trade", () => {
  test("not idle, not hidden, not forced, not after an hour", () => {
    expect(shouldAutoReload(day)).toBe(false);
    expect(shouldAutoReload({ ...day, hidden: true, msSinceActivity: 0 })).toBe(false);
    expect(shouldAutoReload({ ...day, forced: true, msSinceActivity: 0 })).toBe(false);
    expect(shouldAutoReload({ ...day, forced: true, msSinceActivity: 60 * 60_000 })).toBe(false);
  });
});

describe("the quiet window, ordinary mode", () => {
  test("a busy device never reloads", () => {
    expect(shouldAutoReload({ ...night, busy: true })).toBe(false);
  });
  test("the device must be idle", () => {
    expect(shouldAutoReload({ ...night, msSinceActivity: 1000 })).toBe(false);
    expect(shouldAutoReload(night)).toBe(true);
  });
  test("one silent attempt per version, so a lagging CDN cannot reload-loop", () => {
    expect(shouldAutoReload({ ...night, alreadyAttempted: true })).toBe(false);
  });
});

describe("the quiet window, forced mode (a device serving from its local copy)", () => {
  test("BUSY IS STILL ABSOLUTE — an order in progress is never reloaded over", () => {
    expect(shouldAutoReload({ ...night, forced: true, busy: true })).toBe(false);
  });
  test("a device that stayed busy through its one attempt still gets the bundle", () => {
    expect(shouldAutoReload({ ...night, forced: true, alreadyAttempted: true })).toBe(true);
  });
  test("still waits for idle", () => {
    expect(shouldAutoReload({ ...night, forced: true, msSinceActivity: 0 })).toBe(false);
  });
  test("no update, no reload", () => {
    expect(shouldAutoReload({ ...night, updateAvailable: false, forced: true })).toBe(false);
  });
  test("it stops after FORCED_MAX_ATTEMPTS — a lying CDN costs five reloads, not a night", () => {
    expect(shouldAutoReload({ ...night, forced: true, attempts: FORCED_MAX_ATTEMPTS })).toBe(false);
    expect(shouldAutoReload({ ...night, forced: true, attempts: FORCED_MAX_ATTEMPTS - 1 })).toBe(true);
  });
  test("the mode is off until the mirror turns it on", () => {
    expect(isForcedUpdateMode()).toBe(false);
    setForcedUpdateMode(true);
    expect(isForcedUpdateMode()).toBe(true);
    setForcedUpdateMode(false);
  });
});
