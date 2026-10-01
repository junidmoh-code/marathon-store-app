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
  keyPageConstraints, childPageConstraints, constraintNames,
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
