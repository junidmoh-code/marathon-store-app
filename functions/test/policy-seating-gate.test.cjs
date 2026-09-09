// ─── THE SEATING GATE — a policy says HOW MANY, never WHERE ───────────────────
// Run: cd functions && node --test test/policy-seating-gate.test.cjs
//
// The incident this pins (2026-09-08): Slides was armed at hub1 AND hub2, both
// legs unscoped. An unscoped leg is the map's standing promise — the category
// is the arming act, carriage or not — so both hubs were told to keep all 64
// slides in the catalogue when only 3 are actually kept at both. 181 open
// lines, 125 of them at a hub with no cell for the product.
//
// The gate: a location leg that was NOT already armed is written with
// `carriedOnly: true`. That flag is not new — refill-engine.cjs
// categoryPolicyEntry has enforced it since 2026-08-25 through storeCarries,
// CELL EXISTENCE INCLUDING A ZERO CELL. What is new is that arming can no
// longer skip deciding.
//
// The three that matter most are the ones that say what the gate must NOT do:
// it must not touch an already-armed leg, it must not touch a target:0 seating
// switch-off, and it must not un-arm a sold-out product.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy } = require("../lib/category-policy-write.cjs");
const { resolveTarget } = require("../lib/refill-engine.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "gunidmoh@gmail.com";
const NOW = Date.parse("2026-09-09T09:00:00.000Z");

// Two hubs and four slides, shaped like the live catalogue:
//   s_both  — a cell at BOTH hubs
//   s_h1    — hub1 only
//   s_h2    — hub2 only, and its hub1-absent state is the whole point
//   s_none  — seated nowhere (a Central-only line)
// s_h1's size 7 cell is ZERO — sold out, still seated, must stay armed.
function world(overrides = {}) {
  return {
    config: {
      refillEngine: {
        maxIntentsPerRun: 75, maxUnitsPerIntent: 20,
        mode: { hub1: "live", hub2: "live" },
        routes: { hub1: "central", hub2: "central" },
        ruleBasedTargets: false,
        categoryPolicy: {
          // sneakers is ALREADY ARMED at hub1, unscoped, exactly as live.
          // Nothing this file does may change a byte of it.
          sneakers: { perSize: true, hub1: { sizes: { 7: { target: 5, minQty: 3 } } } },
        },
      },
    },
    settings: { productTaxonomy: { cats: {
      slides: { key: "slides", label: "Slides", sizeMode: "list", sizes: ["6", "7"] },
      sneakers: { key: "sneakers", label: "Sneakers", sizeMode: "list", sizes: ["7"] },
    } } },
    locations: { central: { kind: "hub" }, hub1: { kind: "hub" }, hub2: { kind: "hub" } },
    products: {
      s_both: { name: "Both Hubs Slide", categoryKey: "slides", sizes: ["6", "7"], category: "Footwear" },
      s_h1: { name: "Hub One Slide", categoryKey: "slides", sizes: ["6", "7"], category: "Footwear" },
      s_h2: { name: "Hub Two Slide", categoryKey: "slides", sizes: ["6", "7"], category: "Footwear" },
      s_none: { name: "Unseated Slide", categoryKey: "slides", sizes: ["6", "7"], category: "Footwear" },
      k1: { name: "A Sneaker", categoryKey: "sneakers", sizes: ["7"], category: "Footwear" },
    },
    stock: {
      central: { s_both: { 6: { qty: 9 }, 7: { qty: 9 } }, s_h1: { 6: { qty: 9 }, 7: { qty: 9 } },
                 s_h2: { 6: { qty: 9 }, 7: { qty: 9 } }, s_none: { 6: { qty: 9 }, 7: { qty: 9 } },
                 k1: { 7: { qty: 9 } } },
      hub1: { s_both: { 6: { qty: 2 }, 7: { qty: 2 } },
              // A ZERO CELL IS A SEAT. Sold out is not unseated.
              s_h1: { 6: { qty: 1 }, 7: { qty: 0 } },
              k1: { 7: { qty: 1 } } },
      hub2: { s_both: { 6: { qty: 2 }, 7: { qty: 2 } },
              s_h2: { 6: { qty: 1 }, 7: { qty: 1 } } },
    },
    ...overrides,
  };
}

const call = (db, data) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW,
});
const policyAt = (db, key) => readAt(db.state.root, `config/refillEngine/categoryPolicy/${key}`);

// The per-size Slides arming exactly as it was made on 2026-09-08: both hubs,
// keep 3, no carriedOnly anywhere.
const SLIDES_ARM = {
  categoryKey: "slides",
  policy: {
    perSize: true,
    hub1: { sizes: { 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } } },
    hub2: { sizes: { 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } } },
  },
};

// The engine's own reading of the written policy — the only thing that decides
// whether a product is actually armed at a location. Every assertion about
// "arms here / does not arm here" goes through it rather than through the flag,
// because the flag is a means and the resolved target is the end.
const armedAt = (db, dest, pid, size) => {
  const w = db.state.root;
  return resolveTarget(
    { targets: readAt(w, "stock_targets") || {}, config: readAt(w, "config/refillEngine"),
      products: readAt(w, "products"), stock: readAt(w, "stock") },
    dest, pid, size);
};

test("a newly armed leg is written carriedOnly — the flag is not optional", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, SLIDES_ARM);
  assert.equal(res.ok, true);
  assert.equal(policyAt(db, "slides").hub1.carriedOnly, true);
  assert.equal(policyAt(db, "slides").hub2.carriedOnly, true);
  // And the save SAYS so, rather than scoping silently.
  assert.deepEqual(res.seatedOnlyLocations.sort(), ["hub1", "hub2"]);
});

test("a product seated at ONE hub arms at that hub only", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  assert.equal(armedAt(db, "hub1", "s_h1", "6").target, 3);
  assert.equal(armedAt(db, "hub2", "s_h1", "6"), null);
  assert.equal(armedAt(db, "hub2", "s_h2", "6").target, 3);
  assert.equal(armedAt(db, "hub1", "s_h2", "6"), null);
});

test("a product seated at BOTH hubs arms at both", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  assert.equal(armedAt(db, "hub1", "s_both", "6").target, 3);
  assert.equal(armedAt(db, "hub2", "s_both", "6").target, 3);
});

test("a product seated NOWHERE arms nowhere — arming never creates a seating", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  assert.equal(armedAt(db, "hub1", "s_none", "6"), null);
  assert.equal(armedAt(db, "hub2", "s_none", "6"), null);
  // And no stock cell was invented for it either.
  assert.equal(readAt(db.state.root, "stock/hub1/s_none") ?? null, null);
  assert.equal(readAt(db.state.root, "stock/hub2/s_none") ?? null, null);
});

test("a ZERO-QUANTITY cell is a seat — a sold-out product stays armed", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  // s_h1 size 7 holds qty 0 at hub1. That is the cell that must keep arming:
  // "seated" is cell existence, not stock on hand, and refilling a sold-out
  // shelf is the entire job.
  assert.equal(readAt(db.state.root, "stock/hub1/s_h1/7").qty, 0);
  assert.equal(armedAt(db, "hub1", "s_h1", "7").target, 3);
});

test("an explicit target:0 seating switch-off still outranks the policy", async () => {
  const db = makeFakeDb(world({
    stock_targets: { hub1: { s_both: { 6: { target: 0, minQty: 0, source: "seating_off" } } } },
  }));
  await call(db, SLIDES_ARM);
  const t = armedAt(db, "hub1", "s_both", "6");
  assert.equal(t.source, "explicit");
  assert.equal(t.target, 0);
  // …and the row itself was not rewritten by the arming.
  assert.equal(readAt(db.state.root, "stock_targets/hub1/s_both/6").source, "seating_off");
});

test("an explicit POSITIVE row still arms a product the gate would skip", async () => {
  // The owner's own row on an unseated product outranks the map, so the gate
  // sits strictly below it and cannot silence a hand-made decision.
  const db = makeFakeDb(world({
    stock_targets: { hub2: { s_none: { 6: { target: 2, minQty: 1, source: "policy_target" } } } },
  }));
  await call(db, SLIDES_ARM);
  const t = armedAt(db, "hub2", "s_none", "6");
  assert.equal(t.source, "explicit");
  assert.equal(t.target, 2);
});

test("AN ALREADY-ARMED CATEGORY COMES THROUGH BYTE-IDENTICAL", async () => {
  // The live case: hub1's sneakers, armed unscoped, must not be narrowed by a
  // change made for slides. Arming slides does not touch it, and editing
  // sneakers' own numbers does not retro-fit the flag either.
  const db = makeFakeDb(world());
  const before = JSON.stringify(policyAt(db, "sneakers"));
  await call(db, SLIDES_ARM);
  assert.equal(JSON.stringify(policyAt(db, "sneakers")), before);

  const res = await call(db, {
    categoryKey: "sneakers",
    policy: { perSize: true, hub1: { sizes: { 7: { target: 9, minQty: 5 } } } },
    expectedBefore: JSON.parse(before),
  });
  assert.equal(res.ok, true);
  assert.equal(policyAt(db, "sneakers").hub1.carriedOnly, undefined,
    "an existing leg must not acquire the flag — that would silently narrow a live policy");
  assert.deepEqual(res.seatedOnlyLocations, []);
  // The unscoped leg still arms a sneaker hub1 does NOT seat, which is what
  // "untouched" has to mean if it means anything.
  assert.equal(armedAt(db, "hub1", "k1", "7").target, 9);
});

test("adding a SECOND leg to an armed category gates only the new one", async () => {
  const db = makeFakeDb(world());
  const before = policyAt(db, "sneakers");
  const res = await call(db, {
    categoryKey: "sneakers",
    policy: { perSize: true,
      hub1: { sizes: { 7: { target: 5, minQty: 3 } } },
      hub2: { sizes: { 7: { target: 5, minQty: 3 } } } },
    expectedBefore: before,
  });
  assert.equal(policyAt(db, "sneakers").hub1.carriedOnly, undefined);
  assert.equal(policyAt(db, "sneakers").hub2.carriedOnly, true);
  assert.deepEqual(res.seatedOnlyLocations, ["hub2"]);
  // hub2 has no k1 cell, so the new leg reaches nothing there — which is the
  // point. hub1's old leg is unchanged and still reaches it.
  assert.equal(armedAt(db, "hub2", "k1", "7"), null);
  assert.equal(armedAt(db, "hub1", "k1", "7").target, 5);
});

test("an explicit carriedOnly:false on a NEW leg is overridden — no opt-out", async () => {
  // The gate is not a default. The 2026-09-08 arming did not ask for "all
  // products"; it simply never mentioned carriage — so a hatch reachable by
  // omission, or by one client sending false, is not a gate at all. Widening
  // is a second edit against an existing leg, where the effect is visible.
  const db = makeFakeDb(world());
  const res = await call(db, {
    categoryKey: "slides",
    policy: { perSize: true, hub1: { carriedOnly: false, sizes: { 6: { target: 3, minQty: 2 } } } },
  });
  assert.equal(res.ok, true);
  assert.equal(policyAt(db, "slides").hub1.carriedOnly, true);
  assert.deepEqual(res.seatedOnlyLocations, ["hub1"]);
  assert.equal(armedAt(db, "hub1", "s_none", "6"), null);
});

test("…and once the leg EXISTS, widening it is allowed", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  const res = await call(db, {
    categoryKey: "slides",
    policy: { perSize: true,
      hub1: { carriedOnly: false, sizes: { 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } } },
      hub2: policyAt(db, "slides").hub2 },
    expectedBefore: policyAt(db, "slides"),
  });
  assert.equal(res.ok, true);
  assert.equal(policyAt(db, "slides").hub1.carriedOnly, false);
  assert.deepEqual(res.seatedOnlyLocations, []);
  assert.equal(armedAt(db, "hub1", "s_none", "6").target, 3);
});

test("un-arming is not an arming — policy:null still deletes the entry", async () => {
  const db = makeFakeDb(world());
  await call(db, SLIDES_ARM);
  const res = await call(db, { categoryKey: "slides", policy: null, expectedBefore: policyAt(db, "slides") });
  assert.equal(res.ok, true);
  assert.equal(policyAt(db, "slides") ?? null, null);
  assert.equal(armedAt(db, "hub1", "s_both", "6"), null);
});

test("the dry run models exactly what the write would do", async () => {
  // A preview of an UNGATED policy would promise demand the save then refuses
  // to create — the preview is the number the owner decides on, so it has to be
  // the gated one.
  const db = makeFakeDb(world());
  const dry = await call(db, { ...SLIDES_ARM, dryRun: true });
  assert.equal(dry.after.hub1.carriedOnly, true);
  assert.equal(dry.after.hub2.carriedOnly, true);
  assert.deepEqual(dry.seatedOnlyLocations.sort(), ["hub1", "hub2"]);
  assert.equal(policyAt(db, "slides") ?? null, null, "a dry run writes nothing");
});

test("a group's new leg is gated too — and its members' own policies are not", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, {
    action: "setGroup", groupKey: "footwear-all",
    group: { label: "Footwear", armed: false, memberCategoryKeys: ["slides"],
      policy: { perSize: true, hub2: { sizes: { 6: { target: 2, minQty: 1 } } } } },
  });
  assert.equal(res.ok, true);
  const g = readAt(db.state.root, "config/refillEngine/policyGroups/footwear-all");
  assert.equal(g.policy.hub2.carriedOnly, true);
  assert.deepEqual(res.seatedOnlyLocations, ["hub2"]);
});
