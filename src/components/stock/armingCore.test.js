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
  hubArming, bucketFor, flagsFor, armingIndex, sectionRows, suppressed,
  BUCKET, FLAG, HUB1, HUB2,
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
// Recursive, because RTDB prunes at EVERY depth and cannot store an empty array
// either — a last-child delete removes the key outright and it reads back null.
function stockOf(map) {
  const prune = (value) => {
    if (value == null) return undefined;
    if (typeof value !== "object") return value;
    const out = Array.isArray(value) ? [] : {};
    let kept = 0;
    for (const k of Object.keys(value)) {
      const v = prune(value[k]);
      if (v === undefined) continue;
      out[k] = v; kept += 1;
    }
    return kept ? out : undefined;
  };
  return prune(map) ?? {};
}

const ctxOf = ({ config = CAT_BOTH, products = product(), stock = {}, targets = {} } = {}) =>
  ({ config, products, stock: stockOf(stock), targets });

// ── the empty-child rule the fixtures rely on ───────────────────────────────
describe("the test double reproduces RTDB's empty-child delete", () => {
  it("drops a product whose cell map is empty, and a location left with nothing", () => {
    expect(stockOf({ hub1: { p1: {} } })).toEqual({});
    expect(stockOf({ hub1: { p1: {}, p2: { 8: cell(1) } } })).toEqual({ hub1: { p2: { 8: cell(1) } } });
  });

  it("and treats an empty ARRAY exactly as an empty object", () => {
    // RTDB cannot store [] — writing it, or deleting the last child of an
    // array-shaped node, removes the key. /stock DOES hand back arrays: a
    // product whose only cells are "0".."n" comes back array-shaped (live
    // /stock/hub1 holds several), so the array branch is not hypothetical.
    expect(stockOf({ hub1: { p1: [] } })).toEqual({});
    expect(stockOf({ hub1: { p1: { 8: [] } } })).toEqual({});
  });

  it("and an absent map is not carriage — asked of the ENGINE, not only of us", () => {
    // An earlier version of this claimed to use "the engine's own predicate"
    // while calling only our own, over empty stock, where `hasCell: false`
    // would have been true of any implementation. It now puts the same
    // fixture through the real refill-engine and compares the two answers.
    // (Adversarial review, PR #601.)
    const empty = ctxOf({ stock: { hub1: { p1: {} } } });        // pruned to {}
    const held = ctxOf({ stock: { hub1: { p1: { 8: cell(2) } } } });

    expect(hubArming(empty, HUB1, "p1").hasCell).toBe(false);
    expect(hubArming(held, HUB1, "p1").hasCell).toBe(true);

    // The engine decides carriage through the same predicate, inside its
    // carriedOnly gate: no cell, no target; a cell, a target.
    const ask = (c) => engine.resolveTarget(
      { targets: {}, config: c.config, products: c.products, stock: c.stock }, HUB1, "p1", "8");
    expect(ask(empty)).toBe(null);
    expect(ask(held)?.target).toBeGreaterThan(0);
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
    expect(bucketFor(h1, h2)).toBe(BUCKET.BOTH_HUBS);
  });

  it("agrees with the real engine's resolveTarget, size by size, on both hubs", () => {
    // A CROSS-COMPARISON, not two independent assertions over one fixture. The
    // first version asserted "the engine says > 0" in one `it` and "we say
    // armed" in another; that is a sanity check on the fixture, and it would
    // have stayed green with the two answers disagreeing. Here each of our
    // per-size targets is compared with the engine's for the SAME size.
    // (Adversarial review, PR #601.)
    const ask = (hub, size) => engine.resolveTarget(
      { targets: both.targets, config: both.config, products: both.products, stock: both.stock },
      hub, "p1", size);

    let positives = 0;
    for (const hub of [HUB1, HUB2]) {
      const ours = hubArming(both, hub, "p1");
      for (const s of ours.sizes) {
        const theirs = ask(hub, s.size);
        expect(theirs?.target ?? null, `${hub} size ${s.size}`).toBe(s.target);
        if (s.target > 0) positives += 1;
      }
      // …and OUR armed verdict is exactly "the engine gave some size a
      // positive target here".
      expect(ours.armed).toBe(ours.sizes.some((x) => x.target > 0));
    }
    // Not vacuous: the loop above had something to compare.
    expect(positives).toBeGreaterThan(0);
  });
});

// ── ONE HUB ONLY — sections D and E ─────────────────────────────────────────
describe("armed at one hub only", () => {
  it("HUB1_ONLY when only hub 1 has a leg it carries", () => {
    const c = ctxOf({ config: CAT_HUB1, stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 8: cell(3) } } } });
    expect(bucketFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"))).toBe(BUCKET.HUB1_ONLY);
  });

  it("HUB2_ONLY when only hub 2 has one", () => {
    const c = ctxOf({ config: CAT_HUB2, stock: { hub1: { p1: { 8: cell(3) } }, hub2: { p1: { 8: cell(3) } } } });
    expect(bucketFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"))).toBe(BUCKET.HUB2_ONLY);
  });

  it("NOWHERE when neither hub arms it — and every product has a bucket", () => {
    // EXHAUSTIVE is the property that makes these tabs rather than filters. The
    // first build returned no bucket at all here and dropped 960 live products
    // off the screen with no way to reach one.
    const c = ctxOf({ config: CAT_HUB1, stock: { trophy: { p1: { 8: cell(3) } } } });
    expect(bucketFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"))).toBe(BUCKET.NOWHERE);
  });

  it("the four buckets are mutually exclusive over every armed combination", () => {
    const seat = (armed) => ({ armed, hasCell: true, deactivated: false, undecided: false,
      policyWouldArm: armed, zeroRows: [] });
    const seen = [
      bucketFor(seat(true), seat(true)), bucketFor(seat(true), seat(false)),
      bucketFor(seat(false), seat(true)), bucketFor(seat(false), seat(false)),
    ];
    expect(new Set(seen).size).toBe(4);
    expect(seen.sort()).toEqual([BUCKET.BOTH_HUBS, BUCKET.HUB1_ONLY, BUCKET.HUB2_ONLY, BUCKET.NOWHERE].sort());
  });

  it("a carriedOnly leg arms nothing at a hub holding no cell", () => {
    // Both hubs armed in POLICY, only hub 1 carrying. carriedOnly is what makes
    // the split survivable, and it is what section A's 34 rows got past.
    const c = ctxOf({ stock: { hub1: { p1: { 8: cell(3) } } } });
    expect(hubArming(c, HUB2, "p1").armed).toBe(false);
    expect(bucketFor(hubArming(c, HUB1, "p1"), hubArming(c, HUB2, "p1"))).toBe(BUCKET.HUB1_ONLY);
  });
});

// ── ARMED BUT NOT SEATED — section B ────────────────────────────────────────
describe("the NOT SEATED flag", () => {
  // An UNSCOPED leg — no carriedOnly — arms a hub that holds no cell at all.
  const unscoped = cfg({ hub1: sizeLeg(["8", "9"]), hub2: sizeLeg(["8", "9"]) });

  it("flags a hub the engine arms with nothing on the shelf", () => {
    const c = ctxOf({ config: unscoped, stock: { trophy: { p1: { 8: cell(4) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.hasCell).toBe(false);
    expect(flagsFor(h1, hubArming(c, HUB2, "p1"))).toContain(FLAG.NOT_SEATED);
  });

  it("does not flag a hub that carries the line and is merely sold out", () => {
    // A zero-qty cell IS carriage — applyMovement never deletes one. Treating
    // sold-out as unseated would fill section B with every quiet shelf.
    const c = ctxOf({ config: unscoped, stock: {
      hub1: { p1: { 8: cell(0) } }, hub2: { p1: { 8: cell(0) } }, trophy: { p1: { 8: cell(4) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.hasCell).toBe(true);
    expect(flagsFor(h1, hubArming(c, HUB2, "p1"))).not.toContain(FLAG.NOT_SEATED);
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
    expect(flagsFor(h1, hubArming(c, HUB2, "p1"))).toContain(FLAG.SUPPRESSED);
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
    // Armed NOWHERE — and visible there, flagged, rather than dropped.
    expect(bucketFor(h1, h2)).toBe(BUCKET.NOWHERE);
    expect(flagsFor(h1, h2)).toContain(FLAG.DEACTIVATED);
  });

  it("and is counted AND reachable, not silently dropped", () => {
    const c = ctxOf({ products: product(dead), stock: { hub1: { p1: { 8: cell(3) } } } });
    const ix = armingIndex(c, ["p1"]);
    expect(ix.rows.map((r) => r.pid)).toEqual(["p1"]);
    expect(ix.rows[0].bucket).toBe(BUCKET.NOWHERE);
    expect(ix.rows[0].flags).toContain(FLAG.DEACTIVATED);
    expect(ix.counts[BUCKET.NOWHERE]).toBe(1);
    expect(ix.deactivatedSkipped).toBe(1);
  });

  it("a reactivated product is armed again — and it is the DELETION that does it", () => {
    // THE GUARD IS `!!product.deactivated` AND NOTHING ELSE. Reactivation is not
    // a later timestamp winning a comparison: reactivateUpdates writes the
    // `reactivated` node and DELETES `deactivated` in one atomic update
    // (src/utils/deactivation.js), so exactly one of the two ever exists.
    //
    // Asserting only that a record carrying `reactivated` is armed would pass
    // even if the guard ignored that field completely — which it does, and
    // should. (CodeRabbit raised this, and its proposed fixture sets BOTH flags
    // and expects armed; against the engine's actual predicate that expectation
    // is false. So: the reversal is pinned as the deletion it is, and the
    // impossible both-flags state is pinned as still-deactivated, which is the
    // fail-safe answer.)
    const live = ctxOf({
      products: product({ reactivated: { at: 1757000001000, by: "u1", reason: "stock_received" } }),
      stock: { hub1: { p1: { 8: cell(3) } } },
    });
    expect(hubArming(live, HUB1, "p1").armed).toBe(true);

    const stillOff = ctxOf({
      products: product({
        deactivated: { at: 1757000000000, by: "u1" },
        reactivated: { at: 1757000001000, by: "u1", reason: "stock_received" },
      }),
      stock: { hub1: { p1: { 8: cell(3) } } },
    });
    expect(hubArming(stillOff, HUB1, "p1").armed).toBe(false);
    // …and the ENGINE agrees, which is the only reason that is the right answer.
    expect(engine.resolveTarget(
      { targets: {}, config: stillOff.config, products: stillOff.products, stock: stillOff.stock },
      HUB1, "p1", "8",
    )).toBe(null);
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

  it("the gate is the PER-SIZE branch, not merely 'a policy exists here'", () => {
    // undecidedHere is gated on the category entry being per-size, because that
    // is the only branch of resolveTarget that consults sizeUnitsAnywhere.
    // Widening the gate to "any entry" would flag every uniform leg — bags,
    // caps, perfumes, sunglasses at hub 2 — none of which the dead-size rule
    // can ever change.
    const uniform = { ruleBasedTargets: true,
      categoryPolicy: { sneakers: { hub1: { target: 4, minQty: 2, carriedOnly: true } } } };
    // A uniform leg speaks for the "_" cell and nothing else, and that branch
    // never calls sizeUnitsAnywhere — so the answer here is FINAL whichever way
    // it falls. Armed, in this case, and decidedly so.
    const c = ctxOf({ config: uniform, stock: { hub1: { p1: { 8: cell(0) } } } });
    const h1 = hubArming(c, HUB1, "p1");
    expect(h1.armed).toBe(true);
    expect(h1.undecided).toBe(false);

    // …and the same leg over a product it does NOT carry: unarmed by the
    // carriedOnly gate, which is a `dest`-scoped question this tab answers
    // exactly. Still not undecided.
    const away = ctxOf({ config: uniform, stock: { hub2: { p1: { 8: cell(3) } } } });
    expect(hubArming(away, HUB1, "p1").armed).toBe(false);
    expect(hubArming(away, HUB1, "p1").undecided).toBe(false);
  });

  it("the phantom carries the no-size cell, so a product declaring NO sizes is still asked", () => {
    // seatingSizes adds "_" for a uniform leg, and a product with an empty
    // `sizes` array would otherwise get an empty phantom and read as decided
    // for ever. The perfume case that PR #429 was built around.
    const perSizeOneSize = { ruleBasedTargets: true,
      categoryPolicy: { sneakers: { perSize: true, hub1: { sizes: { _: { target: 3 } } } } } };
    const c = ctxOf({ products: product({ sizes: [] }), config: perSizeOneSize, stock: {} });
    // The engine's per-size branch returns null for "_", so this is unarmed and
    // NOT undecided — but the phantom must have been asked, not skipped for
    // want of a size to put in it.
    expect(hubArming(c, HUB1, "p1").armed).toBe(false);
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

  it("returns EVERY product — the unarmed ones belong in Nowhere", () => {
    const ix = armingIndex(c, Object.keys(products));
    expect(ix.rows.map((r) => r.pid).sort()).toEqual(["p1", "p2", "p3"]);
    expect(ix.rows.find((r) => r.pid === "p3").bucket).toBe(BUCKET.NOWHERE);
  });

  it("the four counts add up to the catalogue", () => {
    const ix = armingIndex(c, Object.keys(products));
    expect(ix.counts[BUCKET.BOTH_HUBS]).toBe(1);
    expect(ix.counts[BUCKET.HUB1_ONLY]).toBe(1);
    expect(ix.counts[BUCKET.HUB2_ONLY]).toBe(0);
    expect(ix.counts[BUCKET.NOWHERE]).toBe(1);
    // THE PROPERTY, not three numbers that happen to be right today. A bucket
    // that stops being exhaustive loses products off the screen silently.
    expect(Object.values(ix.counts).reduce((a, b) => a + b, 0)).toBe(ix.rows.length);
    expect(ix.rows.length).toBe(Object.keys(products).length);
  });

  it("counts undecided PAIRS and undecided PRODUCTS separately", () => {
    // A product undecided at both hubs is two pairs and one product. The banner
    // names products (that is what a resolve pass reads); the pair count is what
    // the read-cost reasoning is stated in. Collapsing them puts "2 undecided"
    // above "1/1" on the same screen.
    const two = ctxOf({ products, stock: { hub1: { p1: { 8: cell(0) } }, hub2: { p1: { 8: cell(0) } } } });
    const ix = armingIndex(two, ["p1"]);
    expect(ix.undecided).toBe(2);
    expect(ix.undecidedProducts).toBe(1);
    expect(ix.undecidedPids).toEqual(["p1"]);
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
    { pid: "p1", bucket: BUCKET.BOTH_HUBS, haystack: "air max 90 footwear sneakers nike" },
    { pid: "p2", bucket: BUCKET.HUB1_ONLY, haystack: "zoom fly footwear sneakers nike" },
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
