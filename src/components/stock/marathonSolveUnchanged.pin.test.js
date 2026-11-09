// ─── MARATHON SOLVE UNCHANGED — pinned before the Hub 3 policy work (Junid, 9 Nov 2026)
// Hub 1 / Hub 2 sneaker Solve lines, the Marathon store Solve blocks and the
// first-batch path keep exactly the answers they gave before Hub 3 joined them.
import { describe, it, expect } from "vitest";
import { solveBlocks } from "./solveSections";
import { firstBatchEligible } from "./firstBatchCore";
import { footwearSolvePlan } from "./missingFootwearCore";
import { SEED_REGISTRY, normalizeNetwork } from "../../utils/networkRegistry";

const SNEAKER = { id: "p1", name: "Shoe", categoryKey: "sneakers", category: "Footwear", productType: "sneaker", sizes: ["7", "8", "9"] };
const TEE = { id: "p2", name: "Tee", categoryKey: "t-shirts", category: "Clothing", productType: "clothing", sizes: ["S", "M", "L"] };

describe("Marathon division Solve", () => {
  it("a Marathon clothing Solve still offers exactly Marathon PE and Trophy, through Hub 2", () => {
    const [block] = solveBlocks({ network: SEED_REGISTRY, sections: [2], source: "central", product: TEE, productId: TEE.id, engineConfig: {} });
    expect(block.section).toBe(2);
    expect(block.stores.map((s) => [s.id, s.hub, s.blocked])).toEqual([["marathon-pe", "hub2", null], ["trophy", "hub2", null]]);
  });

  it("the single-hub sneaker Solve plan is min(policy, Central free), unchanged for Hub 1 and Hub 2", () => {
    const lines = footwearSolvePlan({
      catalogSizes: SNEAKER.sizes, policy: { 7: 2, 8: 3, 9: 2 },
      centralCells: { 7: { qty: 5 }, 8: { qty: 1 }, 9: { qty: 0 } },
      openSizes: [], reserved: {},
    });
    expect(lines).toEqual([{ size: "7", qty: 2, want: 2, avail: 5 }, { size: "8", qty: 1, want: 3, avail: 1 }]);
  });

  it("the first-batch-direct path is still open for a Central-stranded Marathon product with no hub presence", () => {
    const routes = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
    const network = normalizeNetwork(null);
    expect(firstBatchEligible({ source: "central", store: "marathon-pe", product: TEE, productId: TEE.id, hub: "hub2", routes, network, hub2Present: false })).toBe(true);
    expect(firstBatchEligible({ source: "central", store: "marathon-pe", product: TEE, productId: TEE.id, hub: "hub2", routes, network, hub2Present: true })).toBe(false);
    expect(firstBatchEligible({ source: "central", store: "trophy", product: SNEAKER, productId: SNEAKER.id, hub: "hub2", routes, network, hub2Present: false })).toBe(false);
  });
});
