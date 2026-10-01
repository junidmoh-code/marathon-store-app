// ─── ONE FOOTWEAR POLICY — A SHARED TEST WORLD ────────────────────────────────
// Used by functions/test/footwear-one-policy.test.cjs (the engine) and by
// src/components/stock/footwearOnePolicy.parity.test.js (the browser mirror),
// so both answer the same question about the same world.
//
// One product per footwear category, every one declaring the whole adult run
// and holding a cell at BOTH hubs; Central holds units of every size so the
// dead-size rule never zeroes a size. Plus the three shapes the tests need:
//   uncarried  a sneaker with NO cell at Hub 1 (carried at Hub 2 only)
//   kids       a kids shoe on the 26–33 labels the registry uses
//   ruled      a sneaker with explicit rows at Hub 1 (a 0 and a 5)

const RUN_SIZES = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"];
const FOOTWEAR_KEYS = ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots"];
// Junid's standing run, 24 Sep 2026 — pinned here as the fixture, not imported,
// so a change to the script copy cannot silently move what the tests expect.
const STANDING = { 3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2 };
const enc = (s) => String(s).replace(".", "_");

function standingLeg() {
  const sizes = {};
  for (const [k, t] of Object.entries(STANDING)) sizes[k] = { target: t, minQty: Math.ceil(t / 2), reorderPoint: 1 };
  return { sizes, carriedOnly: true };
}

function footwearGroup(over = {}) {
  return {
    label: "Footwear", armed: true, memberCategoryKeys: [...FOOTWEAR_KEYS],
    policy: { perSize: true, hub1: standingLeg(), hub2: standingLeg() },
    ...over,
  };
}

function world() {
  const products = {}, hub1 = {}, hub2 = {}, central = {};
  const cells = (sizes, qty) => Object.fromEntries(sizes.map((s) => [enc(s), { qty }]));
  for (const key of FOOTWEAR_KEYS) {
    const pid = `p-${key}`;
    products[pid] = { id: pid, name: key, category: "Footwear", categoryKey: key, productType: "sneaker", sizes: [...RUN_SIZES] };
    hub1[pid] = cells(RUN_SIZES, 1);
    hub2[pid] = cells(RUN_SIZES, 1);
    central[pid] = cells(RUN_SIZES, 10);
  }
  products.uncarried = { id: "uncarried", name: "Uncarried", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["6", "7", "12"] };
  hub2.uncarried = cells(["6", "7", "12"], 1);
  central.uncarried = cells(["6", "7", "12"], 10);
  products.kids = { id: "kids", name: "Kids", category: "Footwear", categoryKey: "kids-shoes", productType: "sneaker", sizes: ["26", "27", "28", "29", "30", "31", "32", "33"] };
  hub1.kids = cells(products.kids.sizes, 1);
  hub2.kids = cells(products.kids.sizes, 1);
  central.kids = cells(products.kids.sizes, 10);
  products.ruled = { id: "ruled", name: "Ruled", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["6", "7", "8"] };
  hub1.ruled = cells(["6", "7", "8"], 1);
  central.ruled = cells(["6", "7", "8"], 10);
  const targets = { hub1: { ruled: { 6: { target: 0, minQty: 0, source: "seating_off" }, 7: { target: 5, minQty: 2, source: "policy_target" } } } };
  const config = {
    mode: { hub1: "live", hub2: "live" },
    routes: { hub1: "central", hub2: "central" },
    ruleBasedTargets: true, maxIntentsPerRun: 200, maxFootwearIntentsPerRun: 200, maxUnitsPerIntent: 20,
    categoryPolicy: {},
    policyGroups: { "footwear-all": footwearGroup() },
  };
  return { products, stock: { hub1, hub2, central }, targets, config };
}

module.exports = { RUN_SIZES, FOOTWEAR_KEYS, STANDING, standingLeg, footwearGroup, world, enc };
