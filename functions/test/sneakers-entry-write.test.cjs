// ─── THE CALLABLE, FOR A GROUP PRESENTED AS ONE CATEGORY ──────────────────────
// Run: cd functions && node --test test/sneakers-entry-write.test.cjs
//
// The screen no longer has a GROUPS section. The Sneakers policy is one entry
// in the same list as every category, so the census has to hand the card that
// entry — one row, one photo, the members' counts added up, its own armed state
// — and the write path has to accept an edit to it that is per-size.
//
// The properties this file pins:
//
//   • the census emits ONE entry per group, with its members' numbers summed
//     and the members attached;
//   • a member category does NOT also appear as a top-level row (it is marked
//     `memberOfGroup`, and the card leaves it out) — a category listed both
//     beside its group and inside it is the separate section this pass removed;
//   • the group entry reports the DISARMED state honestly: it names the
//     locations its policy holds numbers for, and arms none of them;
//   • a dry run models a DISARMED group and says the number is hypothetical, so
//     the editor can preview before anything is armed;
//   • a per-size write against a size no member carries is refused;
//   • every write still leaves an audit entry, and the cap refusal still fires.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "junidmoh@gmail.com";
const NOW = Date.parse("2026-08-22T09:00:00.000Z");

const GROUP = {
  label: "Sneakers",
  memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"],
  armed: false,
  policy: { perSize: true, hub2: { sizes: { 7: { target: 3, minQty: 2, reorderPoint: 0 } } } },
};

function world(group = GROUP) {
  return {
    config: { refillEngine: {
      maxIntentsPerRun: 75, maxUnitsPerIntent: 20,
      mode: { hub2: "live", "marathon-pe": "live" },
      routes: { hub2: "central", "marathon-pe": "hub2" },
      ruleBasedTargets: false,
      categoryPolicy: { "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 0 } } },
      policyGroups: { "footwear-all": group },
    } },
    settings: { productTaxonomy: { cats: {
      "caps-beanies": { key: "caps-beanies", label: "Caps & Beanies", sizeMode: "one", top: "clothing", sizes: ["_"] },
      sneakers: { key: "sneakers", label: "Sneakers", sizeMode: "list", top: "footwear", sizes: ["7", "8"] },
      slides: { key: "slides", label: "Slides", sizeMode: "list", top: "footwear", sizes: ["7"] },
      boots: { key: "boots", label: "Boots", sizeMode: "list", top: "footwear", sizes: ["7"] },
      "designer-shoes": { key: "designer-shoes", label: "Designer Shoes", sizeMode: "list", top: "footwear", sizes: ["8"] },
      "kids-shoes": { key: "kids-shoes", label: "Kids Shoes", sizeMode: "list", top: "footwear", sizes: ["2"] },
      loafers: { key: "loafers", label: "Loafers", sizeMode: "list", top: "footwear", sizes: ["7"] },
      "running-shoes": { key: "running-shoes", label: "Running Shoes", sizeMode: "list", top: "footwear", sizes: ["9"] },
      "soccer-boots": { key: "soccer-boots", label: "Soccer Boots", sizeMode: "list", top: "footwear", sizes: ["7"] },
      "t-shirts": { key: "t-shirts", label: "T-Shirts", sizeMode: "list", top: "clothing", sizes: ["S", "M"] },
    } } },
    locations: { central: { kind: "hub" }, hub2: { kind: "hub" }, "marathon-pe": { kind: "shop" } },
    products: {
      c1: { name: "Black Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
      s1: { name: "Air Max", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8"], productType: "sneaker" },
      s2: { name: "Slide", categoryKey: "slides", category: "Footwear", sizes: ["7"], productType: "sneaker" },
      t1: { name: "Tee", categoryKey: "t-shirts", sizes: ["S", "M"], productType: "clothing" },
    },
    stock: {
      central: { s1: { 7: { qty: 30 }, 8: { qty: 30 } }, s2: { 7: { qty: 9 } }, c1: { _: { qty: 20 } }, t1: { S: { qty: 5 } } },
      hub2: { s1: { 7: { qty: 0 }, 8: { qty: 1 } }, s2: { 7: { qty: 0 } }, c1: { _: { qty: 2 } }, t1: { S: { qty: 0 } } },
    },
    stock_targets: { hub2: { t1: { S: { target: 4, minQty: 2 } }, s1: { 8: { target: 2, minQty: 1 } } } },
  };
}

const call = (db, data) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW });
const history = (db) => Object.values(readAt(db.state.root, "engine_policy_history") || {});

beforeEach(() => invalidateCensusCache());

// ── THE LIST ─────────────────────────────────────────────────────────────────
test("the census emits ONE Sneakers entry, with its members' counts added up", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  assert.equal(res.groupEntries.length, 1);
  const g = res.groupEntries[0];
  assert.equal(g.key, "group:footwear-all");
  assert.equal(g.label, "Sneakers");
  assert.equal(g.isGroup, true);
  assert.equal(g.memberCategoryKeys.length, 7);
  // s1 (sneakers) and s2 (slides) — the members' products, summed.
  assert.equal(g.products, 2);
  assert.equal(g.members.length, 7);
  assert.deepEqual(g.members.map((m) => m.key).sort(), [...GROUP.memberCategoryKeys].sort());
});

test("a member category is marked, so the card does not list it beside its group as well", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  const sneakers = res.categories.find((c) => c.key === "sneakers");
  assert.equal(sneakers.memberOfGroup, "footwear-all");
  const caps = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(caps.memberOfGroup, undefined, "a category in no group must not be marked");
});

test("the disarmed group names its policy's locations and arms NONE of them", async () => {
  const db = makeFakeDb(world());
  const g = (await call(db, { action: "census" })).groupEntries[0];
  assert.equal(g.armedGroup, false);
  assert.deepEqual(g.policyLocations, ["hub2"], "the editor still needs the numbers already typed in");
  assert.deepEqual(g.armedEffective, [], "the ENGINE acts on nothing while it is disarmed");
});

test("the group carries the union of its members' size runs, marked where only some carry a size", async () => {
  const db = makeFakeDb(world());
  const g = (await call(db, { action: "census" })).groupEntries[0];
  assert.deepEqual(g.sizeRun, ["7", "8"]);
  assert.deepEqual(g.sizeRunPartial, ["7", "8"]);
  assert.deepEqual(g.sizeRunCarriedBy["8"], ["sneakers"]);
  assert.ok(g.membersWithoutRun.includes("boots"));
});

test("an armed member's own rows still count against the group's total", async () => {
  const db = makeFakeDb(world());
  const g = (await call(db, { action: "census" })).groupEntries[0];
  // s1 carries one explicit row at hub2 size 8.
  assert.equal(g.ownRowCells, 1);
  assert.equal(g.ownRowProducts, 1);
});

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
test("a dry run models a DISARMED group and says the number is hypothetical", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", dryRun: true,
    group: { ...GROUP, policy: { perSize: true, hub2: { sizes: { 7: { target: 4, minQty: 2 } } } } } });
  assert.equal(res.dryRun, true);
  assert.equal(res.hypothetical, true);
  assert.ok(res.armModel, "an editor with no preview can never enable Save");
  assert.equal(typeof res.armModel.totalRequests, "number");
  // AND IT WROTE NOTHING.
  assert.deepEqual(readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all"), GROUP);
  assert.equal(history(db).length, 0);
});

test("a dry run on an ARMED group is not called hypothetical", async () => {
  const armed = { ...GROUP, armed: true };
  const db = makeFakeDb(world(armed));
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", dryRun: true, group: armed });
  assert.equal(res.hypothetical, false);
  assert.ok(res.armModel);
});

// ── THE WRITE ────────────────────────────────────────────────────────────────
test("editing the group's per-size numbers is written, verified and audited", async () => {
  const db = makeFakeDb(world());
  const after = { ...GROUP, policy: { perSize: true, hub2: { sizes: {
    7: { target: 5, minQty: 3, reorderPoint: 0 }, 8: { target: 2, minQty: 1 } } } } };
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: after, expectedBefore: GROUP });
  assert.equal(res.ok, true);
  assert.deepEqual(readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all"), after);
  const h = history(db);
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, "group");
  assert.equal(h[0].status, "applied");
  assert.deepEqual(h[0].before, GROUP);
  // AND IT IS STILL DISARMED. Editing numbers is not arming.
  assert.equal(readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all").armed, false);
});

test("every size is stored individually — nothing collapses a run to one number", async () => {
  const db = makeFakeDb(world());
  const sizes = { 7: { target: 4, minQty: 2 }, 8: { target: 4, minQty: 2 } };
  await call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
    group: { ...GROUP, policy: { perSize: true, hub2: { sizes } } } });
  const live = readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all");
  assert.deepEqual(Object.keys(live.policy.hub2.sizes).sort(), ["7", "8"]);
  assert.equal(live.policy.hub2.target, undefined, "a location must never hold both shapes");
});

test("a size no member of the group carries is refused", async () => {
  const db = makeFakeDb(world());
  await assert.rejects(
    () => call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
      group: { ...GROUP, policy: { perSize: true, hub2: { sizes: { 13: { target: 2, minQty: 1 } } } } } }),
    /13/);
  assert.deepEqual(readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all"), GROUP);
});

test("arming is still refused when the model exceeds the per-scan cap", async () => {
  const db = makeFakeDb(world());
  // Two cells are below target here, well under the live cap of 75, so the cap
  // is brought to them. (0 is not a cap — the model reads a non-positive
  // maxIntentsPerRun as absent and falls back to its own default.)
  db.state.root.config.refillEngine.maxIntentsPerRun = 1;
  await assert.rejects(
    () => call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
      group: { ...GROUP, armed: true } }),
    (e) => /limit/i.test(e.message) || /refills/i.test(e.message));
  assert.equal(readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all").armed, false);
});

test("a member's own policy is untouched by any group edit", async () => {
  const db = makeFakeDb(world());
  const before = readAt(db.state.root, "config/refillEngine/categoryPolicy");
  await call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
    group: { ...GROUP, policy: { perSize: true, hub2: { sizes: { 7: { target: 6, minQty: 3 } } } } } });
  assert.deepEqual(readAt(db.state.root, "config/refillEngine/categoryPolicy"), before);
});

test("the group's old-row count is the rows on legacy sizes, not the number of sizes", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  const sneakers = res.categories.find((c) => c.key === "sneakers");
  // s1 carries one row at size 8, which IS in the run — so no legacy rows.
  assert.equal(sneakers.extraSizeRowCells, 0);
  const tee = res.categories.find((c) => c.key === "t-shirts");
  assert.equal(typeof tee.extraSizeRowCells, "number");
});

test("a refused category is refused BEFORE the size run is derived", async () => {
  const db = makeFakeDb(world());
  const reads = [];
  const realRef = db.ref.bind(db);
  db.ref = (p) => { reads.push(String(p ?? "")); return realRef(p); };
  await assert.rejects(
    () => call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
      group: { ...GROUP, memberCategoryKeys: [...GROUP.memberCategoryKeys, "visors"],
        policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } } } }),
    /visors/);
  assert.equal(reads.filter((r) => r.startsWith("products")).length, 0,
    "the catalogue must not be paged for a group that is refused on its members");
});

test("NO /stock_targets row is touched by a group write", async () => {
  const db = makeFakeDb(world());
  const before = JSON.stringify(readAt(db.state.root, "stock_targets"));
  await call(db, { action: "setGroup", groupKey: "footwear-all", expectedBefore: GROUP,
    group: { ...GROUP, policy: { perSize: true, hub2: { sizes: { 7: { target: 6, minQty: 3 } } } } } });
  assert.equal(JSON.stringify(readAt(db.state.root, "stock_targets")), before);
});
