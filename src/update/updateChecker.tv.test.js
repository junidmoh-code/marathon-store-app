// A TV screen (#tv, or the board mounted in-app) is never reloaded while the
// store is open — not by the idle rule, not by forced mode, not by the banner's
// applyUpdate. A reload re-locks the browser's audio, which is what silenced the
// pickup voice during the day. The one exception is a single attempt per
// version in the 03:00–05:00 SAST quiet window, so a TV without the launcher
// still cannot sit on an old bundle for ever.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applyUpdate, isTvRoute, isTvScreen, setTvBoardMounted, inTvQuietWindow, reloadIo,
  shouldAutoReload, setForcedUpdateMode,
} from "./updateChecker.js";

const SAST = (h, m = 0) => Date.UTC(2026, 9, 19, h - 2, m); // 19 Oct 2026, h:m SAST

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); setForcedUpdateMode(false); });

function stubLocation(hash) {
  vi.stubGlobal("window", { location: { hash } });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
}

describe("updateChecker on a TV screen", () => {
  it("isTvRoute is the exact #tv hash AuthGate routes on", () => {
    expect(isTvRoute({ hash: "#tv" })).toBe(true);
    expect(isTvRoute({ hash: "" })).toBe(false);
    expect(isTvRoute({ hash: "#tvx" })).toBe(false);
    expect(isTvRoute(null)).toBe(false);
  });

  it("the board mounted in-app (DISPLAY role, no #tv hash) counts as a TV screen", () => {
    stubLocation("");
    expect(isTvScreen()).toBe(false);
    setTvBoardMounted(true);
    expect(isTvScreen()).toBe(true);
    setTvBoardMounted(false);
    expect(isTvScreen()).toBe(false);
  });

  it("the quiet window is 03:00–05:00 SAST, whatever the device's zone", () => {
    expect(inTvQuietWindow(SAST(2, 59))).toBe(false);
    expect(inTvQuietWindow(SAST(3, 0))).toBe(true);
    expect(inTvQuietWindow(SAST(4, 59))).toBe(true);
    expect(inTvQuietWindow(SAST(5, 0))).toBe(false);
    expect(inTvQuietWindow(SAST(11, 0))).toBe(false);
  });

  it("shouldAutoReload: never in trading hours in any mode; once per version in the quiet window", () => {
    const yes = { updateAvailable: true, busy: false, msSinceActivity: 10 * 60_000, alreadyAttempted: false };
    expect(shouldAutoReload(yes)).toBe(true);
    expect(shouldAutoReload({ ...yes, tvRoute: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, hidden: true, tvRoute: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, forced: true, msSinceFirstSeen: 10 * 60_000, tvRoute: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, tvRoute: true, tvQuiet: true })).toBe(true);
    expect(shouldAutoReload({ ...yes, tvRoute: true, tvQuiet: true, alreadyAttempted: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, tvRoute: true, tvQuiet: true, busy: true })).toBe(false);
  });

  it("applyUpdate never calls reload on #tv during trading hours, even in forced mode", () => {
    vi.useFakeTimers({ now: SAST(11) });
    stubLocation("#tv");
    setForcedUpdateMode(true);
    const reload = vi.spyOn(reloadIo, "reload").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyUpdate();
    expect(reload).not.toHaveBeenCalled();
  });

  it("applyUpdate on #tv in the quiet window does reload (same URL, voice re-armed by the keeper)", () => {
    vi.useFakeTimers({ now: SAST(4) });
    stubLocation("#tv");
    const reload = vi.spyOn(reloadIo, "reload").mockImplementation(() => {});
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applyUpdate still reloads every other screen", () => {
    vi.useFakeTimers({ now: SAST(11) });
    stubLocation("");
    const reload = vi.spyOn(reloadIo, "reload").mockImplementation(() => {});
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
