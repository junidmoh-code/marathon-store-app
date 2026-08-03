import { describe, it, expect } from "vitest";
import { buildProductIdIndex, resolveProductIdByName, buildPhotoIndex, photoForProduct, normalizeName } from "./productIdentity";

// Mirrors the live incident: three DISTINCT records, byte-identical names,
// different photos (see _twin-name-collision-forensic-report.md).
const TWINS = [
  { id: "p1781648943606", name: "Nike SB Dunk Low Green White", photoUrl: "https://x/twin1.jpg" },
  { id: "p1781649332106", name: "Nike SB Dunk Low Green White", photoUrl: "https://x/twin2.jpg" },
  { id: "p1781649925620", name: "Nike SB Dunk Low Green White", photoUrl: "https://x/twin3.jpg" },
];
const UNIQUE = { id: "pU", name: "Adidas Samba OG Black", photoUrl: "https://x/samba.jpg" };

describe("buildProductIdIndex / resolveProductIdByName", () => {
  it("resolves a unique name to its pid (raw and normalized)", () => {
    const idx = buildProductIdIndex([...TWINS, UNIQUE]);
    expect(resolveProductIdByName(idx, "Adidas Samba OG Black")).toBe("pU");
    expect(resolveProductIdByName(idx, "  adidas  samba og black ")).toBe("pU");
  });

  it("REFUSES an ambiguous name — returns null, never last-writer-wins", () => {
    // The old map did map[p.name] = p.id in catalog order, so the LAST twin
    // silently won every name lookup. Refusal is the whole point of this module.
    const idx = buildProductIdIndex([...TWINS, UNIQUE]);
    expect(resolveProductIdByName(idx, "Nike SB Dunk Low Green White")).toBeNull();
  });

  it("refuses names that collide only after normalization", () => {
    const idx = buildProductIdIndex([
      { id: "pA", name: "Air Max 90" },
      { id: "pB", name: "air  max 90" },
    ]);
    // Exact strings are distinct, so each still resolves exactly…
    expect(resolveProductIdByName(idx, "Air Max 90")).toBe("pA");
    // …but a query that only matches via normalization is ambiguous → refuse.
    expect(resolveProductIdByName(idx, "AIR MAX 90")).toBeNull();
  });

  it("returns null for unknown or empty names", () => {
    const idx = buildProductIdIndex([UNIQUE]);
    expect(resolveProductIdByName(idx, "No Such Shoe")).toBeNull();
    expect(resolveProductIdByName(idx, "")).toBeNull();
    expect(resolveProductIdByName(null, "Adidas Samba OG Black")).toBeNull();
  });

  it("reports every duplicated exact name with all its ids — the warning the old code never fired", () => {
    const idx = buildProductIdIndex([...TWINS, UNIQUE]);
    expect(idx.duplicates).toHaveLength(1);
    expect(idx.duplicates[0].name).toBe("Nike SB Dunk Low Green White");
    expect(idx.duplicates[0].ids.sort()).toEqual(["p1781648943606", "p1781649332106", "p1781649925620"]);
  });

  it("does not flag the same record listed twice as a duplicate", () => {
    const idx = buildProductIdIndex([UNIQUE, UNIQUE]);
    expect(idx.duplicates).toHaveLength(0);
    expect(resolveProductIdByName(idx, UNIQUE.name)).toBe("pU");
  });
});

describe("buildPhotoIndex / photoForProduct", () => {
  it("all three twins resolve to THREE DIFFERENT images via their pid", () => {
    // The name-keyed map served the LAST twin's photo for all three cards —
    // the misleading face of the wrong-deduction incident.
    const idx = buildPhotoIndex([...TWINS, UNIQUE]);
    const photos = TWINS.map(t => photoForProduct(idx, { productId: t.id, productName: t.name }).photoUrl);
    expect(photos).toEqual(["https://x/twin1.jpg", "https://x/twin2.jpg", "https://x/twin3.jpg"]);
    expect(new Set(photos).size).toBe(3);
  });

  it("falls back to the name join only when there is no pid", () => {
    const idx = buildPhotoIndex([UNIQUE]);
    expect(photoForProduct(idx, { productName: "Adidas Samba OG Black" }).photoUrl).toBe("https://x/samba.jpg");
    expect(photoForProduct(idx, { productName: "adidas samba og black" }).photoUrl).toBe("https://x/samba.jpg");
    expect(photoForProduct(idx, { productName: "No Such Shoe" })).toEqual({ photoUrl: null, photo: "" });
    expect(photoForProduct(idx, null)).toEqual({ photoUrl: null, photo: "" });
  });

  it("an unknown pid with a known name still gets the name fallback", () => {
    const idx = buildPhotoIndex([UNIQUE]);
    expect(photoForProduct(idx, { productId: "pGone", productName: "Adidas Samba OG Black" }).photoUrl).toBe("https://x/samba.jpg");
  });
});

describe("normalizeName", () => {
  it("trims, collapses whitespace, lowercases, collapses spaced hyphens", () => {
    expect(normalizeName("  Nike  Air -  Max ")).toBe("nike air-max");
  });
});
