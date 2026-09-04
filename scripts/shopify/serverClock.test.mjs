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
