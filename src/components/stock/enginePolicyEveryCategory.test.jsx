// ─── ENGINE POLICY — EVERY CATALOGUE CATEGORY HAS A ROW ──────────────────────
// Junid, 22 Nov 2026: he went to arm Kids Shoes and could not find it. The
// list folded a group's members into the group's one row, so eight footwear
// categories had no row of their own; and nothing said that Kids Shoes' sizes
// (26–33) had no number under a Footwear policy that speaks for 3–13.
//
//   • every category the census returns is on the list — members under their group
//   • a brand-new category (a data edit to the taxonomy, no code) shows as
//     "no policy" and can be armed there
//   • arming sets HOW MANY, never WHERE: it never seats a product at a location
//   • products with no category, and keys outside the list, are said out loud
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { mainListEntries, policyGaps, armedInTruth, catalogueOutsideTheList, seedArmedLocation, policyFromDraft, draftForOwnRun, draftFromEntry } from "./enginePolicyCore";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";

const FOOTWEAR_POLICY = {
  perSize: true,
  hub1: { carriedOnly: true, sizes: { 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } } },
  hub2: { carriedOnly: true, sizes: { 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } } },
  hub3: { carriedOnly: true, target: 3, minQty: 2 },
};
const member = (key, label, over = {}) => ({
  key, label, products: 4, units: 20, ownRowCells: 0, ownRowProducts: 0, entry: null, policySource: "group",
  groupKey: "footwear-all", groupLabel: "Footwear", memberOfGroup: "footwear-all", footwearMember: true,
  effectiveEntry: FOOTWEAR_POLICY, armedEffective: ["hub1", "hub2", "hub3"], shapes: { hub1: "per-size", hub2: "per-size", hub3: "uniform" },
  sizeRun: ["6", "7"], sizeRunExtra: [], carriage: { hub1: { carries: true, products: 4, units: 20 } }, imageUrl: null, ...over,
});
const CENSUS = {
  destinations: ["hub1", "hub2", "marathon-pe", "trophy"], cap: 75, history: [],
  groups: { "footwear-all": { label: "Footwear", armed: true, memberCategoryKeys: ["kids-shoes", "sneakers"], policy: FOOTWEAR_POLICY } },
  groupEntries: [{
    key: "group:footwear-all", isGroup: true, groupKey: "footwear-all", label: "Footwear", armed: true, products: 8, units: 40, perSize: true,
    group: { label: "Footwear", armed: true, memberCategoryKeys: ["kids-shoes", "sneakers"], policy: FOOTWEAR_POLICY },
    memberCategoryKeys: ["kids-shoes", "sneakers"], members: [{ key: "kids-shoes", label: "Kids Shoes", products: 4, units: 20 }, { key: "sneakers", label: "Sneakers", products: 4, units: 20 }],
    entry: FOOTWEAR_POLICY, effectiveEntry: FOOTWEAR_POLICY, armedEffective: ["hub1", "hub2", "hub3"], policySource: "group", memberOfGroup: null,
    carriage: { hub1: { carries: true, products: 8, units: 40 } }, ownRowCells: 0, ownRowProducts: 0,
    sizeRun: ["6", "7", "26", "27"], sizeRunPartial: [], sizeRunExtra: [], sizeRunEmpty: false, sizeRunMembersWithRun: 2, imageUrl: null,
  }],
  categories: [
    member("sneakers", "Sneakers"),
    member("kids-shoes", "Kids Shoes", { sizeRun: ["26", "27"], sizeRunExtra: ["24"] }),
    // A BRAND-NEW CATEGORY: in the taxonomy since this morning, three products,
    // no policy, no rows. One size → armed per design.
    { key: "keyrings", label: "Keyrings", products: 3, units: 30, ownRowCells: 0, ownRowProducts: 0, entry: null, effectiveEntry: null,
      armed: [], armedEffective: [], policySource: null, groupKey: null, memberOfGroup: null, inTaxonomy: true,
      sizeRun: [], sizeRunExtra: [], sizeRunEmpty: true, sizeRunOneSize: true, imageUrl: null,
      carriage: { hub2: { carries: true, products: 3, units: 30 }, "marathon-pe": { carries: false, products: 0, units: 0 }, trophy: { carries: false, products: 0, units: 0 }, hub1: { carries: false, products: 0, units: 0 } } },
    // …and a brand-new SIZED one, with no products yet (its run is the registry's).
    { key: "kids-socks", label: "Kids Socks", products: 0, units: 0, ownRowCells: 0, ownRowProducts: 0, entry: null, effectiveEntry: null,
      armed: [], armedEffective: [], policySource: null, groupKey: null, memberOfGroup: null, inTaxonomy: true,
      sizeRun: ["S", "M"], sizeRunExtra: [], sizeRunEmpty: false, sizeRunFromRegistry: true, imageUrl: null,
      carriage: { hub2: { carries: true, products: 0, units: 0 } } },
  ],
};

describe("mainListEntries — every category has a row", () => {
  it("lists every category the census returns, exactly once", () => {
    const keys = mainListEntries(CENSUS).map((c) => c.key);
    for (const c of CENSUS.categories) expect(keys.filter((k) => k === c.key)).toHaveLength(1);
    expect(keys.filter((k) => k === "group:footwear-all")).toHaveLength(1);
    expect(keys).toHaveLength(CENSUS.categories.length + 1);
  });
  it("puts a group's members directly under it, alphabetical, marked as its members", () => {
    const list = mainListEntries(CENSUS);
    const at = list.findIndex((c) => c.key === "group:footwear-all");
    expect(list.slice(at + 1, at + 3).map((c) => [c.key, c.underGroup])).toEqual([["kids-shoes", "group:footwear-all"], ["sneakers", "group:footwear-all"]]);
  });
  it("a category added tomorrow needs nothing but its census entry", () => {
    const tomorrow = { ...CENSUS, categories: [...CENSUS.categories, { key: "lanyards", label: "Lanyards", products: 1, ownRowCells: 0, armedEffective: [], memberOfGroup: null }] };
    expect(mainListEntries(tomorrow).map((c) => c.key)).toContain("lanyards");
  });
  it("never mutates the census entries (the detail screen opens the same objects)", () => {
    const frozen = { ...CENSUS, categories: CENSUS.categories.map((c) => Object.freeze({ ...c })) };
    expect(() => mainListEntries(frozen)).not.toThrow();
    expect("underGroup" in frozen.categories[1]).toBe(false);
  });
});

describe("policyGaps / armedInTruth — sizes with no number", () => {
  const kids = CENSUS.categories[1];
  it("Kids Shoes under a Footwear policy that names 6 and 7: nothing of it is kept at Hub 1 or Hub 2", () => {
    expect(policyGaps(kids)).toEqual({ hub1: { missing: ["26", "27"], all: true }, hub2: { missing: ["26", "27"], all: true } });
    expect(armedInTruth(kids)).toEqual({ real: ["hub3"], hollow: ["hub1", "hub2"], partial: [] });
  });
  it("Sneakers, whose sizes the policy names, has no gap", () => {
    expect(policyGaps(CENSUS.categories[0])).toEqual({});
    expect(armedInTruth(CENSUS.categories[0]).real).toEqual(["hub1", "hub2", "hub3"]);
  });
  it("a size with target 0, or one of several missing, is a partial gap", () => {
    const c = member("x", "X", { sizeRun: ["6", "7", "8"], effectiveEntry: { perSize: true, hub1: { sizes: { 6: { target: 2 }, 7: { target: 0 } } } }, armedEffective: ["hub1"] });
    expect(policyGaps(c)).toEqual({ hub1: { missing: ["7", "8"], all: false } });
    expect(armedInTruth(c)).toEqual({ real: ["hub1"], hollow: [], partial: ["hub1"] });
  });
  it("one number for the whole location speaks for every size; a one-size category has no gap; junk is no gap", () => {
    expect(policyGaps(member("y", "Y", { effectiveEntry: { hub3: { target: 3 } }, armedEffective: ["hub3"] }))).toEqual({});
    expect(policyGaps({ sizeRun: [], effectiveEntry: { hub2: { target: 4 } }, armedEffective: ["hub2"] })).toEqual({});
    expect(policyGaps(null)).toEqual({});
    expect(policyGaps({ sizeRun: ["S"], effectiveEntry: null, armedEffective: [] })).toEqual({});
  });
});

describe("catalogueOutsideTheList — what no row speaks for", () => {
  const products = [
    { id: "a", categoryKey: "keyrings" },
    { id: "b", category: "Footwear", subcategory: "Sneakers" },                 // legacy sneaker → sneakers
    { id: "c", category: "Clothing", subcategory: "Clothing — Uncategorized" }, // no category
    { id: "d", category: "Accessories", subcategory: "Eyewear" },               // no category
    { id: "e", category: "Accessories", subcategory: "Eyewear" },
    { id: "f", categoryKey: "phone-cases" },                                    // a key outside the list
    { id: "g" },                                                                // nothing at all
    { id: "h", category: "Clothing", subcategory: "T-Shirts", deactivated: true },
  ];
  const out = catalogueOutsideTheList({ products, census: CENSUS, categoryKeyOf: effectiveCategoryKey, isDeactivated: (p) => p.deactivated === true });
  it("counts products with no category, by what their old fields say, finished lines left out", () => {
    expect(out.noCategory).toBe(4);
    expect(out.noCategoryBy).toEqual([
      { label: "Accessories › Eyewear", products: 2 },
      { label: "Clothing › Clothing — Uncategorized", products: 1 },
      { label: "Nothing recorded", products: 1 },
    ]);
  });
  it("names a category key that is not on the list", () => {
    expect(out.unlisted).toEqual([{ key: "phone-cases", products: 1 }]);
  });
  it("is quiet when the catalogue is fully on the list", () => {
    expect(catalogueOutsideTheList({ products: products.slice(0, 2), census: CENSUS, categoryKeyOf: effectiveCategoryKey })).toEqual({ noCategory: 0, noCategoryBy: [], unlisted: [] });
    expect(catalogueOutsideTheList({ products: null, census: null, categoryKeyOf: effectiveCategoryKey }).noCategory).toBe(0);
  });
});

describe("arming never seats a product at a new location", () => {
  it("the leg the arm button seeds is scoped to products the location already stocks — one-size and sized", () => {
    expect(seedArmedLocation({ sizeRun: [] }).carriedOnly).toBe(true);
    expect(seedArmedLocation({ sizeRun: ["S", "M"] }).carriedOnly).toBe(true);
  });
  it("…and the policy sent for a brand-new category carries that scope, and names only that location", () => {
    const draft = { hub2: { ...seedArmedLocation({ sizeRun: [] }), target: "4", minQty: "2" } };
    expect(policyFromDraft(draft)).toEqual({ hub2: { target: 4, minQty: 2, carriedOnly: true } });
  });
});

describe("draftForOwnRun — Kids Shoes leaves Footwear's numbers for its own size run", () => {
  it("size-by-size hubs are laid out on the kids sizes, blank; Hub 3's one number and carried-only are kept; no adult size rides along", () => {
    const start = draftFromEntry({ entry: FOOTWEAR_POLICY, carriage: {}, destinations: ["hub1", "hub2"] });
    const d = draftForOwnRun(start, ["27", "26"]);
    expect(Object.keys(d.hub1.sizes)).toEqual(["26", "27"]);
    expect(d.hub1.sizes["26"]).toEqual({ target: "", minQty: "", reorderPoint: "" });
    expect(d.hub1.carriedOnly).toBe(true);
    expect(d.hub3).toEqual(start.hub3);
    // nothing blank becomes a policy: saving it untouched arms Hub 3 only, exactly as it is today
    expect(policyFromDraft(d, { perSize: true })).toEqual({ perSize: true, hub3: { target: 3, minQty: 2, carriedOnly: true } });
  });
  it("a size both runs name keeps Footwear's number", () => {
    const start = draftFromEntry({ entry: FOOTWEAR_POLICY, carriage: {}, destinations: ["hub1"] });
    expect(draftForOwnRun(start, ["7", "26"]).hub1.sizes["7"].target).toBe("3");
  });
});

// ═══ ON THE CARD ═════════════════════════════════════════════════════════════
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, location: { hash: "" }, scrollY: 0, scrollTo() {}, confirm: () => true, requestAnimationFrame(fn) { fn(); } };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());
const calls = [];
vi.mock("firebase/functions", () => ({ httpsCallable: () => async (arg) => { calls.push(arg); return { data: arg?.action === "census" ? CENSUS : { ok: true, preview: { totalRequests: 0, totalUnits: 0, legs: [] } } }; } }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), onValue: () => () => {}, get: async () => ({ val: () => null }), update: vi.fn(async () => {}) }));
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const OWNER = { email: "gunidmoh@gmail.com" };
const PRODUCTS = [{ id: "c", category: "Clothing", subcategory: "Clothing — Uncategorized" }, { id: "f", categoryKey: "phone-cases" }, { id: "a", categoryKey: "keyrings" }];
const mount = async () => { let tree; await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); }); await act(async () => {}); return tree; };
const row = (tree, key) => tree.root.findAll((n) => n.props && n.props["data-category-row"] === key && typeof n.type === "string")[0];
const textOf = (node) => node.findAll((n) => typeof n.type === "string").flatMap((n) => (n.children || []).filter((c) => typeof c === "string")).join("").replace(/\s+/g, " ");
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const label = (b) => (b.children || []).filter((c) => typeof c === "string").join("");

beforeEach(() => { calls.length = 0; });

describe("the Engine Policy list", () => {
  it("shows Kids Shoes as its own row under Footwear, and says its sizes have no numbers at Hub 1 and Hub 2", async () => {
    const tree = await mount();
    const kids = row(tree, "kids-shoes");
    expect(kids).toBeDefined();
    expect(kids.props["data-under-group"]).toBe("group:footwear-all");
    expect(textOf(kids)).toMatch(/Kids Shoes/);
    expect(textOf(kids)).toMatch(/in Footwear/);
    expect(textOf(kids)).toMatch(/no numbers for its sizes at Hub 1 · Hub 2/);
    expect(textOf(kids)).toMatch(/armed at 1/);               // Hub 3 only — not "armed at 3"
    expect(textOf(row(tree, "sneakers"))).toMatch(/armed at 3/);
  });

  it("a brand-new category is on the list as “no policy”", async () => {
    const tree = await mount();
    for (const key of ["keyrings", "kids-socks"]) {
      expect(row(tree, key), key).toBeDefined();
      expect(textOf(row(tree, key))).toMatch(/no policy/);
    }
    expect(textOf(row(tree, "keyrings"))).toMatch(/one size/);
    expect(textOf(row(tree, "kids-socks"))).toMatch(/per size/);
  });

  it("…and can be armed there: one number per design for a one-size category, scoped to what the location already stocks", async () => {
    const tree = await mount();
    await act(async () => { row(tree, "keyrings").findAll((n) => n.type === "button")[0].props.onClick(); });
    const arm = buttons(tree).filter((b) => ["Stock here", "Arm this store"].includes(label(b)));
    expect(arm.length).toBeGreaterThan(0);
    await act(async () => { buttons(tree).find((b) => label(b) === "Stock here").props.onClick(); });
    // armed in the DRAFT only: nothing has been sent, and nothing is ever sent
    // but the census until the owner types a number, previews and saves
    expect(calls.filter((c) => c?.action !== "census")).toEqual([]);
    expect(buttons(tree).some((b) => label(b) === "Stop stocking here")).toBe(true);
  });

  it("a sized brand-new category arms size by size", async () => {
    const tree = await mount();
    await act(async () => { row(tree, "kids-socks").findAll((n) => n.type === "button")[0].props.onClick(); });
    await act(async () => { buttons(tree).find((b) => label(b) === "Stock here").props.onClick(); });
    expect(buttons(tree).some((b) => label(b) === "One number")).toBe(true);   // i.e. it opened size by size
  });

  it("finding by name narrows the list and keeps a member under its group", async () => {
    const tree = await mount();
    const find = tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === "Find a category")[0];
    await act(async () => { find.props.onChange({ target: { value: "kids sh" } }); });
    const shown = tree.root.findAll((n) => n.props && n.props["data-category-row"] && typeof n.type === "string").map((n) => n.props["data-category-row"]);
    expect(shown).toEqual(["group:footwear-all", "kids-shoes"]);
  });

  it("opening Kids Shoes names the sizes with no number, and opens ITS OWN editor on the kids sizes — blank, nothing chosen for Junid (22 Nov 2026)", async () => {
    const tree = await mount();
    await act(async () => { row(tree, "kids-shoes").findAll((n) => n.type === "button")[0].props.onClick(); });
    const flat = textOf(tree.root);
    expect(flat).toMatch(/Sizes with no number/);
    expect(flat).toMatch(/Hub 1: none of its sizes has a number for 26, 27/);
    expect(flat).toMatch(/also come in 24/);
    // Kids Shoes is armable here: no "set once on Footwear" redirect…
    expect(flat).not.toMatch(/Footwear is set once/);
    expect(tree.root.findAll((n) => n.type === "button" && n.props["data-open-group"]).length).toBe(0);
    // …its size-by-size hubs are laid out on the KIDS run, every number blank,
    // and no adult size (6, 7) is offered on its screen.
    const inputs = tree.root.findAll((n) => n.type === "input");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => String(i.props.value ?? "") === "" || i.props.type === "checkbox" || i.props.value === "3" || i.props.value === "2")).toBe(true);
    expect(flat).toMatch(/26/);
  });

  it("Sneakers (any other footwear category) still says Footwear is set once, and points to Footwear", async () => {
    const tree = await mount();
    await act(async () => { row(tree, "sneakers").findAll((n) => n.type === "button")[0].props.onClick(); });
    expect(textOf(tree.root)).toMatch(/Footwear is set once/);
  });

  it("says how many products have no category, and names a key that is not on the list", async () => {
    const tree = await mount();
    const box = tree.root.findAll((n) => n.props && n.props["data-outside-list"] && typeof n.type === "string")[0];
    expect(box).toBeDefined();
    expect(textOf(box)).toMatch(/1 product has no category/);
    expect(textOf(box)).toMatch(/phone-cases/);
    expect(textOf(box)).toMatch(/not in the category list/);
  });

  it("reads nothing new: the only call is the census", async () => {
    await mount();
    expect(calls).toEqual([{ action: "census" }]);
  });
});
