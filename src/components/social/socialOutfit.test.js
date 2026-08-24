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

// ── A PAIRING IS CHOSEN AS A PAIRING, NOT SALVAGED FROM A FAILED OUTFIT ──────
// Owner spec: "A pairing is chosen as a pairing at the START of generation — it
// is never an outfit that failed to fill its slots. If the outfit builder
// cannot fill top/bottom/shoe it still refuses; it does not silently downgrade."
//
// The completeness rule for OUTFITS is unchanged and must stay unchanged: it is
// what stopped "a jacket and one shoe" being posted as a look.
describe("pairings exist alongside outfits, never instead of them", () => {
  const pairing = (candidates) => S.pickForKind("pairing", candidates);

  it("the outfit rule is untouched — a missing bottom still refuses", () => {
    // The assertion the owner asked for by name.
    const r = pick([cand("t-shirts"), cand("sneakers"), cand("perfumes")]);
    expect(r.picks).toEqual([]);
    expect(r.reason).toMatch(/bottom/);
  });

  it("an outfit never downgrades itself to a pairing", () => {
    // Same candidates, asked as an outfit: still nothing, not a consolation
    // two-piece.
    const r = pick([cand("hoodies"), cand("sneakers")]);
    expect(r.picks).toEqual([]);
  });

  it("but the same stock makes a legitimate pairing when ASKED for one", () => {
    const r = pairing([cand("hoodies"), cand("sneakers")]);
    expect(r.reason).toBeNull();
    expect(r.picks.map((p) => p.slot)).toEqual(["top", "shoe"]);
  });

  it("no pairing shape is secretly a complete outfit", () => {
    // A top+bottom+shoe set IS an outfit; posting it as a pairing would waste a
    // whole look on weaker framing.
    for (const shape of S.PAIRING_SHAPES) {
      const covers = S.OUTFIT_CORE.every((slot) => shape.includes(slot));
      expect(covers, `shape ${shape.join("+")} is a full outfit`).toBe(false);
    }
  });

  it("a produced pairing never contains top+bottom+shoe together", () => {
    const r = pairing([cand("hoodies"), cand("pants"), cand("sneakers"), cand("caps-beanies")]);
    expect(r.reason).toBeNull();
    const slots = new Set(r.picks.map((p) => p.slot));
    const isOutfit = S.OUTFIT_CORE.every((s) => slots.has(s));
    expect(isOutfit).toBe(false);
  });

  it("holds to two or three pieces", () => {
    const r = pairing([cand("hoodies"), cand("sneakers"), cand("perfumes"), cand("bags"), cand("caps-beanies")]);
    expect(r.picks.length).toBeGreaterThanOrEqual(2);
    expect(r.picks.length).toBeLessThanOrEqual(3);
  });

  it("refuses rather than pairing two unrelated things", () => {
    // Two bottoms is not a pairing anybody would post.
    const r = pairing([cand("pants"), cand("shorts")]);
    expect(r.picks).toEqual([]);
  });

  it("the mix is one named constant, in the range the owner asked for", () => {
    expect(S.PAIRING_EVERY_N_POSTS).toBeGreaterThanOrEqual(3);
    expect(S.PAIRING_EVERY_N_POSTS).toBeLessThanOrEqual(4);
  });
});

// ── NAMES REACH THE CUSTOMER CLEAN ───────────────────────────────────────────
describe("product names are cleaned once, in one place", () => {
  const { cleanProductName, isDirtyProductName } = require("../../../functions/lib/product-name.cjs");

  // Every case here is a REAL live product name, sampled 2026-08-24.
  for (const [raw, want] of [
    ["Diesel Jeans-4", "Diesel Jeans"],
    ["Adidas Tracksuit Grey #2506", "Adidas Tracksuit Grey"],
    ["DIESEL JEAN BLUE  #Y8161-1", "DIESEL JEAN BLUE"],
    ["Nike Tech Fleece Tracksuit Brown 2", "Nike Tech Fleece Tracksuit Brown"],
    [" New Era 59FIFTY Seattle Mariners cap navy", "New Era 59FIFTY Seattle Mariners cap navy"],
    ["Timberland dark brown ", "Timberland dark brown"],
    ["Nike Air Force 1 shell  Cream Brown", "Nike Air Force 1 shell Cream Brown"],
  ]) {
    it(`cleans ${JSON.stringify(raw)}`, () => expect(cleanProductName(raw)).toBe(want));
  }

  // The other half, and the more dangerous one: a real style code IS the
  // product. Stripping it would name a different item.
  for (const keep of [
    "G-Star Raw Cargo Jean GS-5211",
    "Replay jeans dark green B1113-3",
    "Lacoste L12 100ML",
    "Nike Air Force 1",
    "Jordan 1 black with brown",
  ]) {
    it(`leaves ${JSON.stringify(keep)} alone`, () => expect(cleanProductName(keep)).toBe(keep));
  }

  it("survives rubbish input without throwing", () => {
    for (const v of [null, undefined, 42, {}, ""]) expect(cleanProductName(v)).toBe("");
  });

  it("is idempotent — cleaning a clean name changes nothing", () => {
    for (const raw of ["Diesel Jeans-4", "Adidas Tracksuit Grey #2506", " Timberland "]) {
      const once = cleanProductName(raw);
      expect(cleanProductName(once)).toBe(once);
    }
  });

  it("reports which stored names would change", () => {
    expect(isDirtyProductName("Diesel Jeans-4")).toBe(true);
    expect(isDirtyProductName("Nike Air Force 1")).toBe(false);
  });
});

// ── PIECES HAVE TO BELONG TOGETHER ───────────────────────────────────────────
// Owner: "The shoe slot treats all footwear as interchangeable. It isn't — a
// soccer boot is a studded sports boot and belongs with nothing but sportswear."
//
// 25 soccer boots were live against 398 sneakers, all in one slot, so roughly
// one outfit in seventeen came out with studs and denim. Same failure class as
// the missing bottom slot: the distinction exists in the catalogue and the
// selector ignored it.
describe("footwear is not interchangeable", () => {
  const ctx = (categoryKey) => ({ slot: S.outfitSlot({ categoryKey }), product: { categoryKey } });

  describe("the rule itself, in both directions", () => {
    it("REFUSES soccer boots with jeans", () => {
      expect(S.sharedContext([ctx("soccer-boots"), ctx("jeans")])).toBe(false);
    });
    it("REFUSES soccer boots with chinos or pants", () => {
      expect(S.sharedContext([ctx("soccer-boots"), ctx("pants")])).toBe(false);
    });
    it("ALLOWS soccer boots with a jersey and shorts", () => {
      expect(S.sharedContext([ctx("soccer-boots"), ctx("soccer-jerseys"), ctx("shorts")])).toBe(true);
    });
    it("ALLOWS sneakers with jeans — the ordinary case must not regress", () => {
      expect(S.sharedContext([ctx("sneakers"), ctx("jeans"), ctx("t-shirts")])).toBe(true);
    });
    it("a wildcard accessory cannot rescue an incoherent look", () => {
      // A cap goes with anything and must never be the reason studs pass.
      expect(S.sharedContext([ctx("soccer-boots"), ctx("jeans"), ctx("caps-beanies")])).toBe(false);
    });
    it("a wildcard accessory is never the reason a good look is refused", () => {
      expect(S.sharedContext([ctx("sneakers"), ctx("jeans"), ctx("perfumes"), ctx("bags")])).toBe(true);
    });
  });

  describe("and the selector obeys it", () => {
    it("refuses an outfit when the only shoe is a soccer boot", () => {
      const r = pick([cand("soccer-boots"), cand("t-shirts"), cand("jeans")]);
      expect(r.picks).toEqual([]);
    });

    it("reaches past the boot to a sneaker rather than refusing", () => {
      // The boot may outrank the sneaker; coherence wins.
      const r = pick([cand("soccer-boots"), cand("sneakers"), cand("t-shirts"), cand("jeans")]);
      expect(r.reason).toBeNull();
      const keys = r.picks.map((p) => p.product.categoryKey);
      expect(keys).toContain("sneakers");
      expect(keys).not.toContain("soccer-boots");
    });

    it("still builds the sporty look boots DO belong in", () => {
      const r = pick([cand("soccer-boots"), cand("soccer-jerseys"), cand("shorts")]);
      expect(r.reason).toBeNull();
      expect(r.picks.map((p) => p.product.categoryKey)).toContain("soccer-boots");
    });

    it("refuses a boots-and-jeans PAIRING too", () => {
      const r = S.pickForKind("pairing", [cand("soccer-boots"), cand("jeans")]);
      expect(r.picks).toEqual([]);
    });

    it("allows a boots-and-jersey pairing", () => {
      const r = S.pickForKind("pairing", [cand("soccer-jerseys"), cand("soccer-boots")]);
      expect(r.reason).toBeNull();
      expect(r.picks.length).toBe(2);
    });
  });

  describe("the other footwear each carry their own rules", () => {
    it("slides are casual and summer, not smart", () => {
      expect(S.contextsOf(ctx("slides")).sort()).toEqual(["casual", "summer"]);
    });
    it("boots are winter, not summer — no slides-and-parka equivalents", () => {
      expect(S.contextsOf(ctx("boots"))).toContain("winter");
      expect(S.contextsOf(ctx("boots"))).not.toContain("summer");
    });
    it("a soccer boot belongs to sport and nothing else", () => {
      expect(S.contextsOf(ctx("soccer-boots"))).toEqual(["sport"]);
    });
    it("an unknown category is treated as casual, never as a wildcard", () => {
      // Being wrong towards ordinary streetwear is recoverable; being wrong
      // towards "goes with everything" is how studs reach denim.
      expect(S.contextsOf(ctx("something-new"))).toEqual(["casual"]);
      expect(S.contextsOf(ctx("something-new"))).not.toBeNull();
    });
  });
});
