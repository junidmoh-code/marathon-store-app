// A capture that fails must say WHICH failure it was. For two days it said
// "That did not go through. Check the signal and try again." for a photo that
// reached the server, was sent to the AI reader, and came back HTTP 429 — an
// exhausted prepaid balance. Everybody looked at the phone, the signal and a
// registry change; nobody could look at the one place the answer was.
//
// So each distinguishable failure is pinned to its own sentence here, and the
// catch-all is pinned to being LAST.
import { describe, it, expect } from "vitest";
import {
  describeCallableFailure, rememberFailure, readFailures, clearFailures, failureLine, STAGE,
} from "./captureFailure";

const fbErr = (code, message) => Object.assign(new Error(message), { code });

describe("a rejected callable names itself", () => {
  it("quotes the SERVER's own refusal, because it was written for the till", () => {
    // These sentences exist in the callable for exactly this moment, and the
    // screen was throwing every one of them away.
    for (const [code, message] of [
      ["functions/invalid-argument", "Photo 1 is too large — retake it."],
      ["functions/invalid-argument", "Photo 1 is not valid base64."],
      ["functions/failed-precondition", "Pick the till first."],
    ]) {
      const out = describeCallableFailure(fbErr(code, message));
      expect(out.reason).toBe(message);
      expect(out.retryable).toBe(false);
    }
  });

  it("an exhausted reader says so, and does NOT say try again", () => {
    // THE ONE THAT HAPPENED. "Try again" is not merely unhelpful here, it is
    // false: the retry costs nothing, fixes nothing, and tells the manager the
    // fault is theirs.
    const out = describeCallableFailure(fbErr(
      "functions/resource-exhausted",
      "The slip reader is out of credit, so photographed slips cannot be read until it is topped up.",
    ));
    expect(out.kind).toBe("resource-exhausted");
    expect(out.retryable).toBe(false);
    expect(out.reason).toMatch(/out of credit/);
    expect(out.reason).not.toMatch(/check the signal/i);
  });

  it("a DEAD NETWORK is the one callable code that is not the server talking", () => {
    // The Firebase SDK reports an unreachable backend as `functions/internal`
    // with the message "internal". Quoting that back would put the word
    // "internal" on a shop floor.
    const out = describeCallableFailure(fbErr("functions/internal", "internal"));
    expect(out.kind).toBe("transport");
    expect(out.reason).toMatch(/did not reach the server/);
    expect(out.retryable).toBe(true);
  });

  it("…but an `internal` that DID carry a sentence is the server talking", () => {
    const out = describeCallableFailure(fbErr("functions/internal", "The slip could not be matched to its terminal."));
    expect(out.reason).toBe("The slip could not be matched to its terminal.");
    expect(out.kind).toBe("internal");
  });

  it("a timeout blames the upload, not the till", () => {
    const out = describeCallableFailure(fbErr("functions/deadline-exceeded", "deadline-exceeded"));
    expect(out.reason).toMatch(/took too long/);
    expect(out.reason).toMatch(/wifi/);
  });

  it("a permission failure tells the manager what to do before it tells them who to tell", () => {
    const out = describeCallableFailure(fbErr("functions/permission-denied", ""));
    expect(out.reason).toMatch(/not allowed to capture/);
    expect(out.reason).toMatch(/Sign out and in again/);
    expect(out.retryable).toBe(false);
  });

  it("a browser-level network error is recognised without a callable code", () => {
    for (const m of ["NetworkError when attempting to fetch resource.", "Failed to fetch", "Load failed"]) {
      expect(describeCallableFailure(new Error(m)).kind).toBe("transport");
    }
  });

  it("the catch-all is LAST, and still carries whatever it was given", () => {
    const out = describeCallableFailure(new TypeError("x is not a function"));
    expect(out.kind).toBe("unknown");
    expect(out.reason).toMatch(/x is not a function/);
    // …and a failure with nothing at all still produces a sentence, never an
    // empty red box.
    const nothing = describeCallableFailure(undefined);
    expect(nothing.reason).toMatch(/gave no reason/);
    expect(nothing.reason.length).toBeGreaterThan(20);
  });

  it("every branch answers, and no two of the named ones share a sentence", () => {
    // A vocabulary whose words are the same word is not a vocabulary.
    const said = [
      fbErr("functions/resource-exhausted", ""),
      fbErr("functions/unavailable", ""),
      fbErr("functions/deadline-exceeded", ""),
      fbErr("functions/permission-denied", ""),
      fbErr("functions/internal", "internal"),
      new TypeError("boom"),
    ].map((e) => describeCallableFailure(e).reason);
    expect(new Set(said).size).toBe(said.length);
    for (const s of said) expect(s.length).toBeGreaterThan(20);
  });
});

describe("the breadcrumb the owner reads on the phone", () => {
  const store = () => {
    const held = new Map();
    return {
      getItem: (k) => (held.has(k) ? held.get(k) : null),
      setItem: (k, v) => held.set(k, String(v)),
      removeItem: (k) => held.delete(k),
    };
  };

  it("keeps the newest first, and keeps only a few", () => {
    const s = store();
    for (let i = 1; i <= 8; i++) rememberFailure({ at: i, tid: "0000HP1X", stage: STAGE.EXTRACT, kind: "k", detail: `d${i}` }, s);
    const rows = readFailures(s);
    expect(rows).toHaveLength(5);
    expect(rows[0].detail).toBe("d8");
    expect(rows[4].detail).toBe("d4");
  });

  it("clips a long refusal — this is evidence, not prose", () => {
    const s = store();
    rememberFailure({ at: 1, tid: "T", stage: "extract", kind: "k", detail: "x".repeat(900) }, s);
    expect(readFailures(s)[0].detail).toHaveLength(300);
  });

  it("never throws when storage is unavailable or unreadable", () => {
    expect(() => rememberFailure({ at: 1 }, null)).not.toThrow();
    expect(readFailures(null)).toEqual([]);
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    expect(() => rememberFailure({ at: 1 }, broken)).not.toThrow();
    expect(readFailures(broken)).toEqual([]);
    expect(() => clearFailures(broken)).not.toThrow();
  });

  it("reads as one line, with the time the caller formatted", () => {
    const line = failureLine(
      { tid: "0000HP1X", stage: "extract", kind: "resource-exhausted", detail: "functions/resource-exhausted out of credit" },
      "18 Sep, 20:12",
    );
    expect(line).toBe("18 Sep, 20:12 · 0000HP1X · extract · resource-exhausted — functions/resource-exhausted out of credit");
  });

  it("a row with nothing in it still renders as something", () => {
    expect(failureLine({}, "")).toBe("");
    expect(failureLine({ tid: "T" }, "now")).toBe("now · T");
  });
});
