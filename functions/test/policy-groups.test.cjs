// ─── POLICY GROUPS + PER-SIZE — THE RULES, AS RULES ───────────────────────────
//
// The properties here are the ones the rest of the feature is allowed to
// assume. Each is mutation-proved in scripts/mutation-proof-policy-groups.mjs:
// breaking the implementation on purpose must turn one of these red, or the
// test is decoration.

const test = require("node:test");
const assert = require("node:assert");

const {
  locationEntryMode, validateLocationEntry, validatePolicyGroup,
  armedGroupForCategory, effectivePolicyFor, sizeRunForCategory, sizeRank,
  fillAllSizes, mergeCandidates,
} = require("../lib/policy-groups.cjs");

const UNIFORM = { target: 5, minQty: 3 };
const PERSIZE = { sizes: { S: { target: 3, minQty: 2 }, M: { target: 5, minQty: 3 } } };

// ── SHAPES ───────────────────────────────────────────────────────────────────
test("locationEntryMode tells the two shapes apart and refuses both at once", () => {
  assert.equal(locationEntryMode(UNIFORM), "uniform");
  assert.equal(locationEntryMode(PERSIZE), "per-size");
  assert.equal(locationEntryMode({ target: 5, minQty: 3, sizes: { S: { target: 1, minQty: 1 } } }), "invalid");
  assert.equal(locationEntryMode({}), "invalid");
  assert.equal(locationEntryMode(null), "invalid");
  assert.equal(locationEntryMode([]), "invalid");
});

test("a per-size map is refused outside per-size mode", () => {
  assert.match(validateLocationEntry(PERSIZE, { where: "hub2", perSize: false }) || "",
    /per-size mode/);
  assert.equal(validateLocationEntry(PERSIZE, { where: "hub2", perSize: true }), null);
});

test("per-size rows are held to the SAME rules a uniform row is", () => {
  // minQty above target — refused for a uniform entry, must be refused nested too.
  const bad = { sizes: { S: { target: 3, minQty: 9 } } };
  assert.match(validateLocationEntry(bad, { where: "hub2", perSize: true }) || "", /cannot exceed/);
  // Ask at at or above Keep — same.
  const bad2 = { sizes: { S: { target: 3, minQty: 2, reorderPoint: 3 } } };
  assert.match(validateLocationEntry(bad2, { where: "hub2", perSize: true }) || "", /must be below/);
  // A missing minQty is refused nested exactly as it is at the top level.
  const bad3 = { sizes: { S: { target: 3 } } };
  assert.match(validateLocationEntry(bad3, { where: "hub2", perSize: true }) || "", /minQty is required/);
});

test("size keys must already be in their STORED form — 5.5 cannot be written", () => {
  const raw = { sizes: { "5.5": { target: 2, minQty: 1 } } };
  assert.match(validateLocationEntry(raw, { where: "hub2", perSize: true }) || "", /5_5|letters, digits/);
  const encoded = { sizes: { "5_5": { target: 2, minQty: 1 } } };
  assert.equal(validateLocationEntry(encoded, { where: "hub2", perSize: true }), null);
});

test('"_" is the one-size cell and is refused inside a per-size map', () => {
  const e = { sizes: { _: { target: 2, minQty: 1 } } };
  assert.match(validateLocationEntry(e, { where: "hub2", perSize: true }) || "", /one-size cell/);
});

test("a size outside the category's derived run is refused", () => {
  const e = { sizes: { XXXL: { target: 2, minQty: 1 } } };
  assert.match(validateLocationEntry(e, { where: "hub2", perSize: true, allowedSizes: ["S", "M"] }) || "",
    /not one of this category's sizes/);
});

// ── GROUP VALIDATION ─────────────────────────────────────────────────────────
const GROUP = () => ({
  label: "All footwear except soccer boots",
  memberCategoryKeys: ["sneakers", "slides"],
  armed: false,
  policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
});
const KNOWN = { knownCategoryKeys: ["sneakers", "slides", "soccer-boots"], knownLocations: ["hub2", "trophy"] };

test("a well-formed group validates; null deletes", () => {
  assert.equal(validatePolicyGroup("footwear-all", GROUP(), KNOWN), null);
  assert.equal(validatePolicyGroup("footwear-all", null, KNOWN), null);
});

test("a group cannot be armed without numbers", () => {
  const g = { label: "x", memberCategoryKeys: ["sneakers"], armed: true };
  assert.match(validatePolicyGroup("g", g, KNOWN) || "", /no numbers yet/);
});

test("a category belongs to at most one group", () => {
  const existing = { "other-group": { memberCategoryKeys: ["slides"] } };
  const err = validatePolicyGroup("footwear-all", GROUP(), { ...KNOWN, existingGroups: existing });
  assert.match(err || "", /already in the "other-group" group/);
  // ...but re-writing the SAME group must not trip over itself.
  assert.equal(validatePolicyGroup("footwear-all", GROUP(),
    { ...KNOWN, existingGroups: { "footwear-all": { memberCategoryKeys: ["sneakers", "slides"] } } }), null);
});

test("an unknown categoryKey or location is refused", () => {
  const g = GROUP(); g.memberCategoryKeys = ["sneakers", "made-up"];
  assert.match(validatePolicyGroup("footwear-all", g, KNOWN) || "", /unknown categoryKey/);
  const h = GROUP(); h.policy = { perSize: true, nowhere: { sizes: { 7: { target: 2, minQty: 1 } } } };
  assert.match(validatePolicyGroup("footwear-all", h, KNOWN) || "", /unknown location/);
});

test("the group key is a single RTDB key segment", () => {
  assert.match(validatePolicyGroup("foot/wear", GROUP(), KNOWN) || "", /letters, digits/);
});

test("armed must be an explicit boolean — an absent flag never arms", () => {
  const g = GROUP(); delete g.armed;
  assert.match(validatePolicyGroup("footwear-all", g, KNOWN) || "", /armed must be true or false/);
});

// ── RESOLUTION ───────────────────────────────────────────────────────────────
const CFG = (over = {}) => ({
  categoryPolicy: { "caps-beanies": { hub2: { target: 10, minQty: 5 } } },
  policyGroups: {
    "footwear-all": {
      label: "f", armed: true, memberCategoryKeys: ["sneakers", "caps-beanies"],
      policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
    },
  },
  ...over,
});

test("A DISARMED GROUP IS NOT IN THE RESOLUTION ORDER AT ALL", () => {
  const cfg = CFG();
  cfg.policyGroups["footwear-all"].armed = false;
  assert.equal(armedGroupForCategory(cfg, "sneakers"), null);
  assert.equal(effectivePolicyFor(cfg, "sneakers"), null);
});

test("an armed group speaks for a member with no policy of its own", () => {
  const r = effectivePolicyFor(CFG(), "sneakers");
  assert.equal(r.source, "group");
  assert.equal(r.groupKey, "footwear-all");
  assert.equal(r.entry.hub2.sizes["7"].target, 2);
});

test("A CATEGORY'S OWN POLICY BEATS ITS GROUP'S — entirely, not per location", () => {
  const cfg = CFG();
  const r = effectivePolicyFor(cfg, "caps-beanies");
  assert.equal(r.source, "category");
  assert.equal(r.entry.hub2.target, 10);
  // And the group is not consulted for the locations the own entry omits: the
  // group arms nothing extra for a category that has its own numbers.
  assert.equal(armedGroupForCategory(cfg, "caps-beanies"), null);
});

test("a group with no policy resolves nothing even when armed", () => {
  const cfg = CFG();
  delete cfg.policyGroups["footwear-all"].policy;
  assert.equal(armedGroupForCategory(cfg, "sneakers"), null);
});

test("a non-member resolves nothing", () => {
  assert.equal(effectivePolicyFor(CFG(), "t-shirts"), null);
});

test("two armed groups claiming one category resolve deterministically and report the overlap", () => {
  const cfg = CFG();
  cfg.policyGroups["a-group"] = {
    label: "a", armed: true, memberCategoryKeys: ["sneakers"],
    policy: { perSize: true, hub2: { sizes: { 7: { target: 9, minQty: 1 } } } },
  };
  const r = armedGroupForCategory(cfg, "sneakers");
  assert.equal(r.groupKey, "a-group");                 // lexicographically first
  assert.deepEqual(r.overlaps, ["footwear-all"]);
});

test("garbled config arms nothing", () => {
  assert.equal(armedGroupForCategory({ policyGroups: "nope" }, "sneakers"), null);
  assert.equal(armedGroupForCategory({ policyGroups: { g: null } }, "sneakers"), null);
  assert.equal(armedGroupForCategory({}, "sneakers"), null);
  assert.equal(armedGroupForCategory(null, "sneakers"), null);
  assert.equal(armedGroupForCategory(CFG(), ""), null);
});

// ── SIZE RUN, FROM LIVE DATA ─────────────────────────────────────────────────
const WORLD = () => ({
  products: {
    p1: { categoryKey: "sneakers", sizes: ["7", "8"] },
    p2: { categoryKey: "sneakers", sizes: ["5.5"] },
    p3: { categoryKey: "t-shirts", sizes: ["S"] },
  },
  stock: { hub2: { p1: { 7: { qty: 3 } }, p2: { "5_5": { qty: 1 } } } },
  targets: { hub2: { p1: { 9: { target: 2, minQty: 1 } } } },
  taxonomy: { cats: { sneakers: { sizes: ["7", "8", "5.5", "12"] } } },
});

test("the run is what the registry declares AND live data confirms", () => {
  const w = WORLD();
  const r = sizeRunForCategory({ ...w, categoryKey: "sneakers", locations: ["hub2"] });
  assert.deepEqual(r.union, ["5_5", "7", "8", "9"]);
  assert.deepEqual(r.sizes, ["5_5", "7", "8"]);        // 9 is real but off-registry
  assert.deepEqual(r.sources.declared, ["5_5", "7", "8"]);
  assert.deepEqual(r.sources.stocked, ["5_5", "7"]);
  assert.deepEqual(r.sources.rowed, ["9"]);
  assert.equal(r.empty, false);
});

test("a real size the registry does not know about is SHOWN, not hidden", () => {
  // Measured live 2026-08-22: 1,246 sneakers between them declare garment letter
  // sizes, and fitted caps carry a stray "28". Offering those as policy would put
  // the map on cells the category does not have — but they refill off their own
  // rows today, so they must still be visible.
  const w = WORLD();
  const r = sizeRunForCategory({ ...w, categoryKey: "sneakers", locations: ["hub2"] });
  assert.deepEqual(r.extra, ["9"]);
  assert.ok(!r.sizes.includes("9"));
});

test("a size the registry promises but nothing stocks is never offered", () => {
  const w = WORLD();
  const r = sizeRunForCategory({ ...w, categoryKey: "sneakers", locations: ["hub2"] });
  assert.deepEqual(r.taxonomyOnly, ["12"]);            // promised, exists nowhere
  assert.ok(!r.sizes.includes("12"));
});

test("with no registry run at all, live data stands alone", () => {
  const w = WORLD();
  w.taxonomy = { cats: {} };
  const r = sizeRunForCategory({ ...w, categoryKey: "sneakers", locations: ["hub2"] });
  assert.deepEqual(r.sizes, ["5_5", "7", "8", "9"]);
  assert.deepEqual(r.extra, []);
});

test("a category with no derivable run says so rather than guessing", () => {
  const r = sizeRunForCategory({
    products: { p: { categoryKey: "watches", sizes: ["_"] } }, stock: {}, targets: {},
    taxonomy: { cats: { watches: { sizes: ["_"] } } }, categoryKey: "watches", locations: ["hub2"],
  });
  assert.equal(r.empty, true);
  assert.deepEqual(r.sizes, []);
});

test("5.5 lands in the run as its stored key, once, however it was spelled", () => {
  const r = sizeRunForCategory({
    products: { a: { categoryKey: "s", sizes: ["5.5"] }, b: { categoryKey: "s", sizes: ["5 5"] } },
    stock: { hub2: { a: { "5_5": { qty: 1 } } } }, targets: {},
    taxonomy: { cats: {} }, categoryKey: "s", locations: ["hub2"],
  });
  assert.deepEqual(r.sizes, ["5_5"]);
});

test("sizeRank matches the browser's — letters, then numerics, then junk", () => {
  assert.ok(sizeRank("S") < sizeRank("XL"));
  assert.ok(sizeRank("XXXL") < sizeRank("7"));
  assert.equal(sizeRank("5_5"), 105.5);
  assert.equal(sizeRank("wat"), 999);
});

// ── QUICK-FILL ───────────────────────────────────────────────────────────────
test('"same across all sizes" writes each size individually, never a collapsed number', () => {
  const out = fillAllSizes(["S", "M", "5.5"], { target: 4, minQty: 2, reorderPoint: 1 });
  assert.deepEqual(Object.keys(out), ["S", "M", "5_5"]);
  for (const k of Object.keys(out)) assert.deepEqual(out[k], { target: 4, minQty: 2, reorderPoint: 1 });
});

test("an absent Ask at stays absent in every expanded row — never zeroed", () => {
  const out = fillAllSizes(["S"], { target: 4, minQty: 2, reorderPoint: null });
  assert.deepEqual(out.S, { target: 4, minQty: 2 });
  assert.ok(!("reorderPoint" in out.S));
});

// ── MERGE CANDIDATES ─────────────────────────────────────────────────────────
test("merge candidates are proposals: tiny categories and twinned ones, nothing merged", () => {
  const taxonomy = { cats: {
    gloves: { top: "clothing", sizeMode: "list", sizes: ["M", "L"] },
    scarves: { top: "clothing", sizeMode: "list", sizes: ["M", "L"] },
    boots: { top: "footwear", sizeMode: "list", sizes: ["7"] },
  } };
  const out = mergeCandidates({
    taxonomy, countsByCategory: { gloves: 3, scarves: 4, boots: 40 },
    movementByCategory: { gloves: 10, scarves: 12, boots: 500 }, policy: {}, groups: {},
  });
  assert.ok(out.some((c) => c.kind === "twinned" && c.categories.join() === "gloves,scarves"));
  assert.ok(out.some((c) => c.kind === "tiny" && c.categories[0] === "gloves"));
  assert.ok(!out.some((c) => c.categories.includes("boots")));
});

test("categories already in a group are not proposed again", () => {
  const taxonomy = { cats: { gloves: { top: "clothing", sizeMode: "list", sizes: ["M"] } } };
  const out = mergeCandidates({
    taxonomy, countsByCategory: { gloves: 3 }, movementByCategory: { gloves: 5 },
    policy: {}, groups: { g: { memberCategoryKeys: ["gloves"] } },
  });
  assert.deepEqual(out, []);
});

test("two dead categories are not twinned on zero movement", () => {
  const taxonomy = { cats: {
    a: { top: "clothing", sizeMode: "list", sizes: ["M"] },
    b: { top: "clothing", sizeMode: "list", sizes: ["M"] },
  } };
  const out = mergeCandidates({
    taxonomy, countsByCategory: { a: 50, b: 50 }, movementByCategory: { a: 0, b: 0 }, policy: {}, groups: {},
  });
  assert.deepEqual(out.filter((c) => c.kind === "twinned"), []);
});
