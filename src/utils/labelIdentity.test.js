// ─── labelIdentity tests — REGISTERED means registered, by any route ──────────
// The rule under test is the owner's, stated as a behaviour: a product carrying
// a style code, OR any label alias, OR any label code record is registered —
// and a registered product is never a leftover.

import { describe, it, expect } from "vitest";
import { identityFor, isRegistered, registrationRoute, searchTermsFor } from "./labelIdentity.js";

const P = (over = {}) => ({ id: "p1", name: "Nike Air Force 1", ...over });

describe("isRegistered", () => {
  it("a product carrying a style code is registered, with no map at all", () => {
    expect(isRegistered(P({ styleCodeNormalised: "BQ6817302" }), null)).toBe(true);
  });

  it("a product with only a CODE record in the identity map is registered", () => {
    expect(isRegistered(P(), { p1: { c: ["BQ6817302"], a: [] } })).toBe(true);
  });

  it("a product with only a WORDING alias is registered", () => {
    expect(isRegistered(P(), { p1: { c: [], a: [["NIKE", "AIR"]] } })).toBe(true);
  });

  it("a product with nothing anywhere is NOT registered", () => {
    expect(isRegistered(P(), { p9: { c: ["X"], a: [] } })).toBe(false);
  });

  it("an empty entry is not an identity", () => {
    expect(isRegistered(P(), { p1: { c: [], a: [] } })).toBe(false);
  });

  it("an absent map degrades to the style-code field alone, never to 'all registered'", () => {
    expect(isRegistered(P(), undefined)).toBe(false);
    expect(isRegistered(P({ styleCodeNormalised: "X1" }), undefined)).toBe(true);
  });

  it("null is not registered", () => {
    expect(isRegistered(null, { p1: { c: ["X"], a: [] } })).toBe(false);
  });
});

describe("registrationRoute", () => {
  it("names the route so a report never has to assert without evidence", () => {
    expect(registrationRoute(P({ styleCodeNormalised: "X" }), null)).toBe("code");
    expect(registrationRoute(P(), { p1: { c: ["X"], a: [] } })).toBe("claim-or-alias");
    expect(registrationRoute(P(), { p1: { c: [], a: [["A", "B"]] } })).toBe("claim-or-alias");
    expect(registrationRoute(P(), {})).toBe(null);
  });
});

describe("identityFor", () => {
  it("the product's OWN code leads, and every other code follows without repeating it", () => {
    const { codes } = identityFor(P({ styleCodeNormalised: "AAA" }), { p1: { c: ["AAA", "BBB"], a: [] } });
    expect(codes).toEqual(["AAA", "BBB"]);
  });

  it("returns empty lists rather than null when nothing is known", () => {
    expect(identityFor(P(), null)).toEqual({ codes: [], aliases: [] });
  });
});

describe("searchTermsFor", () => {
  it("every code and every alias TOKEN is searchable", () => {
    const terms = searchTermsFor(
      P({ styleCodeNormalised: "AAA", styleCode: "AAA-111" }),
      { p1: { c: ["AAA", "BBB"], a: [["NIKE", "AIR"]] } },
    );
    expect(terms).toContain("AAA");
    expect(terms).toContain("BBB");
    expect(terms).toContain("AAA-111");
    expect(terms).toContain("NIKE");
    expect(terms).toContain("AIR");
  });
});
