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
  test("is EXCLUSIVE of the cursor — a consumed key is not re-read", () => {
    expect(constraintNames(keyPageConstraints({ after: "-Oz1", limit: 10 })))
      .toEqual(["orderByKey", "startAfter", "limitToFirst"]);
  });

  test("has no bound at all when there is no cursor", () => {
    expect(constraintNames(keyPageConstraints({ after: null, limit: 10 })))
      .toEqual(["orderByKey", "limitToFirst"]);
    expect(constraintNames(keyPageConstraints({ limit: 10 })))
      .toEqual(["orderByKey", "limitToFirst"]);
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

describe("the two are not the same query", () => {
  test("one is exclusive and the other inclusive, deliberately", () => {
    const keyBound = constraintNames(keyPageConstraints({ after: "x", limit: 1 }))[1];
    const tsBound = constraintNames(childPageConstraints("ts", { from: "x", limit: 1 }))[1];
    expect(keyBound).toBe("startAfter");
    expect(tsBound).toBe("startAt");
    expect(keyBound).not.toBe(tsBound);
  });
});
