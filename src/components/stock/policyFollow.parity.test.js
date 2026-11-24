// ─── PINE FOLLOWS TROPHY — the browser's copy is the engine's ────────────────
// policyFollow.js is the one browser copy of functions/lib/policy-follow.cjs.
//   1. the text between the markers is identical in both files;
//   2. the Seating tab's resolver (seatingCore.resolveTarget) answers, cell for
//      cell, what the engine's resolveTarget answers — with the link on, off,
//      garbled, and with a switch-off at either shop.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import * as browser from "./policyFollow.js";
import { resolveTarget as seatingResolve } from "./seatingCore.js";
import { SEED_REGISTRY } from "../../utils/networkRegistry.js";

const require = createRequire(import.meta.url);
const server = require("../../../functions/lib/policy-follow.cjs");
const engine = require("../../../functions/lib/refill-engine.cjs");
const division = require("../../../functions/lib/concrete-division.cjs");

const body = (file) => {
  const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  const a = text.indexOf("// ── BEGIN SHARED BODY"), b = text.indexOf("// ── END SHARED BODY");
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
};

const PINE = "marathon-pine";
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", trusted: true });
const products = {
  tee: { id: "tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "XL"] },
  sun: { id: "sun", category: "Accessories", categoryKey: "sunglasses", sizes: ["_"] },
  bag: { id: "bag", category: "Accessories", categoryKey: "bags", sizes: [] },
  belt: { id: "belt", category: "Accessories", categoryKey: "belts", sizes: ["S", "M"] },
  perf: { id: "perf", category: "Perfume", categoryKey: "perfumes", sizes: [] },
  shoe: { id: "shoe", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["8"] },
  gone: { id: "gone", category: "Accessories", categoryKey: "sunglasses", sizes: ["_"] },   // not at Pine
};
const config = (over = {}) => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: true,
  defaultRunByStore: { trophy: { S: 2, M: 2, XL: 1 }, "marathon-pe": { S: 2, M: 2, XL: 1 } },
  categoryPolicy: {
    sunglasses: { trophy: { target: 5, minQty: 3, reorderPoint: 3 } },
    bags: { trophy: { target: 2, minQty: 1, reorderPoint: 0 } },
    belts: { perSize: true, trophy: { target: 1, minQty: 1, reorderPoint: 0 } },
    perfumes: { "marathon-pe": { target: 8, minQty: 4, reorderPoint: 3 } },
  },
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  ...over,
});
const stock = {
  central: { tee: { S: cell(9), M: cell(9), XL: cell(9) }, sun: { _: cell(9) }, bag: { _: cell(9) }, belt: { S: cell(4) }, perf: { _: cell(9) }, gone: { _: cell(9) } },
  trophy: { tee: { S: cell(1) }, gone: { _: cell(1) } },
  [PINE]: { tee: { S: cell(0), M: cell(0), XL: cell(0) }, sun: { _: cell(0) }, bag: { _: cell(0) }, belt: { S: cell(0), M: cell(0) }, perf: { _: cell(0) }, shoe: { 8: cell(0) } },
  concrete: { sun: { _: cell(0) } },
};
const TARGETS = [
  {},
  { trophy: { tee: { S: { target: 4, minQty: 2 }, M: { target: 0, minQty: 0 } }, sun: { _: { target: 0, minQty: 0 } }, shoe: { 8: { target: 3, minQty: 1 } } } },
  { [PINE]: { sun: { _: { target: 0, minQty: 0 } }, tee: { XL: { target: 0, minQty: 0 } } } },
];
const CONFIGS = [
  config(), config({ policyFollow: { [PINE]: "trophy" } }),
  config({ policyFollow: { [PINE]: "marathon-pe", concrete: "trophy" } }), config({ policyFollow: "trophy" }),
  config({ policyFollow: { [PINE]: "trophy" }, concreteDivision: undefined }),
  config({ policyFollow: { [PINE]: "trophy", concrete: "trophy" } }),
];

describe("policyFollow.js is functions/lib/policy-follow.cjs", () => {
  it("the shared body is the same text in both files", () => {
    expect(body("./policyFollow.js")).toBe(body("../../../functions/lib/policy-follow.cjs"));
  });
  it("the exports agree", () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(server).sort());
    expect(browser.POLICY_FOLLOW_ALLOWED).toEqual(server.POLICY_FOLLOW_ALLOWED);
    expect(browser.POLICY_FOLLOW_ALLOWED).toEqual({ "marathon-pine": ["trophy"], concrete: ["trophy"] });
    expect(browser.POLICY_FOLLOW_FALLBACK).toEqual(server.POLICY_FOLLOW_FALLBACK);
    for (const c of CONFIGS) for (const loc of [PINE, "concrete", "trophy", "hub3"]) {
      expect(browser.policyFollowOf(c, loc)).toBe(server.policyFollowOf(c, loc));
    }
  });
});

describe("the Seating tab resolves a followed cell exactly as the engine does", () => {
  it("every location, product and size, over every config and row set", () => {
    let followed = 0, compared = 0;
    for (const c of CONFIGS) for (const targets of TARGETS) {
      for (const loc of [PINE, "concrete", "trophy", "marathon-pe"]) for (const pid of Object.keys(products)) {
        const sizes = (products[pid].sizes || []).filter((s) => s !== "_");
        for (const size of sizes.length ? sizes : [""]) {
          const ctx = { targets, config: c, products, stock, network: SEED_REGISTRY };
          // The scan hands the engine its division context; with no seats
          // read (this screen has none) a shop's own cell stands in for a seat.
          const want = engine.resolveTarget({ ...ctx, division: division.divisionContext({ config: c, seats: {} }) }, loc, pid, size);
          const got = seatingResolve(ctx, loc, pid, size);
          expect(got, `${loc} ${pid} ${size} ${JSON.stringify(c.policyFollow)}`).toEqual(want);
          compared += 1;
          if (want && want.source === "follows") followed += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(followed).toBeGreaterThan(10);   // the comparison really exercised the link
  });
  it("Pine's numbers with the link on: Trophy's, for what Pine carries and nothing else", () => {
    const ctx = { targets: {}, config: config({ policyFollow: { [PINE]: "trophy" } }), products, stock, network: SEED_REGISTRY };
    const three = (t) => (t ? [t.target, t.minQty, t.reorderPoint] : null);
    expect(three(seatingResolve(ctx, PINE, "sun", ""))).toEqual([5, 3, 3]);
    expect(three(seatingResolve(ctx, PINE, "bag", ""))).toEqual([2, 1, 0]);
    expect(three(seatingResolve(ctx, PINE, "tee", "XL"))).toEqual([1, 1, null]);
    expect(three(seatingResolve(ctx, PINE, "perf", ""))).toEqual([8, 4, 3]);      // Trophy has no perfume policy: Marathon PE's
    expect(seatingResolve(ctx, PINE, "gone", "")).toBe(null);                     // Pine does not carry it
    expect(seatingResolve(ctx, PINE, "shoe", "8")).toBe(null);                    // footwear is left out
    expect(three(seatingResolve(ctx, "concrete", "sun", ""))).toEqual([5, 4, null]);   // Concrete is untouched
  });
});
