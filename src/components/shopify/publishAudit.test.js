// The off-audit contract. Every one of these pins a property that, had it
// held on 22 August 2026, would have made docs/PUBLISH-AUTO-OFF.md a
// two-minute query instead of a day's archaeology.
import { describe, it, expect } from "vitest";
import {
  OFF_REASONS, OFF_LOG_KEEP, buildOffRecord, offAuditFields, offAuditUpdate, describeOff,
} from "./publishAudit";

describe("buildOffRecord", () => {
  it("keeps the actor, the code, the detail and the instant", () => {
    const r = buildOffRecord({ at: 1700, actor: "uid1", reasonCode: "off_to_rename", detail: "  because  " });
    expect(r).toEqual({ at: 1700, actor: "uid1", reasonCode: "off_to_rename", detail: "because" });
  });

  it("REFUSES an unknown reason code", () => {
    // The whole point is that a row can always say something true. A code the
    // renderer does not know produces a row that says nothing, which is the
    // state this module exists to end — so it fails at the write, loudly.
    expect(() => buildOffRecord({ at: 1, actor: "u", reasonCode: "vibes" })).toThrow(/unknown off reasonCode/);
  });

  it("refuses a record with no actor", () => {
    expect(() => buildOffRecord({ at: 1, actor: "", reasonCode: "switched_off" })).toThrow(/actor/);
  });

  it("omits detail entirely rather than writing an empty string", () => {
    const r = buildOffRecord({ at: 1, actor: "u", reasonCode: "switched_off", detail: "   " });
    expect("detail" in r).toBe(false);
  });

  it("caps a runaway detail", () => {
    const r = buildOffRecord({ at: 1, actor: "u", reasonCode: "reconciler_refused", detail: "x".repeat(5000) });
    expect(r.detail.length).toBe(300);
  });
});

describe("offAuditFields", () => {
  const rec = (at) => buildOffRecord({ at, actor: "s", reasonCode: "switched_off" });

  it("writes lastOff and appends to the log", () => {
    const out = offAuditFields({ offLog: { 100: rec(100) } }, rec(200), 200);
    expect(out.lastOff.at).toBe(200);
    expect(Object.keys(out.offLog).sort()).toEqual(["100", "200"]);
  });

  it("trims the OLDEST entries, numerically — not by string order", () => {
    // 9999999999 (10 digits) sorts AFTER 10000000000 (11) as a string. A
    // string sort would drop the newest event and keep the oldest, which is
    // the opposite of a history.
    const log = {};
    for (let i = 0; i < OFF_LOG_KEEP + 5; i++) log[String(9999999995 + i)] = rec(9999999995 + i);
    const out = offAuditFields({ offLog: log }, rec(20000000000), 20000000000);
    const keys = Object.keys(out.offLog).map(Number).sort((a, b) => a - b);
    expect(keys.length).toBe(OFF_LOG_KEEP);
    expect(keys[keys.length - 1]).toBe(20000000000);
    expect(keys[0]).toBeGreaterThan(9999999995);
  });

  it("survives a node with no log at all", () => {
    expect(Object.keys(offAuditFields(null, rec(5), 5).offLog)).toEqual(["5"]);
  });

  it("REFUSES a log key that is not plain epoch ms", () => {
    // This repo has crashed the refill engine once by putting an ISO string in
    // an RTDB key, and a push-id "-" prefix is the ZERO character. Keys here
    // are digits or nothing.
    expect(() => offAuditFields({}, rec(1), "2026-08-28T00:00:00Z")).toThrow(/plain epoch ms/);
    expect(() => offAuditUpdate(rec(1), "-Nabc")).toThrow(/plain epoch ms/);
  });
});

describe("offAuditUpdate", () => {
  it("is an update()-shaped multi-path write, log entry included", () => {
    const r = buildOffRecord({ at: 42, actor: "script:reconcile", reasonCode: "reconciler_refused", detail: "no photo" });
    expect(offAuditUpdate(r, 42)).toEqual({ lastOff: r, "offLog/42": r });
  });
});

describe("describeOff", () => {
  it("says what happened and when", () => {
    const s = describeOff({
      lastOff: buildOffRecord({ at: Date.UTC(2026, 7, 22, 10, 57), actor: "uid", reasonCode: "off_to_rename" }),
    });
    expect(s.known).toBe(true);
    expect(s.text).toContain("Taken off the shop on");
    expect(s.text).toContain("so the listing name could be changed");
  });

  it("prefers the recorded detail over the generic reason", () => {
    const s = describeOff({
      lastOff: buildOffRecord({ at: 1, actor: "script:reconcile", reasonCode: "reconciler_refused", detail: "no photo on the record" }),
    });
    expect(s.text).toContain("no photo on the record");
  });

  it("ADMITS it does not know, rather than inventing a reason", () => {
    // Every product switched off before this shipped lands here — including
    // the 97 from 22 August. A confident-sounding guess would be worse than
    // the silence it replaces.
    const s = describeOff({ state: "live", liveState: "off" });
    expect(s.known).toBe(false);
    expect(s.text).toContain("before this app started recording why");
  });

  it("treats an unreadable reasonCode as unknown, not as a crash", () => {
    expect(describeOff({ lastOff: { at: 1, actor: "u", reasonCode: "from-the-future" } }).known).toBe(false);
  });

  it("flags the finished round trip: taken off to rename, renamed since", () => {
    const at = 1000;
    const s = describeOff({
      lastOff: buildOffRecord({ at, actor: "uid", reasonCode: "off_to_rename" }),
      nameApprovedAt: at + 5,
    });
    expect(s.renamedSince).toBe(true);
    expect(s.text).toContain("ready to publish again");
  });

  it("does NOT claim the rename landed when the approval predates the switch-off", () => {
    // The stamp from an EARLIER naming session is not evidence that the rename
    // this off was for has happened. Claiming it would send someone to publish
    // the very name the product was taken off to escape.
    const s = describeOff({
      lastOff: buildOffRecord({ at: 1000, actor: "uid", reasonCode: "off_to_rename" }),
      nameApprovedAt: 999,
    });
    expect(s.renamedSince).toBe(false);
    expect(s.text).not.toContain("ready to publish again");
  });

  it("never claims a rename for an off that was not about renaming", () => {
    const s = describeOff({
      lastOff: buildOffRecord({ at: 1000, actor: "uid", reasonCode: "switched_off" }),
      nameApprovedAt: 5000,
    });
    expect(s.renamedSince).toBe(false);
  });

  it("returns null for no node", () => {
    expect(describeOff(null)).toBe(null);
  });

  it("every reason code has a sentence", () => {
    for (const [code, text] of Object.entries(OFF_REASONS)) {
      expect(typeof text).toBe("string");
      expect(describeOff({ lastOff: { at: 1, actor: "u", reasonCode: code } }).text).toContain(text);
    }
  });
});
