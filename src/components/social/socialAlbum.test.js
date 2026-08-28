// ── THE ALBUM, READ BACK ─────────────────────────────────────────────────────
// The dangerous failures here are all quiet ones: a fit total that omits a
// line without saying so, a price of R0 where there is no price, an
// add-all button offered on a look that cannot be bought.
import { describe, it, expect } from "vitest";
import {
  albumList, normaliseAlbumEntry, isFit, resolveFit, formatRand, slotRank,
} from "./socialAlbum.js";

const img = (u = "https://s/x.jpg") => [{ type: "image", url: u }];
const entry = (over = {}) => ({
  postId: "P1", media: img(), kind: "outfit", createdAt: 2,
  products: [{ pid: "a", slot: "shoe" }, { pid: "b", slot: "top" }],
  ...over,
});

const catalogue = {
  a: { name: "Campus Black", price: 650, available: true },
  b: { name: "Red tracksuit", price: 850, available: true },
  c: { name: "Cap", price: 250, available: false },
};
const look = (pid) => catalogue[pid] || null;

describe("normalising", () => {
  it("keeps an entry with a picture", () => {
    expect(normaliseAlbumEntry("P1", entry()).url).toBe("https://s/x.jpg");
  });
  it("drops an entry with no picture", () => {
    expect(normaliseAlbumEntry("P1", entry({ media: [] }))).toBeNull();
    expect(normaliseAlbumEntry("P1", null)).toBeNull();
  });
  it("drops products with no pid rather than rendering blanks", () => {
    const e = normaliseAlbumEntry("P1", entry({ products: [{ slot: "shoe" }, { pid: "a" }] }));
    expect(e.products.map((p) => p.pid)).toEqual(["a"]);
  });
  it("lists newest first and survives a null createdAt", () => {
    const list = albumList({ old: entry({ createdAt: 1 }), neu: entry({ createdAt: 9 }), odd: entry({ createdAt: null }) });
    expect(list.map((e) => e.id)).toEqual(["neu", "old", "odd"]);
  });
});

describe("what counts as a fit", () => {
  it("two products is a fit", () => expect(isFit(normaliseAlbumEntry("P", entry()))).toBe(true));
  it("one is not, whatever the kind says", () => {
    expect(isFit(normaliseAlbumEntry("P", entry({ products: [{ pid: "a" }] })))).toBe(false);
  });
});

describe("the fit total", () => {
  it("adds the items up", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry()), look);
    expect(r.total).toBe(1500);
    expect(r.complete).toBe(true);
    expect(r.canAddAll).toBe(true);
  });

  it("reads top to bottom, not in pick order", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry()), look);
    expect(r.items.map((i) => i.slot)).toEqual(["top", "shoe"]);
  });

  it("a deleted product is reported, not silently dropped from the sum", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry({
      products: [{ pid: "a", slot: "shoe" }, { pid: "gone", slot: "top" }],
    })), look);
    expect(r.missingCount).toBe(1);
    expect(r.complete).toBe(false);       // the page must not call 650 "the fit"
    expect(r.total).toBe(650);
    expect(r.canAddAll).toBe(false);
  });

  it("a sold-out item still prices but blocks add-all", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry({
      products: [{ pid: "a", slot: "shoe" }, { pid: "c", slot: "cap" }],
    })), look);
    expect(r.total).toBe(900);
    expect(r.complete).toBe(true);
    expect(r.soldOutCount).toBe(1);
    expect(r.canAddAll).toBe(false);
  });

  it("an unpriced product is not treated as free", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry({ products: [{ pid: "a" }, { pid: "z" }] })),
      (pid) => (pid === "z" ? { name: "No price", price: null, available: true } : catalogue[pid]));
    expect(r.items.find((i) => i.pid === "z").price).toBeNull();
    expect(r.total).toBe(650);
    expect(r.complete).toBe(false);
  });

  it("a zero or negative price is not a price", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry({ products: [{ pid: "z" }] })),
      () => ({ name: "Odd", price: 0, available: true }));
    expect(r.items[0].price).toBeNull();
    expect(r.total).toBeNull();
  });

  it("nothing resolvable gives a null total, never 0", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry()), () => null);
    expect(r.total).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.canAddAll).toBe(false);
  });

  it("survives a missing lookup function", () => {
    const r = resolveFit(normaliseAlbumEntry("P", entry()), undefined);
    expect(r.items).toHaveLength(2);
    expect(r.total).toBeNull();
  });
});

describe("slot order and formatting", () => {
  it("orders a look the way you'd describe it", () => {
    expect(slotRank("cap")).toBeLessThan(slotRank("top"));
    expect(slotRank("top")).toBeLessThan(slotRank("bottom"));
    expect(slotRank("bottom")).toBeLessThan(slotRank("shoe"));
  });
  it("an unknown slot sorts last instead of first", () => {
    expect(slotRank("mystery")).toBeGreaterThan(slotRank("fragrance"));
    expect(slotRank(null)).toBeGreaterThan(slotRank("shoe"));
  });
  it("formats rand without cents, grouped with a plain space", () => {
    expect(formatRand(1500)).toBe("R1 500");
    expect(formatRand(850)).toBe("R850");
    expect(formatRand(1234567)).toBe("R1 234 567");
    // Not the non-breaking space toLocaleString would give us.
    expect(formatRand(1500).includes("\u00a0")).toBe(false);
  });
  it("shows a dash rather than R0 when there is no number", () => {
    expect(formatRand(null)).toBe("—");
    expect(formatRand(NaN)).toBe("—");
  });
});
