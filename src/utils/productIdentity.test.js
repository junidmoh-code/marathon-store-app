import { describe, it, expect } from "vitest";
import { buildProductIdIndex, resolveProductIdByName, resolveProductId, buildPhotoIndex, photoForProduct, normalizeName } from "./productIdentity";

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
    // Exact collisions are NOT repeated in the normalized list — they would
    // otherwise warn twice for the same pair of products.
    expect(idx.normalizedDuplicates).toHaveLength(0);
  });

  it("reports normalize-only collisions separately, so a silent refusal still gets a diagnostic", () => {
    // These names differ as strings, so `duplicates` stays empty — but they
    // collide once normalized, which is enough to refuse a lookup. Without this
    // list the operator sees Fulfil disabled with nothing in the console.
    const idx = buildProductIdIndex([
      { id: "pA", name: "Air Max 90" },
      { id: "pB", name: "air  max 90" },
    ]);
    expect(idx.duplicates).toHaveLength(0);
    expect(idx.normalizedDuplicates).toHaveLength(1);
    expect(idx.normalizedDuplicates[0].name).toBe("air max 90");
    expect(idx.normalizedDuplicates[0].ids.sort()).toEqual(["pA", "pB"]);
    // …and that is exactly the query the index refuses.
    expect(resolveProductIdByName(idx, "AIR MAX 90")).toBeNull();
  });

  it("does not flag the same record listed twice as a duplicate", () => {
    const idx = buildProductIdIndex([UNIQUE, UNIQUE]);
    expect(idx.duplicates).toHaveLength(0);
    expect(idx.normalizedDuplicates).toHaveLength(0);
    expect(resolveProductIdByName(idx, UNIQUE.name)).toBe("pU");
  });
});

describe("resolveProductId (the resolver App.jsx's fulfilCtx.resolveId calls)", () => {
  const idx = buildProductIdIndex([...TWINS, UNIQUE]);

  it("prefers the record's own id over any name lookup", () => {
    // Even for a duplicated name: the record knows what it is.
    expect(resolveProductId({ productId: "p1781649332106", productName: TWINS[0].name }, idx)).toBe("p1781649332106");
  });

  it("falls back to the name index for pid-less records, and refuses ambiguity", () => {
    expect(resolveProductId({ productName: "Adidas Samba OG Black" }, idx)).toBe("pU");
    expect(resolveProductId({ productName: "Nike SB Dunk Low Green White" }, idx)).toBeNull();
  });

  it("returns null for empty input rather than throwing", () => {
    expect(resolveProductId(null, idx)).toBeNull();
    expect(resolveProductId({}, idx)).toBeNull();
    expect(resolveProductId({ productName: "" }, idx)).toBeNull();
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

  it("survives non-string input instead of white-screening the Source view", () => {
    // /products has no schema. The index builders run in a useMemo, so a
    // TypeError here takes the whole view down, not one card. The catalog
    // already holds names like "2598" — one careless re-save from being numeric.
    expect(() => normalizeName(2598)).not.toThrow();
    expect(normalizeName(2598)).toBe("2598");
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(() => normalizeName({})).not.toThrow();
  });
});

describe("index builders tolerate a malformed catalog", () => {
  it("a numeric name is indexed, not thrown on", () => {
    const idx = buildProductIdIndex([{ id: "pNum", name: 2598 }, UNIQUE]);
    expect(resolveProductIdByName(idx, "2598")).toBe("pNum");
    expect(resolveProductIdByName(idx, UNIQUE.name)).toBe("pU");
  });

  it("two products whose numeric names normalize alike still refuse", () => {
    const idx = buildProductIdIndex([{ id: "pA", name: 2598 }, { id: "pB", name: "2598" }]);
    expect(resolveProductIdByName(idx, "2598")).toBeNull();
  });

  it("buildPhotoIndex does not throw on a non-string name", () => {
    const idx = buildPhotoIndex([{ id: "pNum", name: 2598, photoUrl: "https://x/n.jpg" }]);
    expect(photoForProduct(idx, { productId: "pNum" }).photoUrl).toBe("https://x/n.jpg");
    expect(photoForProduct(idx, { productName: 2598 }).photoUrl).toBe("https://x/n.jpg");
  });
});
