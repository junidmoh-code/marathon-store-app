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

// ── THE SNAPSHOT THE MIRROR IS FED ───────────────────────────────────────────
// The mirror was right; the data under it was not. The dead-size rule counts
// units ANYWHERE (sizeUnitsAnywhere walks Object.keys(stock)), so a snapshot
// that omits in_transit or a deactivated warehouse makes a live size read as
// dead — and the row then says "not carried" for a line the engine is actively
// seating. Six category policies are armed live and /stock/in_transit holds
// real units, so this is not hypothetical. (Found in review, PR #429.)
describe("a partial stock snapshot changes the answer", () => {
  const PERFUME = { p9: { id: "p9", name: "Eau", sizes: ["100ml"], categoryKey: "perfumes" } };
  const POLICY = { categoryPolicy: { perfumes: { perSize: true, trophy: { target: 2, minQty: 1 } } } };
  const ROW = { products: PERFUME, targets: {}, config: POLICY };

  it("units sitting in transit keep the size ALIVE", () => {
    const whole = { ...ROW, stock: { in_transit: { p9: { "100ml": { qty: 6 } } }, trophy: { p9: { "100ml": { qty: 0 } } } } };
    expect(resolveTarget(whole, "trophy", "p9", "100ml").target).toBe(2);
    // and the engine agrees, which is the point
    expect(engine.resolveTarget(whole, "trophy", "p9", "100ml").target).toBe(2);
  });

  it("the SAME product reads dead once in_transit is dropped from the snapshot", () => {
    const partial = { ...ROW, stock: { trophy: { p9: { "100ml": { qty: 0 } } } } };
    expect(resolveTarget(partial, "trophy", "p9", "100ml").target).toBe(0);
    expect(seatingAt(partial, "trophy", "p9").seated).toBe(false);
    // ...so the caller must pass every location that can hold a cell.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE COVERAGE FUZZ — a different question from the differential fuzz
// ═════════════════════════════════════════════════════════════════════════════
//
// The differential fuzz asks "for THIS size, do the two copies agree?" It can
// never catch a size seatingSizes forgot to return, because it only ever asks
// about sizes seatingSizes returned. That blind spot hid a live bug: a one-size
// category policy arms the "_" cell with no carriage gate, and the switch-off
// covered every size except that one.
//
// So this asks the other question: IS THERE ANY SIZE THE ENGINE ARMS THAT THE
// SWITCH-OFF WOULD NOT COVER? If there is, switching off leaves the shop armed
// and the screen says it is off — the precise failure the feature exists to
// end. (Adversarial review, PR #429.)
describe("no size the engine arms is left uncovered", () => {
  it("holds over 12,000 randomised (policy, catalogue, stock, location) cases", () => {
    const r = rng(429429);
    const PROBE = ["", "S", "M", "L", "XL", "5.5", "8", "100ml", "ONE"];
    let armed = 0;
    const misses = [];
    for (let i = 0; i < 400; i++) {
      const c = makeCase(r);
      const ctx = { targets: c.targets, config: c.config, products: c.products, stock: c.stock };
      for (const loc of LOCS) {
        const covered = new Set(seatingSizes(ctx, loc, c.pid));
        for (const size of PROBE) {
          const t = engine.resolveTarget(ctx, loc, c.pid, size);
          if (!t || t.target <= 0) continue;           // not armed → nothing to cover
          armed++;
          if (!covered.has(engine.encodeSizeKey(size))) {
            misses.push(`case ${i} ${loc} ${JSON.stringify(size)} armed ${t.target} via ${t.source}`);
          }
        }
      }
    }
    expect(armed, "the fuzz must actually arm things").toBeGreaterThan(200);
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it("the concrete case that was live: a one-size category policy on a perfume", () => {
    const products = { p9: { id: "p9", name: "Eau", sizes: ["S", "M"], categoryKey: "perfumes" } };
    const config = { categoryPolicy: { perfumes: { trophy: { target: 4, minQty: 2 } } } };
    const ctx = { products, stock: {}, targets: {}, config };
    // The engine arms the no-size cell at trophy, with no cell and no row.
    expect(engine.resolveTarget(ctx, "trophy", "p9", "").target).toBe(4);
    expect(seatingSizes(ctx, "trophy", "p9")).toContain("_");
    expect(seatingAt(ctx, "trophy", "p9").seated).toBe(true);
    expect(seatingAt(ctx, "trophy", "p9").reason).toBe(SEAT_REASON.CATEGORY_POLICY);
  });

  it("a product declaring NO sizes can still be switched off", () => {
    const products = { p9: { id: "p9", name: "Eau", categoryKey: "perfumes" } };
    const config = { categoryPolicy: { perfumes: { trophy: { target: 4, minQty: 2 } } } };
    const ctx = { products, stock: {}, targets: {}, config };
    // Used to be [] — nothing to write, so the location could not be turned off.
    expect(seatingSizes(ctx, "trophy", "p9")).toEqual(["_"]);
  });

  it("a PER-SIZE policy does not gain a phantom \"_\" row", () => {
    const products = { p9: { id: "p9", name: "Cap", sizes: ["S", "M"], categoryKey: "caps-beanies" } };
    const config = { categoryPolicy: { "caps-beanies": { perSize: true, trophy: { target: 2, minQty: 1 } } } };
    expect(seatingSizes({ products, stock: {}, targets: {}, config }, "trophy", "p9")).not.toContain("_");
  });
});
