// ─── THE ASSIGNMENT MODEL — the proofs ───────────────────────────────────────
// The failure this suite exists to prevent is one sentence long: somebody is
// notified whom nobody assigned, or somebody assigned is never notified.
//
// The model it replaced inferred a subscription from stockRole and destShop.
// Several tests below exist only to hold the line that NOTHING is inferred any
// more — a record carrying every one of those fields and no hub flag is still
// off. They look redundant. They are the whole point.
import { describe, it, expect } from "vitest";
import {
  PUSH_HUBS,
  PUSH_HUB_LABEL,
  assignedHubs,
  assignmentUpdates,
  isAssigned,
  isLegalKey,
  pushAssignmentPath,
  pushHubAudienceEntryPath,
  pushHubAudiencePath,
} from "./pushAssignments";

describe("absence is OFF, and nothing else may be read as consent", () => {
  it("no record at all means no hubs", () => {
    expect(assignedHubs(null)).toEqual([]);
    expect(assignedHubs(undefined)).toEqual([]);
    expect(isAssigned(null)).toBe(false);
  });

  it("an EMPTY record means no hubs", () => {
    expect(assignedHubs({})).toEqual([]);
  });

  it("stockRole, destShop, permissions and email are NOT an assignment", () => {
    // Every field the old resolver consulted, on one record, with no hub flag.
    const record = {
      stockRole: "warehouse",
      destShop: "marathon-pe",
      permissions: ["stock", "warehouse"],
      email: "gunidmoh@gmail.com",
      role: "admin",
      refillRequests: true,
    };
    expect(assignedHubs(record)).toEqual([]);
    expect(isAssigned(record)).toBe(false);
  });

  it("only a REAL boolean true counts — a stray value is corruption, not consent", () => {
    for (const truthy of ["true", 1, "hub1", {}, [], "yes"]) {
      expect(assignedHubs({ hub1: truthy })).toEqual([]);
    }
    expect(assignedHubs({ hub1: true })).toEqual(["hub1"]);
  });

  it("false is off, and so is null", () => {
    expect(assignedHubs({ hub1: false, hub2: null })).toEqual([]);
  });

  it("a malformed node does not throw", () => {
    for (const junk of ["", 0, 7, "hub1", [], [1, 2], true]) {
      expect(() => assignedHubs(junk)).not.toThrow();
      expect(assignedHubs(junk)).toEqual([]);
    }
  });
});

describe("the three real answers", () => {
  it("Hub 1 only", () => {
    expect(assignedHubs({ hub1: true, hub2: false })).toEqual(["hub1"]);
  });
  it("Hub 2 only", () => {
    expect(assignedHubs({ hub1: false, hub2: true })).toEqual(["hub2"]);
  });
  it("both, in a stable order", () => {
    expect(assignedHubs({ hub1: true, hub2: true })).toEqual(["hub1", "hub2"]);
    expect(assignedHubs({ hub2: true, hub1: true })).toEqual(["hub1", "hub2"]);
  });
  it("a hub outside the closed list is not an assignment", () => {
    expect(assignedHubs({ hub3: true, central: true })).toEqual([]);
  });
});

describe("the hubs an assignment may name", () => {
  it("is Hub 1 and Hub 2 — Pine runs its own floor", () => {
    expect(PUSH_HUBS).toEqual(["hub1", "hub2"]);
    expect(PUSH_HUBS).not.toContain("hub3");
  });
  it("every hub has words a person can read", () => {
    for (const hub of PUSH_HUBS) expect(typeof PUSH_HUB_LABEL[hub]).toBe("string");
  });
});

describe("paths", () => {
  it("keys the decision per user and the index per hub per user", () => {
    expect(pushAssignmentPath("u1")).toBe("push_assignments/u1");
    expect(pushHubAudiencePath("hub1")).toBe("push_hub_audience/hub1");
    expect(pushHubAudienceEntryPath("hub2", "u1")).toBe("push_hub_audience/hub2/u1");
  });
  it("refuses a uid RTDB could not store as a key", () => {
    for (const bad of ["a.b", "a#b", "a$b", "a/b", "a[b", "a]b", "", null, 7]) {
      expect(isLegalKey(bad)).toBe(false);
    }
    expect(isLegalKey("kK3dSl2Xy9")).toBe(true);
  });
});

describe("the write keeps the decision and the index in step", () => {
  const NOW = 1_757_000_000_000;

  it("assigning both hubs writes the record AND both index entries", () => {
    expect(assignmentUpdates("u1", ["hub1", "hub2"], NOW)).toEqual({
      "push_hub_audience/hub1/u1": { at: NOW },
      "push_hub_audience/hub2/u1": { at: NOW },
      "push_assignments/u1": { hub1: true, hub2: true, updatedAt: NOW },
    });
  });

  it("assigning ONE hub NULLS the other's index entry — otherwise it keeps firing", () => {
    const upd = assignmentUpdates("u1", ["hub1"], NOW);
    expect(upd["push_hub_audience/hub1/u1"]).toEqual({ at: NOW });
    expect(upd["push_hub_audience/hub2/u1"]).toBe(null);
    expect(upd["push_assignments/u1"]).toEqual({ hub1: true, hub2: false, updatedAt: NOW });
  });

  it("EVERY hub in the closed list is written on every save, set or nulled", () => {
    for (const hubs of [[], ["hub1"], ["hub2"], ["hub1", "hub2"]]) {
      const upd = assignmentUpdates("u1", hubs, NOW);
      for (const hub of PUSH_HUBS) {
        expect(Object.prototype.hasOwnProperty.call(upd, `push_hub_audience/${hub}/u1`)).toBe(true);
      }
    }
  });

  it("clearing an assignment DELETES the record — off must be absence, not a row of falses", () => {
    expect(assignmentUpdates("u1", [], NOW)).toEqual({
      "push_hub_audience/hub1/u1": null,
      "push_hub_audience/hub2/u1": null,
      "push_assignments/u1": null,
    });
  });

  it("an unknown hub is ignored rather than written as a path", () => {
    const upd = assignmentUpdates("u1", ["hub3", "central", "hub1"], NOW);
    expect(Object.keys(upd).sort()).toEqual([
      "push_assignments/u1",
      "push_hub_audience/hub1/u1",
      "push_hub_audience/hub2/u1",
    ]);
    expect(upd["push_assignments/u1"]).toEqual({ hub1: true, hub2: false, updatedAt: NOW });
  });

  it("hubs that is not a list at all clears, rather than throwing mid-save", () => {
    for (const junk of [null, undefined, "hub1", 3, {}]) {
      expect(assignmentUpdates("u1", junk, NOW)["push_assignments/u1"]).toBe(null);
    }
  });

  it("EVERY key it writes is a legal RTDB key", () => {
    const illegal = /[.#$[\]]/;
    for (const path of Object.keys(assignmentUpdates("u1", ["hub1", "hub2"], NOW))) {
      for (const seg of path.split("/")) expect(illegal.test(seg)).toBe(false);
    }
  });

  it("a uid RTDB could not store REFUSES the write instead of throwing inside the SDK", () => {
    expect(() => assignmentUpdates("a.b", ["hub1"], NOW)).toThrow(/unusable uid/);
    expect(() => assignmentUpdates("", ["hub1"], NOW)).toThrow(/unusable uid/);
  });

  it("the timestamp it stores is the one it was handed — a caller's clock, never Date.now()", () => {
    const upd = assignmentUpdates("u1", ["hub1"], 42);
    expect(upd["push_assignments/u1"].updatedAt).toBe(42);
    expect(upd["push_hub_audience/hub1/u1"].at).toBe(42);
  });
});
