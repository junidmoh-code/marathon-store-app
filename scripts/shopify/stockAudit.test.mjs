import { describe, it, expect } from "vitest";
import { sellable, causeOfOver, auditSummary } from "./stockAudit.mjs";

describe("sellable", () => {
  it("is on_hand less committed for a tracked DENY variant", () => {
    expect(sellable({ onHand: 8, committed: 1, tracked: true, inventoryPolicy: "DENY" })).toBe(7);
    expect(sellable({ onHand: -1, committed: 0, tracked: true, inventoryPolicy: "DENY" })).toBe(0);
    expect(sellable({ onHand: null, tracked: true, inventoryPolicy: "DENY" })).toBe(0);
  });
  it("is unlimited when Shopify is not limiting the variant", () => {
    expect(sellable({ onHand: 0, tracked: false, inventoryPolicy: "DENY" })).toBe(Infinity);
    expect(sellable({ onHand: 0, tracked: true, inventoryPolicy: "CONTINUE" })).toBe(Infinity);
  });
});

describe("causeOfOver", () => {
  const base = { tracked: true, inventoryPolicy: "DENY", shopify: 3, app: 1 };
  it("names the policy causes before the timing ones", () => {
    expect(causeOfOver({ ...base, unmanaged: true })).toBe("unmanaged");
    expect(causeOfOver({ ...base, unmapped: true })).toBe("stale-map");
    expect(causeOfOver({ ...base, tracked: false })).toBe("untracked");
    expect(causeOfOver({ ...base, allLocations: 3, excludedUnits: 2 }, { dirty: true })).toBe("excluded-only");
  });
  it("excluded units must cover the WHOLE overage", () => {
    expect(causeOfOver({ ...base, allLocations: 3, excludedUnits: 1 })).toBe("unexplained");
  });
  it("then a waiting marker, then a movement since the sweep", () => {
    expect(causeOfOver(base, { dirty: true, movedSinceSweep: true })).toBe("pending-push");
    expect(causeOfOver(base, { movedSinceSweep: true })).toBe("moved-since-sweep");
    expect(causeOfOver(base)).toBe("unexplained");
  });
});

describe("auditSummary", () => {
  it("counts direction, units, causes and zero-stock sellables", () => {
    const s = auditSummary([
      { shopify: 3, app: 1, sellable: 3, cause: "pending-push" },
      { shopify: 1, app: 2, sellable: 1 },
      { shopify: 2, app: 2, sellable: 2 },
      { shopify: 0, app: 0, sellable: Infinity },
      { shopify: 2, app: 0, sellable: 2, cause: "unmanaged" },
      { shopify: -1, app: 0, sellable: 0 },
      { shopify: 0, app: 5, sellable: 0, staleMap: true },
    ]);
    expect(s.staleMap).toBe(1);
    expect(s).toMatchObject({ variants: 6, above: 2, below: 1, equal: 3, unitsAbove: 4, unitsBelow: 1 });
    expect(s.byCause).toEqual({ "pending-push": { variants: 1, units: 2 }, unmanaged: { variants: 1, units: 2 } });
    expect(s).toMatchObject({ sellableAtZero: 2, sellableAtZeroUnits: 2, unlimitedAtZero: 1 });
  });
});
