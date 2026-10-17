// Owner, 2026-10-17: a one-shop account (destShop) sees its own shop and the
// hubs holding its back stock, never the other shop.
import { describe, it, expect } from "vitest";
import { scopedLocationIds, withinScope } from "./shopScope";
import { transferTargets, sellableLocations } from "../components/stock/locations";

describe("scopedLocationIds", () => {
  it("no destShop: no scope at all (every location, as before)", () => {
    expect(scopedLocationIds(null)).toBe(null);
    expect(scopedLocationIds(undefined)).toBe(null);
  });
  it("Marathon PE: PE and its back-stock hubs, never Trophy", () => {
    const ids = scopedLocationIds("marathon-pe");
    expect(ids).toContain("marathon-pe");
    expect(ids).toEqual(expect.arrayContaining(["hub1", "hub2"]));
    expect(ids).not.toContain("trophy");
  });
  it("Trophy: Trophy and its hubs, never PE", () => {
    const ids = scopedLocationIds("trophy");
    expect(ids).toContain("trophy");
    expect(ids).not.toContain("marathon-pe");
    expect(ids).not.toContain("marathon-pine");
  });
  it("a shop the registry doesn't know: only itself, never everything", () => {
    expect(scopedLocationIds("nowhere")).toEqual(["nowhere"]);
  });
});

describe("withinScope on the real location lists the screens use", () => {
  it("transfer targets (Barcodes) and sellable shops (Print Labels) lose the other shop", () => {
    const all = transferTargets({}).map((l) => l.id);
    expect(all).toEqual(expect.arrayContaining(["marathon-pe", "trophy"]));
    expect(withinScope(transferTargets({}), "marathon-pe").map((l) => l.id)).not.toContain("trophy");
    expect(withinScope(transferTargets({}), "trophy").map((l) => l.id)).not.toContain("marathon-pe");
    expect(withinScope(sellableLocations({}), "trophy").map((l) => l.id)).toEqual(["trophy"]);
    expect(withinScope(sellableLocations({}), null).map((l) => l.id)).toEqual(sellableLocations({}).map((l) => l.id));
  });
});
