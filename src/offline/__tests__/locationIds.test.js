import { describe, test, expect } from "vitest";
import {
  canonicalLocationId, requireCanonicalLocationId, shortLocationId,
  isCanonicalLocationId, UnknownLocationError, CANONICAL_LOCATION_IDS,
} from "../locationIds";

describe("the two id namespaces", () => {
  test("the short shop ids map to the canonical ones", () => {
    expect(canonicalLocationId("pe")).toBe("marathon-pe");
    expect(canonicalLocationId("pine")).toBe("marathon-pine");
  });

  test("a canonical id maps to itself", () => {
    for (const id of CANONICAL_LOCATION_IDS) {
      expect(canonicalLocationId(id)).toBe(id);
    }
  });

  test("an id the map does not know returns null — it is NEVER guessed", () => {
    // The POS mirror built `/stock/pe` by hoping, read zero rows and stamped
    // itself healthy. A prefix-guessing fallback is how that happens.
    expect(canonicalLocationId("hub9")).toBeNull();
    expect(canonicalLocationId("marathon-durban")).toBeNull();
    expect(canonicalLocationId("")).toBeNull();
    expect(canonicalLocationId(null)).toBeNull();
    expect(canonicalLocationId(undefined)).toBeNull();
  });

  test("requireCanonicalLocationId raises rather than returning a falsy path", () => {
    expect(() => requireCanonicalLocationId("hub9", "stock leg")).toThrow(UnknownLocationError);
    try { requireCanonicalLocationId("hub9", "stock leg"); }
    catch (err) { expect(err.message).toContain("stock leg"); }
  });

  test("the reverse map only shortens the two double-named shops", () => {
    expect(shortLocationId("marathon-pe")).toBe("pe");
    expect(shortLocationId("marathon-pine")).toBe("pine");
    expect(shortLocationId("hub1")).toBe("hub1");
    expect(shortLocationId("nowhere")).toBeNull();
  });

  test("round-tripping a short id through both directions is stable", () => {
    for (const short of ["pe", "pine", "trophy"]) {
      expect(shortLocationId(canonicalLocationId(short))).toBe(short);
    }
  });

  test("isCanonicalLocationId does not accept a short id", () => {
    expect(isCanonicalLocationId("pe")).toBe(false);
    expect(isCanonicalLocationId("marathon-pe")).toBe(true);
  });
});

// ─── SECTIONS: THE TYPED LIST AND THE NETWORK REGISTRY, IN STEP ──────────────
// The list is typed in locationIds.js on purpose (the mirror must know a
// location exists without a read of /network). This is what stops the two
// drifting: a location added to the registry seed and not to that file drops
// that location's stock rows from every mirrored device, silently.
import { SEED_REGISTRY, TRANSIT_ID, listLocations } from "../../utils/networkRegistry";
import { SHORT_TO_CANONICAL } from "../locationIds";

describe("the mirror's closed list matches the registry seed", () => {
  test("every registry location (retired ones too) plus in_transit — and nothing else", () => {
    const registry = listLocations(SEED_REGISTRY, { includeRetired: true }).map((l) => l.id);
    expect([...CANONICAL_LOCATION_IDS].sort()).toEqual([...registry, TRANSIT_ID].sort());
  });
  test("Concrete is accepted; the removed Concrete Stockroom is not", () => {
    expect(isCanonicalLocationId("concrete")).toBe(true);
    expect(isCanonicalLocationId("concrete-stockroom")).toBe(false);
    expect(canonicalLocationId("concrete")).toBe("concrete");
    expect(shortLocationId("concrete")).toBe("concrete");
  });
  test("every store's POS id resolves to that store, and only stores have one", () => {
    const stores = listLocations(SEED_REGISTRY, { type: "store" });
    expect(Object.keys(SHORT_TO_CANONICAL).sort()).toEqual(stores.map((l) => l.posId).sort());
    for (const l of stores) expect(canonicalLocationId(l.posId)).toBe(l.id);
  });
  test("still STRICT: a registry ALIAS is not an id the mirror accepts", () => {
    expect(canonicalLocationId("Concrete Stockroom")).toBeNull();
    expect(canonicalLocationId("Hub 3")).toBeNull();
    expect(canonicalLocationId("marathon-concrete")).toBeNull();
  });
});
