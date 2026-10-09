import { describe, it, expect } from "vitest";
import { alternativesForSize } from "./alternativesCore";
import { ducksWorld, DUCKS_PID, isAirForce1 } from "./__fixtures__/ducksHarness";

// ─── REPRODUCTION: Ducks of a Feather, size 8 (Junid, 2026-10-08 14:36) ──────
//
// Measured on the live slice in __fixtures__/ducksOfAFeather.json:
//   • the product was created 2026-09-23, after the attribute run, so it has
//     NO /product_attributes record and NO stored `alternatives` list — the
//     sheet had nothing to join and said "No similar styles in size 8";
//   • at the same moment 30+ Air Force 1s were sellable in an 8 at Hub 1.
describe("Ducks of a Feather size 8 (live data)", () => {
  const w = ducksWorld();
  const ducks = w.products[DUCKS_PID];

  it("size 8 really is unavailable on the shoe itself", () => {
    expect(w.sneakerOut(ducks, "8")).toBe(true);
  });

  it("many Air Force 1s really are sellable in an 8", () => {
    const args = w.args(ducks, "8");
    const af1In8 = w.list.filter((p) => p.id !== DUCKS_PID && isAirForce1(p) && args.sizeAvailable(p, "8"));
    expect(af1In8.length).toBeGreaterThan(10);
  });

  it("the sheet offers Air Force 1s in size 8, AF1s first — never 'no similar styles'", () => {
    const { rows } = alternativesForSize(w.args(ducks, "8"));
    expect(rows.length).toBe(8);
    expect(rows.slice(0, 8).every((r) => isAirForce1(r.product))).toBe(true);
  });
});
