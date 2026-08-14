// ─── The migration mapping, pinned ───────────────────────────────────────────
// planMigration bulk-rewrites production /shopify_publish state — the same
// treatment idMap.test.mjs gives planIdMapWrite. Every legacy value's target,
// the idempotency of the new-model values, and the refuse-on-unknown guard.
import { describe, it, expect } from "vitest";
import { planMigration } from "./migrateLiveStatePlan.mjs";

describe("planMigration — legacy → 2026-08-14 model", () => {
  it("none and nominated become awaiting (nothing else touched)", () => {
    expect(planMigration({ state: "none" })).toEqual({ state: "awaiting" });
    expect(planMigration({ state: "nominated", condition: "x" })).toEqual({ state: "awaiting" });
  });
  it("draft becomes live+off with desiredState seeded equal (no phantom pending)", () => {
    expect(planMigration({ state: "draft" }))
      .toEqual({ state: "live", liveState: "off", desiredState: "off" });
  });
  it("old-model live (no liveState) becomes live+on", () => {
    expect(planMigration({ state: "live" }))
      .toEqual({ state: "live", liveState: "on", desiredState: "on" });
  });
  it("idempotent: new-model nodes plan nothing", () => {
    expect(planMigration({ state: "awaiting" })).toBeNull();
    expect(planMigration({ state: "blocked" })).toBeNull();
    expect(planMigration({ state: "live", liveState: "on", desiredState: "on" })).toBeNull();
    expect(planMigration({ state: "live", liveState: "off", desiredState: "off" })).toBeNull();
  });
  it("null/absent nodes plan nothing; unknown states refuse loudly", () => {
    expect(planMigration(null)).toBeNull();
    expect(planMigration(undefined)).toBeNull();
    expect(() => planMigration({ state: "shipped" })).toThrow(/unrecognised state/);
  });
});
