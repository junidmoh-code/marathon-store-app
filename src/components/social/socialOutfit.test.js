// ── AN OUTFIT IS A LOOK, NOT A PILE ──────────────────────────────────────────
// Owner, on the posts this engine was producing: "The outfits aren't
// combinations a real person would wear — a jacket and one shoe isn't a look."
//
// Two structural causes, both fixed and both pinned here:
//
//   1. THERE WAS NO BOTTOM SLOT. The slot vocabulary was shoe / top / cap /
//      fragrance, so no outfit this engine could build was capable of
//      containing trousers. 38 pants and 4 shorts were live and unreachable.
//
//   2. minProducts WAS 2. A t-shirt and a pair of trainers satisfied it.
//
// An outfit now has to cover the CORE — top, bottom, shoe — with a tracksuit
// counting as both top and bottom, because adding trousers beside one is a
// styling error rather than a completeness fix.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../../../functions/lib/social-select.cjs");

// A candidate as buildCandidates emits it — only the fields the picker reads.
let n = 0;
const cand = (categoryKey, over = {}) => {
  const pid = `p${++n}`;
  return {
    pid, name: `Item ${pid}`, displayName: `Brand Item ${pid}`,
    product: { categoryKey }, slot: S.outfitSlot({ categoryKey }),
    retailPrice: 500, score: 1, ...over,
  };
};
const pick = (candidates) => S.pickForKind("outfit", candidates);

describe("the slot vocabulary reaches the whole catalogue", () => {
  for (const [key, slot] of [
    ["pants", "bottom"], ["shorts", "bottom"], ["jeans", "bottom"],
    ["sneakers", "shoe"], ["designer-shoes", "shoe"], ["slides", "shoe"],
    ["t-shirts", "top"], ["hoodies", "top"], ["tracksuits", "top"],
    ["caps-beanies", "cap"], ["bags", "bag"], ["perfumes", "fragrance"],
  ]) {
    it(`${key} fills the ${slot} slot`, () => {
      expect(S.outfitSlot({ categoryKey: key })).toBe(slot);
    });
  }

  it("bottoms are reachable at all — the regression that started this", () => {
    expect(S.OUTFIT_SLOTS).toContain("bottom");
  });
});

describe("an outfit must cover top, bottom and shoe", () => {
  it("refuses a top and a shoe with nothing on the legs", () => {
    const r = pick([cand("t-shirts"), cand("sneakers")]);
    expect(r.picks).toEqual([]);
    expect(r.reason).toMatch(/bottom/);
  });

  it("refuses a bottom and a shoe with nothing on top", () => {
    const r = pick([cand("pants"), cand("sneakers")]);
    expect(r.picks).toEqual([]);
    expect(r.reason).toMatch(/top/);
  });

  it("refuses a top and a bottom with no shoes", () => {
    const r = pick([cand("hoodies"), cand("pants")]);
    expect(r.picks).toEqual([]);
    expect(r.reason).toMatch(/shoe/);
  });

  it("accepts a genuine look", () => {
    const r = pick([cand("hoodies"), cand("pants"), cand("sneakers")]);
    expect(r.reason).toBeNull();
    expect(r.picks.map((p) => p.slot).sort()).toEqual(["bottom", "shoe", "top"]);
  });

  it("does not let finishing pieces stand in for the core", () => {
    // A cap, a bag and a fragrance is three products and no outfit.
    const r = pick([cand("caps-beanies"), cand("bags"), cand("perfumes")]);
    expect(r.picks).toEqual([]);
  });
});

describe("a tracksuit is the top AND the bottom", () => {
  it("is accepted with shoes alone, without trousers added beside it", () => {
    const r = pick([cand("tracksuits"), cand("sneakers")]);
    expect(r.reason).toBeNull();
    expect(r.picks.map((p) => p.slot)).toEqual(["top", "shoe"]);
  });

  it("does not pull in separate trousers when a tracksuit is chosen", () => {
    const r = pick([cand("tracksuits"), cand("pants"), cand("sneakers")]);
    expect(r.reason).toBeNull();
    expect(r.picks.some((p) => p.slot === "bottom")).toBe(false);
  });

  it("still adds finishing pieces to a tracksuit look", () => {
    const r = pick([cand("tracksuits"), cand("sneakers"), cand("caps-beanies")]);
    expect(r.picks.map((p) => p.slot)).toContain("cap");
  });
});

describe("finishing pieces are added, never required", () => {
  it("adds cap, bag and fragrance when they are there", () => {
    const r = pick([
      cand("hoodies"), cand("pants"), cand("sneakers"),
      cand("caps-beanies"), cand("bags"), cand("perfumes"),
    ]);
    expect(r.reason).toBeNull();
    const slots = r.picks.map((p) => p.slot);
    expect(slots).toContain("cap");
    expect(slots.length).toBeLessThanOrEqual(5);   // the kind's ceiling
  });

  it("is happy with the bare core when nothing else is live", () => {
    const r = pick([cand("t-shirts"), cand("shorts"), cand("slides")]);
    expect(r.reason).toBeNull();
    expect(r.picks.length).toBe(3);
  });

  it("never returns fewer than three pieces for an outfit", () => {
    const r = pick([cand("hoodies"), cand("pants"), cand("sneakers")]);
    expect(r.picks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the outfit kind's own contract", () => {
  const outfit = S.POST_KINDS.find((k) => k.key === "outfit");
  it("needs at least three products", () => {
    // The old minimum of 2 is what made "a jacket and one shoe" legal.
    expect(outfit.minProducts).toBeGreaterThanOrEqual(3);
  });
  it("allows room for the finishing pieces", () => {
    expect(outfit.maxProducts).toBeGreaterThanOrEqual(5);
  });
});
