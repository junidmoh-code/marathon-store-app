// The TV voice state machine: persisted arming, the blocked fallback, silent
// re-arm on any touch, and the kiosk launch never showing the hint.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createVoiceKeeper, isKioskLaunch, readVoiceArmed, shouldShowVoiceHint, voiceWanted,
  VOICE_ARMED_KEY, RESUME_SETTLE_MS, START_RETRY_MS, PRIMER_EVERY_MS,
} from "./tvVoiceKeeper.js";

// A Web Audio context the test controls. `allow` decides whether resume()
// actually starts it — false is Chrome's autoplay block (resume stays pending).
function fakeCtx({ allow = false, state = "suspended" } = {}) {
  const listeners = {};
  const ctx = {
    state, allow, currentTime: 0, sampleRate: 44100, destination: {}, primers: 0, resumes: 0,
    resume() {
      ctx.resumes += 1;
      if (ctx.allow) { ctx.state = "running"; (listeners.statechange || []).forEach((f) => f()); return Promise.resolve(); }
      return new Promise(() => {}); // Chrome leaves it pending while blocked
    },
    createBuffer: () => ({}),
    createBufferSource: () => ({ connect() {}, start() { ctx.primers += 1; }, stop() {} }),
    onstatechange: null,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  };
  return ctx;
}

function fakeTarget() {
  const l = {};
  return {
    visibilityState: "visible",
    addEventListener: (t, f) => { (l[t] ||= []).push(f); },
    removeEventListener: (t, f) => { l[t] = (l[t] || []).filter((x) => x !== f); },
    fire: (t) => (l[t] || []).forEach((f) => f({ type: t })),
    count: (t) => (l[t] || []).length,
  };
}

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

const quiet = { warn: vi.fn() };

describe("tvVoiceKeeper", () => {
  beforeEach(() => { vi.useFakeTimers(); quiet.warn.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup({ allow, armed = false } = {}) {
    const ctx = fakeCtx({ allow });
    const storage = memStorage(armed ? { [VOICE_ARMED_KEY]: "1" } : {});
    const win = fakeTarget(), doc = fakeTarget();
    const states = [];
    const k = createVoiceKeeper({ getCtx: () => ctx, storage, win, doc, log: quiet, onChange: (s) => states.push(s) });
    return { ctx, storage, win, doc, states, k };
  }

  it("a browser that allows audio (kiosk flag) arms on load with no gesture and persists it", async () => {
    const { k, ctx, storage } = setup({ allow: true });
    await expect(k.start()).resolves.toBe(true);
    expect(k.getState()).toBe("armed");
    expect(storage.m.get(VOICE_ARMED_KEY)).toBe("1");
    expect(ctx.primers).toBeGreaterThan(0);
  });

  it("persisted-armed screen tries immediately on load; a blocking browser lands in 'blocked', not 'armed'", async () => {
    const { k, storage } = setup({ allow: false, armed: true });
    expect(readVoiceArmed(storage)).toBe(true);
    const p = k.start();
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS);
    await expect(p).resolves.toBe(false);
    expect(k.getState()).toBe("blocked");
    expect(quiet.warn).toHaveBeenCalled();
  });

  it("re-arms silently on the first incidental touch, and the arm survives a reload via localStorage", async () => {
    const { k, ctx, win, storage } = setup({ allow: false });
    const p = k.start();
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS);
    await p;
    expect(k.getState()).toBe("blocked");
    ctx.allow = true;                    // the touch is the gesture Chrome wanted
    win.fire("pointerdown");
    await vi.advanceTimersByTimeAsync(0);
    expect(k.getState()).toBe("armed");
    expect(storage.m.get(VOICE_ARMED_KEY)).toBe("1");
    // "Reload": a fresh keeper on the same storage reads the arm back.
    expect(readVoiceArmed(storage)).toBe(true);
  });

  it("listens in the capture phase for touch, key and focus, and stop() removes every listener", () => {
    const { k, win, doc } = setup({ allow: true });
    k.start();
    expect(win.count("pointerdown")).toBe(1);
    expect(win.count("keydown")).toBe(1);
    expect(win.count("focus")).toBe(1);
    expect(doc.count("visibilitychange")).toBe(1);
    k.stop();
    expect(win.count("pointerdown") + win.count("keydown") + win.count("focus") + doc.count("visibilitychange")).toBe(0);
  });

  it("re-runs the silent primer every few minutes and resumes on becoming visible", async () => {
    const { k, ctx, doc } = setup({ allow: true });
    await k.start();
    const before = ctx.primers;
    await vi.advanceTimersByTimeAsync(PRIMER_EVERY_MS * 2);
    expect(ctx.primers).toBe(before + 2);
    ctx.state = "suspended";
    doc.fire("visibilitychange");
    expect(ctx.state).toBe("running");
  });

  it("whenRunning retries once after 3 s, then logs the drop with the reason", async () => {
    const { k } = setup({ allow: false });
    const fn = vi.fn();
    k.whenRunning(fn, "Order 12");
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS + START_RETRY_MS + RESUME_SETTLE_MS);
    expect(fn).not.toHaveBeenCalled();
    expect(quiet.warn.mock.calls.some((c) => String(c[0]).includes('"Order 12" not spoken'))).toBe(true);
  });

  it("guardStart cancels a stuck queue (frozen clock) and retries the announcement once", async () => {
    const { k, ctx } = setup({ allow: true });
    await k.start();
    const stopped = [];
    const sources = [{ stop: () => stopped.push(1) }, { stop: () => stopped.push(2) }];
    const retry = vi.fn();
    const onCancel = vi.fn();
    k.guardStart({ sources, onCancel, retry, label: "Order 7" });
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);   // currentTime never moved
    expect(stopped).toEqual([1, 2]);
    expect(onCancel).toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("guardStart leaves a playing queue alone", async () => {
    const { k, ctx } = setup({ allow: true });
    await k.start();
    const retry = vi.fn();
    k.guardStart({ sources: [], retry, label: "x" });
    ctx.currentTime = 2;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);
    expect(retry).not.toHaveBeenCalled();
  });

  it("no Web Audio at all → 'unsupported', never a hint", async () => {
    const k = createVoiceKeeper({ getCtx: () => null, log: quiet });
    await k.start();
    expect(k.getState()).toBe("unsupported");
    expect(shouldShowVoiceHint({ kiosk: false, state: k.getState() })).toBe(false);
  });
});

describe("kiosk + hint policy", () => {
  it("?kiosk=1 is a kiosk launch; anything else is not", () => {
    expect(isKioskLaunch("?kiosk=1")).toBe(true);
    expect(isKioskLaunch("?section=1&kiosk=1")).toBe(true);
    expect(isKioskLaunch("?kiosk=0")).toBe(false);
    expect(isKioskLaunch("")).toBe(false);
  });

  it("kiosk mode never shows the hint, whatever the audio state", () => {
    for (const state of ["starting", "armed", "blocked", "unsupported"]) {
      expect(shouldShowVoiceHint({ kiosk: true, state })).toBe(false);
    }
  });

  it("outside kiosk the hint shows only when the browser really blocked audio", () => {
    expect(shouldShowVoiceHint({ kiosk: false, state: "starting" })).toBe(false);
    expect(shouldShowVoiceHint({ kiosk: false, state: "armed" })).toBe(false);
    expect(shouldShowVoiceHint({ kiosk: false, state: "blocked" })).toBe(true);
  });

  it("kiosk always wants to speak; elsewhere only once armed", () => {
    expect(voiceWanted({ kiosk: true, state: "starting" })).toBe(true);
    expect(voiceWanted({ kiosk: false, state: "starting" })).toBe(false);
    expect(voiceWanted({ kiosk: false, state: "armed" })).toBe(true);
  });
});
