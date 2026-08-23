// ─── THE IDENTITY CACHE — patched as you work, and never blank ───────────────
// The behaviours pinned here are the ones a warehouse pass depends on:
//   • registering a shoe updates the map with NO network round trip;
//   • `ready` never goes back to false, so a list is never emptied mid-pass;
//   • a response that was superseded while in flight is DISCARDED — the older
//     map must not win a race against a patch;
//   • a failed call resolves to what we already had, never a rejection.

import { describe, it, expect, beforeEach, vi } from "vitest";

let calls = 0;
let respond = async () => ({ data: { map: {} } });
vi.mock("../firebase", () => ({ functions: {} }));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => (...a) => { calls += 1; return respond(...a); },
}));

const store = await import("./labelIdentityStore.js");

beforeEach(() => {
  store.__resetIdentityCacheForTests();
  calls = 0;
  respond = async () => ({ data: { map: {} } });
});

describe("fetching", () => {
  it("fetches once and shares the result", async () => {
    respond = async () => ({ data: { map: { p1: { c: ["X"], a: [] } } } });
    const [a, b] = await Promise.all([store.fetchIdentityMap(), store.fetchIdentityMap()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.p1.c).toEqual(["X"]);
  });

  it("a failed call resolves to a usable map, never a rejection", async () => {
    respond = async () => { throw new Error("permission-denied"); };
    await expect(store.fetchIdentityMap()).resolves.toEqual({});
  });

  it("a failed call is not cached — the next screen retries", async () => {
    respond = async () => { throw new Error("nope"); };
    await store.fetchIdentityMap();
    await store.fetchIdentityMap();
    expect(calls).toBe(2);
  });
});

describe("patching beats refetching", () => {
  it("noteRegistered updates the map with NO round trip", async () => {
    await store.fetchIdentityMap();
    expect(calls).toBe(1);
    store.noteRegistered("p9", { codes: ["BQ6817302"] });
    expect(calls).toBe(1);                        // still one — nothing refetched
    await expect(store.fetchIdentityMap()).resolves.toMatchObject({ p9: { c: ["BQ6817302"] } });
    expect(calls).toBe(1);
  });

  it("a wording-only registration registers the product too", async () => {
    await store.fetchIdentityMap();
    store.noteRegistered("p9", { tokens: ["NIKE", "AIR"] });
    const map = await store.fetchIdentityMap();
    expect(map.p9.a).toEqual([["AIR", "NIKE"]]);
  });

  it("an EMPTY patch never manufactures an identity", async () => {
    await store.fetchIdentityMap();
    store.noteRegistered("p9", {});
    const map = await store.fetchIdentityMap();
    expect(map.p9).toBeUndefined();
  });

  it("patches accumulate rather than replacing each other", async () => {
    await store.fetchIdentityMap();
    store.noteRegistered("p9", { codes: ["AAA"] });
    store.noteRegistered("p9", { codes: ["BBB"], tokens: ["ONE", "TWO"] });
    const map = await store.fetchIdentityMap();
    expect(map.p9.c).toEqual(["AAA", "BBB"]);
    expect(map.p9.a).toEqual([["ONE", "TWO"]]);
  });
});

describe("the stale-response race", () => {
  it("a response superseded by a patch while in flight is DISCARDED", async () => {
    let release;
    respond = () => new Promise((r) => { release = () => r({ data: { map: { p1: { c: ["OLD"], a: [] } } } }); });
    const inFlight = store.fetchIdentityMap();
    // A registration lands before the (slow) response does.
    store.noteRegistered("p9", { codes: ["JUST_WRITTEN"] });
    release();
    await inFlight;
    const map = await store.fetchIdentityMap();
    expect(map.p9.c).toEqual(["JUST_WRITTEN"]);
    expect(map.p1).toBeUndefined();   // the older answer did NOT overwrite the patch
  });

  it("a response superseded by an invalidate while in flight is DISCARDED — and the store refetches ITSELF", async () => {
    let release;
    let n = 0;
    respond = () => {
      n += 1;
      // Call 1: the slow, about-to-be-stale answer, released by hand below.
      // Call 2: the replacement — it must happen WITHOUT anyone asking again.
      if (n === 1) return new Promise((r) => { release = () => r({ data: { map: { p1: { c: ["OLD"], a: [] } } } }); });
      return Promise.resolve({ data: { map: { p3: { c: ["FRESH"], a: [] } } } });
    };
    const inFlight = store.fetchIdentityMap();
    store.noteRegistered("p2", { codes: ["KEEP"] });
    store.invalidateIdentity();          // lands while call 1 is still in flight
    release();
    const map = await inFlight;          // the ORIGINAL waiter, no second call from the test
    expect(calls).toBe(2);               // the store started the replacement on its own
    expect(map.p3.c).toEqual(["FRESH"]); // and the original waiter got the fresh map
    expect(map.p1).toBeUndefined();      // the stale answer never landed
    expect(store.currentIdentityMap().p3.c).toEqual(["FRESH"]);
  });
});
