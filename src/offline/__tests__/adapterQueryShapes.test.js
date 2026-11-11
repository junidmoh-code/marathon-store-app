// ─── THE FAKE CANNOT VOUCH FOR THE REAL QUERY ────────────────────────────────
//
// Every sync test runs against src/offline/__tests__/fakeAdapter.js, which
// RE-IMPLEMENTS the query semantics it stands in for. A mutation audit flipped
// `startAt` to `startAfter` in the production adapter and all 206 tests stayed
// green: the test named "the ts cursor is INCLUSIVE, so movements sharing a
// timestamp are not skipped" was proving the fake, not the code.
//
// That one character loses every /stock_movements row that shares a timestamp
// with the cursor — which is every movement of a multi-size transfer but one —
// silently, for ever.
//
// So this file asserts the REAL constraint objects the real adapter builds.
// It is the same job changeLegsMatch.test.js does for the two leg tables.
import { describe, test, expect } from "vitest";
import {
  keyPageConstraints, childPageConstraints, constraintNames, changeSignalConstraints,
  createRtdbAdapter,
} from "../rtdbAdapter";

describe("the key-page query", () => {
  // startAfter + limitToFirst(n) comes back n-1 on this database — the server
  // counts the cursor's row and the SDK drops it — and on /stock (limit 1) it
  // came back EMPTY. Measured live 2026-09-21. So the wire query is INCLUSIVE
  // and asks for one extra; readKeyPage drops the cursor's row itself.
  test("is INCLUSIVE on the wire and asks for one extra row", () => {
    const parts = keyPageConstraints({ after: "-Oz1", limit: 10 });
    expect(constraintNames(parts)).toEqual(["orderByKey", "startAt", "limitToFirst"]);
    expect(constraintNames(parts)).not.toContain("startAfter");
    expect(parts[2]._limit).toBe(11);
  });

  test("has no bound at all when there is no cursor, and no extra row", () => {
    expect(constraintNames(keyPageConstraints({ after: null, limit: 10 })))
      .toEqual(["orderByKey", "limitToFirst"]);
    expect(keyPageConstraints({ limit: 10 })[1]._limit).toBe(10);
  });

  test("takes the page from the FRONT — a forward walk, not the tail", () => {
    const parts = keyPageConstraints({ after: null, limit: 10 });
    expect(constraintNames(parts)).toContain("limitToFirst");
    expect(constraintNames(parts)).not.toContain("limitToLast");
  });
});

describe("the ts-page query", () => {
  test("is INCLUSIVE of the cursor — ts is not unique", () => {
    // One transfer writes several movements with an identical ISO string.
    // startAfter would keep the one that set the cursor and lose the rest.
    expect(constraintNames(childPageConstraints("ts", { from: "2026-09-01T00:00:00.000Z", limit: 10 })))
      .toEqual(["orderByChild", "startAt", "limitToFirst"]);
  });

  test("orders by the field it was given, not by key", () => {
    const parts = childPageConstraints("ts", { from: null, limit: 10 });
    expect(constraintNames(parts)).toEqual(["orderByChild", "limitToFirst"]);
  });
});

describe("neither query uses startAfter", () => {
  test("both bounds are startAt — the key page drops its cursor row itself", () => {
    const keyBound = constraintNames(keyPageConstraints({ after: "x", limit: 1 }))[1];
    const tsBound = constraintNames(childPageConstraints("ts", { from: "x", limit: 1 }))[1];
    expect(keyBound).toBe("startAt");
    expect(tsBound).toBe("startAt");
  });
});

describe("the compound ts cursor", () => {
  test("carries the key as well as the value, so a resume is one row not a timestamp", () => {
    expect(constraintNames(childPageConstraints("ts", {
      from: "2026-09-15T07:35:13.608Z", fromKey: "sold:abc", limit: 10,
    }))).toEqual(["orderByChild", "startAt", "limitToFirst"]);
  });

  test("a cursor with no key still bounds on the value alone", () => {
    // A cursor stored by an older build, and the first page of a fresh walk.
    const parts = childPageConstraints("ts", { from: "2026-09-15T00:00:00.000Z", fromKey: null, limit: 10 });
    expect(constraintNames(parts)).toEqual(["orderByChild", "startAt", "limitToFirst"]);
  });

  // VERIFIED AGAINST THE LIVE DATABASE, 2026-09-19 (read-only, from the Mac
  // mini — node on the laptop cannot reach Google). Recorded here because the
  // semantics are the SERVER's and no unit test can establish them:
  //
  //   /stock_movements under orderByChild("ts") is ordered by (ts, key).
  //   startAt(ts, key) is INCLUSIVE of that exact pair.
  //   A row sharing the ts but sorting before the key is EXCLUDED.
  //
  // And in one eight-row live page, three movements shared
  // 2026-09-15T07:35:13.608Z and two shared 2026-09-15T07:21:12.205Z — a
  // single sale writing several lines at one instant. An exclusive bound would
  // have lost two of the first three. The hazard is measured, not imagined.
});

// ─── THE CHANGE SIGNAL ──────────────────────────────────────────────────────
//
// Measured on the fleet, 11 Nov 2026 08:00–11:00: one handset whose cursor had
// been dropped subscribed to the WHOLE change log six times (9.7 MB each), and
// 306 cursor-bounded subscribes delivered 20 MB of backlog that the pass then
// read again as pages. The signal only has to say "something was written".
describe("the change signal", () => {
  test("is exactly ONE record wide — the newest — whatever the cursor is", () => {
    const parts = changeSignalConstraints();
    expect(constraintNames(parts)).toEqual(["orderByKey", "limitToLast"]);
    expect(parts[1]._limit).toBe(1);
  });

  test("never carries a start bound: it cannot be opened over a backlog, or over the whole log", () => {
    const names = constraintNames(changeSignalConstraints());
    expect(names).not.toContain("startAfter");
    expect(names).not.toContain("startAt");
    expect(names).not.toContain("limitToFirst");
  });
});

// ─── THE KEYS-ONLY READ ─────────────────────────────────────────────────────
describe("shallowKeys — a node's keys without its values", () => {
  const db = { app: { options: { databaseURL: "https://example-rtdb.firebasedatabase.app/" } } };
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  test("asks the REST API for shallow=true as the signed-in user, and weighs what came back", async () => {
    const urls = [];
    let bytes = 0;
    const adapter = createRtdbAdapter({
      db, onBytes: (n) => { bytes += n; },
      getIdToken: async () => "tok en",
      fetchFn: async (url) => { urls.push(url); return ok({ p1: true, p2: true }); },
    });
    expect(await adapter.shallowKeys("settings/displaySlots/marathon-pe")).toEqual(["p1", "p2"]);
    expect(urls).toEqual([
      "https://example-rtdb.firebasedatabase.app/settings/displaySlots/marathon-pe.json?shallow=true&auth=tok%20en",
    ]);
    expect(bytes).toBe(JSON.stringify({ p1: true, p2: true }).length);
  });

  test("an ARRAY body (dense integer keys) names its indices — and a hole is not a key", async () => {
    const adapter = createRtdbAdapter({ db, getIdToken: async () => "t", fetchFn: async () => ok([null, true, null, true, true]) });
    expect(await adapter.shallowKeys("x")).toEqual(["1", "3", "4"]);
  });

  test("a null value in an object body is not a key either", async () => {
    const adapter = createRtdbAdapter({ db, getIdToken: async () => "t", fetchFn: async () => ok({ a: true, b: null, c: true }) });
    expect(await adapter.shallowKeys("x")).toEqual(["a", "c"]);
  });

  test("the fake answers both shapes the same way", async () => {
    const { createFakeRtdb } = await import("./fakeAdapter");
    const w = createFakeRtdb({ dense: [null, { n: 1 }, null, { n: 3 }], sparse: { a: { n: 1 }, c: { n: 3 } } });
    expect(await w.adapter.shallowKeys("dense")).toEqual(["1", "3"]);
    expect(await w.adapter.shallowKeys("sparse")).toEqual(["a", "c"]);
    expect(await w.adapter.shallowKeys("nowhere")).toEqual([]);
  });

  test("a leaf, and an absent node, have no keys", async () => {
    for (const body of [null, true, 7, "x"]) {
      const adapter = createRtdbAdapter({ db, getIdToken: async () => "t", fetchFn: async () => ok(body) });
      expect(await adapter.shallowKeys("x")).toEqual([]);
    }
  });

  test("a refusal is a permission error, named so the caller can tell it from a fault", async () => {
    const adapter = createRtdbAdapter({
      db, getIdToken: async () => "t", fetchFn: async () => ({ ok: false, status: 401, text: async () => "" }),
    });
    await expect(adapter.shallowKeys("orders")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("a key read that is refused is ABORTED, not left downloading a body nobody will read", async () => {
    let signal = null;
    const adapter = createRtdbAdapter({
      db, getIdToken: async () => "t",
      fetchFn: async (url, init) => { signal = init?.signal ?? null; return { ok: false, status: 500, text: async () => "" }; },
    });
    await expect(adapter.shallowKeys("products")).rejects.toThrow(/refused \(500\)/);
    expect(signal).not.toBeNull();
    expect(signal.aborted).toBe(true);
  });

  test("…and a read that succeeds is not aborted", async () => {
    let signal = null;
    const adapter = createRtdbAdapter({
      db, getIdToken: async () => "t",
      fetchFn: async (url, init) => { signal = init?.signal ?? null; return ok({ a: true }); },
    });
    await adapter.shallowKeys("products");
    expect(signal.aborted).toBe(false);
  });

  test("with nobody signed in, or no fetch, it fails — it never reads without a user", async () => {
    let called = 0;
    const fetchFn = async () => { called += 1; return ok({}); };
    await expect(createRtdbAdapter({ db, getIdToken: async () => null, fetchFn }).shallowKeys("x")).rejects.toThrow(/signed-in/);
    await expect(createRtdbAdapter({ db, fetchFn }).shallowKeys("x")).rejects.toThrow(/no shallow read/);
    await expect(createRtdbAdapter({ db, getIdToken: async () => "t", fetchFn: null }).shallowKeys("x")).rejects.toThrow(/no shallow read/);
    expect(called).toBe(0);
  });
});
