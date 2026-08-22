// ─── setCategoryPolicy — PASS 3: the group as one entry, per-size group writes ─
// Run: cd functions && node --test test/engine-policy-pass3-write.test.cjs
//
// policy-groups-write.test.cjs pins the group write path that shipped in #401.
// This file pins what the third pass adds to the callable:
//
//   • the CENSUS carries each group as ONE ENTRY (key "group:<gk>") with the
//     members' counts summed, the union size run with partial sizes marked, a
//     photo borrowed from its biggest member — and every member flagged
//     memberOfGroup whether or not the group is armed
//   • a PER-SIZE GROUP WRITE is validated against the DERIVED UNION of the
//     members' runs, never the client's list; an empty union and a union over
//     the stop are refused before anything is written
//   • a DRY RUN on a disarmed group models it without writing or refusing, so
//     the preview can say what arming would cost
//   • a label-only edit (the relabel to "Sneakers") writes, leaves the group
//     DISARMED and the numbers untouched, and leaves a history entry
//   • the rows list accepts a groupKey and returns every member's rows
//
// Mutation-proved in scripts/mutation-proof-engine-policy-pass3.mjs (M3W-*).

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "gunidmoh@gmail.com";
const NOW = Date.parse("2026-08-22T09:00:00.000Z");

const GROUP = (over = {}) => ({
  label: "All footwear except soccer boots",
  memberCategoryKeys: ["sneakers", "slides", "boots"],
  armed: false,
  policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1, reorderPoint: 0 } } } },
  ...over,
});

function world(overrides = {}) {
  return {
    config: {
      refillEngine: {
        maxIntentsPerRun: 75, maxUnitsPerIntent: 20,
        mode: { hub2: "live", "marathon-pe": "live" },
        routes: { hub2: "central", "marathon-pe": "hub2" },
        ruleBasedTargets: false,
        categoryPolicy: { "caps-beanies": { hub2: { target: 10, minQty: 5, reorderPoint: 0 } } },
        policyGroups: { "footwear-all": GROUP() },
      },
    },
    settings: { productTaxonomy: { cats: {
      "caps-beanies": { key: "caps-beanies", label: "Caps & Beanies", sizeMode: "one", top: "clothing", sizes: ["_"], imageUrl: "https://x/caps.png" },
      sneakers: { key: "sneakers", label: "Sneakers", sizeMode: "list", top: "footwear", sizes: ["7", "8", "5.5", "9"], imageUrl: "https://x/sneakers.png" },
      slides: { key: "slides", label: "Slides", sizeMode: "list", top: "footwear", sizes: ["7", "8"], imageUrl: "https://x/slides.png" },
      boots: { key: "boots", label: "Boots", sizeMode: "list", top: "footwear", sizes: ["7", "8"] },
      "soccer-boots": { key: "soccer-boots", label: "Soccer Boots", sizeMode: "list", top: "footwear", sizes: ["7"] },
    } } },
    locations: { central: { kind: "hub" }, hub2: { kind: "hub" }, "marathon-pe": { kind: "shop" }, trophy: { kind: "shop" } },
    products: {
      c1: { name: "Black Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
      s1: { name: "Air Max", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8", "5.5"], productType: "sneaker" },
      s3: { name: "Air Force", categoryKey: "sneakers", category: "Footwear", sizes: ["7"], productType: "sneaker" },
      s2: { name: "Slide", categoryKey: "slides", category: "Footwear", sizes: ["7"], productType: "sneaker" },
    },
    stock: {
      central: { c1: { _: { qty: 40 } }, s1: { 7: { qty: 30 }, 8: { qty: 30 }, "5_5": { qty: 30 } }, s2: { 7: { qty: 5 } }, s3: { 7: { qty: 5 } } },
      hub2: { c1: { _: { qty: 3 } }, s1: { 7: { qty: 0 }, 8: { qty: 0 }, "5_5": { qty: 0 } }, s2: { 7: { qty: 2 } }, s3: { 7: { qty: 1 } } },
      "marathon-pe": { c1: { _: { qty: 1 } }, s2: { 7: { qty: 4 } } },
    },
    stock_targets: {
      hub2: {
        c1: { _: { target: 6, minQty: 3 } },
        s1: { 7: { target: 4, minQty: 2, provenance: { by: "a-script" } } },
        s2: { 7: { target: 1, minQty: 1 } },
      },
    },
    ...overrides,
  };
}

const call = (db, data, opts = {}) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW, ...opts,
});
const groupAt = (db, k) => readAt(db.state.root, `config/refillEngine/policyGroups/${k}`);
const history = (db) => Object.values(readAt(db.state.root, "engine_policy_history") || {});
beforeEach(() => { invalidateCensusCache(); });

async function rejects(fn, code, match) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.httpsCode, code, `expected ${code}, got ${e.httpsCode}: ${e.message}`);
    if (match) assert.match(e.message, match);
    return true;
  });
}

// ═══ THE CENSUS: A GROUP IS ONE ENTRY ════════════════════════════════════════
test("the census carries the group as ONE entry — counts summed, run united, photo borrowed, armed state carried", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  assert.ok(Array.isArray(res.groupEntries));
  const g = res.groupEntries.find((e) => e.key === "group:footwear-all");
  assert.ok(g, "one entry, keyed group:<gk>");
  assert.equal(g.isGroup, true);
  assert.equal(g.groupKey, "footwear-all");
  assert.equal(g.label, "All footwear except soccer boots");
  assert.equal(g.armed, false);
  assert.equal(g.policySource, "group");
  // SUMMED across members: sneakers 2 products (s1, s3) + slides 1 + boots 0.
  assert.equal(g.products, 3);
  // units: hub2 s1 0+0+0, s3 1, s2 2; pe s2 4; central is a source and counted
  // by carriageForCategory too (30+30+30 + 5 + 5) — the same sum the member
  // entries report, added up.
  const members = res.categories.filter((c) => ["sneakers", "slides", "boots"].includes(c.key));
  assert.equal(g.units, members.reduce((n, c) => n + c.units, 0));
  assert.equal(g.ownRowCells, members.reduce((n, c) => n + c.ownRowCells, 0));
  assert.equal(g.ownRowCells, 2, "s1/7 and s2/7");
  // THE UNION of the members' derived runs, partial sizes marked.
  assert.deepEqual(g.sizeRun, ["5_5", "7", "8"], "sneakers 5.5/7/8 ∪ slides 7 — 9 is taxonomy-only and never offered");
  assert.deepEqual(g.sizeRunPartial, ["5_5", "8"], "only sneakers carries 5.5 and 8");
  assert.deepEqual(g.sizeRunCarriedBy["7"], ["sneakers", "slides"]);
  assert.equal(g.sizeRunByMember.boots.empty, true, "boots has no products and no run");
  assert.equal(g.sizeRunOverStop, false);
  // The photo is the biggest member's.
  assert.equal(g.imageUrl, "https://x/sneakers.png");
  // The member list, with own-policy flags.
  assert.deepEqual(g.members.map((m) => m.key), ["sneakers", "slides", "boots"]);
  assert.equal(g.members[0].ownPolicy, false);
  // Carriage merged: hub2 carries (any member does), trophy does not.
  assert.equal(g.carriage.hub2.carries, true);
  assert.equal(g.carriage.trophy?.carries ?? false, false);
  // The same fields a category entry has, so the SAME detail screen renders it.
  for (const f of ["entry", "effectiveEntry", "armedEffective", "perSize", "sizeRun", "sizeRunExtra", "sizeRunEmpty", "carriage", "ownRowCells", "ownRowProducts", "imageUrl", "label", "products", "units"]) {
    assert.ok(f in g, `group entry carries ${f}`);
  }
  assert.deepEqual(g.armedEffective, ["hub2"]);
  assert.equal(g.perSize, true);
});

test("every member is flagged memberOfGroup — WHILE THE GROUP IS DISARMED — so the list can fold it in", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  for (const k of ["sneakers", "slides", "boots"]) {
    const c = res.categories.find((x) => x.key === k);
    assert.ok(c, `${k} is still in categories (reachable from inside the group)`);
    assert.equal(c.memberOfGroup, "footwear-all", `${k} names its group while disarmed`);
    assert.equal(c.groupKey, null, "…and groupKey stays the ARMED-group answer: null");
  }
  assert.equal(res.categories.find((x) => x.key === "caps-beanies").memberOfGroup, null);
});

// ═══ PER-SIZE GROUP WRITES — VALIDATED AGAINST THE DERIVED UNION ═════════════
test("a per-size group write may name a size only SOME members carry — and never a size NO member carries", async () => {
  const db = makeFakeDb(world());
  const live = groupAt(db, "footwear-all");
  // 5.5: sneakers only — allowed (the union, partial marked).
  const okGroup = { ...live, policy: { perSize: true, hub2: { sizes: {
    7: { target: 2, minQty: 1, reorderPoint: 0 }, "5_5": { target: 1, minQty: 1, reorderPoint: 0 } } } } };
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: okGroup, expectedBefore: live });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(groupAt(db, "footwear-all").policy.hub2.sizes).sort(), ["5_5", "7"]);
  assert.equal(groupAt(db, "footwear-all").armed, false, "still disarmed");
  // 9: in the sneakers TAXONOMY but no product declares it, no cell, no row — refused.
  const bad = { ...live, policy: { perSize: true, hub2: { sizes: { 9: { target: 2, minQty: 1 } } } } };
  await rejects(() => call(db, { action: "setGroup", groupKey: "footwear-all", group: bad, expectedBefore: groupAt(db, "footwear-all") }),
    "invalid-argument", /9 is not one of this category's sizes \(5_5, 7, 8\)/);
  // 10: nowhere at all — refused.
  const bad2 = { ...live, policy: { perSize: true, hub2: { sizes: { 10: { target: 2, minQty: 1 } } } } };
  await rejects(() => call(db, { action: "setGroup", groupKey: "footwear-all", group: bad2, expectedBefore: groupAt(db, "footwear-all") }),
    "invalid-argument", /10 is not one of/);
  // the client's claim about sizes is NOT consulted — there is no field for it.
});

test("a per-size policy on a group whose members have NO derivable run is refused — not guessed", async () => {
  const db = makeFakeDb(world());
  const empty = { label: "Nothing yet", memberCategoryKeys: ["soccer-boots"], armed: false,
    policy: { perSize: true, hub2: { sizes: { 7: { target: 1, minQty: 1 } } } } };
  await rejects(() => call(db, { action: "setGroup", groupKey: "soccer-only", group: empty }),
    "failed-precondition", /No size run can be worked out/);
  assert.equal(groupAt(db, "boots-only"), null, "nothing written");
  // A UNIFORM policy on the same group is fine — it needs no run.
  const uniform = { ...empty, policy: { perSize: true, hub2: { target: 1, minQty: 1 } } };
  const res = await call(db, { action: "setGroup", groupKey: "soccer-only", group: uniform });
  assert.equal(res.ok, true);
});

test("a union over the stop refuses a per-size group policy — the list is reported, not trimmed", async () => {
  const w = world();
  const sizes = Array.from({ length: 21 }, (_, i) => String(30 + i));
  w.settings.productTaxonomy.cats.widths = { key: "widths", label: "Widths", sizeMode: "list", top: "footwear", sizes };
  w.products.w1 = { name: "Wide", categoryKey: "widths", category: "Footwear", sizes, productType: "sneaker" };
  w.stock.hub2.w1 = Object.fromEntries(sizes.map((s) => [s, { qty: 0 }]));
  const db = makeFakeDb(w);
  const g = { label: "Too wide", memberCategoryKeys: ["widths"], armed: false,
    policy: { perSize: true, hub2: { sizes: { 30: { target: 1, minQty: 1 } } } } };
  await rejects(() => call(db, { action: "setGroup", groupKey: "wide", group: g }), "failed-precondition", /21 sizes/);
  assert.equal(groupAt(db, "wide"), null);
});

// ═══ DRY RUN MODELS A DISARMED GROUP ═════════════════════════════════════════
test("a dry run on a DISARMED group models what arming would cost — writes nothing, refuses nothing", async () => {
  const db = makeFakeDb(world());
  const live = groupAt(db, "footwear-all");
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: live, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.armedNow, false);
  assert.ok(res.armModel, "the model runs on a dry run whatever the armed state");
  assert.equal(typeof res.armModel.totalRequests, "number");
  assert.ok(res.armModel.perMember.some((m) => m.key === "sneakers"));
  assert.deepEqual(groupAt(db, "footwear-all"), live, "nothing written");
  assert.equal(history(db).filter((h) => h.kind === "group").length, 0, "no history on a dry run");
  // …and a dry run that would be OVER the cap still returns rather than refusing,
  // because it is a question, not an arming.
  const w = world(); w.config.refillEngine.maxIntentsPerRun = 1;
  const db2 = makeFakeDb(w);
  // Two sizes so there are two un-rowed deficits (s1/8 and s3/7) against a cap of 1.
  const over = { ...groupAt(db2, "footwear-all"), policy: { perSize: true, hub2: { sizes: {
    7: { target: 2, minQty: 1, reorderPoint: 0 }, 8: { target: 2, minQty: 1, reorderPoint: 0 } } } } };
  const res2 = await call(db2, { action: "setGroup", groupKey: "footwear-all", group: over, dryRun: true });
  assert.equal(res2.armModel.exceedsCap, true);
  assert.equal(res2.ok, true);
});

// ═══ THE RELABEL ═════════════════════════════════════════════════════════════
test('relabelling the group to "Sneakers" writes the label, keeps it DISARMED, keeps the numbers, leaves history', async () => {
  const db = makeFakeDb(world());
  const live = groupAt(db, "footwear-all");
  const res = await call(db, { action: "setGroup", groupKey: "footwear-all", group: { ...live, label: "Sneakers" }, expectedBefore: live });
  assert.equal(res.ok, true);
  const after = groupAt(db, "footwear-all");
  assert.equal(after.label, "Sneakers");
  assert.equal(after.armed, false);
  assert.deepEqual(after.policy, live.policy);
  assert.deepEqual(after.memberCategoryKeys, live.memberCategoryKeys);
  const h = history(db).filter((x) => x.kind === "group");
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "applied");
  assert.equal(h[0].before.label, "All footwear except soccer boots");
  assert.equal(h[0].after.label, "Sneakers");
  // and the census now says Sneakers
  invalidateCensusCache();
  const c = await call(db, { action: "census" });
  assert.equal(c.groupEntries[0].label, "Sneakers");
});

// ═══ ROWS BY GROUP ═══════════════════════════════════════════════════════════
test("the rows list accepts a groupKey and returns every member's rows; an unknown group is refused", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, { action: "rows", groupKey: "footwear-all" });
  assert.equal(res.groupKey, "footwear-all");
  assert.deepEqual(res.rows.map((r) => `${r.pid}/${r.sizeKey}`).sort(), ["s1/7", "s2/7"]);
  assert.equal(res.total, 2);
  await rejects(() => call(db, { action: "rows", groupKey: "nope" }), "invalid-argument", /unknown group/);
  // a category read is unchanged
  const one = await call(db, { action: "rows", categoryKey: "slides" });
  assert.deepEqual(one.rows.map((r) => r.pid), ["s2"]);
});
