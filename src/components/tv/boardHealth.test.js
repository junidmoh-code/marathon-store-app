import { describe, it, expect } from "vitest";
import { boardStatus, feedAnswered, watchdogStep, reloadUrl, WATCHDOG_MS, RELOAD_FLOOR_MS, FIRST_ANSWER_MS, MAX_UNRECOVERED_RELOADS } from "./boardHealth";

const list = (props, rows = []) => Object.assign(rows.slice(), props);

describe("feedAnswered", () => {
  it("a settled useOrders list or an answered kiosk list is live; errors and the initial list are not", () => {
    expect(feedAnswered(list({ settled: true }))).toBe(true);
    expect(feedAnswered(list({ answered: true }))).toBe(true);
    expect(feedAnswered(list({ settled: false }))).toBe(false);
    expect(feedAnswered([])).toBe(false);                       // a kiosk hook's initial []
    expect(feedAnswered(list({ settled: true, error: true }))).toBe(false);
    expect(feedAnswered(null)).toBe(false);
  });
});

describe("boardStatus — green only when the socket AND the orders read are good", () => {
  it("the 28 Nov board (socket up, orders refused) is red, not 'System connected'", () => {
    expect(boardStatus({ connected: true, feedError: true, lastOkAt: null })).toBe("refused");
    expect(boardStatus({ connected: true, feedError: true, lastOkAt: 5 })).toBe("refused");
  });
  it("socket up with no orders answer yet is 'waiting'; with one it is live", () => {
    expect(boardStatus({ connected: true, feedError: false, lastOkAt: null })).toBe("waiting");
    expect(boardStatus({ connected: true, feedError: false, lastOkAt: 1 })).toBe("live");
  });
  it("socket down is 'offline' whatever the feed says; unknown is 'booting'", () => {
    expect(boardStatus({ connected: false, feedError: false, lastOkAt: 1 })).toBe("offline");
    expect(boardStatus({ connected: null, feedError: false, lastOkAt: null })).toBe("booting");
  });
});

describe("watchdogStep", () => {
  const base = { healthy: false, since: 0, bouncedAt: null, lastReloadAt: null };
  it("does nothing while healthy or before 3 minutes", () => {
    expect(watchdogStep({ ...base, healthy: true, nowMs: 10 * WATCHDOG_MS })).toBe("none");
    expect(watchdogStep({ ...base, nowMs: WATCHDOG_MS - 1 })).toBe("none");
  });
  it("reopens the socket at 3 minutes, reloads 3 minutes after that", () => {
    expect(watchdogStep({ ...base, nowMs: WATCHDOG_MS })).toBe("bounce");
    expect(watchdogStep({ ...base, bouncedAt: WATCHDOG_MS, nowMs: 2 * WATCHDOG_MS - 1 })).toBe("none");
    expect(watchdogStep({ ...base, bouncedAt: WATCHDOG_MS, nowMs: 2 * WATCHDOG_MS })).toBe("reload");
  });
  it("never reloads within 5 minutes of the last reload on this device", () => {
    const nowMs = 100 * WATCHDOG_MS;
    expect(watchdogStep({ ...base, bouncedAt: nowMs - WATCHDOG_MS, lastReloadAt: nowMs - RELOAD_FLOOR_MS + 1, nowMs })).toBe("none");
    expect(watchdogStep({ ...base, bouncedAt: nowMs - WATCHDOG_MS, lastReloadAt: nowMs - RELOAD_FLOOR_MS, nowMs })).toBe("reload");
  });
});

describe("watchdogStep — first answer budget and the reload cap", () => {
  const base = { healthy: false, since: 0, bouncedAt: null, lastReloadAt: null };
  it("never-answered boards wait FIRST_ANSWER_MS before the first bounce", () => {
    expect(watchdogStep({ ...base, neverAnswered: true, nowMs: WATCHDOG_MS })).toBe("none");
    expect(watchdogStep({ ...base, neverAnswered: true, nowMs: FIRST_ANSWER_MS })).toBe("bounce");
  });
  it("after MAX_UNRECOVERED_RELOADS it only reopens the socket", () => {
    const nowMs = 100 * WATCHDOG_MS;
    expect(watchdogStep({ ...base, bouncedAt: nowMs - WATCHDOG_MS, unrecoveredReloads: MAX_UNRECOVERED_RELOADS, nowMs })).toBe("bounce-only");
  });
});

describe("reloadUrl", () => {
  it("keeps the page, its query and its hash, and adds a cache-busting stamp", () => {
    expect(reloadUrl({ pathname: "/", search: "?section=1&kiosk=1", hash: "#tv" }, 42)).toBe("/?section=1&kiosk=1&_tvr=42#tv");
    expect(reloadUrl({ pathname: "/", search: "?_tvr=1", hash: "" }, 7)).toBe("/?_tvr=7");
  });
});
