import { describe, it, expect } from "vitest";
import { brandFill } from "./brandFill.mjs";
describe("backfill never writes a brand over a set one", () => {
  it("a corrected brand is left alone, whatever the name now derives", () => {
    expect(brandFill("Christian Louboutin", "Christian")).toBeNull();
    expect(brandFill("Alexander McQueen", null)).toBeNull();
  });
  it("only an EMPTY brand is filled, and only with a recognised one", () => {
    expect(brandFill(null, "Nike")).toBe("Nike");
    expect(brandFill("  ", "Nike")).toBe("Nike");
    expect(brandFill(null, null)).toBeNull();
  });
});
