// ─── THE MUTE — the pure proofs ──────────────────────────────────────────────
// Mutation-proven by scripts/mutation-proof-push-notify.mjs (U1–U5).
//
// The failure this file guards against is the one that produced this release.
// #569's personal switch was an OPT-IN, which made it load-bearing for
// delivery: a person had to find it before an assignment could reach them, and
// when it was deleted in #573 the permission prompt went with it and nobody
// received anything for two days. A MUTE has neither property, and the tests
// that matter most here are the ones that pin "never touched it" to AUDIBLE.

import { describe, it, expect } from "vitest";
import { isMuted, muteUpdates, pushMutePath, pushMuteFlagPath, PUSH_MUTES_PATH } from "./pushMute";

describe("isMuted — absence is AUDIBLE, and that is the default for everybody", () => {
  it("no record at all is not muted", () => {
    expect(isMuted(null)).toBe(false);
    expect(isMuted(undefined)).toBe(false);
  });

  it("an empty record is not muted", () => {
    expect(isMuted({})).toBe(false);
  });

  it("a real boolean true is muted", () => {
    expect(isMuted({ muted: true, updatedAt: 1 })).toBe(true);
  });

  it("reads the BARE LEAF too — the fan-out asks for push_mutes/{uid}/muted", () => {
    expect(isMuted(true)).toBe(true);
    expect(isMuted(false)).toBe(false);
  });

  it("muted:false is audible — unmuting deletes, so this shape should not exist, and is read the safe way if it does", () => {
    expect(isMuted({ muted: false, updatedAt: 1 })).toBe(false);
  });

  it("ONLY A REAL BOOLEAN MUTES — corruption degrades towards DELIVERY", () => {
    // The opposite direction from assignedHubs(), and deliberately: there the
    // harm is notifying somebody nobody chose, here it is silencing somebody
    // who WAS chosen. Every one of these is a value the switch cannot write.
    expect(isMuted({ muted: "true" })).toBe(false);
    expect(isMuted({ muted: 1 })).toBe(false);
    expect(isMuted({ muted: "yes" })).toBe(false);
    expect(isMuted({ muted: {} })).toBe(false);
  });

  it("is TOTAL — no shape of input throws", () => {
    for (const v of [0, "", "muted", [], [true], NaN, () => {}, Symbol("x")]) {
      expect(() => isMuted(v)).not.toThrow();
      expect(isMuted(v)).toBe(false);
    }
  });

  it("an array is never a record, however it is filled", () => {
    const arr = [];
    arr.muted = true;
    expect(isMuted(arr)).toBe(false);
  });
});

describe("muteUpdates — one representation of each answer", () => {
  it("muting writes the flag and a server stamp", () => {
    expect(muteUpdates("u1", true, 1234)).toEqual({
      "push_mutes/u1": { muted: true, updatedAt: 1234 },
    });
  });

  it("UNMUTING DELETES — it never stores muted:false", () => {
    // Two representations of one answer is a thing every later reader has to
    // agree about, and one of them eventually will not. Absence is audible, so
    // audible must produce absence.
    expect(muteUpdates("u1", false, 1234)).toEqual({ "push_mutes/u1": null });
  });

  it("is written from the database ROOT, so it composes with assignmentUpdates", () => {
    const upd = muteUpdates("u1", true, 1);
    expect(Object.keys(upd)).toEqual(["push_mutes/u1"]);
    expect(Object.keys(upd)[0].startsWith("/")).toBe(false);
  });

  it("TOUCHES ONLY /push_mutes — a mute may never write an assignment or an audience", () => {
    // The whole safety argument for a client-writable node. If this ever grew
    // a second path the switch would be granting something.
    for (const muted of [true, false]) {
      for (const path of Object.keys(muteUpdates("u1", muted, 1))) {
        expect(path.startsWith(`${PUSH_MUTES_PATH}/`)).toBe(true);
      }
    }
  });

  it("REFUSES a uid RTDB could not store, rather than letting the SDK throw", () => {
    // The SDK throws SYNCHRONOUSLY on an illegal key, before any promise exists
    // to catch it — so a refusal here is the difference between a setting that
    // does not save and a home screen that crashes. Same lesson as #269.
    for (const bad of ["a.b", "a#b", "a$b", "a/b", "a[b", "a]b", "", null, undefined, 7]) {
      expect(() => muteUpdates(bad, true, 1)).toThrow(/unusable uid/);
    }
  });

  it("a legal uid with unusual characters is accepted", () => {
    expect(() => muteUpdates("__proto__", true, 1)).not.toThrow();
    expect(muteUpdates("-Nabc_123", true, 1)["push_mutes/-Nabc_123"]).toEqual({ muted: true, updatedAt: 1 });
  });
});

describe("the paths", () => {
  it("the record is per-uid, so the rule can scope both read and write to auth.uid", () => {
    expect(pushMutePath("u1")).toBe("push_mutes/u1");
  });

  it("the fan-out reads the LEAF — the smallest read RTDB can be asked for", () => {
    expect(pushMuteFlagPath("u1")).toBe("push_mutes/u1/muted");
  });

  it("neither path is the node — a whole-node read would grow with headcount for ever", () => {
    expect(pushMutePath("u1")).not.toBe(PUSH_MUTES_PATH);
    expect(pushMuteFlagPath("u1").startsWith(`${PUSH_MUTES_PATH}/`)).toBe(true);
  });
});
