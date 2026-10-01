// ─── A PARKED STALE BUNDLE COST ABOUT $400/MONTH ─────────────────────────────
//
// A device reading from a local mirror makes that worse, not better: it has no
// whole-node subscriptions to make a wrong bundle obvious, so it can sit on an
// old build for days, quietly, reading a schema the new build has moved on
// from. So its reload is FORCED rather than advisory.
//
// Forced must never mean rude, and these pin both halves.
import { describe, test, expect } from "vitest";
import {
  shouldAutoReload, setForcedUpdateMode, isForcedUpdateMode,
  FORCED_GRACE_MS, FORCED_MAX_ATTEMPTS,
} from "../../update/updateChecker";

const base = {
  updateAvailable: true, busy: false, msSinceActivity: 0,
  alreadyAttempted: false, hidden: false,
};

describe("the ordinary mode is completely unchanged", () => {
  test("a busy device never reloads", () => {
    expect(shouldAutoReload({ ...base, busy: true, msSinceActivity: 10 * 60_000 })).toBe(false);
  });
  test("a visible device must be idle", () => {
    expect(shouldAutoReload({ ...base, msSinceActivity: 1000 })).toBe(false);
    expect(shouldAutoReload({ ...base, msSinceActivity: 4 * 60_000 })).toBe(true);
  });
  test("a hidden tab can interrupt nobody", () => {
    expect(shouldAutoReload({ ...base, hidden: true })).toBe(true);
  });
  test("one silent attempt per version, so a lagging CDN cannot reload-loop", () => {
    expect(shouldAutoReload({ ...base, hidden: true, alreadyAttempted: true })).toBe(false);
  });
});

describe("forced mode, for a device serving from its local copy", () => {
  test("it does NOT wait for three minutes of stillness", () => {
    expect(shouldAutoReload({
      ...base, forced: true, msSinceActivity: 0, msSinceFirstSeen: FORCED_GRACE_MS,
    })).toBe(true);
  });

  test("but it does wait out the grace, so nobody is reloaded mid-sentence", () => {
    expect(shouldAutoReload({
      ...base, forced: true, msSinceFirstSeen: FORCED_GRACE_MS - 1,
    })).toBe(false);
  });

  test("BUSY IS STILL ABSOLUTE — an order in progress is never reloaded over", () => {
    expect(shouldAutoReload({
      ...base, forced: true, busy: true, msSinceFirstSeen: 10 * 60_000,
    })).toBe(false);
  });

  test("a device that stayed busy through its one attempt still gets the bundle", () => {
    // The once-per-version latch is what would otherwise mean "busy at that
    // moment" equals "never takes this build at all".
    expect(shouldAutoReload({
      ...base, forced: true, alreadyAttempted: true, msSinceFirstSeen: 10 * 60_000,
    })).toBe(true);
  });

  test("no update, no reload, in either mode", () => {
    expect(shouldAutoReload({ ...base, updateAvailable: false, forced: true, msSinceFirstSeen: 1e9 })).toBe(false);
  });

  test("the mode is off until the mirror turns it on", () => {
    expect(isForcedUpdateMode()).toBe(false);
    setForcedUpdateMode(true);
    expect(isForcedUpdateMode()).toBe(true);
    setForcedUpdateMode(false);
  });
});

describe("forced mode has a floor", () => {
  test("it stops after FORCED_MAX_ATTEMPTS — a lying CDN costs five reloads, not a day", () => {
    // The once-per-version latch forced mode drops exists because a lagging
    // CDN serves a new version.json beside an old bundle, and the device
    // reloads into the same old bundle for ever. (Fable-vs-spec review.)
    const attempted = {
      ...base, forced: true, msSinceFirstSeen: 10 * 60_000, attempts: FORCED_MAX_ATTEMPTS,
    };
    expect(shouldAutoReload(attempted)).toBe(false);
    expect(shouldAutoReload({ ...attempted, attempts: FORCED_MAX_ATTEMPTS - 1 })).toBe(true);
  });

  test("the ordinary mode's attempt count is irrelevant to it", () => {
    expect(shouldAutoReload({ ...base, hidden: true, attempts: 99 })).toBe(true);
  });
});
