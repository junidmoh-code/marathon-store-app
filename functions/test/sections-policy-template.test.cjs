// ─── HUB AND STORE POLICIES APPLY TO SECTION 1 ───────────────────────────────
// "The same size policy applies to all stores unless a store-specific policy
// already exists." A location with no numbers of its own in a policy map
// follows the location the network registry says it is like: Marathon Pine and
// Concrete → Marathon PE; Hub 3 and the Concrete Stockroom → Hub 2.
//
// Real config and products throughout (fixtures/sections-routing-fixture.json).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const engine = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const { withPolicyTemplates, policyTemplateKey, LOCATION_MAP_KEYS } = require("../lib/policy-template.cjs");
const {
  locationPolicyFor, footwearPolicyDrift, footwearFollowers, FOOTWEAR_GROUP_KEY, FOOTWEAR_POLICY_HUBS,
} = require("../lib/policy-resolve.cjs");

const { computeRefillPlan, resolveTarget } = engine;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/sections-routing-fixture.json"), "utf8"));
const NOW_MS = Date.parse("2026-10-01T10:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const S1 = ["hub3", "marathon-pine", "concrete", "concrete-stockroom"];
const S2 = ["hub1", "hub2", "marathon-pe", "trophy"];
const LIKE = { "marathon-pine": "marathon-pe", concrete: "marathon-pe", hub3: "hub2", "concrete-stockroom": "hub2" };
const SEED = reg.SEED_REGISTRY;
const allLive = reg.normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, { live: true }])) });

// ── the template itself ─────────────────────────────────────────────────────

test("the registry's templates are the four the owner named", () => {
  for (const id of S1) assert.equal(SEED.locations[id].policyLike, LIKE[id], id);
  for (const id of S2) assert.equal(SEED.locations[id].policyLike, undefined, `${id} follows nobody`);
});

test("SECTION 2: every map entry for PE, Trophy, Hub 1 and Hub 2 is the SAME object after templating", () => {
  const cfg = clone(FIXTURE.config);
  const out = withPolicyTemplates(cfg, SEED);
  for (const k of LOCATION_MAP_KEYS) {
    if (!cfg[k] || typeof cfg[k] !== "object") { assert.equal(out[k], cfg[k], k); continue; }
    for (const loc of S2) assert.equal(out[k][loc], cfg[k][loc], `${k}.${loc}`);
  }
  for (const key of Object.keys(cfg.categoryPolicy)) {
    for (const loc of S2) assert.equal(out.categoryPolicy[key][loc], cfg.categoryPolicy[key][loc], `categoryPolicy.${key}.${loc}`);
  }
  for (const gk of Object.keys(cfg.policyGroups)) {
    for (const loc of S2) assert.equal(out.policyGroups[gk].policy[loc], cfg.policyGroups[gk].policy[loc], `${gk}.${loc}`);
    assert.deepEqual(out.policyGroups[gk].memberCategoryKeys, cfg.policyGroups[gk].memberCategoryKeys);
    assert.equal(out.policyGroups[gk].armed, cfg.policyGroups[gk].armed);
  }
  // …and the config handed in is never written to.
  assert.deepEqual(cfg, FIXTURE.config);
});

test("SECTION 2: every cell resolves the same target from the raw config and the templated one", () => {
  const raw = clone(FIXTURE.config);
  const tpl = withPolicyTemplates(raw, SEED);
  let cells = 0, resolved = 0;
  for (const loc of S2) {
    for (const [pid, p] of Object.entries(FIXTURE.products)) {
      for (const size of [...(p.sizes || []).map(String), "_"]) {
        const a = resolveTarget({ targets: FIXTURE.targets, config: raw, products: FIXTURE.products, stock: FIXTURE.stock }, loc, pid, size);
        const b = resolveTarget({ targets: FIXTURE.targets, config: tpl, products: FIXTURE.products, stock: FIXTURE.stock }, loc, pid, size);
        assert.deepEqual(b, a, `${loc}/${pid}/${size}`);
        cells += 1; if (a) resolved += 1;
      }
    }
  }
  assert.ok(cells > 2000 && resolved > 500, `${resolved}/${cells} — the sweep would prove nothing`);
});

test("a location with no numbers of its own gets its template's entry, map by map", () => {
  const cfg = clone(FIXTURE.config);
  const out = withPolicyTemplates(cfg, SEED);
  assert.equal(out.defaultRunByStore["marathon-pine"], cfg.defaultRunByStore["marathon-pe"]);
  assert.equal(out.defaultRunByStore.concrete, cfg.defaultRunByStore["marathon-pe"]);
  assert.equal(out.defaultRunByStore.hub3, cfg.defaultRunByStore.hub2);
  assert.equal(out.defaultRunByStore["concrete-stockroom"], cfg.defaultRunByStore.hub2);
  for (const k of ["footwearRunByLocation", "subcategoryRunByLocation", "footwearReorderPoint"]) {
    for (const [loc, like] of Object.entries(LIKE)) {
      assert.deepEqual(out[k]?.[loc], cfg[k]?.[like], `${k}.${loc} follows ${like}`);
    }
  }
  // the category policy and the policy group
  for (const key of Object.keys(cfg.categoryPolicy)) {
    for (const [loc, like] of Object.entries(LIKE)) {
      assert.deepEqual(out.categoryPolicy[key][loc], cfg.categoryPolicy[key][like], `categoryPolicy.${key}.${loc}`);
      assert.deepEqual(locationPolicyFor(out, key, loc), locationPolicyFor(cfg, key, like), `${key}@${loc} resolves as ${like}`);
    }
  }
  const g = out.policyGroups[FOOTWEAR_GROUP_KEY].policy;
  assert.equal(g.hub3, cfg.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2);
  assert.equal(g["concrete-stockroom"], cfg.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2);
  assert.deepEqual(locationPolicyFor(out, "sneakers", "hub3"), locationPolicyFor(cfg, "sneakers", "hub2"));
  assert.equal(locationPolicyFor(cfg, "sneakers", "hub3"), null, "the stored config names no Hub 3 — nothing is written");
});

test("a store-specific policy that already exists is never overridden", () => {
  const cfg = {
    defaultRunByStore: { "marathon-pe": { M: 2 }, "marathon-pine": { M: 9 }, hub2: { M: 3 } },
    subcategoryRunByLocation: { "marathon-pe": { Watches: 2 } },
    categoryPolicy: {
      perfumes: { hub2: { target: 8, minQty: 4 }, hub3: { target: 1, minQty: 1 }, "marathon-pe": { target: 2 } },
      belts: { hub2: { target: 5 }, hub3: "not here" },          // present but unusable = Hub 3's own "no"
    },
    policyGroups: { g: { armed: true, memberCategoryKeys: ["bags"], policy: { hub2: { target: 4 }, "concrete-stockroom": { target: 6 } } } },
  };
  const out = withPolicyTemplates(cfg, SEED);
  assert.deepEqual(out.defaultRunByStore["marathon-pine"], { M: 9 }, "Pine's own run stands");
  assert.deepEqual(out.defaultRunByStore.concrete, { M: 2 }, "Concrete has none → Marathon PE's");
  assert.deepEqual(out.categoryPolicy.perfumes.hub3, { target: 1, minQty: 1 });
  assert.deepEqual(out.categoryPolicy.perfumes["concrete-stockroom"], { target: 8, minQty: 4 });
  assert.equal(locationPolicyFor(out, "perfumes", "hub3").target, 1);
  assert.equal(locationPolicyFor(out, "perfumes", "marathon-pine").target, 2);
  assert.equal(out.categoryPolicy.belts.hub3, "not here");
  assert.equal(locationPolicyFor(out, "belts", "hub3"), null, "an unusable own entry arms nothing — it does not fall back to Hub 2");
  assert.equal(locationPolicyFor(out, "belts", "concrete-stockroom").target, 5);
  assert.deepEqual(out.policyGroups.g.policy["concrete-stockroom"], { target: 6 });
  assert.deepEqual(out.policyGroups.g.policy.hub3, { target: 4 });
  assert.equal(policyTemplateKey(SEED, cfg.defaultRunByStore, "marathon-pine"), "marathon-pine");
  assert.equal(policyTemplateKey(SEED, cfg.defaultRunByStore, "concrete"), "marathon-pe");
  assert.equal(policyTemplateKey(SEED, cfg.subcategoryRunByLocation, "hub3"), "hub3", "its template has no entry either → nothing to follow");
});

test("the per-destination switches follow the template only in their map form", () => {
  const on = (cfg, loc) => engine.computeRefillPlan({
    nowMs: NOW_MS, config: { routes: {}, mode: {}, ...cfg }, network: allLive,
    targets: {}, stock: { central: {} }, products: {}, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  }).policy.ruleBasedTargets[loc];
  // a map: Hub 3 follows Hub 2, Pine follows Marathon PE, an own entry wins
  const map = { ruleBasedTargets: { hub2: true, "marathon-pe": false, concrete: true } };
  assert.equal(on(map, "hub3"), true);
  assert.equal(on(map, "concrete-stockroom"), true);
  assert.equal(on(map, "marathon-pine"), false, "Marathon PE is off → Pine is off");
  assert.equal(on(map, "concrete"), true, "Concrete's own entry wins");
  assert.equal(withPolicyTemplates(map, SEED).ruleBasedTargets.hub2, true);
  // true / false / absent already speak for every location — left exactly alone
  for (const v of [true, false, undefined, null, "yes"]) {
    const cfg = { ruleBasedTargets: v, footwearTargets: v };
    const out = withPolicyTemplates(cfg, SEED);
    assert.equal(out.ruleBasedTargets, v);
    assert.equal(out.footwearTargets, v);
  }
  assert.equal(on({ ruleBasedTargets: true }, "hub3"), true);
  assert.equal(on({}, "hub3"), false, "absent = OFF, for a follower too");
});

test("garbage in, the same garbage out — nothing is invented", () => {
  for (const cfg of [null, undefined, "x", 7, []]) assert.equal(withPolicyTemplates(cfg, SEED), cfg);
  const cfg = { defaultRunByStore: "garbage", categoryPolicy: { a: "garbage", b: null }, policyGroups: { g: "garbage", h: { policy: 3 } } };
  assert.deepEqual(withPolicyTemplates(cfg, SEED), cfg);
  // no registry handed in = the seed's templates; a registry with none = untouched
  assert.deepEqual(withPolicyTemplates({ defaultRunByStore: { hub2: { M: 3 } } }, null).defaultRunByStore.hub3, { M: 3 });
  const noTemplates = { locations: { a: { id: "a", type: "hub", section: 1 } }, aliasIndex: { a: "a" } };
  const same = { defaultRunByStore: { hub2: { M: 3 } } };
  assert.equal(withPolicyTemplates(same, noTemplates), same);
});

// ── explicit rows stay first ────────────────────────────────────────────────

test("an explicit /stock_targets row is still the first priority, and is read under the location's own id only", () => {
  const cfg = withPolicyTemplates(clone(FIXTURE.config), SEED);
  // a Pine cell the template arms…
  const pid = Object.keys(FIXTURE.stock["marathon-pine"]).find((id) => (FIXTURE.products[id]?.sizes || []).some((s) =>
    resolveTarget({ targets: {}, config: cfg, products: FIXTURE.products, stock: FIXTURE.stock }, "marathon-pine", id, String(s))?.source === "default"));
  assert.ok(pid, "the fixture has a Pine product the clothing run arms");
  const size = String(FIXTURE.products[pid].sizes.find((s) =>
    resolveTarget({ targets: {}, config: cfg, products: FIXTURE.products, stock: FIXTURE.stock }, "marathon-pine", pid, String(s))));
  const ctx = (targets) => ({ targets, config: cfg, products: FIXTURE.products, stock: FIXTURE.stock });
  assert.equal(resolveTarget(ctx({}), "marathon-pine", pid, size).source, "default");
  // …is overridden by Pine's own row, 0 included…
  assert.deepEqual(resolveTarget(ctx({ "marathon-pine": { [pid]: { [size]: { target: 7, minQty: 3 } } } }), "marathon-pine", pid, size),
    { target: 7, minQty: 3, reorderPoint: null, source: "explicit" });
  assert.equal(resolveTarget(ctx({ "marathon-pine": { [pid]: { [size]: { target: 0, minQty: 0 } } } }), "marathon-pine", pid, size).target, 0);
  // …and Marathon PE's ROW is not Pine's: rows are never templated.
  assert.equal(resolveTarget(ctx({ "marathon-pe": { [pid]: { [size]: { target: 7, minQty: 3 } } } }), "marathon-pine", pid, size).source, "default");
});

// ── through the engine ──────────────────────────────────────────────────────

function world(network, { stockHub3 = true } = {}) {
  const cfg = clone(FIXTURE.config);
  cfg.maxIntentsPerRun = 100000; cfg.maxFootwearIntentsPerRun = 100000;
  const stock = clone(FIXTURE.stock);
  if (stockHub3) stock.hub3 = clone(FIXTURE.stock.hub2);
  return {
    nowMs: NOW_MS, config: cfg, targets: clone(FIXTURE.targets), stock, products: clone(FIXTURE.products),
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], network, uncapped: true,
  };
}

test("ENGINE: Pine, with no rows and no numbers of its own, is kept to Marathon PE's run from Hub 3", () => {
  const snap = world(allLive);
  assert.equal(snap.targets["marathon-pine"], undefined, "Pine has no explicit rows in this world");
  assert.equal(snap.config.defaultRunByStore["marathon-pine"], undefined, "…and no run of its own");
  const plan = computeRefillPlan(snap);
  const pine = plan.intents.filter((i) => i.dest === "marathon-pine");
  assert.ok(pine.length > 0, "the template raised no Pine leg");
  const run = FIXTURE.config.defaultRunByStore["marathon-pe"];
  const tpl = withPolicyTemplates(snap.config, allLive);
  let byRun = 0, byCategory = 0;
  for (const i of pine) {
    assert.equal(i.source, "hub3");
    const have = Math.max(Number(snap.stock["marathon-pine"][i.productId]?.[i.sizeKey]?.qty) || 0, 0);
    const cat = locationPolicyFor(tpl, engine.policyCategoryKey(snap.products[i.productId]), "marathon-pine");
    if (cat) {
      // A category policy that names Marathon PE arms the CATEGORY there —
      // and so, through the template, at Pine: same numbers.
      byCategory += 1;
      assert.deepEqual(cat, locationPolicyFor(snap.config, engine.policyCategoryKey(snap.products[i.productId]), "marathon-pe"));
      continue;
    }
    // The clothing run: only what Pine already carries, to Marathon PE's numbers.
    byRun += 1;
    assert.ok(engine.isClothing(snap.products[i.productId]), `${i.productId} is not clothing`);
    assert.ok(Object.keys(snap.stock["marathon-pine"][i.productId] || {}).length > 0, `${i.productId}: the run arms only what Pine already carries`);
    assert.ok(i.qty <= run[i.size] - have, `${i.productId}/${i.size}: asked ${i.qty}, PE's run is ${run[i.size]}, Pine holds ${have}`);
  }
  assert.ok(byRun > 0, "no leg came from the clothing run");
  // Pine's below-target rows carry Marathon PE's numbers
  for (const b of plan.exceptions.belowTarget.items.filter((r) => r.loc === "marathon-pine")) {
    const cat = locationPolicyFor(tpl, engine.policyCategoryKey(snap.products[b.pid]), "marathon-pine");
    if (cat) continue;
    // A subcategory run (Watches) outranks the size run — and it too is
    // Marathon PE's number, through the template.
    const sub = FIXTURE.config.subcategoryRunByLocation["marathon-pe"][snap.products[b.pid].subcategory];
    assert.equal(b.target, sub !== undefined ? sub : run[b.size], `${b.pid}/${b.size}`);
  }
  // the stored config was not written to
  assert.equal(snap.config.defaultRunByStore["marathon-pine"], undefined);
});

test("ENGINE: Hub 3 follows Hub 2's footwear leg — carried products only — and nothing reports drift", () => {
  const snap = world(allLive, { stockHub3: false });   // Hub 3's own fixture stock, short of the run
  const plan = computeRefillPlan(snap);
  const hub3 = plan.intents.filter((i) => i.dest === "hub3" && !i.passThrough);
  const shoes = hub3.filter((i) => engine.passThroughExcluded(snap.products[i.productId]));
  assert.ok(shoes.length > 0, "no footwear leg into Hub 3");
  const leg = FIXTURE.config.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2;
  for (const i of shoes) {
    assert.equal(i.source, "central");
    assert.ok(snap.stock.hub3[i.productId], `${i.productId}: Hub 2's leg is carriedOnly, and Hub 3 holds no cell for it`);
    assert.ok(leg.sizes[i.sizeKey] && i.qty <= leg.sizes[i.sizeKey].target, `${i.productId}/${i.sizeKey}`);
  }
  assert.deepEqual(plan.exceptions.footwearPolicyDrift, { count: 0, items: [] });
});

test("ENGINE: a category policy that names Hub 2 and Marathon PE governs Hub 3 and Pine with no row", () => {
  const snap = world(allLive);
  const perfume = Object.keys(FIXTURE.products).find((id) => FIXTURE.products[id].categoryKey === "perfumes");
  const entry = FIXTURE.config.categoryPolicy.perfumes;
  const tpl = withPolicyTemplates(snap.config, allLive);
  const ctx = { targets: snap.targets, config: tpl, products: snap.products, stock: snap.stock };
  for (const [loc, like] of Object.entries(LIKE)) {
    assert.deepEqual(resolveTarget(ctx, loc, perfume, ""), entry[like] ? resolveTarget({ ...ctx, targets: {} }, like, perfume, "") : null, `${loc} as ${like}`);
  }
  assert.equal(resolveTarget({ ...ctx, config: snap.config }, "hub3", perfume, ""), null, "without the template Hub 3 has no perfume policy");
});

// ── footwear drift ──────────────────────────────────────────────────────────

const kinds = (cfg, network) => footwearPolicyDrift(cfg, network).map((i) => (i.loc ? `${i.kind}@${i.loc}` : i.key ? `${i.kind}:${i.key}` : i.kind)).sort();

test("DRIFT: the live footwear policy reads clean with and without a registry", () => {
  assert.deepEqual(kinds(FIXTURE.config), []);
  assert.deepEqual(kinds(FIXTURE.config, SEED), []);
  assert.deepEqual(kinds(FIXTURE.config, allLive), []);
  assert.deepEqual(footwearFollowers(SEED), ["concrete-stockroom", "hub3"]);
  assert.deepEqual(footwearFollowers(undefined), []);
  assert.deepEqual([...FOOTWEAR_POLICY_HUBS], ["hub1", "hub2"]);
});

test("DRIFT: Hub 3 and the Concrete Stockroom following Hub 2 — by template or by their own leg — are not drift", () => {
  // by template: the config the engine actually resolves with
  assert.deepEqual(kinds(withPolicyTemplates(clone(FIXTURE.config), SEED), SEED), []);
  // by its own leg (a store-specific policy)
  const own = clone(FIXTURE.config);
  own.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub3 = { sizes: { 7: { target: 1, minQty: 1 } }, carriedOnly: true };
  assert.deepEqual(kinds(own, SEED), []);
  // …but with NO registry the same config is what it always was: an extra location
  assert.deepEqual(kinds(own), ["extra_location@hub3"]);
  assert.deepEqual(kinds(withPolicyTemplates(clone(FIXTURE.config), SEED)), ["extra_location@concrete-stockroom", "extra_location@hub3"]);
});

test("DRIFT: a genuine difference between Hub 1 and Hub 2 is still drift, registry or not", () => {
  for (const network of [undefined, SEED, allLive]) {
    const differ = clone(FIXTURE.config);
    const sizes = differ.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub1.sizes;
    const k = Object.keys(sizes)[0];
    sizes[k] = { ...sizes[k], target: sizes[k].target + 1 };
    assert.deepEqual(kinds(differ, network), ["hub_legs_differ"]);

    const noHub2 = clone(FIXTURE.config);
    delete noHub2.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2;
    assert.deepEqual(kinds(noHub2, network), ["hub_legs_differ", "hub_not_armed@hub2"]);

    // a location that follows NOBODY's footwear leg is still an extra location
    const extra = clone(FIXTURE.config);
    extra.policyGroups[FOOTWEAR_GROUP_KEY].policy.central = clone(extra.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2);
    extra.policyGroups[FOOTWEAR_GROUP_KEY].policy["marathon-pine"] = clone(extra.policyGroups[FOOTWEAR_GROUP_KEY].policy.hub2);
    assert.deepEqual(kinds(extra, network), ["extra_location@central", "extra_location@marathon-pine"]);

    const own = clone(FIXTURE.config);
    own.categoryPolicy.sneakers = { perSize: true, hub1: { target: 2 } };
    assert.deepEqual(kinds(own, network), ["own_entry:sneakers"]);

    const rule = { ...clone(FIXTURE.config), footwearTargets: true };
    assert.deepEqual(kinds(rule, network), ["footwear_rule_on@hub1", "footwear_rule_on@hub2"]);
  }
  // the old footwear rule switched on at a follower BY NAME is reported there
  assert.deepEqual(kinds({ ...clone(FIXTURE.config), footwearTargets: { hub3: true } }, SEED), ["footwear_rule_on@hub3"]);
  assert.deepEqual(kinds({ ...clone(FIXTURE.config), footwearTargets: { hub3: true } }), []);
});
