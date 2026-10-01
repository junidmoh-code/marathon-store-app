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
