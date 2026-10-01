// ── The server clock, behaviourally ──────────────────────────────────────────
// `serverNowMs` existed to keep a machine's own clock out of the data, and it
// did not work: it read `/.info/serverTimeOffset` with `.get()`, which THROWS,
// so its catch set the offset to 0 on every call and it was a plain alias for
// `Date.now()` from the day it was written. Nothing noticed because nothing
// tested it — reverting the fix passes every source guard in this repo, which
// is why this file drives the function instead of reading it.
//
// WHY `.get()` CANNOT WORK, and why a fake has to model it: `/.info` is a
// CLIENT-SYNTHESISED tree with nothing behind it on the server. The SDK routes
// a read there to `infoSyncTree_` only through the event path
// (`repoAddEventCallbackForQuery`, which tests `pathGetFront(path) === ".info"`);
// `repoGetValue`, which backs `.get()`, has no such branch and asks the wire for
// a path literally named ".info/serverTimeOffset".
//
// Measured on the Mac mini, 4 Sep 2026, through the same firebase-admin the
// scripts load:
//     get()          -> THREW "Invalid token in path"
//     once("value")  -> -88   (the real offset, in ms)
// The fake below reproduces exactly that, so a revert to `.get()` fails here.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The real SDK's behaviour on /.info, as measured.
function fakeDb(offset) {
  const calls = { get: 0, once: 0 };
  return {
    calls,
    ref(path) {
      const isInfo = path.split("/")[0] === ".info";
      return {
        async get() {
          calls.get += 1;
          if (isInfo) throw new Error("Invalid token in path");
          return { val: () => null };
        },
        async once(kind) {
          calls.once += 1;
          expect(kind).toBe("value");
          return { val: () => (isInfo ? offset : null) };
        },
      };
    },
  };
}

// serverNowMs memoises the offset for the life of the module, so each test gets
// a fresh copy of it. vi.resetModules() is the supported way — a query-string
// cache-buster is not statically analysable and Vite refuses it.
const load = async () => {
  vi.resetModules();
  return (await import("./publishNode.mjs")).serverNowMs;
};

describe("serverNowMs actually reads the server's clock", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("applies a NEGATIVE offset (the mini runs ahead)", async () => {
    const serverNowMs = await load();
    const db = fakeDb(-88);
    const before = Date.now();
    const t = await serverNowMs(db);
    expect(t).toBeLessThan(before);              // corrected backwards
    expect(before - t).toBeGreaterThanOrEqual(80);
    expect(before - t).toBeLessThanOrEqual(200);
  });

  it("applies a POSITIVE offset (the machine runs behind)", async () => {
    const serverNowMs = await load();
    const t = await serverNowMs(fakeDb(5000));
    expect(t - Date.now()).toBeGreaterThan(4000);
  });

  // The regression itself. A `.get()` on /.info throws, so a version that used
  // it fell into its catch and returned the raw clock — with the offset well
  // outside any plausible jitter, "uncorrected" is unmistakable.
  it("does NOT fall back to the raw clock when an offset is available", async () => {
    const serverNowMs = await load();
    const db = fakeDb(3_600_000);   // an hour out; no jitter looks like this
    const t = await serverNowMs(db);
    expect(t - Date.now(), "the offset was dropped — serverNowMs returned Date.now()")
      .toBeGreaterThan(3_000_000);
    expect(db.calls.once, "the offset must be read through once('value')").toBe(1);
    expect(db.calls.get, "a .get() on /.info throws; it must not be used").toBe(0);
  });

  it("memoises: one offset read for the life of the process", async () => {
    const serverNowMs = await load();
    const db = fakeDb(-88);
    await serverNowMs(db); await serverNowMs(db); await serverNowMs(db);
    expect(db.calls.once).toBe(1);
  });

  // A HANG IS NOT A FAILURE THE CATCH CAN SEE. `once("value")` on /.info does
  // not fire until the connection handshake completes — which is precisely what
  // makes the fix correct, since there is no premature 0 to swallow — and it
  // therefore never throws if the connection never comes up. This is the FIRST
  // awaited RTDB call in a reconcile tick, and a hung tick holds the runner's
  // single-flight lock indefinitely (reconcile-runner.mjs is explicit that a
  // live run is never interrupted, however slow). So it is bounded, and the
  // bound falls into the same loud degrade as any other failure.
  it("does not wait for ever on a connection that never comes up", async () => {
    vi.useFakeTimers();
    try {
      const serverNowMs = await load();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const never = { ref: () => ({ once: () => new Promise(() => {}) }) };
      const p = serverNowMs(never);
      await vi.advanceTimersByTimeAsync(11_000);
      const t = await p;
      // Degraded to the raw clock: the offset was 0, so the value is this
      // machine's clock as at the moment the timer fired. Fake timers advance
      // Date.now() as well, so the gap is the remaining 1s of the advance, not
      // a correction — hence the tolerance rather than an equality.
      expect(Math.abs(t - Date.now())).toBeLessThan(2000);
      expect(spy.mock.calls.flat().join(" ")).toMatch(/timed out/);
      spy.mockRestore();
    } finally { vi.useRealTimers(); }
  });

  // It must never block a take-down. A failing read degrades to the raw clock —
  // but LOUDLY, because a silent degrade is what hid the original bug.
  it("degrades to the raw clock when the offset cannot be read, and says so", async () => {
    const serverNowMs = await load();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = { ref: () => ({ async once() { throw new Error("offline"); } }) };
    const t = await serverNowMs(db);
    expect(Math.abs(t - Date.now())).toBeLessThan(1000);
    expect(spy.mock.calls.flat().join(" ")).toMatch(/serverTimeOffset/);
    spy.mockRestore();
  });
});
