// Division names: the two sections are called by the owner's names, stored at
// /network/sections/{n}/name, seeded "Marathon" (Section 2) and "Concrete"
// (Section 1). A picker beside store names says "Concrete group".
import { describe, it, expect } from "vitest";
import {
  normalizeNetwork, sectionName, sectionLabel, sectionsInOrder, seedPayload, SEED_REGISTRY,
} from "./networkRegistry";
import { sectionNameUpdate, seedUpdate } from "../components/admin/networkSettingsCore";

describe("division names", () => {
  it("seeds Marathon = PE, Trophy, Hub 1, Hub 2 and Concrete = Pine, Concrete, Hub 3, the Stockroom", () => {
    expect(sectionName(SEED_REGISTRY, 2)).toBe("Marathon");
    expect(sectionName(SEED_REGISTRY, 1)).toBe("Concrete");
    const ids = (n) => Object.values(SEED_REGISTRY.locations).filter((l) => l.section === n).map((l) => l.id).sort();
    expect(ids(2)).toEqual(["hub1", "hub2", "marathon-pe", "trophy"]);
    expect(ids(1)).toEqual(["concrete", "concrete-stockroom", "hub3", "marathon-pine"]);
  });

  it("reads the stored names, and falls back to the seed for a blank or junk one", () => {
    const R = normalizeNetwork({ sections: { 1: { name: "  Concrete North " }, 2: { name: "" } } });
    expect(sectionName(R, 1)).toBe("Concrete North");
    expect(sectionName(R, 2)).toBe("Marathon");
    // RTDB may hand { 1: …, 2: … } back as an array.
    const A = normalizeNetwork({ sections: [null, { name: "C" }, { name: "M" }] });
    expect([sectionName(A, 1), sectionName(A, 2)]).toEqual(["C", "M"]);
    expect(sectionName(normalizeNetwork({ sections: "junk" }), 1)).toBe("Concrete");
  });

  it("disambiguates the division only where it shares a store's name", () => {
    expect(sectionLabel(SEED_REGISTRY, 1)).toBe("Concrete group");
    expect(sectionLabel(SEED_REGISTRY, 2)).toBe("Marathon");
    expect(sectionLabel(normalizeNetwork({ sections: { 1: { name: "Durban" } } }), 1)).toBe("Durban");
  });

  it("orders Marathon first", () => {
    expect(sectionsInOrder(SEED_REGISTRY)).toEqual([2, 1]);
    expect(sectionsInOrder(normalizeNetwork({ sections: { 1: { sort: 0 } } }))).toEqual([1, 2]);
  });

  it("the seed writes the names; a stored name is never overwritten", () => {
    expect(seedPayload().sections).toEqual({ 1: { id: 1, name: "Concrete", sort: 2 }, 2: { id: 2, name: "Marathon", sort: 1 } });
    const fresh = seedUpdate({ creditScope: "shared" }, { concrete: {}, "concrete-stockroom": {} }, 1, "o").updates;
    expect(fresh["network/sections/2"]).toEqual({ id: 2, name: "Marathon", sort: 1 });
    const kept = seedUpdate({ sections: { 1: { id: 1, name: "Mine", sort: 2 }, 2: { id: 2, name: "Marathon", sort: 1 } } }, {}, 1, "o").updates;
    expect(Object.keys(kept).filter((k) => k.startsWith("network/sections"))).toEqual([]);
  });

  it("a rename writes one small path, trimmed, and refuses nonsense", () => {
    const r = sectionNameUpdate(1, "  Concrete   group  ", 5, "o");
    expect(r.ok).toBe(true);
    expect(r.updates["network/sections/1/name"]).toBe("Concrete group");
    expect(r.updates["network/updatedAt"]).toBe(5);
    expect(sectionNameUpdate(3, "x", 5, "o").ok).toBe(false);
    expect(sectionNameUpdate(1, "   ", 5, "o").ok).toBe(false);
    expect(sectionNameUpdate(1, "x".repeat(41), 5, "o").ok).toBe(false);
  });
});
