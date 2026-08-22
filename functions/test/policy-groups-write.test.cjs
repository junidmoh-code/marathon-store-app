// ─── setCategoryPolicy — GROUPS, PER-SIZE, AND EDITING EXPLICIT ROWS ──────────
// Run: cd functions && node --test test/policy-groups-write.test.cjs
//
// category-policy-write.test.cjs pins the write path that shipped. This file
// pins the three the redesign adds, and the two constraints that are not
// negotiable in any of them:
//
//   NO ROW IS EVER DELETED. There is no argument, no flag and no code path that
//   removes a /stock_targets row. Junid armed those by hand over months —
//   7,797 of them on 1,666 products — and this screen edits them in place.
//
//   NO ROW IS EVER CREATED HERE EITHER. An absent row is refused. Creating one
//   is arming a new cell, which has a different blast radius and belongs to a
//   different act than "fix this number".
//
// The owner check and the drift checks are mutation-proven in
// scripts/mutation-proof-policy-groups-write.mjs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "gunidmoh@gmail.com";
const NOW = Date.parse("2026-08-22T09:00:00.000Z");

function world(overrides = {}) {
  return {
    config: {
      refillEngine: {
        maxIntentsPerRun: 75,
        maxUnitsPerIntent: 20,
        mode: { hub2: "live", "marathon-pe": "live" },
        routes: { hub2: "central", "marathon-pe": "hub2" },
        ruleBasedTargets: false,
        categoryPolicy: {
          "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 0 } },
        },
      },
    },
    settings: { productTaxonomy: { cats: {
      "caps-beanies": { key: "caps-beanies", label: "Caps & Beanies", sizeMode: "one", top: "clothing", sizes: ["_"] },
      sneakers: { key: "sneakers", label: "Sneakers", sizeMode: "list", top: "footwear", sizes: ["7", "8", "5.5"] },
      slides: { key: "slides", label: "Slides", sizeMode: "list", top: "footwear", sizes: ["7", "8"] },
      "soccer-boots": { key: "soccer-boots", label: "Soccer Boots", sizeMode: "list", top: "footwear", sizes: ["7"] },
      visors: { key: "visors", label: "Visors", sizeMode: "one", top: "clothing", sizes: ["_"] },
    } } },
    locations: { central: { kind: "hub" }, hub2: { kind: "hub" }, "marathon-pe": { kind: "shop" }, trophy: { kind: "shop" } },
    products: {
      c1: { name: "Black Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
      s1: { name: "Air Max", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8", "5.5"], productType: "sneaker" },
      s2: { name: "Slide", categoryKey: "slides", category: "Footwear", sizes: ["7"], productType: "sneaker" },
    },
    stock: {
      central: { c1: { _: { qty: 40 } }, s1: { 7: { qty: 30 }, 8: { qty: 30 }, "5_5": { qty: 30 } }, s2: { 7: { qty: 5 } } },
      hub2: { c1: { _: { qty: 3 } }, s1: { 7: { qty: 0 }, 8: { qty: 0 }, "5_5": { qty: 0 } }, s2: { 7: { qty: 0 } } },
      "marathon-pe": { c1: { _: { qty: 1 } } },
    },
    stock_targets: {
      hub2: {
        c1: { _: { target: 6, minQty: 3 }, S: { target: 2, minQty: 1, reorderPoint: 1 } },
        s1: { 7: { target: 4, minQty: 2, provenance: { by: "a-script" } } },
      },
    },
    ...overrides,
  };
}

const call = (db, data, opts = {}) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW, ...opts,
});
const groupAt = (db, k) => readAt(db.state.root, `config/refillEngine/policyGroups/${k}`);
const rowAt = (db, loc, pid, sz) => readAt(db.state.root, `stock_targets/${loc}/${pid}/${sz}`);
const history = (db) => Object.values(readAt(db.state.root, "engine_policy_history") || {});

async function rejects(fn, code, match) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.httpsCode, code, `expected ${code}, got ${e.httpsCode}: ${e.message}`);
    if (match) assert.match(e.message, match);
    return true;
  });
}

const GROUP = (over = {}) => ({
  label: "All footwear except soccer boots",
  memberCategoryKeys: ["sneakers", "slides"],
  armed: false,
  policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1, reorderPoint: 0 } } } },
  ...over,
});

// ═══ GATE 3 STILL APPLIES TO EVERY NEW ACTION ════════════════════════════════
test("every new action is refused for anyone but the owner", async () => {
  const db = makeFakeDb(world());
  for (const data of [
    { action: "setGroup", groupKey: "g", group: GROUP() },
    { action: "rows", categoryKey: "caps-beanies" },
    { action: "setRows", rows: [{ loc: "hub2", pid: "c1", sizeKey: "_", target: 7, minQty: 3 }] },
  ]) {
    await rejects(() => applyCategoryPolicy({
      db, callerEmail: "ahmed@marathon.internal", adminEmail: OWNER, data, nowMs: NOW,
    }), "permission-denied");
  }
  // …and nothing was written by any of them.
  assert.equal(groupAt(db, "g"), null);
  assert.equal(rowAt(db, "hub2", "c1", "_").target, 6);
});

// ═══ GROUPS ══════════════════════════════════════════════════════════════════
test("a group is written disarmed, and writing it arms nothing", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP() });
  assert.equal(res.ok, true);
  const live = groupAt(db, "footwear-all");
  assert.equal(live.armed, false);
  assert.deepEqual(live.memberCategoryKeys, ["sneakers", "slides"]);
  // The category map is untouched — a group is not a category entry.
  assert.equal(readAt(db.state.root, "config/refillEngine/categoryPolicy/sneakers"), null);
  const h = history(db).filter((x) => x.kind === "group");
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "applied");
  assert.equal(h[0].armed, false);
});

test("ARMING IS REFUSED WHEN THE MODELLED VOLUME EXCEEDS THE PER-SCAN CAP", async () => {
  // The live footwear case: 2,176 modelled requests against a cap of 75. Here
  // the cap is dropped to 1 so the same refusal is reachable in a small world.
  const w = world();
  w.config.refillEngine.maxIntentsPerRun = 1;
  const db = makeFakeDb(w);
  invalidateCensusCache();
  await rejects(() => call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP({ armed: true }) }),
    "failed-precondition", /against a limit of 1/);
  assert.equal(groupAt(db, "footwear-all"), null, "nothing may be written when arming is refused");
});

test("arming succeeds under the cap and the group then governs its members", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP({ armed: true }) });
  assert.equal(res.ok, true);
  assert.equal(groupAt(db, "footwear-all").armed, true);
  assert.ok(res.armModel.totalRequests > 0, "arming must be modelled, and the model must be non-empty here");
  assert.ok(res.armModel.totalRequests <= res.armModel.cap);
});

test("a group cannot be armed with no numbers behind it", async () => {
  const db = makeFakeDb(world());
  const g = GROUP({ armed: true }); delete g.policy;
  await rejects(() => call(db, { action: "setGroup", groupKey: "g", group: g }), "invalid-argument", /no numbers yet/);
});

test("a refused category cannot be put in a group", async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, { action: "setGroup", groupKey: "g",
    group: GROUP({ memberCategoryKeys: ["sneakers", "visors"] }) }), "invalid-argument", /visors/);
});

test("a category cannot belong to two groups", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "a-group", group: GROUP() });
  invalidateCensusCache();
  await rejects(() => call(db, { action: "setGroup", groupKey: "b-group",
    group: GROUP({ memberCategoryKeys: ["sneakers"] }) }), "invalid-argument", /already in the "a-group" group/);
});

test("an omitted group field is refused — a dropped field must not delete a live group", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP() });
  await rejects(() => call(db, { action: "setGroup", groupKey: "footwear-all" }), "invalid-argument", /group is required/);
  assert.ok(groupAt(db, "footwear-all"), "the group must survive the refusal");
});

test("group: null deletes it, and the group's members go back to whatever they had", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP({ armed: true }) });
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "footwear-all", group: null });
  assert.equal(groupAt(db, "footwear-all"), null);
});

test("a group write refuses on drift and writes nothing", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP() });
  invalidateCensusCache();
  await rejects(() => call(db, {
    action: "setGroup", groupKey: "footwear-all",
    group: GROUP({ label: "Renamed" }),
    expectedBefore: null,                       // "I opened this when it did not exist"
  }), "failed-precondition", /changed while this was open/);
  assert.equal(groupAt(db, "footwear-all").label, "All footwear except soccer boots");
});

// ═══ PER-SIZE POLICY ═════════════════════════════════════════════════════════
test("a per-size map is written, size by size, and the halves keep their stored key", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const policy = { perSize: true, hub2: { sizes: {
    7: { target: 4, minQty: 2 }, "5_5": { target: 2, minQty: 1, reorderPoint: 1 },
  } } };
  const res = await call(db, { categoryKey: "sneakers", policy });
  assert.equal(res.ok, true);
  const live = readAt(db.state.root, "config/refillEngine/categoryPolicy/sneakers");
  assert.equal(live.hub2.sizes["7"].target, 4);
  assert.equal(live.hub2.sizes["5_5"].target, 2);
  assert.equal(live.hub2.sizes["5_5"].reorderPoint, 1);
  assert.ok(!("reorderPoint" in live.hub2.sizes["7"]), "an absent Ask at stays absent, never zeroed");
});

test("a size outside the DERIVED run is refused — the run comes from live data", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  // The registry declares 7, 8 and 5.5 for sneakers; only s1 exists and it
  // declares all three, so all three are legal. "12" is in none of them.
  await rejects(() => call(db, { categoryKey: "sneakers",
    policy: { perSize: true, hub2: { sizes: { 12: { target: 4, minQty: 2 } } } } }),
  "invalid-argument", /not one of this category's sizes/);
});

test("a raw 5.5 key is refused — RTDB cannot store a dot in a key", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await rejects(() => call(db, { categoryKey: "sneakers",
    policy: { perSize: true, hub2: { sizes: { "5.5": { target: 4, minQty: 2 } } } } }),
  "invalid-argument", /5_5|letters, digits/);
});

test("a per-size map on a one-size category is refused", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await rejects(() => call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { sizes: { S: { target: 4, minQty: 2 } } } } }),
  "invalid-argument", /one-size category/);
});

test("a sized category with no derivable run is a STOP, not a guessed list", () => {
  // Distinct from the one-size case above, and deliberately a different error
  // class: one-size is a fact about the category, an underivable run is a fault.
  const { sizeRunForCategory } = require("../lib/policy-groups.cjs");
  const r = sizeRunForCategory({
    products: { x: { categoryKey: "ghosts", sizes: [] } }, stock: {}, targets: {},
    taxonomy: { cats: { ghosts: { sizeMode: "list", sizes: ["S", "M"] } } },
    categoryKey: "ghosts", locations: ["hub2"],
  });
  assert.equal(r.empty, true);
  assert.equal(r.oneSize, false);
});

test("the uniform shape still writes exactly as it did", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { categoryKey: "caps-beanies", policy: { hub2: { target: 12, minQty: 6, reorderPoint: 2 } } });
  const live = readAt(db.state.root, "config/refillEngine/categoryPolicy/caps-beanies");
  assert.deepEqual(live, { hub2: { target: 12, minQty: 6, reorderPoint: 2 } });
});

// ═══ EXPLICIT ROWS ═══════════════════════════════════════════════════════════
test("the row list reads every explicit row on the category's products", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "rows", categoryKey: "caps-beanies" });
  assert.equal(res.count, 2);
  const byKey = Object.fromEntries(res.rows.map((r) => [`${r.loc}/${r.pid}/${r.sizeKey}`, r]));
  assert.equal(byKey["hub2/c1/_"].target, 6);
  assert.equal(byKey["hub2/c1/S"].reorderPoint, 1);
  assert.equal(byKey["hub2/c1/S"].name, "Black Cap");
});

test("a row is EDITED IN PLACE, and every field the row carries survives", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const res = await call(db, { action: "setRows", categoryKey: "sneakers", rows: [
    { loc: "hub2", pid: "s1", sizeKey: "7", target: 9, minQty: 4,
      expected: { target: 4, minQty: 2, reorderPoint: null } },
  ] });
  assert.equal(res.ok, true);
  const row = rowAt(db, "hub2", "s1", "7");
  assert.equal(row.target, 9);
  assert.equal(row.minQty, 4);
  // The scan's own provenance is not this screen's to drop.
  assert.deepEqual(row.provenance, { by: "a-script" });
});

test("A ROW IS NEVER DELETED — there is no argument that removes one", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  // Every shape a caller might reach for. None of them may remove the row.
  for (const bad of [
    { loc: "hub2", pid: "c1", sizeKey: "_", target: null, minQty: null },
    { loc: "hub2", pid: "c1", sizeKey: "_", target: 0, minQty: 0 },
    { loc: "hub2", pid: "c1", sizeKey: "_" },
  ]) {
    await rejects(() => call(db, { action: "setRows", rows: [bad] }), "invalid-argument");
  }
  assert.equal(rowAt(db, "hub2", "c1", "_").target, 6, "the row must still be there, unchanged");
});

test("A ROW IS NEVER CREATED — an absent row is refused, loudly", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await rejects(() => call(db, { action: "setRows", rows: [
    { loc: "marathon-pe", pid: "c1", sizeKey: "_", target: 5, minQty: 3 },
  ] }), "failed-precondition", /has no row today/);
  assert.equal(rowAt(db, "marathon-pe", "c1", "_"), null);
});

test("a row edit refuses on drift, and the whole batch is refused with it", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await rejects(() => call(db, { action: "setRows", rows: [
    { loc: "hub2", pid: "c1", sizeKey: "_", target: 8, minQty: 4, expected: { target: 6, minQty: 3, reorderPoint: null } },
    { loc: "hub2", pid: "c1", sizeKey: "S", target: 3, minQty: 2, expected: { target: 99, minQty: 1, reorderPoint: 1 } },
  ] }), "failed-precondition", /changed while this was open/);
  // ONE update, so the first edit must not have landed either.
  assert.equal(rowAt(db, "hub2", "c1", "_").target, 6);
  assert.equal(rowAt(db, "hub2", "c1", "S").target, 2);
});

test("a blank Ask at removes the field rather than leaving the old one behind", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setRows", rows: [
    { loc: "hub2", pid: "c1", sizeKey: "S", target: 4, minQty: 2 },   // no reorderPoint
  ] });
  const row = rowAt(db, "hub2", "c1", "S");
  assert.equal(row.target, 4);
  assert.ok(!("reorderPoint" in row), "the old reorderPoint of 1 must be gone, not silently kept");
});

test("row edits are validated by the SAME rules a policy entry is", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  for (const [bad, re] of [
    [{ target: 5, minQty: 9 }, /cannot exceed/],
    [{ target: 5, minQty: 2, reorderPoint: 5 }, /must be below/],
    [{ target: 0, minQty: 0 }, /whole number from 1/],
    [{ target: 5 }, /minQty is required/],
  ]) {
    await rejects(() => call(db, { action: "setRows",
      rows: [{ loc: "hub2", pid: "c1", sizeKey: "_", ...bad }] }), "invalid-argument", re);
  }
});

test("a row edit records the whole previous row in history before it writes", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setRows", categoryKey: "caps-beanies", rows: [
    { loc: "hub2", pid: "c1", sizeKey: "_", target: 8, minQty: 4 },
  ] });
  const h = history(db).filter((x) => x.kind === "rows");
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "applied");
  assert.equal(h[0].before[0].row.target, 6, "the previous numbers must be recoverable from the audit entry alone");
});

test("a path segment that is not a single key is refused", async () => {
  const db = makeFakeDb(world());
  for (const bad of [
    { loc: "hub2/../central", pid: "c1", sizeKey: "_", target: 5, minQty: 3 },
    { loc: "hub2", pid: "c1/x", sizeKey: "_", target: 5, minQty: 3 },
    { loc: "hub2", pid: "c1", sizeKey: "5.5", target: 5, minQty: 3 },
  ]) {
    await rejects(() => call(db, { action: "setRows", rows: [bad] }), "invalid-argument");
  }
});

test("a batch bigger than the cap is refused rather than half-applied", async () => {
  const db = makeFakeDb(world());
  const many = Array.from({ length: 201 }, () => ({ loc: "hub2", pid: "c1", sizeKey: "_", target: 5, minQty: 3 }));
  await rejects(() => call(db, { action: "setRows", rows: many }), "invalid-argument", /at most 200/);
});

// ═══ THE CENSUS SEES ALL OF IT ═══════════════════════════════════════════════
test('the census reports "with their own rows" for an UNARMED category too', async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const res = await call(db, { action: "census", refresh: true });
  const sneakers = res.categories.find((c) => c.key === "sneakers");
  assert.equal(sneakers.armed.length, 0, "sneakers is not armed");
  assert.equal(sneakers.ownRowCells, 1, "…and it still has a row, which the chip must count");
  const caps = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(caps.ownRowCells, 2);
  assert.equal(caps.ownRowProducts, 1);
});

test("the census reports a grouped category's source and numbers", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  await call(db, { action: "setGroup", groupKey: "footwear-all", group: GROUP({ armed: true }) });
  invalidateCensusCache();
  const res = await call(db, { action: "census", refresh: true });
  const sneakers = res.categories.find((c) => c.key === "sneakers");
  assert.equal(sneakers.policySource, "group");
  assert.equal(sneakers.groupKey, "footwear-all");
  assert.deepEqual(sneakers.armedEffective, ["hub2"]);
  // …and a category with its OWN entry is not reported as grouped.
  const caps = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(caps.policySource, "category");
  assert.equal(caps.groupKey, null);
});

test("the census reports the DERIVED size run, not the registry's", async () => {
  const db = makeFakeDb(world());
  invalidateCensusCache();
  const res = await call(db, { action: "census", refresh: true });
  const sneakers = res.categories.find((c) => c.key === "sneakers");
  assert.deepEqual(sneakers.sizeRun, ["5_5", "7", "8"]);
  const slides = res.categories.find((c) => c.key === "slides");
  // s2 declares only 7. The registry promises 8 as well, and nothing has it.
  assert.deepEqual(slides.sizeRun, ["7"]);
  const caps = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(caps.sizeRunEmpty, true, "a one-size category has no run, and says so");
});

test("a category that exists only as rows is listed, read-only", async () => {
  const w = world();
  w.stock_targets.hub2.pk1 = { _: { target: 3, minQty: 1 } };
  w.products.pk1 = { name: "Poly bags", categoryKey: "packaging", sizes: ["_"] };
  const db = makeFakeDb(w);
  invalidateCensusCache();
  const res = await call(db, { action: "census", refresh: true });
  const pk = res.categories.find((c) => c.key === "packaging");
  assert.ok(pk, "a category with rows and no taxonomy entry must still be listed");
  assert.equal(pk.rowOnly, true);
  assert.equal(pk.ownRowCells, 1);
});
