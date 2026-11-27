import { describe, it, expect } from "vitest";
import { isNewVersion, shouldAutoReload, shouldReloadOnReturn, setUpdateBusy, isUpdateBusy } from "./updateChecker.js";

const IDLE = 3 * 60 * 1000;

describe("isNewVersion", () => {
  it("true only for a real, different, non-dev version", () => {
    expect(isNewVersion("abc.1", "def.2")).toBe(true);
    expect(isNewVersion("abc.1", "abc.1")).toBe(false);
    expect(isNewVersion("dev", "def.2")).toBe(false); // dev server never updates
    expect(isNewVersion("abc.1", "")).toBe(false);
    expect(isNewVersion("abc.1", undefined)).toBe(false);
    expect(isNewVersion("abc.1", null)).toBe(false);
  });
});

describe("shouldAutoReload — never under anybody, never because they looked away", () => {
  // Quiet = 03:00–05:00 SAST. Everything else is trading time for this rule.
  const base = { updateAvailable: true, busy: false, msSinceActivity: IDLE, alreadyAttempted: false, tvQuiet: true };
  it("reloads an idle, not-busy device in the quiet window", () => {
    expect(shouldAutoReload(base)).toBe(true);
  });
  it("never reloads by itself outside the quiet window — idle, hidden or forced", () => {
    const day = { ...base, tvQuiet: false };
    expect(shouldAutoReload(day)).toBe(false);
    expect(shouldAutoReload({ ...day, hidden: true })).toBe(false);
    expect(shouldAutoReload({ ...day, msSinceActivity: 60 * 60_000 })).toBe(false);
    expect(shouldAutoReload({ ...day, forced: true })).toBe(false);
  });
  it("going hidden is not a reason: a recently-touched device waits even in the window", () => {
    expect(shouldAutoReload({ ...base, msSinceActivity: 30_000, hidden: true })).toBe(false);
  });
  it("never reloads while busy (sale in cart / count running)", () => {
    expect(shouldAutoReload({ ...base, busy: true })).toBe(false);
    expect(shouldAutoReload({ ...base, busy: true, forced: true })).toBe(false);
  });
  it("one silent attempt per version — the latch blocks loops", () => {
    expect(shouldAutoReload({ ...base, alreadyAttempted: true })).toBe(false);
  });
  it("forced (mirrored) keeps trying in the window, up to the attempt floor", () => {
    expect(shouldAutoReload({ ...base, forced: true, alreadyAttempted: true, attempts: 2 })).toBe(true);
    expect(shouldAutoReload({ ...base, forced: true, attempts: 5 })).toBe(false);
  });
  it("no update → no reload", () => {
    expect(shouldAutoReload({ ...base, updateAvailable: false })).toBe(false);
  });
});

describe("busy registry", () => {
  it("any registered key marks the app busy; clearing all frees it", () => {
    expect(isUpdateBusy()).toBe(false);
    setUpdateBusy("cart", true);
    setUpdateBusy("payment", true);
    expect(isUpdateBusy()).toBe(true);
    setUpdateBusy("cart", false);
    expect(isUpdateBusy()).toBe(true);
    setUpdateBusy("payment", false);
    expect(isUpdateBusy()).toBe(false);
  });
});

describe("shouldReloadOnReturn — the stale-bundle backstop (Sonnet review, #1019)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const base = { updateAvailable: true, busy: false, buildAgeMs: DAY, hiddenMs: 30 * 60_000 };
  it("a build out for a day is taken on a return after 30+ minutes away", () => {
    expect(shouldReloadOnReturn(base)).toBe(true);
  });
  it("never on a quick trip to another app, never for a fresh build", () => {
    expect(shouldReloadOnReturn({ ...base, hiddenMs: 29 * 60_000 })).toBe(false);
    expect(shouldReloadOnReturn({ ...base, buildAgeMs: DAY - 1 })).toBe(false);
  });
  it("never busy, never the TV, latch and attempt floor respected", () => {
    expect(shouldReloadOnReturn({ ...base, busy: true })).toBe(false);
    expect(shouldReloadOnReturn({ ...base, tvRoute: true })).toBe(false);
    expect(shouldReloadOnReturn({ ...base, alreadyAttempted: true })).toBe(false);
    expect(shouldReloadOnReturn({ ...base, forced: true, alreadyAttempted: true, attempts: 1 })).toBe(true);
    expect(shouldReloadOnReturn({ ...base, forced: true, attempts: 5 })).toBe(false);
  });
});
