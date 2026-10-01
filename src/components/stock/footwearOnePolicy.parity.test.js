// ─── ONE FOOTWEAR POLICY — THE BROWSER MIRROR ANSWERS LIKE THE ENGINE ─────────
// The Seating tab and the Engine Policy card read targets through seatingCore's
// mirror of refill-engine.cjs resolveTarget. Junid's trigger was a Targets
// table that disagreed with what he expected; this pins that the mirror and the
// engine give the SAME answer for every footwear category, every size 3–13,
// both hubs, in the one-policy world (functions/test/helpers/footwear-world.cjs)
// — plus the three shapes that must not arm: an uncarried pair, a kids label,
// a size outside the run. Mutation-proved by
// scripts/mutation-proof-footwear-one-policy.mjs.

import { describe, it, expect } from "vitest";
import { resolveTarget } from "./seatingCore";

const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const engine = req("../../../functions/lib/refill-engine.cjs");
const W = req("../../../functions/test/helpers/footwear-world.cjs");

const ctxOf = (w) => ({ targets: w.targets, config: w.config, products: w.products, stock: w.stock });

describe("one footwear policy — mirror parity", () => {
  it("every category × size 3–13 × hub: mirror === engine === the standing run", () => {
    const ctx = ctxOf(W.world());
    let checked = 0;
    for (const hub of ["hub1", "hub2"]) {
      for (const key of W.FOOTWEAR_KEYS) {
        for (const size of W.RUN_SIZES) {
          const e = engine.resolveTarget(ctx, hub, `p-${key}`, size);
          const m = resolveTarget(ctx, hub, `p-${key}`, size);
          expect(m, `${key} ${hub} ${size}`).toEqual(e);
          expect(m?.target, `${key} ${hub} ${size}`).toBe(W.STANDING[W.enc(size)]);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 8 * 12);
  });

  it("the shapes that must NOT arm agree too: uncarried, kids labels, a size outside the run", () => {
    const w = W.world();
    w.products["p-boots"].sizes.push("14");
    w.stock.hub1["p-boots"]["14"] = { qty: 1 };
    const ctx = ctxOf(w);
    const cases = [
      ["hub1", "uncarried", "6"], ["hub1", "uncarried", "12"],
      ["hub1", "kids", "26"], ["hub2", "kids", "33"],
      ["hub1", "p-boots", "14"],
    ];
    for (const [hub, pid, size] of cases) {
      expect(resolveTarget(ctx, hub, pid, size), `${pid} ${hub} ${size}`).toBeNull();
      expect(engine.resolveTarget(ctx, hub, pid, size), `${pid} ${hub} ${size}`).toBeNull();
    }
  });

  it("explicit rows win in both copies", () => {
    const ctx = ctxOf(W.world());
    for (const size of ["6", "7", "8"]) {
      expect(resolveTarget(ctx, "hub1", "ruled", size)).toEqual(engine.resolveTarget(ctx, "hub1", "ruled", size));
    }
    expect(resolveTarget(ctx, "hub1", "ruled", "6").target).toBe(0);
    expect(resolveTarget(ctx, "hub1", "ruled", "7").target).toBe(5);
  });
});
