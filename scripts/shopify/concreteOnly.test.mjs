import { describe, it, expect } from "vitest";
import { fakeDb } from "./fakeRtdb.testutil.mjs";
import { needsMarathonOff, concreteOnlyOffFields, enforceConcreteOnlyOnMarathon } from "./concreteOnly.mjs";

const AT = 1795200000000;

describe("needsMarathonOff", () => {
  it("live and on, or wanted on → off needed; already off or awaiting → not", () => {
    expect(needsMarathonOff({ state: "live", liveState: "on" })).toBe(true);
    expect(needsMarathonOff({ state: "awaiting", desiredState: "on" })).toBe(true);
    expect(needsMarathonOff({ state: "live", liveState: "on", desiredState: "off" })).toBe(false);
    expect(needsMarathonOff({ state: "live", liveState: "off" })).toBe(false);
    expect(needsMarathonOff({ state: "awaiting" })).toBe(false);
    expect(needsMarathonOff(null)).toBe(false);
  });
});

describe("concreteOnlyOffFields", () => {
  it("writes the off intent with the concrete_only record and keeps the old log", () => {
    const f = concreteOnlyOffFields({ offLog: { 1: { at: 1, actor: "x", reasonCode: "script" } } }, { at: AT, actor: "script:t" });
    expect(f.desiredState).toBe("off");
    expect(f.updatedAt).toBe(AT);
    expect(f.lastOff).toEqual({ at: AT, actor: "script:t", reasonCode: "concrete_only" });
    expect(Object.keys(f.offLog)).toEqual(["1", String(AT)]);
  });
  it("refuses a missing clock", () => {
    expect(() => concreteOnlyOffFields({}, { at: 0, actor: "a" })).toThrow();
  });
});

describe("enforceConcreteOnlyOnMarathon", () => {
  const store = () => ({
    settings: { concreteOnlyIndex: { p1: true, p2: true, p3: true } },
    products: {
      p1: { name: "live concrete", concreteProduct: true },
      p2: { name: "stale index", concreteProduct: false, listOnConcrete: true },
      p3: { name: "legacy only", listOnConcrete: true },
      p9: { name: "marathon, unindexed", concreteProduct: true },
    },
    shopify_publish: {
      p1: { state: "live", liveState: "on" },
      p2: { state: "live", liveState: "on" },
      p3: { state: "awaiting" },
      p9: { state: "live", liveState: "on" },
    },
  });
  it("turns off only indexed products whose record really is Concrete-only and that are live", async () => {
    const { db, store: s } = fakeDb(store());
    const r = await enforceConcreteOnlyOnMarathon(db, { nowMs: async () => AT, actor: "script:t", commit: true });
    expect(r.turnedOff).toEqual(["p1"]);
    expect(r.skipped.map((x) => x.pid)).toEqual(["p2"]);
    expect(s.shopify_publish.p1.desiredState).toBe("off");
    expect(s.shopify_publish.p2.desiredState).toBeUndefined();
    expect(s.shopify_publish.p9.desiredState).toBeUndefined(); // only the index is read
  });
  it("report-only writes nothing", async () => {
    const { db, writes } = fakeDb(store());
    const r = await enforceConcreteOnlyOnMarathon(db, { nowMs: async () => AT, actor: "script:t", commit: false });
    expect(r.turnedOff).toEqual(["p1"]);
    expect(writes).toEqual([]);
  });
  it("an empty index (RTDB drops empty nodes) is a no-op", async () => {
    const { db } = fakeDb({});
    const r = await enforceConcreteOnlyOnMarathon(db, { nowMs: async () => AT, actor: "script:t", commit: true });
    expect(r).toEqual({ checked: 0, turnedOff: [], skipped: [] });
  });
});
