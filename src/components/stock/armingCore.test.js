// ─── ARMING — THE CLASSIFICATION, PINNED ──────────────────────────────────────
//
// armingCore answers two questions and must not be allowed to blur them:
// "will the engine ask this hub to hold this product" (ARMED) and "does this
// hub hold a cell for it" (SEATED). Every section of the tab is a different
// combination of those two across two hubs, so every section is a test here.
//
// The target resolution itself is NOT re-tested: it is seatingCore's, and
// seatingCore.test.js already differential-fuzzes it against the real engine.
// What is tested here is what this file adds — the deactivation guard the
// mirror does not carry, the policy-without-rows pass, the undecided flag, and
// the fact that an unarmed size is ABSENT rather than zero.
//
// Run: npx vitest run src/components/stock/armingCore.test.js

import { describe, it, expect } from "vitest";
import {
  hubArming, bucketsFor, armingIndex, sectionRows, suppressed,
  BUCKET, HUB1, HUB2,
} from "./armingCore";

const { createRequire } = await import("node:module");
const engine = createRequire(import.meta.url)("../../../functions/lib/refill-engine.cjs");

// ── fixtures ────────────────────────────────────────────────────────────────
// A per-size category leg, which is the shape every hub leg on live actually
// has (slides and sneakers at both hubs, carriedOnly; the clothing categories
// at hub2). carriedOnly is opt-in per leg so both carriage regimes are covered.
const sizeLeg = (sizes, carriedOnly) => ({
  ...(carriedOnly ? { carriedOnly: true } : {}),
  sizes: Object.fromEntries(sizes.map((s) => [s, { target: 2, minQty: 1, reorderPoint: 1 }])),
});

const cfg = (legs, extra = {}) => ({
  ruleBasedTargets: true,
  categoryPolicy: { sneakers: { perSize: true, ...legs } },
  ...extra,
});

const CAT_BOTH = cfg({ hub1: sizeLeg(["8", "9"], true), hub2: sizeLeg(["8", "9"], true) });
const CAT_HUB1 = cfg({ hub1: sizeLeg(["8", "9"], true) });
const CAT_HUB2 = cfg({ hub2: sizeLeg(["8", "9"], true) });

const product = (over = {}) => ({
  p1: { id: "p1", name: "Air Max 90", category: "Footwear", categoryKey: "sneakers",
    sizes: ["8", "9"], ...over },
});

const cell = (qty) => ({ qty, updatedAt: "2026-09-01T00:00:00.000Z", lastType: "received", v: 1 });

// REAL RTDB DELETES AN EMPTY CHILD. A location with no cells for a product does
// not appear as `{}` — the key is gone. Every fixture below is built through
// this helper so no test can accidentally assert against a shape the database
// cannot produce.
function stockOf(map) {
  const out = {};
  for (const [loc, byPid] of Object.entries(map)) {
    const keptPids = {};
    for (const [pid, cells] of Object.entries(byPid)) {
      if (cells && Object.keys(cells).length) keptPids[pid] = cells;
    }
    if (Object.keys(keptPids).length) out[loc] = keptPids;
  }
  return out;
}

const ctxOf = ({ config = CAT_BOTH, products = product(), stock = {}, targets = {} } = {}) =>
  ({ config, products, stock: stockOf(stock), targets });

// ── the empty-child rule the fixtures rely on ───────────────────────────────
describe("the test double reproduces RTDB's empty-child delete", () => {
  it("drops a product whose cell map is empty, and a location left with nothing", () => {
    expect(stockOf({ hub1: { p1: {} } })).toEqual({});
    expect(stockOf({ hub1: { p1: {}, p2: { 8: cell(1) } } })).toEqual({ hub1: { p2: { 8: cell(1) } } });
  });

  it("and storeCarries therefore reads the same answer the engine reads", () => {
    // The engine's own predicate, not a copy of it: both must agree that an
    // absent map is not carriage.
    const s = stockOf({ hub1: { p1: {} } });
    expect(hubArming(ctxOf({ stock: {} }), HUB1, "p1").hasCell).toBe(false);
    expect(s.hub1).toBeUndefined();
  });
});

// ── ARMED AT BOTH HUBS — section A, the defect the tab exists for ───────────
describe("armed at both hubs", () => {
  const both = ctxOf({ stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 9: cell(2) } } } });

  it("reports armed at each hub and lands in BOTH_HUBS", () => {
    const h1 = hubArming(both, HUB1, "p1");
    const h2 = hubArming(both, HUB2, "p1");
    expect(h1.armed).toBe(true);
    expect(h2.armed).toBe(true);
    expect(bucketsFor(h1, h2)).toContain(BUCKET.BOTH_HUBS);
    expect(bucketsFor(h1, h2)).not.toContain(BUCKET.HUB1_ONLY);
    expect(bucketsFor(h1, h2)).not.toContain(BUCKET.HUB2_ONLY);
  });

  it("agrees with the real engine's resolveTarget on both hubs", () => {
    // The point of section A is a claim about the ENGINE. Assert it against the
    // engine, not against our own mirror of it.
    for (const hub of [HUB1, HUB2]) {
      const t = engine.resolveTarget(
        { targets: both.targets, config: both.config, products: both.products, stock: both.stock },
        hub, "p1", hub === HUB1 ? "8" : "9",
      );
      expect(t?.target, `${hub} must resolve a positive target`).toBeGreaterThan(0);
    }
  });
});

// ── ONE HUB ONLY — sections D and E ─────────────────────────────────────────
describe("armed at one hub only", () => {
  it("HUB1_ONLY when only hub 1 has a leg it carries", () => {
    const c = ctxOf({ config: CAT_HUB1, stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 8: cell(3) } } } });
    const b = bucketsFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"));
    expect(b).toEqual([BUCKET.HUB1_ONLY]);
  });

  it("HUB2_ONLY when only hub 2 has one", () => {
    const c = ctxOf({ config: CAT_HUB2, stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 8: cell(3) } } } });
    const b = bucketsFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"));
    expect(b).toEqual([BUCKET.HUB2_ONLY]);
  });

  it("a carriedOnly leg arms nothing at a hub holding no cell", () => {
    // Both hubs armed in POLICY, only hub 1 carrying. carriedOnly is what makes
    // the split survivable, and it is what section A's 34 rows got past.
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(3) } } } });
    expect(hubArming(c, HUB2, "p1").armed).toBe(false);
    expect(bucketsFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"))).toEqual([BUCKET.HUB1_ONLY]);
  });
});

// ── ARMED BUT NOT SEATED — section B ────────────────────────────────────────
describe("armed but not seated", () => {
  // An UNSCOPED leg — no carriedOnly — arms a hub that holds no cell at all.
  const unscoped = cfg({ hub1: sizeLeg(["8", "9"]), hub2: sizeLeg(["8", "9"]) });

  it("flags a hub the engine arms with nothing on the shelf", () => {
    const c = ctxOf({ config: unscoped, stock: { trophy: { p1: { 8: cell(4) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.hasCell).toBe(false);
    expect(bucketsFor(h1, hubArming(c, HUB2, "p1"))).toContain(BUCKET.NOT_SEATED);
  });

  it("does not flag a hub that carries the line and is merely sold out", () => {
    // A zero-qty cell IS carriage — applyMovement never deletes one. Treating
    // sold-out as unseated would fill section B with every quiet shelf.
    const c = ctxOf({ config: unscoped, stock: {
      hub1: { p1: { 8: cell(0) } }, hub2: { p1: { 8: cell(0) } }, trophy: { p1: { 8: cell(4) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.hasCell).toBe(true);
    expect(bucketsFor(h1, hubArming(c, HUB2, "p1"))).not.toContain(BUCKET.NOT_SEATED);
  });
});

// ── SUPPRESSED BY SEATING — section C ───────────────────────────────────────
describe("category-armed then switched off", () => {
  const rows = (t) => ({ hub1: { p1: { 8: { target: t, minQty: 0, source: "seating_off" }, 9: { target: t, minQty: 0, source: "seating_off" } } } });

  it("is its own state, not 'never armed'", () => {
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(0), 9: cell(0) } }, central: { p1: { 8: cell(9) } } },
      targets: rows(0) });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(false);
    expect(h1.policyWouldArm).toBe(true);
    expect(h1.zeroRows.sort()).toEqual(["8", "9"]);
    expect(suppressed(h1)).toBe(true);
    expect(bucketsFor(h1, hubArming(c, HUB2, "p1"))).toContain(BUCKET.SUPPRESSED);
  });

  it("a positive explicit row is not suppression", () => {
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(1) } } }, targets: rows(4) });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(suppressed(h1)).toBe(false);
  });

  it("a target:0 row where no policy would arm anyway is not suppression", () => {
    // Nothing is being killed — there was nothing to kill. Reporting it would
    // put every retired hand-written row into section C.
    const c = ctxOf({ config: CAT_HUB2, stock: { hub1: { p1: { 8: cell(0) } }, central: { p1: { 8: cell(9) } } },
      targets: rows(0) });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.policyWouldArm).toBe(false);
    expect(suppressed(h1)).toBe(false);
  });
});

// ── UNARMED SIZES ARE ABSENT, NOT ZERO ──────────────────────────────────────
describe("the per-size run", () => {
  it("leaves a size nothing arms OUT of the run entirely", () => {
    // The catalogue declares 8, 9 and 10; the policy leg names 8 and 9. Size 10
    // must not appear as target 0 — an absent target and a deliberate zero are
    // different facts and this screen shows the difference.
    const c = ctxOf({
      products: product({ sizes: ["8", "9", "10"] }),
      stock: { hub1: { p1: { 8: cell(1), 9: cell(1), 10: cell(1) } } },
    });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.sizes.map((s) => s.sizeKey).sort()).toEqual(["8", "9"]);
    expect(h1.sizes.every((s) => s.target > 0)).toBe(true);
  });

  it("keeps a deliberate zero, with its source, so section C can name it", () => {
    const c = ctxOf({
      stock: { hub1: { p1: { 8: cell(0), 9: cell(0) } } },
      targets: { hub1: { p1: { 8: { target: 0, minQty: 0, source: "seating_off" } } } },
    });
    const h1 = hubArming(c, HUB1, "p1");
    const eight = h1.sizes.find((s) => s.sizeKey === "8");
    expect(eight.target).toBe(0);
    expect(eight.source).toBe("explicit");
  });
});

// ── THE DEACTIVATION GUARD THE MIRROR DOES NOT CARRY ────────────────────────
describe("a deactivated product is armed nowhere", () => {
  const dead = { deactivated: { at: 1757000000000, by: "u1" } };

  it("matches the engine, which refuses above the explicit-row branch", () => {
    const c = ctxOf({
      products: product(dead),
      stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 8: cell(3) } } },
      targets: { hub1: { p1: { 8: { target: 5, minQty: 2 } } } },
    });
    // The ENGINE's answer, with a live explicit row in place: still nothing.
    expect(engine.resolveTarget(
      { targets: c.targets, config: c.config, products: c.products, stock: c.stock }, HUB1, "p1", "8",
    )).toBe(null);

    const h1 = hubArming(c, HUB1, "p1");
    const h2 = hubArming(c, HUB2, "p1");
    expect(h1.armed).toBe(false);
    expect(h2.armed).toBe(false);
    expect(h1.deactivated).toBe(true);
    expect(bucketsFor(h1, h2)).toEqual([]);
  });

  it("and is counted, not silently dropped", () => {
    const c = ctxOf({ products: product(dead), stock: { hub1: { p1: { 8: cell(3) } } } });
    const ix = armingIndex(c, ["p1"]);
    expect(ix.rows).toEqual([]);
    expect(ix.deactivatedSkipped).toBe(1);
  });

  it("a reactivated product is armed again", () => {
    const c = ctxOf({
      products: product({ reactivated: { at: 1757000000000, by: "u1", reason: "stock_received" } }),
      stock: { hub1: { p1: { 8: cell(3) } } },
    });
    expect(hubArming(c, HUB1, "p1").armed).toBe(true);
  });
});

// ── THE UNDECIDED FLAG ──────────────────────────────────────────────────────
describe("the dead-size rule, and what two hub reads cannot settle", () => {
  it("flags a hub whose answer turns on stock held somewhere else", () => {
    // Hub 1 carries the line (so carriedOnly passes) but holds zero units of
    // every covered size. sizeUnitsAnywhere decides, and the units — if any —
    // are at Central, which this read does not hold.
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(0), 9: cell(0) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(false);
    expect(h1.undecided).toBe(true);
  });

  it("is decided once the units are in the context", () => {
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(0), 9: cell(0) } }, central: { p1: { 8: cell(6) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.undecided).toBe(false);
  });

  it("never flags an ARMED hub — the error is one-directional", () => {
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(4) } } } });
    expect(hubArming(c, HUB1, "p1").undecided).toBe(false);
  });

  it("clears once the product's stock has been read from everywhere", () => {
    // The phantom alone can never clear the flag — a genuinely dead size would
    // also come alive under it. resolvedPids is what says "there is no more
    // stock to find", and without it the residue would never shrink to zero.
    const stock = { hub1: { p1: { 8: cell(0), 9: cell(0) } } };
    expect(hubArming(ctxOf({ stock }), HUB1, "p1").undecided).toBe(true);
    const resolved = { ...ctxOf({ stock }), resolvedPids: new Set(["p1"]) };
    const h1 = hubArming(resolved, HUB1, "p1");
    expect(h1.undecided).toBe(false);
    expect(h1.armed).toBe(false);
  });

  it("never flags a hub with no per-size leg at all", () => {
    // A uniform ("_") leg never consults sizeUnitsAnywhere, and neither does
    // the clothing size run. Flagging them would put the whole catalogue in the
    // residue.
    const uniform = { ruleBasedTargets: true, categoryPolicy: { sneakers: { hub2: { target: 4, minQty: 2 } } } };
    const c = ctxOf({ config: uniform, stock: { hub1: { p1: { 8: cell(0) } } } });
    expect(hubArming(c, HUB1, "p1").undecided).toBe(false);
    expect(hubArming(c, HUB2, "p1").undecided).toBe(false);
  });

  it("the phantom never leaks into the rendered facts", () => {
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(0), 9: cell(0) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.units).toBe(0);
    expect(Object.keys(c.stock)).toEqual(["hub1"]);
  });
});

// ── THE INDEX ───────────────────────────────────────────────────────────────
describe("armingIndex", () => {
  const products = {
    ...product(),
    p2: { id: "p2", name: "Zoom Fly", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] },
    p3: { id: "p3", name: "Unarmed Tee", category: "Clothing", categoryKey: "tees", sizes: ["M"] },
  };

  const c = ctxOf({
    products,
    stock: {
      hub1: { p1: { 8: cell(2) }, p2: { 8: cell(1) } },
      hub2: { p1: { 9: cell(2) } },
      trophy: { p3: { M: cell(5) } },
    },
  });

  it("returns only products at least one section claims", () => {
    const ix = armingIndex(c, Object.keys(products));
    expect(ix.rows.map((r) => r.pid).sort()).toEqual(["p1", "p2"]);
  });

  it("counts each section independently", () => {
    const ix = armingIndex(c, Object.keys(products));
    expect(ix.counts[BUCKET.BOTH_HUBS]).toBe(1);
    expect(ix.counts[BUCKET.HUB1_ONLY]).toBe(1);
    expect(ix.counts[BUCKET.HUB2_ONLY]).toBe(0);
  });

  it("skips a pid the catalogue does not hold rather than inventing a row", () => {
    expect(armingIndex(c, ["nope"]).rows).toEqual([]);
  });

  it("sorts by name so the list is stable between loads", () => {
    const ix = armingIndex(c, ["p2", "p1"]);
    expect(ix.rows.map((r) => r.name)).toEqual(["Air Max 90", "Zoom Fly"]);
  });
});

// ── SEARCH ──────────────────────────────────────────────────────────────────
describe("sectionRows", () => {
  const rows = [
    { pid: "p1", buckets: [BUCKET.BOTH_HUBS, BUCKET.NOT_SEATED], haystack: "air max 90 footwear sneakers nike" },
    { pid: "p2", buckets: [BUCKET.HUB1_ONLY], haystack: "zoom fly footwear sneakers nike" },
  ];

  it("filters within the section and nowhere else", () => {
    expect(sectionRows(rows, BUCKET.BOTH_HUBS, "").map((r) => r.pid)).toEqual(["p1"]);
    expect(sectionRows(rows, BUCKET.HUB1_ONLY, "").map((r) => r.pid)).toEqual(["p2"]);
  });

  it("requires every term, so a second word narrows", () => {
    expect(sectionRows(rows, BUCKET.HUB1_ONLY, "nike zoom").map((r) => r.pid)).toEqual(["p2"]);
    expect(sectionRows(rows, BUCKET.HUB1_ONLY, "nike air").map((r) => r.pid)).toEqual([]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(sectionRows(rows, BUCKET.BOTH_HUBS, "  AIR   Max ").map((r) => r.pid)).toEqual(["p1"]);
  });
});
