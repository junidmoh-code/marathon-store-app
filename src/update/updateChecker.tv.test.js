// The TV route (#tv) is never reloaded by the update checker — not by the idle
// rule, not by forced mode, not by the banner's applyUpdate. A reload re-locks
// the browser's audio, which is what silenced the pickup voice during the day.
import { describe, it, expect, vi, afterEach } from "vitest";
import { applyUpdate, isTvRoute, reloadIo, shouldAutoReload, setForcedUpdateMode } from "./updateChecker.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setForcedUpdateMode(false); });

function stubLocation(hash) {
  vi.stubGlobal("window", { location: { hash } });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
}

describe("updateChecker on the TV route", () => {
  it("isTvRoute is the exact #tv hash AuthGate routes on", () => {
    expect(isTvRoute({ hash: "#tv" })).toBe(true);
    expect(isTvRoute({ hash: "" })).toBe(false);
    expect(isTvRoute({ hash: "#tvx" })).toBe(false);
    expect(isTvRoute(null)).toBe(false);
  });

  it("shouldAutoReload is false for the TV in every mode that would otherwise reload", () => {
    const yes = { updateAvailable: true, busy: false, msSinceActivity: 10 * 60_000, alreadyAttempted: false };
    expect(shouldAutoReload(yes)).toBe(true);
    expect(shouldAutoReload({ ...yes, tvRoute: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, hidden: true, tvRoute: true })).toBe(false);
    expect(shouldAutoReload({ ...yes, forced: true, msSinceFirstSeen: 10 * 60_000, tvRoute: true })).toBe(false);
  });

  it("applyUpdate never calls reload on #tv, even in forced mode", () => {
    stubLocation("#tv");
    setForcedUpdateMode(true);
    const reload = vi.spyOn(reloadIo, "reload").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyUpdate();
    expect(reload).not.toHaveBeenCalled();
  });

  it("applyUpdate still reloads every other screen", () => {
    stubLocation("");
    const reload = vi.spyOn(reloadIo, "reload").mockImplementation(() => {});
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
