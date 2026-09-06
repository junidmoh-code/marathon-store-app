// ─── AUDIO IS LOCKED UNTIL A GESTURE, AND SILENCE MUST NEVER BE A CRASH ──────
// The property worth pinning is the one that fails invisibly: a chime played
// before the page has had a user gesture does not error, it is silently
// dropped. Code that "worked" in a test and made no sound in the shop is the
// exact outcome this guards against.
import { describe, it, expect, beforeEach, vi } from "vitest";

let handlers;
let resumed;

function installAudioWindow({ withAudio = true } = {}) {
  handlers = new Map();
  resumed = 0;
  class FakeParam {
    setValueAtTime() {} exponentialRampToValueAtTime() {}
  }
  class FakeCtx {
    constructor() { this.currentTime = 0; this.state = "suspended"; this.destination = {}; }
    resume() { resumed += 1; this.state = "running"; }
    createOscillator() { return { type: "", frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: new FakeParam(), connect() {} }; }
  }
  globalThis.window = {
    AudioContext: withAudio ? FakeCtx : undefined,
    addEventListener: (ev, fn) => { handlers.set(ev, fn); },
    removeEventListener: (ev) => { handlers.delete(ev); },
  };
}

describe("the chime", () => {
  beforeEach(() => { vi.resetModules(); installAudioWindow(); });

  it("plays NOTHING before a user gesture — the browser would drop it anyway", async () => {
    const { playChime, audioUnlocked } = await import("./chime");
    expect(audioUnlocked()).toBe(false);
    expect(playChime()).toBe(false);
  });

  it("the first gesture after load unlocks playback, once", async () => {
    const { armAudioUnlock, playChime, audioUnlocked } = await import("./chime");
    armAudioUnlock();
    expect(handlers.has("pointerdown")).toBe(true);
    handlers.get("pointerdown")();
    expect(audioUnlocked()).toBe(true);
    expect(resumed).toBe(1);
    // The listener removes itself: a page that keeps re-resuming the context on
    // every tap for the rest of the session is a leak, not a feature.
    expect(handlers.has("pointerdown")).toBe(false);
    expect(playChime()).toBe(true);
  });

  it("a keyboard press counts as the gesture too — tills have no touchscreen worth using", async () => {
    const { armAudioUnlock, audioUnlocked } = await import("./chime");
    armAudioUnlock();
    handlers.get("keydown")();
    expect(audioUnlocked()).toBe(true);
  });

  it("returns false instead of throwing when the browser has no Web Audio at all", async () => {
    vi.resetModules();
    installAudioWindow({ withAudio: false });
    const { armAudioUnlock, playChime } = await import("./chime");
    armAudioUnlock();
    handlers.get("pointerdown")();
    expect(() => playChime()).not.toThrow();
    expect(playChime()).toBe(false);
  });
});
