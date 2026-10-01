// ─── A STOCKED SIZE NEVER READS "NOT CARRIED" ─────────────────────────────────
// Junid, 24 Sep 2026: Timberland Premium 6-Inch Wheat at Hub 1 showed "Not
// carried" beside size 13 with 2 units on hand. The cause was the policy (the
// Sneakers Hub 1 leg stopped at 11) — but the WORDS were wrong independently of
// it: a size holding units is carried; what it lacks is a target. This pins the
// Targets table in both worlds: the drifted Hub 1 leg, and the one footwear
// policy that replaced it.
//
// Run: npx vitest run src/components/stock/productTargetEditor.footwear.render.test.jsx

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};
vi.mock("./seatingStore", async (orig) => ({ ...(await orig()), saveProductTargets: async () => ({ ok: true }) }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u" } } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), get: async () => ({ exists: () => false, val: () => null }) }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));

const ProductTargetEditor = (await import("./ProductTargetEditor.jsx")).default;
const { seatingAt } = await import("./seatingCore.js");
const { nowLabel, whyLine } = await import("./targetOverride.js");
const { createRequire } = await import("node:module");
const W = createRequire(import.meta.url)("../../../functions/test/helpers/footwear-world.cjs");

const PID = "tim";
const P = { [PID]: { id: PID, name: "Timberland Premium 6-Inch Wheat", category: "Footwear", categoryKey: "sneakers",
  subcategory: "Boots", sizes: ["6", "7", "8", "9", "10", "11", "12", "13"] } };
// The live shape on 24 Sep: 7→1, 8→3, 9–11→2, 12→0, 13→2 at Hub 1; no 6 cell.
const STOCK = {
  hub1: { [PID]: { 7: { qty: 1 }, 8: { qty: 3 }, 9: { qty: 2 }, 10: { qty: 2 }, 11: { qty: 2 }, 12: { qty: 0 }, 13: { qty: 2 } } },
  central: { [PID]: { 7: { qty: 4 }, 8: { qty: 6 }, 9: { qty: 12 }, 10: { qty: 4 }, 12: { qty: 3 }, 13: { qty: 3 } } },
};
const OLD_HUB1 = { perSize: true, hub1: { carriedOnly: true, sizes: Object.fromEntries(
  ["3", "4", "5", "5_5", "6", "7", "8", "9", "10", "11"].map((k) => [k, { target: ["6", "7", "8"].includes(k) ? 3 : 2, minQty: 1, reorderPoint: 1 }])) } };
const DRIFTED = { mode: { hub1: "live" }, categoryPolicy: { sneakers: OLD_HUB1 } };
const ONE = { mode: { hub1: "live" }, categoryPolicy: {}, policyGroups: { "footwear-all": W.footwearGroup() } };
const ctxOf = (config, products = P) => ({ products, stock: STOCK, targets: {}, config });

const render = (ctx) => {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <ProductTargetEditor seat={seatingAt(ctx, "hub1", PID)} ctx={ctx} label="Hub 1"
        locations={["hub1"]} canWrite onDone={() => {}} onFail={() => {}} />,
    );
  });
  return JSON.stringify(tree.toJSON());
};
const count = (s, needle) => s.split(needle).length - 1;

describe("the Targets table on a footwear product", () => {
  it("drifted Hub 1 leg: 13 with 2 units says it is held and outside the run — only the EMPTY 12 says Not carried", () => {
    const out = render(ctxOf(DRIFTED));
    expect(count(out, "Held · not in run")).toBe(1);        // 13
    expect(count(out, "Not carried")).toBe(1);              // 12, zero units
  });

  it("one footwear policy: every size 6–13 follows the policy — nothing reads Not carried", () => {
    const out = render(ctxOf(ONE));
    expect(count(out, "Not carried")).toBe(0);
    expect(count(out, "Held ·")).toBe(0);
    expect(count(out, "Category policy")).toBe(8);
  });

  it("a stocked size the record does not declare says so, whatever the run", () => {
    const products = { [PID]: { ...P[PID], sizes: ["6", "7", "8", "9", "10", "11", "12"] } };
    const ctx = ctxOf(ONE, products);
    expect(nowLabel(ctx, "hub1", PID, "13", null, 2)).toBe("Held · not on record");
    expect(nowLabel(ctx, "hub1", PID, "13", null, 0)).toBe("Not carried");
  });

  it("no policy at all, units on the shelf: held, no policy", () => {
    const ctx = ctxOf({ mode: { hub1: "live" } });
    expect(nowLabel(ctx, "hub1", PID, "13", null, 2)).toBe("Held · no policy");
    expect(whyLine(seatingAt(ctx, "hub1", PID))).toBe("Held · no target");
  });
});
