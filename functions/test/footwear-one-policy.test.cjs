// ─── ONE FOOTWEAR POLICY — THE PROPERTIES ─────────────────────────────────────
//
// Junid, 24 Sep 2026: every footwear product at Hub 1 and Hub 2 is governed by
// ONE footwear policy with his standing run, and no footwear category can carry
// its own drifted copy of the numbers again. The design: the footwear-all group,
// armed, holding all eight categories (policy-resolve.cjs, the ONE FOOTWEAR
// POLICY note). What this file pins, through the engine's own exports:
//
//   1. ALL EIGHT categories resolve IDENTICAL targets for sizes 3–13, at both
//      hubs, and those targets are the standing run.
//   2. An explicit product row still wins (a 0 and a 5).
//   3. A (product, hub) pair with no stock cell never gains a target, and the
//      plan raises no intent for it — HOW MANY, never WHERE.
//   4. Kids labels outside the run (26–33) stay unarmed.
//   5. The drift check names every way footwear can stop being one policy.
//   6. The write path refuses a footwear category its own numbers while the
//      policy is armed — and a genuine revert still goes through.
//
// The browser mirror answers the same world in
// src/components/stock/footwearOnePolicy.parity.test.js. The carried-only and
// parity tests are mutation-proved by scripts/mutation-proof-footwear-one-policy.mjs.
//
// Run: cd functions && node --test test/footwear-one-policy.test.cjs

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTarget, computeRefillPlan } = require("../lib/refill-engine.cjs");
const { footwearPolicyDrift, FOOTWEAR_CATEGORY_KEYS, FOOTWEAR_GROUP_KEY } = require("../lib/policy-resolve.cjs");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const W = require("./helpers/footwear-world.cjs");

const NOW = Date.parse("2026-09-24T09:00:00.000Z");
const ctxOf = (w) => ({ targets: w.targets, config: w.config, products: w.products, stock: w.stock });
const plan = (w) => computeRefillPlan({
  nowMs: NOW, config: w.config, targets: w.targets, stock: w.stock, products: w.products,
  openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {},
});

// ── 1. ONE ANSWER FOR ALL EIGHT ──────────────────────────────────────────────
test("the footwear key list is the eight categories, Soccer Boots and Designer Shoes included", () => {
  assert.deepEqual([...FOOTWEAR_CATEGORY_KEYS].sort(), [...W.FOOTWEAR_KEYS].sort());
  assert.equal(FOOTWEAR_GROUP_KEY, "footwear-all");
});

test("all eight categories resolve IDENTICAL targets for sizes 3–13 at both hubs — the standing run", () => {
  const w = W.world();
  const ctx = ctxOf(w);
  for (const hub of ["hub1", "hub2"]) {
    for (const size of W.RUN_SIZES) {
      const answers = W.FOOTWEAR_KEYS.map((k) => resolveTarget(ctx, hub, `p-${k}`, size));
      const want = W.STANDING[W.enc(size)];
      for (const [i, t] of answers.entries()) {
        assert.deepEqual(t, { target: want, minQty: Math.ceil(want / 2), reorderPoint: 1, source: "category_policy" },
          `${W.FOOTWEAR_KEYS[i]} at ${hub} size ${size}`);
      }
    }
  }
});

test("Hub 1 and Hub 2 answer the same for every category and size", () => {
  const ctx = ctxOf(W.world());
  for (const k of W.FOOTWEAR_KEYS) for (const s of W.RUN_SIZES) {
    assert.deepEqual(resolveTarget(ctx, "hub1", `p-${k}`, s), resolveTarget(ctx, "hub2", `p-${k}`, s), `${k} ${s}`);
  }
});

test("a size the run does not name stays UNARMED (no target, not a 0)", () => {
  const w = W.world();
  w.products["p-boots"].sizes.push("14");
  w.stock.hub1["p-boots"]["14"] = { qty: 1 };
  assert.equal(resolveTarget(ctxOf(w), "hub1", "p-boots", "14"), null);
});

test("an own entry SHADOWS the group completely — why the write path refuses one", () => {
  const w = W.world();
  w.config.categoryPolicy = { boots: { perSize: true, hub1: { sizes: { 6: { target: 9, minQty: 1, reorderPoint: 1 } }, carriedOnly: true } } };
  const ctx = ctxOf(w);
  assert.equal(resolveTarget(ctx, "hub1", "p-boots", "6").target, 9);
  assert.equal(resolveTarget(ctx, "hub1", "p-boots", "12"), null, "the group's 12 no longer reaches boots");
  assert.equal(resolveTarget(ctx, "hub1", "p-sneakers", "12").target, 2);
});

// ── 2. EXPLICIT ROWS STILL WIN ───────────────────────────────────────────────
test("an explicit product row outranks the footwear policy — a 0 and a 5", () => {
  const ctx = ctxOf(W.world());
  assert.deepEqual(resolveTarget(ctx, "hub1", "ruled", "6"), { target: 0, minQty: 0, reorderPoint: null, source: "explicit" });
  assert.equal(resolveTarget(ctx, "hub1", "ruled", "7").target, 5);
  assert.equal(resolveTarget(ctx, "hub1", "ruled", "7").source, "explicit");
  assert.equal(resolveTarget(ctx, "hub1", "ruled", "8").source, "category_policy", "a size with no row follows the policy");
});

// ── 3. HOW MANY, NEVER WHERE ─────────────────────────────────────────────────
test("a (product, hub) pair with no stock cell never gains a target", () => {
  const ctx = ctxOf(W.world());
  for (const s of ["6", "7", "12"]) {
    assert.equal(resolveTarget(ctx, "hub1", "uncarried", s), null, `hub1 size ${s}`);
    assert.equal(resolveTarget(ctx, "hub2", "uncarried", s)?.source, "category_policy", `hub2 carries it, size ${s}`);
  }
});

test("…and the plan raises no intent for it, while the carried hub does ask", () => {
  const w = W.world();
  w.stock.hub2.uncarried = { 6: { qty: 0 }, 7: { qty: 0 }, 12: { qty: 0 } };
  const p = plan(w);
  assert.equal(p.intents.filter((i) => i.productId === "uncarried" && i.dest === "hub1").length, 0);
  assert.ok(p.intents.some((i) => i.productId === "uncarried" && i.dest === "hub2"), "control: the carried hub is asked");
});

test("arming nothing outside the carried set: every intent in the plan sits on a pair that holds a cell", () => {
  const w = W.world();
  for (const pid of Object.keys(w.stock.hub1)) for (const k of Object.keys(w.stock.hub1[pid])) w.stock.hub1[pid][k] = { qty: 0 };
  const p = plan(w);
  assert.ok(p.intents.length > 0, "control: the plan asks for something");
  for (const i of p.intents) assert.ok(w.stock[i.dest]?.[i.productId], `${i.productId} at ${i.dest} has no cell`);
});

// ── 4. KIDS LABELS ───────────────────────────────────────────────────────────
test("kids shoes on 26–33 labels stay unarmed at both hubs — no kids numbers are invented", () => {
  const ctx = ctxOf(W.world());
  for (const hub of ["hub1", "hub2"]) for (const s of ["26", "27", "28", "29", "30", "31", "32", "33"]) {
    assert.equal(resolveTarget(ctx, hub, "kids", s), null, `${hub} ${s}`);
  }
});

test("a kids shoe on an adult label the run names IS governed like every other footwear", () => {
  const w = W.world();
  w.products.kids.sizes.push("5");
  w.stock.hub1.kids["5"] = { qty: 1 };
  w.stock.central.kids["5"] = { qty: 5 };
  assert.equal(resolveTarget(ctxOf(w), "hub1", "kids", "5").target, 2);
});

// ── 5. DRIFT ─────────────────────────────────────────────────────────────────
const kinds = (cfg) => footwearPolicyDrift(cfg).map((d) => `${d.kind}${d.key ? ":" + d.key : ""}${d.loc ? "@" + d.loc : ""}`).sort();

test("drift: the standing shape is clean", () => {
  assert.deepEqual(footwearPolicyDrift(W.world().config), []);
});

test("drift: every structural way out of one policy is named", () => {
  const base = () => W.world().config;
  assert.deepEqual(kinds({ ...base(), policyGroups: {} }), ["group_missing"]);
  assert.deepEqual(kinds({ ...base(), policyGroups: { [FOOTWEAR_GROUP_KEY]: W.footwearGroup({ armed: false }) } }), ["group_disarmed"]);
  assert.deepEqual(kinds({ ...base(), categoryPolicy: { boots: { perSize: true, hub1: W.standingLeg() } } }), ["own_entry:boots"]);
  assert.deepEqual(kinds({ ...base(), policyGroups: { [FOOTWEAR_GROUP_KEY]: W.footwearGroup({ memberCategoryKeys: W.FOOTWEAR_KEYS.filter((k) => k !== "soccer-boots") }) } }),
    ["member_missing:soccer-boots"]);
  const differ = W.footwearGroup();
  differ.policy.hub2.sizes["7"] = { target: 2, minQty: 1, reorderPoint: 1 };
  assert.deepEqual(kinds({ ...base(), policyGroups: { [FOOTWEAR_GROUP_KEY]: differ } }), ["hub_legs_differ"]);
  const noHub2 = W.footwearGroup();
  delete noHub2.policy.hub2;
  assert.deepEqual(kinds({ ...base(), policyGroups: { [FOOTWEAR_GROUP_KEY]: noHub2 } }), ["hub_legs_differ", "hub_not_armed@hub2"]);
  const extra = W.footwearGroup();
  extra.policy.central = W.standingLeg();
  assert.deepEqual(kinds({ ...base(), policyGroups: { [FOOTWEAR_GROUP_KEY]: extra } }), ["extra_location@central"]);
  assert.deepEqual(kinds({ ...base(), footwearTargets: { hub1: true } }), ["footwear_rule_on@hub1"]);
  assert.deepEqual(kinds({ ...base(), policyGroups: { ...base().policyGroups, other: { label: "x", armed: true, memberCategoryKeys: ["slides"], policy: { hub2: { target: 1, minQty: 1 } } } } }),
    ["other_group:slides"]);
});

test("drift: key order in a stored leg is not drift", () => {
  const g = W.footwearGroup();
  const reordered = {};
  for (const k of Object.keys(g.policy.hub2.sizes).reverse()) {
    const r = g.policy.hub2.sizes[k];
    reordered[k] = { reorderPoint: r.reorderPoint, minQty: r.minQty, target: r.target };
  }
  g.policy.hub2 = { carriedOnly: true, sizes: reordered };
  assert.deepEqual(kinds({ ...W.world().config, policyGroups: { [FOOTWEAR_GROUP_KEY]: g } }), []);
});

test("drift reaches the scan's Health snapshot", () => {
  const w = W.world();
  w.config.categoryPolicy = { slides: { perSize: true, hub1: W.standingLeg() } };
  const p = plan(w);
  assert.equal(p.exceptions.footwearPolicyDrift.count, 1);
  assert.equal(p.exceptions.footwearPolicyDrift.items[0].kind, "own_entry");
  assert.equal(plan(W.world()).exceptions.footwearPolicyDrift.count, 0);
});

// ── 6. THE WRITE PATH ────────────────────────────────────────────────────────
const OWNER = "gunidmoh@gmail.com";
function dbWorld({ armed = true, own = {} } = {}) {
  const w = W.world();
  const cats = {};
  for (const k of W.FOOTWEAR_KEYS) cats[k] = { key: k, label: k, sizeMode: "list", top: "footwear", sizes: W.RUN_SIZES };
  cats.perfumes = { key: "perfumes", label: "Perfumes", sizeMode: "one", top: "beauty", sizes: ["_"] };
  return makeFakeDb({
    config: { refillEngine: { ...w.config, categoryPolicy: own, policyGroups: { [FOOTWEAR_GROUP_KEY]: W.footwearGroup({ armed }) } } },
    settings: { productTaxonomy: { cats } },
    locations: { central: { kind: "hub" }, hub1: { kind: "hub" }, hub2: { kind: "hub" } },
    products: w.products, stock: w.stock, stock_targets: w.targets,
  });
}
const call = (db, data) => applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", data, nowMs: NOW });
async function rejects(fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, "expected a refusal");
  assert.match(String(err.message), re);
  return err;
}
const OWN = { perSize: true, hub1: { sizes: { 6: { target: 9, minQty: 5, reorderPoint: 1 } } } };

test("write: a footwear category cannot get its own numbers while the footwear policy is armed", async () => {
  invalidateCensusCache();
  const db = dbWorld();
  await rejects(() => call(db, { categoryKey: "boots", policy: OWN }), /Footwear is set once/);
  await rejects(() => call(db, { categoryKey: "boots", policy: OWN, dryRun: true }), /Footwear is set once/);
  assert.equal(readAt(db.state.root, "config/refillEngine/categoryPolicy/boots"), null);
});

test("write: a non-footwear category is untouched by the rule", async () => {
  invalidateCensusCache();
  const db = dbWorld();
  const res = await call(db, { categoryKey: "perfumes", policy: { hub2: { target: 5, minQty: 2 } } });
  assert.equal(res.ok, true);
});

test("write: deleting a stray own entry is always allowed", async () => {
  invalidateCensusCache();
  const db = dbWorld({ own: { slides: { perSize: true, hub1: { sizes: { 6: { target: 3, minQty: 2, reorderPoint: 1 } }, carriedOnly: true } } } });
  const res = await call(db, { categoryKey: "slides", policy: null });
  assert.equal(res.ok, true);
  assert.equal(readAt(db.state.root, "config/refillEngine/categoryPolicy/slides"), null);
});

test("write: with the footwear policy DISARMED an own entry is allowed — the emergency brake", async () => {
  invalidateCensusCache();
  const db = dbWorld({ armed: false });
  const res = await call(db, { categoryKey: "boots", policy: { perSize: true, hub1: { sizes: { 6: { target: 3, minQty: 2, reorderPoint: 1 } } } } });
  assert.equal(res.ok, true);
});

test("write: a GENUINE revert of a deletion goes through; a borrowed id does not", async () => {
  invalidateCensusCache();
  const leg = { perSize: true, hub1: { sizes: { 6: { target: 3, minQty: 2, reorderPoint: 1 } }, carriedOnly: true } };
  const db = dbWorld({ own: { slides: leg } });
  const del = await call(db, { categoryKey: "slides", policy: null });
  // A borrowed id: a real entry, but for a different key.
  const other = await call(db, { categoryKey: "perfumes", policy: { hub2: { target: 5, minQty: 2 } } });
  assert.ok(other.historyId);
  await rejects(() => call(db, { categoryKey: "slides", policy: leg, revertOf: other.historyId }), /Footwear is set once/);
  await rejects(() => call(db, { categoryKey: "slides", policy: leg, revertOf: "-nope" }), /Footwear is set once/);
  // Right id, different numbers: not a revert.
  await rejects(() => call(db, { categoryKey: "slides", policy: { perSize: true, hub1: { sizes: { 6: { target: 9, minQty: 2, reorderPoint: 1 } }, carriedOnly: true } }, revertOf: del.historyId }), /Footwear is set once/);
  const res = await call(db, { categoryKey: "slides", policy: leg, expectedBefore: null, revertOf: del.historyId });
  assert.equal(res.ok, true);
  assert.ok(readAt(db.state.root, "config/refillEngine/categoryPolicy/slides"));
});

test("write: an armed footwear policy cannot drop one of the eight; disarming it can", async () => {
  invalidateCensusCache();
  const db = dbWorld();
  const g = readAt(db.state.root, `config/refillEngine/policyGroups/${FOOTWEAR_GROUP_KEY}`);
  await rejects(() => call(db, { action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY,
    group: { ...g, memberCategoryKeys: g.memberCategoryKeys.filter((k) => k !== "designer-shoes") } }), /cannot be left out/);
  const res = await call(db, { action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group: { ...g, armed: false } });
  assert.equal(res.ok, true);
});

// ── 7. THE CARD'S CENSUS CARRIES THE DRIFT ───────────────────────────────────
test("census: clean footwear has no drift; an own entry badges that category AND the Footwear entry", async () => {
  invalidateCensusCache();
  const clean = await call(dbWorld(), { action: "census", refresh: true });
  assert.deepEqual(clean.footwearDrift, []);
  const fw = clean.groupEntries.find((g) => g.groupKey === FOOTWEAR_GROUP_KEY);
  assert.equal(fw.footwearPolicy, true);
  assert.deepEqual(fw.footwearDrift, []);
  assert.equal(clean.categories.find((c) => c.key === "boots").footwearMember, true);
  assert.equal(clean.categories.find((c) => c.key === "perfumes").footwearMember, false);

  invalidateCensusCache();
  const drifted = await call(dbWorld({ own: { boots: { perSize: true, hub1: W.standingLeg() } } }), { action: "census", refresh: true });
  assert.deepEqual(drifted.footwearDrift.map((d) => d.kind), ["own_entry"]);
  assert.equal(drifted.categories.find((c) => c.key === "boots").footwearDrift.length, 1);
  assert.equal(drifted.categories.find((c) => c.key === "sneakers").footwearDrift.length, 0);
  assert.equal(drifted.groupEntries.find((g) => g.groupKey === FOOTWEAR_GROUP_KEY).footwearDrift.length, 1);
});

test("write: a STALE history entry for the same key is not a revert — only the newest change is", async () => {
  invalidateCensusCache();
  // Each write one minute apart: history order is by `at`, as it is live.
  let t = NOW;
  const call = (db, data) => applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", data, nowMs: (t += 60000) });
  const legA = { perSize: true, hub1: { sizes: { 6: { target: 3, minQty: 2, reorderPoint: 1 } }, carriedOnly: true } };
  const legB = { perSize: true, hub1: { sizes: { 6: { target: 7, minQty: 2, reorderPoint: 1 } }, carriedOnly: true } };
  // Disarmed: own entries may be written, building an old deletion E0 of legB.
  const db = dbWorld({ armed: false, own: { slides: legB } });
  const e0 = await call(db, { categoryKey: "slides", policy: null });
  await call(db, { categoryKey: "slides", policy: legA, expectedBefore: null });
  // Re-arm the footwear policy, then delete legA (E1).
  const g = readAt(db.state.root, `config/refillEngine/policyGroups/${FOOTWEAR_GROUP_KEY}`);
  await call(db, { action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group: { ...g, armed: true }, expectedBefore: g });
  const e1 = await call(db, { categoryKey: "slides", policy: null });
  await rejects(() => call(db, { categoryKey: "slides", policy: legB, expectedBefore: null, revertOf: e0.historyId }), /Footwear is set once/);
  const ok = await call(db, { categoryKey: "slides", policy: legA, expectedBefore: null, revertOf: e1.historyId });
  assert.equal(ok.ok, true);
});
