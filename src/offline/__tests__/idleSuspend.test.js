import { describe, test, expect, beforeEach } from "vitest";
import {
  startIdleSuspend, shouldSuspend, isTradingHours, IDLE_MS, IDLE_CHECK_MS, SUSPEND_MAX_MS, HEARTBEAT_MS,
} from "../idleSuspend";

// 22 Sep 2026, SAST. 22:00 SAST = 20:00 UTC; 11:00 SAST = 09:00 UTC.
const NIGHT = Date.parse("2026-09-22T20:00:00Z");
const DAY = Date.parse("2026-09-22T09:00:00Z");

function page(start) {
  let now = start;
  const docL = new Map();
  const winL = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (e, f) => docL.set(e, f),
    removeEventListener: (e) => docL.delete(e),
  };
  const win = {
    addEventListener: (e, f) => winL.set(e, f),
    removeEventListener: (e) => winL.delete(e),
  };
  let tick = null;
  const calls = [];
  const state = { mirrored: true, busy: false, tv: false };
  const ctl = startIdleSuspend({
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
    isMirrored: () => state.mirrored,
    isBusy: () => state.busy,
    isWatchSurface: () => state.tv,
    doc, win,
    now: () => now,
    setIntervalFn: (f) => { tick = f; return 1; },
    clearIntervalFn: () => { tick = null; },
  });
  return {
    ctl, calls, state,
    // Time passes the way the interval sees it: one check a minute.
    pass(ms) { for (let t = 0; t < ms; t += IDLE_CHECK_MS) { now += IDLE_CHECK_MS; tick?.(); } },
    hide() { doc.visibilityState = "hidden"; docL.get("visibilitychange")(); },
    show() { doc.visibilityState = "visible"; docL.get("visibilitychange")(); },
    touch() { winL.get("pointerdown")(); },
  };
}

describe("when a mirrored device suspends", () => {
  test("hidden for 15 minutes, at any hour — day included", () => {
    const p = page(DAY);
    p.hide();
    p.pass(IDLE_MS - IDLE_CHECK_MS);
    expect(p.calls).toEqual([]);
    p.pass(IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend"]);
    p.pass(IDLE_MS);
    expect(p.calls).toEqual(["suspend"]);         // once
  });

  test("visible and untouched: only OUTSIDE trading hours — a watched queue is never frozen", () => {
    const day = page(DAY);
    day.pass(3 * IDLE_MS);
    expect(day.calls).toEqual([]);
    const night = page(NIGHT);
    night.pass(IDLE_MS);
    expect(night.calls).toEqual(["suspend"]);
  });

  test("never while anything is busy (a cart, a count, an unconfirmed write)", () => {
    const p = page(NIGHT);
    p.state.busy = true;
    p.hide();
    p.pass(3 * IDLE_MS);
    expect(p.calls).toEqual([]);
    p.state.busy = false;
    p.pass(IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend"]);
  });

  test("never on a device that is not mirrored — its screens need the live connection", () => {
    const p = page(NIGHT);
    p.state.mirrored = false;
    p.hide();
    p.pass(3 * IDLE_MS);
    expect(p.calls).toEqual([]);
  });

  test("never on the TV", () => {
    const p = page(NIGHT);
    p.state.tv = true;
    p.pass(3 * IDLE_MS);
    expect(p.calls).toEqual([]);
  });
});

describe("and resumes", () => {
  test("the moment the page is shown again", () => {
    const p = page(NIGHT);
    p.hide();
    p.pass(IDLE_MS);
    p.show();
    expect(p.calls).toEqual(["suspend", "resume"]);
  });

  test("on the first touch", () => {
    const p = page(NIGHT);
    p.pass(IDLE_MS);
    p.touch();
    expect(p.calls).toEqual(["suspend", "resume"]);
    // …and the idle clock restarts from the touch.
    p.pass(IDLE_MS - IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);
  });

  test("when the device stops being mirrored while suspended — never left with neither source", () => {
    const p = page(NIGHT);
    p.pass(IDLE_MS);
    p.state.mirrored = false;
    p.pass(IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);
  });

  test("when it is stopped (the switch going off stops it)", () => {
    const p = page(NIGHT);
    p.pass(IDLE_MS);
    p.ctl.stop();
    expect(p.calls).toEqual(["suspend", "resume"]);
  });
});

describe("a suspend is bounded, so the kill switch is still heard", () => {
  test("every SUSPEND_MAX_MS it reconnects for HEARTBEAT_MS, then suspends again", () => {
    const p = page(NIGHT);
    p.hide();
    p.pass(IDLE_MS);
    expect(p.calls).toEqual(["suspend"]);
    p.pass(SUSPEND_MAX_MS - IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend"]);
    p.pass(IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);          // heartbeat: connected
    p.pass(HEARTBEAT_MS - IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);          // …for the whole heartbeat
    p.pass(IDLE_CHECK_MS);
    expect(p.calls).toEqual(["suspend", "resume", "suspend"]);
  });

  test("a switch heard OFF during the heartbeat keeps it connected", () => {
    const p = page(NIGHT);
    p.hide();
    p.pass(IDLE_MS + SUSPEND_MAX_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);
    p.state.mirrored = false;                                 // the hint drops with the switch
    p.pass(3 * HEARTBEAT_MS);
    expect(p.calls).toEqual(["suspend", "resume"]);
  });
});

describe("trading hours are SAST", () => {
  test("07:00 opens, 19:00 closes", () => {
    expect(isTradingHours(Date.parse("2026-09-22T04:59:00Z"))).toBe(false); // 06:59
    expect(isTradingHours(Date.parse("2026-09-22T05:00:00Z"))).toBe(true);  // 07:00
    expect(isTradingHours(Date.parse("2026-09-22T16:59:00Z"))).toBe(true);  // 18:59
    expect(isTradingHours(Date.parse("2026-09-22T17:00:00Z"))).toBe(false); // 19:00
  });
  test("a hidden page that was never visible counts from when it was hidden", () => {
    expect(shouldSuspend({
      now: NIGHT, hidden: true, hiddenSince: null, lastActivityAt: 0, mirrored: true, busy: false, watchSurface: false,
    })).toBe(false);
  });
});
