import { describe, it, expect } from "vitest";
import { isNewVersion, shouldAutoReload, setUpdateBusy, isUpdateBusy } from "./updateChecker.js";

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

describe("shouldAutoReload — never interrupt, one attempt per version", () => {
  const base = { updateAvailable: true, busy: false, msSinceActivity: IDLE, alreadyAttempted: false };
  it("reloads an idle, not-busy tab", () => {
    expect(shouldAutoReload(base)).toBe(true);
  });
  it("never reloads while busy (sale in cart / count running), even hidden", () => {
    expect(shouldAutoReload({ ...base, busy: true })).toBe(false);
    expect(shouldAutoReload({ ...base, busy: true, hidden: true })).toBe(false);
  });
  it("waits for idle when visible; hidden tab may swap immediately", () => {
    expect(shouldAutoReload({ ...base, msSinceActivity: 30_000 })).toBe(false);
    expect(shouldAutoReload({ ...base, msSinceActivity: 30_000, hidden: true })).toBe(true);
  });
  it("one silent attempt per version — the latch blocks loops", () => {
    expect(shouldAutoReload({ ...base, alreadyAttempted: true })).toBe(false);
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
