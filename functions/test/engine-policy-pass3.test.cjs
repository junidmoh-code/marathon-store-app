// ─── ENGINE POLICY, PASS 3 — THE GUARDS ───────────────────────────────────────
// Run: cd functions && node --test test/engine-policy-pass3.test.cjs
//
// This pass adds NO new branch to resolution. That is the claim, and a claim
// about "nothing changed" is the easiest kind to be wrong about silently — so
// it is pinned the hard way: a fixed world covering every arrangement the engine
// knows (clothing on the rule, an explicit row, a uniform one-size entry, a
// uniform per-size entry, a per-size MAP, an armed group, a disarmed group,
// footwear behind its switch) is resolved cell by cell and the whole result is
// hashed. The hash is a literal in this file. Any change to what any cell
// resolves to — clothing included — fails the first test.
//
// The five properties the brief names are then each asserted on their own,
// because a hash says "something moved" and a property says what:
//
//   1. a DISARMED Sneakers group (live shape: 7 members, per-size) → ZERO intents
//   2. CLOTHING resolution is unchanged by groups and per-size maps existing
//   3. an existing SCALAR policy resolves identically — and a per-size map that
//      names every size with the same number is indistinguishable from it
//   4. a PER-SIZE policy resolves PER SIZE
//   5. a member's OWN numbers beat the group's — entirely, not per location
//
// Each is mutation-proved in scripts/mutation-proof-engine-policy-pass3.mjs.
//
// The live proof for clothing is scripts/census-engine-policy-pass3.mjs
// --replay, which puts the captured live catalogue through this branch's engine
// and diffs against the capture. This file is the same proof at unit scale, so
// CI has it too.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { computeRefillPlan, resolveTarget, encodeSizeKey } = require("../lib/refill-engine.cjs");
const { sizeRunForGroup, fillAllSizes, MAX_GROUP_UNION } = require("../lib/policy-groups.cjs");

const NOW = Date.parse("2026-08-22T09:00:00.000Z");
const DESTS = ["hub2", "marathon-pe"];

// ── THE WORLD ────────────────────────────────────────────────────────────────
const PRODUCTS = {
  // clothing on the RULE (defaultRunByStore), no policy anywhere
  tee1: { id: "tee1", name: "Tee 1", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L", "XL"] },
  // clothing with EXPLICIT rows at hub2
  tee2: { id: "tee2", name: "Tee 2", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L"] },
  // clothing under a UNIFORM per-size category entry (one number, every size)
  hood1: { id: "hood1", name: "Hoodie", categoryKey: "hoodies", productType: "clothing", sizes: ["S", "M", "L"] },
  // ONE-SIZE under a uniform entry
  cap1: { id: "cap1", name: "Cap", categoryKey: "caps-beanies", productType: "clothing", sizes: ["_"] },
  // a PER-SIZE MAP
  fc1: { id: "fc1", name: "Fitted", categoryKey: "fitted-caps", productType: "clothing", sizes: ["56", "57", "58"] },
  // one-size, nothing
  bag1: { id: "bag1", name: "Bag", categoryKey: "bags", productType: "clothing", sizes: ["_"] },
  // footwear — members of the Sneakers group
  sn1: { id: "sn1", name: "Air Max", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["5.5", "7", "8", "9"] },
  sl1: { id: "sl1", name: "Slide", category: "Footwear", categoryKey: "slides", productType: "sneaker", sizes: ["5.5", "7"] },
  ds1: { id: "ds1", name: "Loafer-ish", category: "Footwear", categoryKey: "designer-shoes", productType: "sneaker", sizes: ["7", "8"] },
};
const cells = (pid, qty) => Object.fromEntries(PRODUCTS[pid].sizes.map((s) => [encodeSizeKey(s), { qty }]));
const STOCK = {
  hub2: { tee1: cells("tee1", 0), tee2: cells("tee2", 1), hood1: cells("hood1", 0), cap1: cells("cap1", 3),
    fc1: cells("fc1", 0), bag1: cells("bag1", 0), sn1: cells("sn1", 0), sl1: cells("sl1", 0), ds1: cells("ds1", 0) },
  "marathon-pe": { tee1: cells("tee1", 0), hood1: cells("hood1", 0), sn1: cells("sn1", 0) },
  central: { tee1: cells("tee1", 40), tee2: cells("tee2", 40), hood1: cells("hood1", 40), cap1: cells("cap1", 40),
    fc1: cells("fc1", 40), bag1: cells("bag1", 40), sn1: cells("sn1", 40), sl1: cells("sl1", 40), ds1: cells("ds1", 40) },
};
const TARGETS = { hub2: { tee2: { S: { target: 4, minQty: 2 }, M: { target: 4, minQty: 2, reorderPoint: 1 } } } };

// The Sneakers group, in its LIVE shape: seven members, per-size, disarmed.
const SNEAKERS_MEMBERS = ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"];
const GROUP_POLICY = { perSize: true, hub2: { sizes: {
  "5_5": { target: 2, minQty: 1, reorderPoint: 0 }, 7: { target: 3, minQty: 2, reorderPoint: 0 }, 8: { target: 2, minQty: 1, reorderPoint: 0 },
} } };
function cfg({ armed = false, groups = true, categoryPolicy, footwearTargets } = {}) {
  const c = {
    mode: { hub2: "live", "marathon-pe": "live" }, routes: { hub2: "central", "marathon-pe": "hub2" },
    ruleBasedTargets: true, maxIntentsPerRun: 200, maxUnitsPerIntent: 20,
    defaultRunByStore: { hub2: { S: 2, M: 3, L: 3, XL: 2 }, "marathon-pe": { S: 1, M: 2, L: 2, XL: 1 } },
    footwearRunByLocation: { hub2: { "5_5": 1, 7: 2, 8: 2 } },
    categoryPolicy: categoryPolicy || {
      hoodies: { perSize: true, hub2: { target: 5, minQty: 2 } },
      "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
      "fitted-caps": { perSize: true, hub2: { sizes: { 56: { target: 3, minQty: 1 }, 57: { target: 2, minQty: 1 } } } },
    },
  };
  if (groups) c.policyGroups = { "footwear-all": { label: "Sneakers", memberCategoryKeys: SNEAKERS_MEMBERS, armed, policy: GROUP_POLICY } };
  if (footwearTargets !== undefined) c.footwearTargets = footwearTargets;
  return c;
}
const ctx = (config, targets = TARGETS) => ({ targets, config, products: PRODUCTS, stock: STOCK });
const plan = (config, targets = TARGETS) => computeRefillPlan({
  nowMs: NOW, config, targets, stock: STOCK, products: PRODUCTS,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {},
});

// Every destination × product × declared size, resolved, in a fixed order.
function resolveAll(config, { only } = {}) {
  const out = [];
  for (const dest of DESTS) {
    for (const pid of Object.keys(PRODUCTS).sort()) {
      if (only && !only(PRODUCTS[pid])) continue;
      for (const size of PRODUCTS[pid].sizes) out.push([dest, pid, size, resolveTarget(ctx(config), dest, pid, size)]);
    }
  }
  return out;
}
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const isClothingP = (p) => p.productType === "clothing";

// ═══ THE GOLDEN HASH ═════════════════════════════════════════════════════════
// Computed on main at 58cec17 (before this branch touched anything) and pinned.
// If this fails, SOMETHING a cell resolves to has changed. Find out what before
// touching the literal — the per-cell list is printed on failure.
const GOLDEN_ALL = "5c11c62b8cdd3707";
const GOLDEN_CLOTHING = "0b4081573f68b81c";
const GOLDEN_PLAN = "2ecc217d624c8d20";

test("GOLDEN — every cell in the fixed world resolves exactly as it did on main", () => {
  const all = resolveAll(cfg());
  const clothing = resolveAll(cfg(), { only: isClothingP });
  const intents = plan(cfg()).intents.map((i) => ({ dest: i.dest, pid: i.productId, size: i.size, qty: i.qty, priority: i.priority }));
  const got = { all: hash(all), clothing: hash(clothing), plan: hash(intents) };
  const want = { all: GOLDEN_ALL, clothing: GOLDEN_CLOTHING, plan: GOLDEN_PLAN };
  assert.deepEqual(got, want, `resolution moved. got ${JSON.stringify(got)}\n${JSON.stringify(all)}\n${JSON.stringify(intents)}`);
});

// A few of the golden cells, spelled out, so a future reader can see what the
// hash is a hash OF without recomputing it.
test("GOLDEN — spelled out: rule, explicit row, uniform one-size, uniform per-size, per-size map, disarmed group", () => {
  const c = cfg();
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "tee1", "S"), { target: 2, minQty: 1, reorderPoint: null, source: "default" });
  assert.deepEqual(resolveTarget(ctx(c), "marathon-pe", "tee1", "XL"), { target: 1, minQty: 1, reorderPoint: null, source: "default" });
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "tee2", "M"), { target: 4, minQty: 2, reorderPoint: 1, source: "explicit" });
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "cap1", "_"), { target: 10, minQty: 5, reorderPoint: 2, source: "category_policy" });
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "hood1", "L"), { target: 5, minQty: 2, reorderPoint: null, source: "category_policy" });
  assert.deepEqual(resolveTarget(ctx(c), "hub2", "fc1", "56"), { target: 3, minQty: 1, reorderPoint: null, source: "category_policy" });
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7"), null, "disarmed group: footwear resolves nothing");
});

// ═══ 1. A DISARMED SNEAKERS GROUP PRODUCES ZERO INTENTS ══════════════════════
test("1. A DISARMED SNEAKERS GROUP — live shape, seven members — PRODUCES ZERO INTENTS", () => {
  const p = plan(cfg({ armed: false }));
  const footwear = p.intents.filter((i) => ["sn1", "sl1", "ds1"].includes(i.productId));
  assert.equal(footwear.length, 0, "not one footwear intent while the group is disarmed");
  for (const pid of ["sn1", "sl1", "ds1"]) {
    for (const s of PRODUCTS[pid].sizes) assert.equal(resolveTarget(ctx(cfg()), "hub2", pid, s), null, `${pid} ${s}`);
  }
});

test("1b. the disarmed group is INVISIBLE — the plan is identical with the group deleted, under both footwear switch states", () => {
  for (const footwearTargets of [undefined, true]) {
    const withGroup = plan(cfg({ armed: false, footwearTargets }));
    const noGroup = plan(cfg({ armed: false, groups: false, footwearTargets }));
    assert.deepEqual(withGroup.intents, noGroup.intents, `footwearTargets=${footwearTargets}`);
  }
});

test("1c. …and ARMING it is what produces intents — so 1 tests the switch, not a dead branch", () => {
  const p = plan(cfg({ armed: true }));
  assert.ok(p.intents.some((i) => i.productId === "sn1" && i.size === "7"), "an armed group asks");
  assert.ok(p.intents.some((i) => i.productId === "sn1" && i.size === "5.5"), "the half size too, keyed 5_5 in the map");
});

// ═══ 2. CLOTHING RESOLUTION IS UNCHANGED BY GROUPS AND PER-SIZE MAPS ═════════
test("2. CLOTHING — byte-identical with the group present, armed, absent, and with a per-size map added elsewhere", () => {
  const base = resolveAll(cfg({ groups: false }), { only: isClothingP });
  assert.equal(hash(base), GOLDEN_CLOTHING, "the no-group clothing result IS the golden clothing result");
  assert.deepEqual(resolveAll(cfg({ armed: false }), { only: isClothingP }), base, "disarmed group present");
  assert.deepEqual(resolveAll(cfg({ armed: true }), { only: isClothingP }), base, "ARMED group present");
  const plus = cfg();
  plus.categoryPolicy = { ...plus.categoryPolicy, belts: { perSize: true, hub2: { sizes: { S: { target: 9, minQty: 1 } } } } };
  assert.deepEqual(resolveAll(plus, { only: isClothingP }), base, "a per-size map on an unrelated category");
});

// ═══ 3. AN EXISTING SCALAR POLICY RESOLVES IDENTICALLY ═══════════════════════
test("3. SCALAR — a uniform entry resolves the same whether or not groups / per-size maps exist anywhere", () => {
  const want = { target: 5, minQty: 2, reorderPoint: null, source: "category_policy" };
  const only = { hoodies: { perSize: true, hub2: { target: 5, minQty: 2 } } };
  assert.deepEqual(resolveTarget(ctx(cfg({ groups: false, categoryPolicy: only })), "hub2", "hood1", "M"), want);
  assert.deepEqual(resolveTarget(ctx(cfg({ armed: true })), "hub2", "hood1", "M"), want);
  assert.deepEqual(resolveTarget(ctx(cfg()), "hub2", "hood1", "M"), want);
  // one-size scalar too
  const cap = { target: 10, minQty: 5, reorderPoint: 2, source: "category_policy" };
  assert.deepEqual(resolveTarget(ctx(cfg({ armed: true })), "hub2", "cap1", "_"), cap);
});

// THE CLAIM IS QUALIFIED: identical OVER THE DERIVED RUN. A uniform perSize
// entry answers for every size a product DECLARES; a per-size map answers only
// for the sizes it names, and the server lets it name only the derived run
// (live ∩ registry). A declared size OUTSIDE the registry's run — the 1,246
// sneakers with garment letters, measured live — is answered by the uniform
// entry and falls through past a map. The screen says so in one line when a
// location is switched to size by size. (Adversarial review, PR #405.)
test('3b. SCALAR ≡ "same for every size" OVER THE DERIVED RUN — a map naming every declared size with the uniform numbers is indistinguishable', () => {
  const uniform = cfg({ groups: false, categoryPolicy: { hoodies: { perSize: true, hub2: { target: 5, minQty: 2, reorderPoint: 1 } } } });
  const filled = cfg({ groups: false, categoryPolicy: { hoodies: { perSize: true,
    hub2: { sizes: fillAllSizes(PRODUCTS.hood1.sizes, { target: 5, minQty: 2, reorderPoint: 1 }) } } } });
  for (const dest of DESTS) {
    for (const s of PRODUCTS.hood1.sizes) {
      assert.deepEqual(resolveTarget(ctx(filled), dest, "hood1", s), resolveTarget(ctx(uniform), dest, "hood1", s), `${dest} ${s}`);
    }
  }
  assert.deepEqual(plan(filled).intents, plan(uniform).intents, "and the plan is the same plan");
});

test("3c. …and a declared size OUTSIDE the run is where they differ: the uniform entry answers it, a map cannot name it", () => {
  const products = { ...PRODUCTS, hood1: { ...PRODUCTS.hood1, sizes: ["S", "M", "L", "XL"] } };   // XL declared, not in the map
  const stock = { ...STOCK, central: { ...STOCK.central, hood1: { S: { qty: 40 }, M: { qty: 40 }, L: { qty: 40 }, XL: { qty: 40 } } } };
  const uniform = cfg({ groups: false, categoryPolicy: { hoodies: { perSize: true, hub2: { target: 5, minQty: 2 } } } });
  const filled = cfg({ groups: false, categoryPolicy: { hoodies: { perSize: true, hub2: { sizes: fillAllSizes(["S", "M", "L"], { target: 5, minQty: 2 }) } } } });
  const c = (config) => ({ targets: TARGETS, config, products, stock });
  assert.equal(resolveTarget(c(uniform), "hub2", "hood1", "XL")?.target, 5, "uniform answers XL with the map's 5");
  // The map does NOT answer XL — and the cell does not go silent: it falls
  // through to the clothing RULE (defaultRunByStore hub2 XL = 2), which is
  // not necessarily the conservative direction. That is why the screen says so.
  const xl = resolveTarget(c(filled), "hub2", "hood1", "XL");
  assert.equal(xl.source, "default", "falls through past the map to the rule");
  assert.equal(xl.target, 2);
});

// ═══ 4. A PER-SIZE POLICY RESOLVES PER SIZE ══════════════════════════════════
test("4. PER-SIZE — each named size gets ITS OWN numbers; an unnamed size resolves nothing from the map", () => {
  const c = cfg();
  assert.equal(resolveTarget(ctx(c), "hub2", "fc1", "56").target, 3);
  assert.equal(resolveTarget(ctx(c), "hub2", "fc1", "57").target, 2);
  assert.equal(resolveTarget(ctx(c), "hub2", "fc1", "58"), null, "58 is not in the map and fitted caps have no letter run");
  // the group's map, armed: three sizes, three different answers
  const a = cfg({ armed: true });
  assert.equal(resolveTarget(ctx(a), "hub2", "sn1", "7").target, 3);
  assert.equal(resolveTarget(ctx(a), "hub2", "sn1", "8").target, 2);
  assert.equal(resolveTarget(ctx(a), "hub2", "sn1", "5.5").target, 2);
  assert.equal(resolveTarget(ctx(a), "hub2", "sn1", "9"), null, "9 is not named");
});

// ═══ 5. A MEMBER'S OWN NUMBERS BEAT THE GROUP'S ══════════════════════════════
test("5. OWN BEATS GROUP — entirely: at a location the own entry omits, the group is NOT consulted", () => {
  const c = cfg({ armed: true });
  c.categoryPolicy = { ...c.categoryPolicy, slides: { perSize: true, hub2: { target: 9, minQty: 1 } } };
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "7").target, 9, "own numbers at hub2");
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7").target, 3, "the other member still takes the group's");
  // slides' own entry names hub2 only; the group names hub2 only too — so add a
  // group location the own entry omits and prove it is not used.
  const d = cfg({ armed: true });
  d.policyGroups["footwear-all"].policy = { ...GROUP_POLICY, "marathon-pe": { sizes: { 7: { target: 4, minQty: 1 } } } };
  d.categoryPolicy = { ...d.categoryPolicy, sneakers: { perSize: true, hub2: { target: 6, minQty: 1 } } };
  assert.equal(resolveTarget(ctx(d), "hub2", "sn1", "7").target, 6);
  assert.equal(resolveTarget(ctx(d), "marathon-pe", "sn1", "7"), null, "own entry omits marathon-pe → nothing, not the group's 4");
  assert.equal(resolveTarget(ctx(d), "marathon-pe", "sl1", "7")?.target, 4, "a member WITHOUT its own entry still takes the group's at marathon-pe");
});

test("5b. OWN BEATS GROUP — a GARBLED own entry arms nothing and consults no group (the unsafe direction is closed)", () => {
  const c = cfg({ armed: true });
  c.categoryPolicy = { ...c.categoryPolicy, slides: "garbage" };
  assert.equal(resolveTarget(ctx(c), "hub2", "sl1", "7"), null, "present-but-unreadable own entry: nothing, not the group's 3");
  assert.equal(resolveTarget(ctx(c), "hub2", "sn1", "7").target, 3, "the other member is unaffected");
});

// ═══ THE GROUP'S SIZE RUN — THE UNION, WITH PARTIAL SIZES MARKED ═════════════
test("sizeRunForGroup — the union of the members' derived runs, sizes only some carry marked, empty members listed", () => {
  const taxonomy = { cats: {
    sneakers: { sizeMode: "list", sizes: ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"] },
    slides: { sizeMode: "list", sizes: ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"] },
    "designer-shoes": { sizeMode: "list", sizes: ["3", "4", "5", "6", "7", "8", "9", "10", "11"] },
    boots: { sizeMode: "list", sizes: ["3", "4", "5"] },
  } };
  const products = {
    a: { categoryKey: "sneakers", sizes: ["5.5", "7", "12", "13", "XL"] },
    b: { categoryKey: "slides", sizes: ["5.5", "7"] },
    c: { categoryKey: "designer-shoes", sizes: ["7", "8"] },
  };
  const stock = { hub2: { a: { "5_5": { qty: 1 }, 7: { qty: 0 }, 12: { qty: 0 }, 13: { qty: 0 } } } };
  const r = sizeRunForGroup({ products, stock, targets: {}, taxonomy, memberCategoryKeys: ["boots", "designer-shoes", "slides", "sneakers"], locations: ["hub2"] });
  assert.deepEqual(r.sizes, ["5_5", "7", "8", "12", "13"], "the union, sorted, 5.5 stored as 5_5, the stray XL never enters");
  assert.deepEqual(r.membersWithRun, ["designer-shoes", "slides", "sneakers"], "boots has no products and no run");
  assert.equal(r.byMember.boots.empty, true);
  assert.deepEqual(r.partial, ["5_5", "8", "12", "13"], "7 is the only size every member with a run carries");
  assert.deepEqual(r.carriedBy["5_5"], ["slides", "sneakers"]);
  assert.equal(r.overStop, false);
  assert.equal(r.empty, false);
});

test("sizeRunForGroup — a union over the stop is flagged, never trimmed", () => {
  const sizes = Array.from({ length: MAX_GROUP_UNION + 1 }, (_, i) => String(30 + i));
  const taxonomy = { cats: { x: { sizeMode: "list", sizes } } };
  const products = { p: { categoryKey: "x", sizes } };
  const stock = { hub2: { p: Object.fromEntries(sizes.map((s) => [s, { qty: 0 }])) } };
  const r = sizeRunForGroup({ products, stock, targets: {}, taxonomy, memberCategoryKeys: ["x"], locations: ["hub2"] });
  assert.equal(r.sizes.length, MAX_GROUP_UNION + 1);
  assert.equal(r.overStop, true);
});

test("sizeRunForGroup — members with no products produce an EMPTY run, not a guessed one", () => {
  const r = sizeRunForGroup({ products: {}, stock: {}, targets: {}, taxonomy: { cats: { boots: { sizes: ["3"] } } },
    memberCategoryKeys: ["boots"], locations: ["hub2"] });
  assert.equal(r.empty, true);
  assert.deepEqual(r.sizes, []);
});
