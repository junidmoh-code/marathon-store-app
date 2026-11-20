// ─── THE SOLVE MIRROR'S CATEGORY BRANCH = THE ENGINE'S (Junid, 20 Nov 2026) ──
// resolvedRun's category-policy overlay must arm exactly the cells
// resolveTarget's category_policy branch arms, for every way a product can
// name its category: the plain key, a padded key, a key-less legacy sneaker,
// a key resolved through an armed policy group, a garbled own entry, and the
// live 20 Nov case — a beanie filed as chains-bracelets (both sides: nothing)
// next to the same beanie filed as caps-beanies (both sides: 10 at Hub 2,
// 5 at Marathon PE). Before this, the mirror indexed the RAW categoryKey and
// knew nothing of groups, so a padded or grouped key greyed a card the engine
// was refilling.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { resolvedRun, categoryPolicyLocs } from "./solvePlan.js";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";

const require = createRequire(import.meta.url);
const engine = require("../../../functions/lib/refill-engine.cjs");

// The live caps-beanies entry, byte-for-byte (read 20 Nov 2026).
const CAPS = { hub2: { minQty: 5, reorderPoint: 2, target: 10 }, "marathon-pe": { minQty: 3, reorderPoint: 2, target: 5 } };
const GROUPED = { armed: true, label: "Headwear", memberCategoryKeys: ["bucket-hats"], policy: { hub2: { target: 4 }, "marathon-pe": { target: 2 } } };
const config = (over = {}) => ({ enabled: true, ruleBasedTargets: true, categoryPolicy: { "caps-beanies": CAPS, broken: "garbage" }, policyGroups: { headwear: GROUPED }, ...over });
const LOCS = ["hub2", "marathon-pe", "trophy"];

const engineAt = (cfg, product, loc, size) => {
  const r = engine.resolveTarget({ targets: {}, config: cfg, products: { p: product }, stock: {} }, loc, "p", size);
  return r && r.source === "category_policy" ? r.target : null;
};
const mirrorAt = (cfg, product, loc, size) => {
  const run = resolvedRun({ std: {}, sizes: product.sizes, targets: {}, pid: "p", ruleBasedTargets: false,
    categoryPolicy: cfg.categoryPolicy, policyGroups: cfg.policyGroups, categoryKey: effectiveCategoryKey(product), unitsAnywhere: () => 0 });
  const t = run?.[loc]?.[String(size).toUpperCase()];
  return typeof t === "number" ? t : null;
};

const beanie = (over) => ({ id: "p", name: "Lacoste beanie grey", productType: "clothing", category: "Clothing", subcategory: "Caps & Hats", sizes: ["_"], ...over });
const CASES = {
  "caps-beanies (the solvable ones)": beanie({ categoryKey: "caps-beanies" }),
  "chains-bracelets (Junid's greyed ones)": beanie({ categoryKey: "chains-bracelets", category: "Accessories", subcategory: "Jewellery" }),
  "padded key": beanie({ categoryKey: "  caps-beanies " }),
  "missing key": beanie({ categoryKey: undefined }),
  "grouped key": beanie({ name: "Lacoste bucket hat", categoryKey: "bucket-hats" }),
  "garbled own entry": beanie({ categoryKey: "broken" }),
};

describe("Solve mirror vs engine — category_policy branch, one-size", () => {
  for (const [label, product] of Object.entries(CASES)) {
    it(label, () => {
      for (const loc of LOCS) expect(mirrorAt(config(), product, loc, "_")).toBe(engineAt(config(), product, loc, "_"));
    });
  }
  it("the live cases resolve the numbers Junid has armed", () => {
    expect(mirrorAt(config(), CASES["caps-beanies (the solvable ones)"], "hub2", "_")).toBe(10);
    expect(mirrorAt(config(), CASES["caps-beanies (the solvable ones)"], "marathon-pe", "_")).toBe(5);
    expect(mirrorAt(config(), CASES["chains-bracelets (Junid's greyed ones)"], "hub2", "_")).toBe(null);
    // The divergences this change closes: the engine arms these, so must Solve.
    expect(engineAt(config(), CASES["padded key"], "hub2", "_")).toBe(10);
    expect(mirrorAt(config(), CASES["padded key"], "hub2", "_")).toBe(10);
    expect(engineAt(config(), CASES["grouped key"], "hub2", "_")).toBe(4);
    expect(mirrorAt(config(), CASES["grouped key"], "hub2", "_")).toBe(4);
  });
  it("a key-less legacy sneaker resolves its sneakers entry on both sides", () => {
    const cfg = config({ categoryPolicy: { sneakers: { perSize: true, hub2: { target: 2 } } } });
    const p = { id: "p", name: "Adidas Campus", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] };
    // per-size dead-size rule: zero units anywhere → explicit 0 on both sides
    expect(mirrorAt(cfg, p, "hub2", "8")).toBe(engineAt(cfg, p, "hub2", "8"));
  });
  it("a disarmed group arms nothing on either side", () => {
    const cfg = config({ policyGroups: { headwear: { ...GROUPED, armed: false } } });
    for (const loc of LOCS) {
      expect(engineAt(cfg, CASES["grouped key"], loc, "_")).toBe(null);
      expect(mirrorAt(cfg, CASES["grouped key"], loc, "_")).toBe(null);
    }
  });
  it("categoryPolicyLocs trims the key like the engine", () => {
    expect(categoryPolicyLocs(config().categoryPolicy, " caps-beanies ")).toEqual(["hub2", "marathon-pe"]);
  });
});
