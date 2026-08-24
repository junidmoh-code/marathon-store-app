// ─── THE MIRROR CHECK ─────────────────────────────────────────────────────────
// seatingCore.js mirrors resolveTarget out of functions/lib/refill-engine.cjs
// because the browser bundle cannot import functions/. A mirror nothing checks
// is a mirror that drifts, and a drifted carriage answer on this screen means
// switching off a shop the engine is still refilling.
//
// A hand-written table only proves the cases somebody thought of. This
// DIFFERENTIAL-FUZZES: randomised catalogues, configs, stock and rows, every
// case put through BOTH copies, every disagreement a failure. (The same method
// found two bugs two human reviews missed on the last engine mirror.)

import { describe, it, expect } from "vitest";
import {
  resolveTarget, seatingAt, seatingSizes, storeCarries, engineSizeKey,
  lastTouch, SEAT_REASON, SEATING_OFF_SOURCE,
} from "./seatingCore";

const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const engine = req("../../../functions/lib/refill-engine.cjs");

// ── a small deterministic PRNG: a fuzz that cannot be reproduced is a fuzz that
// cannot be debugged, and Math.random() would reroll on every CI run.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const LOCS = ["hub2", "marathon-pe", "trophy", "central"];
const SIZES = ["S", "M", "L", "XL", "5.5", "8", "", "ONE"];
const CATS = ["caps-beanies", "perfumes", "sneakers", "", null];

function makeCase(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const maybe = (v) => (r() < 0.5 ? v : undefined);
  const pid = "p1";
  const declared = SIZES.filter(() => r() < 0.5);
  const products = {
    [pid]: {
      id: pid,
      name: "X",
      sizes: declared,
      productType: maybe(pick(["clothing", "sneaker", undefined])),
      category: maybe(pick(["Footwear", "Clothing", undefined])),
      categoryKey: maybe(pick(CATS)),
      subcategory: maybe(pick(["Watches", "Caps", undefined])),
    },
  };
  const stock = {};
  for (const loc of LOCS) {
    if (r() < 0.4) continue;
    const bySize = {};
    for (const s of SIZES) if (r() < 0.4) bySize[engineSizeKey(s)] = { qty: Math.floor(r() * 9) - 2 };
    if (Object.keys(bySize).length) stock[loc] = { [pid]: bySize };
  }
  const targets = {};
  for (const loc of LOCS) {
    if (r() < 0.5) continue;
    const rows = {};
    for (const s of SIZES) {
      if (r() > 0.35) continue;
      rows[engineSizeKey(s)] = {
        target: pick([0, 1, 3, 7, -1, "4", NaN]),
        minQty: pick([0, 1, 2]),
        reorderPoint: maybe(pick([0, 1, -1, "2"])),
        source: pick([SEATING_OFF_SOURCE, "excluded", undefined]),
      };
    }
    if (Object.keys(rows).length) targets[loc] = { [pid]: rows };
  }
  const perSizeMap = {};
  for (const s of SIZES) if (r() < 0.4) perSizeMap[engineSizeKey(s)] = { target: pick([0, 2, 5, -1]), minQty: 1 };
  const config = {
    ruleBasedTargets: pick([true, false, undefined, { hub2: true, trophy: true }]),
    footwearTargets: pick([true, false, undefined, { hub2: true }]),
    defaultRunByStore: { hub2: { S: 2, M: 3, L: 3, XL: 2 }, trophy: { S: 1, M: 2 }, "marathon-pe": { M: 2 } },
    footwearRunByLocation: { hub2: { 8: 2, "5_5": 1 }, trophy: { 8: 1 } },
    footwearReorderPoint: maybe({ hub2: 0 }),
    // 0, negative and garbage are in the pool deliberately: a policy-level 0 is
    // a typo, NOT an exclusion, and a fuzz that never emits one cannot prove the
    // engine and this file agree about that. (It did not, and M2 survived.)
    subcategoryRunByLocation: maybe({ hub2: { Watches: pick([2, 0, -1, "3", NaN]) }, trophy: { Caps: pick([3, 0, NaN]) } }),
    categoryPolicy: maybe({
      [pick(CATS.filter(Boolean)) || "caps-beanies"]: r() < 0.5
        ? { perSize: r() < 0.5, hub2: { target: pick([0, 2, 4]), minQty: 1 }, trophy: { target: 2, minQty: 1 } }
        : { perSize: true, hub2: { sizes: perSizeMap } },
    }),
    policyGroups: maybe({
      g1: { armed: pick([true, false]), memberCategoryKeys: ["sneakers"], policy: { perSize: false, hub2: { target: 3, minQty: 1 } } },
    }),
  };
  return { products, stock, targets, config, pid, declared };
}

describe("resolveTarget is byte-for-byte the deployed engine's", () => {
  it("agrees on 40,000 randomised (config, catalogue, stock, row, size) cases", () => {
    const r = rng(20260824);
    let compared = 0;
    let nonNull = 0;
    for (let i = 0; i < 800; i++) {
      const c = makeCase(r);
      const ctx = { targets: c.targets, config: c.config, products: c.products, stock: c.stock };
      for (const loc of LOCS) {
        for (const size of SIZES) {
          const mine = resolveTarget(ctx, loc, c.pid, size);
          const theirs = engine.resolveTarget(ctx, loc, c.pid, size);
          compared++;
          if (theirs) nonNull++;
          expect(mine, `case ${i} ${loc} ${JSON.stringify(size)}`).toEqual(theirs);
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
    // A fuzz that only ever produced nulls would pass while proving nothing.
    expect(nonNull).toBeGreaterThan(compared / 20);
  });

  it("encodeSizeKey is the engine's, not the client encoder's", () => {
    for (const s of ["", " ", "M", 5.5, "5.5", null, undefined, "ONE SIZE", "a.b", 8]) {
      expect(engineSizeKey(s), String(s)).toBe(engine.encodeSizeKey(s));
    }
    // The difference that made this necessary: src/utils/sizeKey.js returns ""
    // for "", the engine returns the "_" no-size cell key.
    expect(engineSizeKey("")).toBe("_");
  });

  it("storeCarries is cell existence, quantity irrelevant", () => {
    const stock = { hub2: { p1: { M: { qty: 0 } } }, trophy: { p1: {} } };
    expect(storeCarries(stock, "hub2", "p1")).toBe(true);   // sold out, still carried
    expect(storeCarries(stock, "trophy", "p1")).toBe(false);
    expect(storeCarries(stock, "central", "p1")).toBe(false);
  });
});

// ── THE ANSWER ITSELF ────────────────────────────────────────────────────────

const P = { p1: { id: "p1", name: "Tee", sizes: ["S", "M", "L"], productType: "clothing" } };
const RUN = { ruleBasedTargets: true, defaultRunByStore: { trophy: { S: 1, M: 2, L: 2 } } };

describe("seatingAt", () => {
  it("a stocked clothing line at an armed shop is seated by the size run", () => {
    const stock = { trophy: { p1: { M: { qty: 4 } } } };
    const s = seatingAt({ products: P, stock, targets: {}, config: RUN }, "trophy", "p1");
    expect(s.seated).toBe(true);
    expect(s.reason).toBe(SEAT_REASON.CLOTHING_RULE);
    expect(s.units).toBe(4);
  });

  it("sold out is still seated — an empty shelf is not a delisting", () => {
    const stock = { trophy: { p1: { M: { qty: 0 } } } };
    const s = seatingAt({ products: P, stock, targets: {}, config: RUN }, "trophy", "p1");
    expect(s.seated).toBe(true);
    expect(s.units).toBe(0);
  });

  it("a target-0 row outranks the size run and reads as switched off", () => {
    const stock = { trophy: { p1: { M: { qty: 0 } } } };
    const targets = { trophy: { p1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 }, L: { target: 0, minQty: 0 } } } };
    const s = seatingAt({ products: P, stock, targets, config: RUN }, "trophy", "p1");
    expect(s.seated).toBe(false);
    expect(s.reason).toBe(SEAT_REASON.SWITCHED_OFF);
  });

  it("one size left un-zeroed still leaves the location seated", () => {
    const stock = { trophy: { p1: { M: { qty: 0 } } } };
    const targets = { trophy: { p1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 } } } };
    const s = seatingAt({ products: P, stock, targets, config: RUN }, "trophy", "p1");
    expect(s.seated).toBe(true);   // L is still armed by the run
  });

  it("stock with nothing arming it is CELL_ONLY, not switched off", () => {
    const stock = { trophy: { p1: { M: { qty: 3 } } } };
    const s = seatingAt({ products: P, stock, targets: {}, config: { ruleBasedTargets: false } }, "trophy", "p1");
    expect(s.seated).toBe(false);
    expect(s.reason).toBe(SEAT_REASON.CELL_ONLY);
    expect(s.units).toBe(3);
  });

  it("no cell and no row is NOT_SEATED", () => {
    const s = seatingAt({ products: P, stock: {}, targets: {}, config: RUN }, "trophy", "p1");
    expect(s.reason).toBe(SEAT_REASON.NOT_SEATED);
    expect(s.hasCell).toBe(false);
  });

  it("offRows names only the rows this screen wrote", () => {
    const targets = { trophy: { p1: {
      S: { target: 0, minQty: 0, source: SEATING_OFF_SOURCE },
      M: { target: 0, minQty: 0, source: "excluded" },
      L: { target: 4, minQty: 2 },
    } } };
    const s = seatingAt({ products: P, stock: {}, targets, config: RUN }, "trophy", "p1");
    expect(s.offRows).toEqual(["S"]);
  });
});

describe("seatingSizes covers every size the engine would arm", () => {
  it("declared catalogue sizes, not merely stocked ones", () => {
    const stock = { trophy: { p1: { M: { qty: 1 } } } };
    expect(seatingSizes({ products: P, stock, targets: {} }, "trophy", "p1").sort())
      .toEqual(["L", "M", "S"]);
  });

  it("keeps a row key for a size the catalogue no longer declares", () => {
    const targets = { trophy: { p1: { XXL: { target: 0, minQty: 0 } } } };
    expect(seatingSizes({ products: P, stock: {}, targets }, "trophy", "p1")).toContain("XXL");
  });
});

describe("lastTouch", () => {
  it("names the newest cell touch and whether it was a sale", () => {
    const stock = { trophy: { p1: {
      S: { qty: 1, lastType: "received", updatedAt: "2026-08-01T00:00:00.000Z" },
      M: { qty: 1, lastType: "sold", updatedAt: "2026-08-20T00:00:00.000Z" },
    } } };
    const t = lastTouch(seatingAt({ products: P, stock, targets: {}, config: RUN }, "trophy", "p1"));
    expect(t.sold).toBe(true);
    expect(t.at).toBe("2026-08-20T00:00:00.000Z");
  });

  it("is null when no cell was ever touched", () => {
    expect(lastTouch(seatingAt({ products: P, stock: {}, targets: {}, config: RUN }, "trophy", "p1"))).toBe(null);
  });
});
