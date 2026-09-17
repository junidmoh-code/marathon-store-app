import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeMissingProducts, groupOf, countByCategory, isClothing, isPerfume,
  buildChips, pickActiveTab, inFootwearGroup, admitsMissingProduct, FOOTWEAR_GROUP_KEYS,
} from "./missingProductsCore";

// Live catalogue shapes (2026-08-03). Bags, watches and belts are all recorded
// as productType "clothing" — that is why they appear in this tab at all.
const TEE     = { id: "t1", name: "Nike Tee",     category: "Clothing",    subcategory: "T-Shirts", productType: "clothing", sizes: ["S", "M", "L"] };
const JERSEY  = { id: "j1", name: "Real Madrid",  category: "Clothing",    subcategory: "Jerseys",  productType: "clothing", sizes: ["M", "L"] };
const UNCAT   = { id: "u1", name: "Mystery top",  category: "Clothing",    subcategory: "Clothing — Uncategorized", productType: "clothing", sizes: ["M"] };
const BAG     = { id: "b1", name: "Nike Duffel",  category: "Accessories", subcategory: "Bags",     productType: "clothing", sizes: ["_"] };
const WATCH   = { id: "w1", name: "Swarovski",    category: "Accessories", subcategory: "Watches",  productType: "clothing", sizes: ["_"] };
const BELT    = { id: "be1", name: "Belt Premium", category: "Accessories", subcategory: "Belts",   productType: "clothing", sizes: ["_"] };
const SNEAKER = { id: "s1", name: "Air Force 1",  category: "Footwear",    subcategory: "Sneakers", productType: "sneaker",  sizes: ["8", "9"] };
// A perfume exactly as the catalogue holds one (2026-08-13): NO productType at
// all — the app form cannot create these, they are script-written — and
// categoryKey "perfumes" is the identity all 65 live records share.
const PERFUME = { id: "pf1", name: "Queen of Fire", category: "Perfume",   subcategory: "Perfume",  categoryKey: "perfumes", sizes: ["_"] };
// The two live hybrids: categoryKey "perfumes" AND productType "clothing".
// isClothing wins, so they stay under Clothing exactly where they are today.
const HYBRID  = { id: "hy1", name: "Perfume Gift Bag", category: "Accessories", subcategory: "Bags", categoryKey: "perfumes", productType: "clothing", sizes: ["_"] };

const PRODUCTS = [TEE, JERSEY, UNCAT, BAG, WATCH, BELT, SNEAKER, PERFUME, HYBRID];
const cell = (qty) => ({ qty });

// Owner directives, layered: 2026-08-05 — Sneakers and Clothing, with Clothing
// holding everything non-sneaker (superseding the 2026-08-04 per-subcategory
// chips of PR #308); 2026-08-13 — Perfume added as its own third fixed chip,
// with the Clothing count unchanged. These tests pin that three-chip contract
// so a revert to per-type chips, or perfume bleeding into Clothing, fails here.
describe("groupOf — clothing is one pile, perfume is its own chip", () => {
  it("puts every clothing product under the ONE Clothing chip", () => {
    for (const p of [TEE, JERSEY, BAG, WATCH, BELT, UNCAT]) {
      expect(groupOf(p)).toEqual({ key: "clothing", label: "Clothing" });
    }
  });
  it("uncategorised is not split out — it is simply part of Clothing", () => {
    // Under #308 this was its own chip (45% of the tab). The 2026-08-05
    // directive folds it in: nothing is hidden, because the Clothing chip IS
    // the clothing pile.
    expect(groupOf(UNCAT).key).toBe("clothing");
    expect(groupOf({ subcategory: "" }).key).toBe("clothing");
    expect(groupOf({}).key).toBe("clothing");
    expect(groupOf(null).key).toBe("clothing");
  });
  it("perfume gets its OWN chip — the Clothing count must not change", () => {
    expect(groupOf(PERFUME)).toEqual({ key: "perfume", label: "Perfume" });
  });
  it("a clothing-typed record stays Clothing even with categoryKey 'perfumes'", () => {
    // The two live hybrids appear under Clothing today; admitting perfume must
    // move NOTHING that is already visible.
    expect(groupOf(HYBRID).key).toBe("clothing");
  });
});

describe("isPerfume — the exact live identity, and nothing wider", () => {
  it("admits a live perfume record (no productType, '_' size)", () => {
    expect(isPerfume(PERFUME)).toBe(true);
  });
  it("admits nothing else — category/subcategory spellings do NOT count", () => {
    // categoryKey is the one field all 65 live perfumes share; a look-alike
    // record without it stays out, as does every other class in the catalogue.
    expect(isPerfume({ category: "Perfume", subcategory: "Perfume", sizes: ["_"] })).toBe(false);
    for (const p of [TEE, JERSEY, UNCAT, BAG, WATCH, BELT, SNEAKER, null, undefined, {}]) {
      expect(isPerfume(p)).toBe(false);
    }
  });
});

describe("computeMissingProducts — which products are stranded", () => {
  it("flags Central-only stock as 'Only in Central'", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: "t1", source: "central", kind: "Only in Central", units: 5, group: "clothing", groupLabel: "Clothing" });
    expect(cards[0].missing).toEqual(["hub2", "marathon-pe", "trophy"]);
  });
  it("flags Hub 2 stock no shop carries as 'Only in Hub 2'", () => {
    const cards = computeMissingProducts({
      allStock: { hub2: { t1: { M: cell(3) } } }, products: PRODUCTS,
    });
    expect(cards[0]).toMatchObject({ source: "hub2", kind: "Only in Hub 2" });
    expect(cards[0].missing).toEqual(["marathon-pe", "trophy"]);
  });
  it("a shop CARRYING it retires the card, even at qty 0 — that's what Solve does", () => {
    const carriedZero = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } }, trophy: { t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(carriedZero).toHaveLength(0);
  });
  it("Central stock already buffered at Hub 2 is not stranded", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(5) } }, hub2: { t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("excludes sneakers (their own tab) and anything with no upstream units", () => {
    const cards = computeMissingProducts({
      allStock: { central: { s1: { 9: cell(10) }, t1: { M: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("ADMITS perfume — stranded perfume was invisible here until 2026-08-13", () => {
    // The old contract ("excludes perfume") is deliberately flipped: 6 perfumes
    // holding 288 units sat stranded at Central with no way to ever be seen or
    // solved. A perfume card carries the perfume group so it renders under its
    // own chip, leaving the Clothing count untouched.
    const cards = computeMissingProducts({
      allStock: { central: { pf1: { _: cell(9) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: "pf1", source: "central", kind: "Only in Central", units: 9, group: "perfume", groupLabel: "Perfume" });
    // The one-size sentinel survives as the card's size key — never a label.
    expect(cards[0].sizes).toEqual([{ size: "_", avail: 9 }]);
  });
  it("a perfume a shop already carries is not stranded — same carriage rule as clothing", () => {
    const cards = computeMissingProducts({
      allStock: { central: { pf1: { _: cell(9) } }, "marathon-pe": { pf1: { _: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("a perfume with no units anywhere is not a card — nothing to send", () => {
    const cards = computeMissingProducts({
      allStock: { central: { pf1: { _: cell(0) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(0);
  });
  it("bags and watches land in the tab — under Clothing", () => {
    const cards = computeMissingProducts({
      allStock: { central: { b1: { _: cell(6) }, w1: { _: cell(2) } } }, products: PRODUCTS,
    });
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.group))).toEqual(new Set(["clothing"]));
  });
  it("negative cells never count as available units", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(-4), L: cell(2) } } }, products: PRODUCTS,
    });
    expect(cards[0].units).toBe(2);
    expect(cards[0].sizes.map((s) => s.size)).toEqual(["L"]);
  });
  it("sorts by units, heaviest first", () => {
    const cards = computeMissingProducts({
      allStock: { central: { t1: { M: cell(2) }, j1: { L: cell(9) }, b1: { _: cell(5) } } }, products: PRODUCTS,
    });
    expect(cards.map((c) => c.pid)).toEqual(["j1", "b1", "t1"]);
  });
  it("survives empty, absent and MALFORMED input without throwing", () => {
    expect(computeMissingProducts({ allStock: {}, products: [] })).toEqual([]);
    expect(computeMissingProducts({})).toEqual([]);
    expect(computeMissingProducts()).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { ghost: { M: cell(3) } } }, products: PRODUCTS })).toEqual([]);
    // The shapes that actually threw before hardening: the raw /products MAP
    // instead of the array the app passes, and null/undefined members. A crash
    // here blanks the whole Health screen, so it must degrade to "nothing
    // stranded" instead. (Codex review, PR #308.)
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: {} })).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: null })).toEqual([]);
    expect(computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: "nope" })).toEqual([]);
    expect(() => computeMissingProducts({ allStock: { central: { t1: { M: cell(5) } } }, products: [null, undefined, TEE] })).not.toThrow();
  });
});

describe("countByCategory — the chip numbers", () => {
  const allStock = {
    central: { t1: { M: cell(4) }, j1: { L: cell(3) }, b1: { _: cell(6) }, w1: { _: cell(2) }, be1: { _: cell(1) }, u1: { M: cell(7) } },
  };
  it("every clothing card counts under the one Clothing chip", () => {
    const counts = countByCategory(computeMissingProducts({ allStock, products: PRODUCTS }));
    expect(counts).toEqual({ clothing: 6 });
  });
  it("a stranded perfume counts under Perfume — Clothing stays byte-for-byte", () => {
    // The hybrid (clothing-typed, categoryKey "perfumes") lands under Clothing:
    // admitting perfume changes no number that already rendered.
    const withPerfume = {
      central: { ...allStock.central, pf1: { _: cell(9) }, hy1: { _: cell(2) } },
    };
    const counts = countByCategory(computeMissingProducts({ allStock: { central: withPerfume.central }, products: PRODUCTS }));
    expect(counts).toEqual({ clothing: 7, perfume: 1 });
  });
  it("THE LOAD-BEARING PROPERTY: the chips account for every single card", () => {
    // If this ever fails, stranded stock is invisible in the one tab meant to
    // surface it. With one Clothing bucket this reduces to "the chip count IS
    // the card count" — asserted directly.
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    const summed = Object.values(countByCategory(cards)).reduce((a, b) => a + b, 0);
    expect(summed).toBe(cards.length);
  });
  it("and the Clothing chip's count matches the list the tab renders", () => {
    const cards = computeMissingProducts({ allStock, products: PRODUCTS });
    expect(cards.filter((c) => c.group === "clothing")).toHaveLength(countByCategory(cards).clothing);
  });
});

describe("buildChips + pickActiveTab — three fixed chips", () => {
  const card = () => ({ group: "clothing", groupLabel: "Clothing" });
  const many = (n) => Array.from({ length: n }, card);
  const perfumeCard = () => ({ group: "perfume", groupLabel: "Perfume" });

  it("is always exactly [Clothing, Perfume, Sneakers] — no per-type chips", () => {
    expect(buildChips(many(41), 12)).toEqual([
      ["clothing", "Clothing", 41],
      ["perfume", "Perfume", 0],
      ["sneakers", "Sneakers", 12],
    ]);
  });
  it("counts each chip from its GROUP — perfume cards never inflate Clothing", () => {
    const chips = buildChips([...many(3), perfumeCard(), perfumeCard()], 1);
    expect(chips).toEqual([
      ["clothing", "Clothing", 3],
      ["perfume", "Perfume", 2],
      ["sneakers", "Sneakers", 1],
    ]);
  });
  it("all chips render even at zero, so the row never reshuffles", () => {
    expect(buildChips([], 0)).toEqual([
      ["clothing", "Clothing", 0],
      ["perfume", "Perfume", 0],
      ["sneakers", "Sneakers", 0],
    ]);
    expect(buildChips(undefined, undefined)).toEqual([
      ["clothing", "Clothing", 0],
      ["perfume", "Perfume", 0],
      ["sneakers", "Sneakers", 0],
    ]);
  });
  it("keeps the user's selection while it still exists", () => {
    const chips = buildChips(many(5), 3);
    expect(pickActiveTab(chips, "clothing")).toBe("clothing");
    expect(pickActiveTab(chips, "perfume")).toBe("perfume");
    expect(pickActiveTab(chips, "sneakers")).toBe("sneakers");
  });
  it("a stale per-type selection from before this change falls back, never blanks", () => {
    // An operator could have "bags" persisted from the #308 chip row.
    const chips = buildChips(many(5), 3);
    for (const stale of ["bags", "watches", "uncategorised", "nonsense", null, undefined]) {
      expect(pickActiveTab(chips, stale)).toBe("clothing");
    }
  });
  it("opens on Clothing when nothing has been chosen yet", () => {
    expect(pickActiveTab(buildChips(many(2), 4), null)).toBe("clothing");
  });
  it("never returns a key that isn't in the rendered row", () => {
    const chips = buildChips(many(3), 1);
    const keys = chips.map(([k]) => k);
    for (const sel of ["bags", "t-shirts", "nonsense", undefined, null]) {
      expect(keys).toContain(pickActiveTab(chips, sel));
    }
  });
});

describe("the admission gate — the complement of the footwear group (2026-09-17)", () => {
  const MISTYPED_SUIT = { id: "su1", name: "Suit jacket black FF1070", categoryKey: "suits", category: "Clothing", subcategory: "Suits", productType: "sneaker", sizes: ["S", "M"] };
  const PHONE = { id: "ph1", name: "Phone case", categoryKey: "iphone", sizes: ["_"] };
  const KEYLESS_TYPELESS = { id: "kt1", name: "Mystery accessory", category: "Accessories", sizes: ["_"] };
  const BOOT = { id: "bt1", name: "Timberland", categoryKey: "boots", category: "Footwear", subcategory: "Boots", sizes: ["8"] };
  const SLIDE = { id: "sl1", name: "Arizona", categoryKey: "slides", category: "Footwear", subcategory: "Sandals & Slides", sizes: ["8"] };
  const LEGACY_SNEAKER = { id: "ls1", name: "Campus", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] };
  const KEYED_SHOE_ODD_CATEGORY = { id: "ks1", name: "Loafer", categoryKey: "loafers", category: "Accessories", sizes: ["8"] };
  it("ADMITS every non-footwear record — clothing, perfume, AND the mis-typed / typeless ones that used to be invisible", () => {
    for (const p of [TEE, BAG, WATCH, PERFUME, HYBRID, MISTYPED_SUIT, PHONE, KEYLESS_TYPELESS]) {
      expect(admitsMissingProduct(p), p.id).toBe(true);
      expect(inFootwearGroup(p), p.id).toBe(false);
    }
    const cards = computeMissingProducts({
      allStock: { central: { su1: { S: cell(8) }, ph1: { _: cell(3) } } }, products: [...PRODUCTS, MISTYPED_SUIT, PHONE],
    });
    expect(cards.map((c) => c.pid).sort()).toEqual(["ph1", "su1"]);
    expect(cards.every((c) => c.group === "clothing")).toBe(true);   // no new chip — the pile
  });
  it("EXCLUDES the whole footwear group, by legacy category OR by key (incl. a keyless legacy sneaker)", () => {
    for (const p of [SNEAKER, BOOT, SLIDE, LEGACY_SNEAKER, KEYED_SHOE_ODD_CATEGORY]) {
      expect(admitsMissingProduct(p), p.id).toBe(false);
      expect(inFootwearGroup(p), p.id).toBe(true);
    }
    const cards = computeMissingProducts({
      allStock: { central: { bt1: { 8: cell(4) }, sl1: { 8: cell(4) }, ls1: { 8: cell(4) } } }, products: [...PRODUCTS, BOOT, SLIDE, LEGACY_SNEAKER],
    });
    expect(cards).toHaveLength(0);
    expect(admitsMissingProduct(null)).toBe(false);
    expect(admitsMissingProduct(undefined)).toBe(false);
  });
  it("a clothing-typed record is clothing whatever its category says — the engine's precedence — and the two Health tabs are complementary on it", async () => {
    const hoodie = { id: "h", name: "Footwear hoodie", category: "Footwear", productType: "clothing", sizes: ["M"] };
    expect(inFootwearGroup(hoodie)).toBe(false);
    const { computeMissingFootwear } = await import("./missingFootwearCore.js");
    const allStock = { central: { h: { M: cell(3) } } };
    expect(computeMissingProducts({ allStock, products: [hoodie] }).map((c) => c.pid)).toEqual(["h"]);
    expect(computeMissingFootwear({ allStock, products: [hoodie] })).toEqual([]);
    // and a real shoe is the other way round
    const shoe = { id: "s", name: "Campus", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] };
    expect(computeMissingProducts({ allStock: { central: { s: { 8: cell(3) } } }, products: [shoe] })).toEqual([]);
    expect(computeMissingFootwear({ allStock: { central: { s: { 8: cell(3) } } }, products: [shoe] }).map((c) => c.pid)).toEqual(["s"]);
  });
  it("the group's key list is the engine's own (refill-engine.cjs FOOTWEAR_GROUP_KEYS), so the two Health tabs cannot drift", () => {
    const engine = readFileSync(new URL("../../../functions/lib/refill-engine.cjs", import.meta.url), "utf8");
    const m = /const FOOTWEAR_GROUP_KEYS = new Set\(\[([^\]]+)\]\)/.exec(engine);
    expect(m).toBeTruthy();
    const engineKeys = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
    expect([...FOOTWEAR_GROUP_KEYS].sort()).toEqual(engineKeys);
  });
});

describe("isClothing — unchanged from the engine's definition", () => {
  it("prefers the explicit flag", () => {
    expect(isClothing(TEE)).toBe(true);
    expect(isClothing(BAG)).toBe(true);
    expect(isClothing(SNEAKER)).toBe(false);
  });
  it("falls back to the garment-size heuristic when productType is absent", () => {
    expect(isClothing({ sizes: ["M", "L"] })).toBe(true);
    expect(isClothing({ sizes: ["_"] })).toBe(false);
    expect(isClothing({ sizes: ["9", "10"] })).toBe(false);
    expect(isClothing(null)).toBe(false);
  });
});
