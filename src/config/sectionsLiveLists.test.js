// The lists that left Pine / Hub 3 out by owner decision now key on the LIVE
// flag of the network registry instead of a typed list. Proof that (a) today's
// membership is unchanged on the seed and (b) flipping a location live is what
// brings it in — nothing else does.
import { describe, it, expect, beforeEach } from "vitest";
import { AUDIT_STORES, AUDIT_HUBS, auditStoresOf, auditHubsOf, LOCATION_LABEL, locationLabel } from "./stockAudit";
import { DISPLAY_CHECKS_STORE_FLAGS, isDisplayChecksStoreEnabled, displayChecksEnabledStores } from "./displayChecks";
import { normalizeNetwork, SEED_REGISTRY } from "../utils/networkRegistry";
import { setCurrentNetworkFromRaw, __resetNetworkForTests } from "../utils/networkStore";
import { CLOTHING_SOLD_STORES } from "../utils/clothingSold";
import { VALID_HUBS, cleanHubs } from "../utils/newProductRecord";

beforeEach(() => __resetNetworkForTests());

describe("stock audit lists", () => {
  it("on the seed: exactly the lists that were typed here", () => {
    expect(AUDIT_STORES).toEqual([{ id: "marathon-pe", label: "Marathon PE" }, { id: "trophy", label: "Trophy" }]);
    expect(AUDIT_HUBS).toEqual([{ id: "hub1", label: "Hub 1" }, { id: "hub2", label: "Hub 2" }]);
    expect(LOCATION_LABEL).toEqual({ "marathon-pe": "Marathon PE", trophy: "Trophy", hub1: "Hub 1", hub2: "Hub 2" });
    expect(auditStoresOf(SEED_REGISTRY)).toEqual(AUDIT_STORES);
    expect(auditHubsOf()).toEqual(AUDIT_HUBS);
  });
  it("a location joins when the owner marks it live — and only then", () => {
    const net = normalizeNetwork({ locations: { "marathon-pine": { live: true }, hub3: { live: true } } });
    expect(auditStoresOf(net).map((s) => s.id)).toEqual(["marathon-pine", "marathon-pe", "trophy"]);
    expect(auditHubsOf(net).map((s) => s.id)).toEqual(["hub3", "hub1", "hub2"]);
    expect(auditStoresOf(net).map((s) => s.id)).not.toContain("concrete");
  });
  it("labels never come back blank", () => {
    expect(locationLabel("hub2")).toBe("Hub 2");
    expect(locationLabel("hub3")).toBe("Hub 3");
    expect(locationLabel("concrete-stockroom")).toBe("concrete-stockroom");   // removed 8 Oct 2026: not a known location
    expect(locationLabel("mystery")).toBe("mystery");
    expect(locationLabel(null)).toBe("—");
  });
});

describe("Display Checks store flags", () => {
  it("on the seed: PE on, Trophy on, Pine off — as typed before — and Concrete off", () => {
    expect(DISPLAY_CHECKS_STORE_FLAGS).toEqual({ "marathon-pe": true, trophy: true, "marathon-pine": false, concrete: false });
    expect(isDisplayChecksStoreEnabled("marathon-pe")).toBe(true);
    expect(isDisplayChecksStoreEnabled("trophy")).toBe(true);
    expect(isDisplayChecksStoreEnabled("marathon-pine")).toBe(false);
    expect(isDisplayChecksStoreEnabled("concrete")).toBe(false);
    expect(displayChecksEnabledStores()).toEqual(["marathon-pe", "trophy"]);
  });
  it("unknown, absent, or not-a-store → false", () => {
    for (const id of ["nowhere", "", null, undefined, "hub1", "pe"]) expect(isDisplayChecksStoreEnabled(id)).toBe(false);
  });
  it("Concrete switches on the moment /network says it is live, no deploy", () => {
    setCurrentNetworkFromRaw({ locations: { concrete: { live: true } } });
    expect(isDisplayChecksStoreEnabled("concrete")).toBe(true);
    expect(isDisplayChecksStoreEnabled("marathon-pine")).toBe(false);
    expect(displayChecksEnabledStores()).toEqual(["marathon-pe", "trophy", "concrete"]);
  });
});

describe("the other seed-derived lists", () => {
  it("Clothing Sold stores: the three as before, then Concrete", () => {
    expect(CLOTHING_SOLD_STORES).toEqual(["marathon-pe", "trophy", "marathon-pine", "concrete"]);
  });
  it("product hub tags: hub1, hub2, hub3 — no Concrete Stockroom; the clothing rule is unchanged", () => {
    expect(VALID_HUBS).toEqual(["hub1", "hub2", "hub3"]);
    expect(cleanHubs(["hub1", "hub2"], true)).toEqual(["hub2"]);
    expect(cleanHubs([], true)).toEqual(["hub2"]);
    expect(cleanHubs([], false)).toEqual(["hub1"]);
    expect(cleanHubs(["hub3", "concrete-stockroom", "bogus"], true)).toEqual(["hub3"]);
  });
});
