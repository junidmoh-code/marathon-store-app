// scripts/apply-central-clothing-policy.mjs — the pure plan (Junid, 12 Nov 2026).
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { planCentralClothingPolicy, HUB3_LEG } = require("./centralClothingPolicy.cjs");

// The live group's shape on 12 Nov 2026 (hub1/hub2 per-size legs, Hub 3 at 3).
const LIVE = {
  armed: true, label: "Footwear", memberCategoryKeys: ["sneakers", "slides"],
  policy: {
    perSize: true,
    hub1: { carriedOnly: true, sizes: { 6: { minQty: 2, reorderPoint: 1, target: 3 }, 9: { minQty: 1, reorderPoint: 1, target: 2 } } },
    hub2: { carriedOnly: true, sizes: { 6: { minQty: 2, reorderPoint: 1, target: 3 } } },
    hub3: { carriedOnly: true, minQty: 2, reorderPoint: 1, target: 3 },
  },
};
const OLD_DIV = { fromHub3: { askAt: 0, oneSize: 5, perSize: 1 }, hub3Keep: { on: false, oneSize: 10, perSize: 2 }, shopOnly: { oneSize: 5, perSize: 2 } };

describe("planCentralClothingPolicy", () => {
  it("sets Hub 3 to keep 2, ask at 1, seated only — and nothing else in the group moves", () => {
    const p = planCentralClothingPolicy({ liveGroup: LIVE, liveDivision: OLD_DIV });
    expect(p.group.policy.hub3).toEqual({ target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true });
    expect(p.group.policy.hub1).toEqual(LIVE.policy.hub1);
    expect(p.group.policy.hub2).toEqual(LIVE.policy.hub2);
    expect(p.group.memberCategoryKeys).toEqual(LIVE.memberCategoryKeys);
    expect(p.group.armed).toBe(true);
    expect(p.groupChanges).toBe(true);
    expect(LIVE.policy.hub3.target).toBe(3);
  });
  it("the division key becomes the shop keep alone", () => {
    expect(planCentralClothingPolicy({ liveGroup: LIVE, liveDivision: OLD_DIV }).division).toEqual({ shopOnly: { perSize: 2, oneSize: 5 } });
  });
  it("already applied: no group change", () => {
    const done = { ...LIVE, policy: { ...LIVE.policy, hub3: { ...HUB3_LEG } } };
    expect(planCentralClothingPolicy({ liveGroup: done, liveDivision: OLD_DIV }).groupChanges).toBe(false);
  });
  it("refuses an unarmed group or a missing division key", () => {
    expect(() => planCentralClothingPolicy({ liveGroup: { ...LIVE, armed: false }, liveDivision: OLD_DIV })).toThrow(/not armed/);
    expect(() => planCentralClothingPolicy({ liveGroup: LIVE, liveDivision: null })).toThrow(/key is off/);
  });
});
