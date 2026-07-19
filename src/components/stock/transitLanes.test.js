// transitLanes — the building map is load-bearing: a wrong entry either strands
// stock in in_transit (same-building lane gone two-step) or teleports it across
// town (cross-building lane gone instant). Lock the confirmed map + T1 scope.
import { describe, it, expect } from "vitest";
import { isTransitLane, buildingOf, BUILDING } from "./transitLanes";

describe("building map (confirmed by owner 2026-07-19)", () => {
  it("places every known location", () => {
    expect(buildingOf("central")).toBe("A");
    expect(buildingOf("studio")).toBe("A");
    expect(buildingOf("base")).toBe("A");
    expect(buildingOf("marathon-pe")).toBe("B");
    expect(buildingOf("trophy")).toBe("B");
    expect(buildingOf("hub1")).toBe("B");
    expect(buildingOf("hub2")).toBe("B");
    expect(buildingOf("marathon-pine")).toBe("C");
    expect(buildingOf("hub3")).toBe("C");
  });

  it("never maps the in_transit holding itself", () => {
    expect(BUILDING.in_transit).toBeUndefined();
  });
});

describe("isTransitLane — transit = outbound cross-building from Building A", () => {
  it("A → B goes in transit", () => {
    expect(isTransitLane("central", "marathon-pe")).toBe(true);
    expect(isTransitLane("central", "trophy")).toBe(true);
    expect(isTransitLane("central", "hub1")).toBe(true);
    expect(isTransitLane("central", "hub2")).toBe(true);
    expect(isTransitLane("studio", "trophy")).toBe(true);
    expect(isTransitLane("base", "hub2")).toBe(true);
  });

  it("A → C goes in transit", () => {
    expect(isTransitLane("central", "marathon-pine")).toBe(true);
    expect(isTransitLane("central", "hub3")).toBe(true);
    expect(isTransitLane("base", "hub3")).toBe(true);
  });

  it("same-building moves stay instant", () => {
    expect(isTransitLane("central", "studio")).toBe(false);
    expect(isTransitLane("central", "base")).toBe(false);
    expect(isTransitLane("hub2", "marathon-pe")).toBe(false);  // within B
    expect(isTransitLane("hub2", "trophy")).toBe(false);       // within B
    expect(isTransitLane("hub3", "marathon-pine")).toBe(false); // within C
  });

  it("reverse cross-building (into A) stays instant — deliberate T1 scope", () => {
    expect(isTransitLane("marathon-pe", "central")).toBe(false);
    expect(isTransitLane("hub2", "central")).toBe(false);
    expect(isTransitLane("hub3", "base")).toBe(false);
  });

  it("B ↔ C cross-building stays instant in T1 (no lane from a non-A origin)", () => {
    expect(isTransitLane("hub2", "hub3")).toBe(false);
    expect(isTransitLane("hub3", "trophy")).toBe(false);
  });

  it("unmapped locations default to instant (never strand stock)", () => {
    expect(isTransitLane("central", "hubX")).toBe(false);
    expect(isTransitLane("hubX", "central")).toBe(false);
    expect(isTransitLane(undefined, "central")).toBe(false);
    expect(isTransitLane("central", null)).toBe(false);
  });

  it("a degenerate same-id move is instant", () => {
    expect(isTransitLane("central", "central")).toBe(false);
  });
});
