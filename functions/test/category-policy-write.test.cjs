// ─── setCategoryPolicy — the write path ───────────────────────────────────────
// Run: cd functions && node --test test/category-policy-write.test.cjs
//
// Two of the assertions in this file are load-bearing beyond their own subject
// and are mutation-proven in scripts/mutation-proof-engine-policy.mjs:
//
//   M-SERVER  deleting the owner check must make tests fail
//   M-DRIFT   deleting the drift check must make tests fail
//
// Everything else pins the shape of a policy the engine will honour, and the
// two orderings that decide whether a bad save is recoverable: the history
// entry is written BEFORE the mutation, and the drift check is re-run
// immediately before it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy, normalizePolicy, sameValue, invalidateCensusCache } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "gunidmoh@gmail.com";
const NOW = Date.parse("2026-08-21T09:00:00.000Z");

// A miniature but structurally real world: two caps in a one-size category,
// PE sourced from hub2, hub2 from central, and the live caps-beanies entry as
// it actually stands (5 / 10, reorderPoint 0 on both legs).
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
          "caps-beanies": {
            hub2: { target: 10, minQty: 5, reorderPoint: 0 },
            "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 },
          },
        },
      },
    },
    settings: { productTaxonomy: { cats: {
      "caps-beanies": { key: "caps-beanies", label: "Caps & Beanies", sizeMode: "one" },
      "t-shirts": { key: "t-shirts", label: "T-Shirts", sizeMode: "list" },
      visors: { key: "visors", label: "Visors", sizeMode: "one" },
    } } },
    locations: { central: { kind: "hub" }, hub2: { kind: "hub" }, "marathon-pe": { kind: "shop" }, trophy: { kind: "shop" } },
    products: {
      c1: { name: "Black Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
      c2: { name: "Grey Beanie", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
      // c3 is the SOURCE-EMPTY case: stock exists at central, but PE's source
      // is hub2, and hub2 has none. The engine's actionable-only rule says PE
      // gets no card — the central->hub2 leg is created first and PE's leg
      // appears on the NEXT scan, once hub2 has received.
      c3: { name: "Red Cap", categoryKey: "caps-beanies", sizes: ["_"], productType: "clothing" },
    },
    stock: {
      central: { c1: { _: { qty: 40 } }, c2: { _: { qty: 0 } }, c3: { _: { qty: 20 } } },
      hub2: { c1: { _: { qty: 3 } }, c2: { _: { qty: 0 } }, c3: { _: { qty: 0 } } },
      "marathon-pe": { c1: { _: { qty: 1 } }, c2: { _: { qty: 0 } }, c3: { _: { qty: 0 } } },
    },
    ...overrides,
  };
}

const call = (db, data, opts = {}) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW, ...opts,
});
const policyAt = (db, key = "caps-beanies") => readAt(db.state.root, `config/refillEngine/categoryPolicy/${key}`);
const history = (db) => Object.values(readAt(db.state.root, "engine_policy_history") || {});

async function rejects(fn, code) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.httpsCode, code, `expected ${code}, got ${e.httpsCode}: ${e.message}`);
    return true;
  });
}

// ── GATE 3: THE OWNER CHECK ──────────────────────────────────────────────────
// Every identity that exists in this system, tried against the door. The staff
// case is the one that matters day to day: they sign in as
// {username}@marathon.internal, and there is no permission that promotes them.
test("only the owner's email may write the policy", async () => {
  const edit = { categoryKey: "caps-beanies", policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } } };
  for (const who of [undefined, null, "", "junid@marathon.internal", "ahmed@marathon.internal",
                     "someone@gmail.com", "GUNIDMOH@GMAIL.COM", "gunidmoh@gmail.com.evil.com"]) {
    const db = makeFakeDb(world());
    await rejects(() => applyCategoryPolicy({
      db, callerEmail: who, adminEmail: OWNER, data: edit, nowMs: NOW,
    }), "permission-denied");
    // Refused means REFUSED: no history entry, no mutation, not even a read-only
    // side effect. A gate that logs the attempt into the audit trail would let
    // a refused caller write to the database.
    assert.deepEqual(history(db), []);
    assert.equal(policyAt(db).hub2.reorderPoint, 0);
  }
});

test("an unconfigured admin identity refuses everyone rather than letting everyone in", async () => {
  const db = makeFakeDb(world());
  await rejects(() => applyCategoryPolicy({
    db, callerEmail: OWNER, adminEmail: undefined, data: { categoryKey: "caps-beanies", policy: null }, nowMs: NOW,
  }), "failed-precondition");
});

// ── VALIDATION ───────────────────────────────────────────────────────────────
test("rejects unknown category keys, and refuses visors outright", async () => {
  const db = makeFakeDb(world());
  const p = { hub2: { target: 4, minQty: 2 } };
  await rejects(() => call(db, { categoryKey: "not-a-category", policy: p }), "invalid-argument");
  await rejects(() => call(db, { categoryKey: "", policy: p }), "invalid-argument");
  await rejects(() => call(db, { categoryKey: 7, policy: p }), "invalid-argument");
  // visors IS in the taxonomy — it is refused because it deliberately carries
  // no policy, not because it is unknown. The two must not be conflated.
  await rejects(() => call(db, { categoryKey: "visors", policy: p }), "invalid-argument");
  assert.equal(readAt(db.state.root, "config/refillEngine/categoryPolicy/visors"), null);
});

test("minQty is required alongside target — and defaulted rather than demanded", async () => {
  const db = makeFakeDb(world());
  // Omitted → ceil(keep / 2), so it is never typed from scratch.
  const res = await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, reorderPoint: 0 }, "marathon-pe": { target: 5, reorderPoint: 0 } } });
  assert.equal(res.after.hub2.minQty, 5);
  assert.equal(res.after["marathon-pe"].minQty, 3);
  // Explicitly nonsensical values are still refused.
  await rejects(() => call(makeFakeDb(world()), { categoryKey: "caps-beanies", policy: { hub2: { target: 10, minQty: 11 } } }), "invalid-argument");
  await rejects(() => call(makeFakeDb(world()), { categoryKey: "caps-beanies", policy: { hub2: { target: 10, minQty: -1 } } }), "invalid-argument");
  await rejects(() => call(makeFakeDb(world()), { categoryKey: "caps-beanies", policy: { hub2: { target: 10, minQty: 2.5 } } }), "invalid-argument");
});

test("ranges: target must be a positive whole number, reorderPoint must sit below it", async () => {
  const bad = [
    { target: 0, minQty: 0 },
    { target: -3, minQty: 0 },
    { target: 2.5, minQty: 1 },
    { target: "10", minQty: 5 },
    { target: 100000, minQty: 5 },
    { target: 10, minQty: 5, reorderPoint: -1 },
    { target: 10, minQty: 5, reorderPoint: 10 },   // at target = does nothing
    { target: 10, minQty: 5, reorderPoint: 11 },   // above target = does nothing
    { target: 10, minQty: 5, reorderPoint: 1.5 },
    { target: 10, minQty: 5, nonsense: 1 },
  ];
  for (const entry of bad) {
    await rejects(() => call(makeFakeDb(world()), { categoryKey: "caps-beanies", policy: { hub2: entry } }), "invalid-argument");
  }
  // reorderPoint 0 is LEGAL and means "ask only when the shelf is empty" — the
  // opposite of absent. A truthiness test would have eaten it.
  const db = makeFakeDb(world());
  const ok = await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 0 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 3 } } });
  assert.equal(ok.after["marathon-pe"].reorderPoint, 3);
});

test("an unknown location is refused — a typo would arm nothing and say nothing", async () => {
  await rejects(() => call(makeFakeDb(world()), { categoryKey: "caps-beanies", policy: { "marathon-p": { target: 5, minQty: 3 } } }), "invalid-argument");
});

test("a blank Ask at is ABSENT, not zero", async () => {
  // Absent = top up eagerly. 0 = ask only at empty. Different policies, and the
  // normaliser must not collapse one into the other.
  assert.equal("reorderPoint" in normalizePolicy({ hub2: { target: 5, minQty: 3, reorderPoint: null } }).hub2, false);
  assert.equal("reorderPoint" in normalizePolicy({ hub2: { target: 5, minQty: 3 } }).hub2, false);
  assert.equal(normalizePolicy({ hub2: { target: 5, minQty: 3, reorderPoint: 0 } }).hub2.reorderPoint, 0);
});

// ── THE HAPPY PATH ───────────────────────────────────────────────────────────
test("a real edit: history first, then the mutation, then a post-verify", async () => {
  const seen = [];
  const db = makeFakeDb(world(), { afterWrite: (path) => { seen.push(path); } });
  const res = await call(db, {
    categoryKey: "caps-beanies",
    expectedBefore: world().config.refillEngine.categoryPolicy["caps-beanies"],
    policy: {
      hub2: { target: 10, minQty: 5, reorderPoint: 2 },
      "marathon-pe": { target: 5, minQty: 3, reorderPoint: 2 },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(policyAt(db).hub2.reorderPoint, 2);
  assert.equal(policyAt(db)["marathon-pe"].reorderPoint, 2);
  // Targets were NOT touched by a reorderPoint edit.
  assert.equal(policyAt(db).hub2.target, 10);
  assert.equal(policyAt(db)["marathon-pe"].target, 5);

  // ORDER: the rollback snapshot exists before the thing it protects against.
  const firstHistory = seen.findIndex((p) => p.startsWith("engine_policy_history"));
  const firstPolicy = seen.findIndex((p) => p.startsWith("config/refillEngine/categoryPolicy"));
  assert.ok(firstHistory >= 0 && firstPolicy >= 0);
  assert.ok(firstHistory < firstPolicy, "history must be written before the policy is mutated");

  const [h] = history(db);
  assert.equal(h.by, OWNER);
  assert.equal(h.byUid, "owner-uid");
  assert.equal(h.at, NOW);
  assert.equal(h.categoryKey, "caps-beanies");
  assert.equal(h.status, "applied");
  assert.equal(h.before.hub2.reorderPoint, 0);
  assert.equal(h.after.hub2.reorderPoint, 2);
  // The diff the owner was shown IS the diff that was recorded.
  assert.deepEqual(res.changes, h.changes);
  assert.deepEqual(h.changes.map((c) => [c.loc, c.field, c.from, c.to]).sort(), [
    ["hub2", "reorderPoint", 0, 2],
    ["marathon-pe", "reorderPoint", 0, 2],
  ].sort());
});

test("null un-arms the category, and the node is GONE rather than left empty", async () => {
  const db = makeFakeDb(world());
  await call(db, { categoryKey: "caps-beanies", policy: null });
  // Real RTDB has no empty containers. If this reads {} the fake is lying and
  // so is any assertion built on it.
  assert.equal(policyAt(db), null);
  // RTDB stores no nulls, so "after" is ABSENT on the history entry rather than
  // present-and-null. Asserting the absence is asserting the real shape.
  assert.equal(history(db)[0].after ?? null, null);
  assert.equal("after" in history(db)[0], false);
  assert.equal(history(db)[0].before.hub2.target, 10);
});

test("no change writes nothing at all — not even an audit entry", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, {
    categoryKey: "caps-beanies",
    policy: world().config.refillEngine.categoryPolicy["caps-beanies"],
  });
  assert.equal(res.noChange, true);
  assert.deepEqual(history(db), []);
});

test("dryRun answers the question and touches nothing", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, {
    categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 2 } },
  });
  assert.equal(res.dryRun, true);
  assert.deepEqual(history(db), []);
  assert.equal(policyAt(db).hub2.reorderPoint, 0, "a preview must not mutate the policy");
  // The preview is the model, per leg, before and after.
  assert.equal(res.preview.after.categoryKey, "caps-beanies");
  assert.equal(res.preview.after.products, 3);
  assert.equal(res.preview.after.legs.length, 2);
  const pe = res.preview.after.legs.find((l) => l.loc === "marathon-pe");
  // PE keeps 5, holds 1 of c1, and hub2 has 3 to give → one request for 4.
  // c2 is at 0 everywhere, so it parks as a reorder candidate, never a request.
  assert.equal(pe.wouldRequest, 1);
  // 4 short, but hub2 only holds 3 — the engine caps every card to what the
  // source can actually pick, so the ask is 3 and the remainder re-proposes
  // after hub2 is topped up. A model that said 4 would promise a card nobody
  // could complete.
  assert.equal(pe.unitsWanted, 3);
  assert.equal(pe.parkedNothingAnywhere, 1);
  // THE ACTIONABLE-ONLY RULE. c3 sits 5 short at PE with 20 units at central —
  // but PE draws from hub2, and hub2 has none. No card is written for work
  // nobody can complete; it parks until the central->hub2 leg lands. Without
  // this gate the model reported 293 day-one requests for caps-beanies where
  // the real engine creates 0.
  assert.equal(pe.parkedNoSource, 1);
  assert.equal(pe.wouldRequest, 1, "only c1 is fillable from hub2 right now");
  const hub2 = res.preview.after.legs.find((l) => l.loc === "hub2");
  // hub2 keeps 10 with "Ask at" 2. c1 sits at 3, above the point, so it stays
  // SILENT — that is what an Ask at buys. c3 is at 0 and central has 20, so it
  // is the one request.
  assert.equal(hub2.wouldRequest, 1);
  assert.equal(hub2.silent, 1);
  assert.equal(hub2.unitsWanted, 10);
  assert.equal(res.preview.after.centralOnHand, 60);
  // A dryRun is a question, so it is answered even when the world has moved.
  const drifted = makeFakeDb(world());
  await drifted.ref("config/refillEngine/categoryPolicy/caps-beanies/hub2/target").set(99);
  const ok = await call(drifted, { categoryKey: "caps-beanies", dryRun: true, expectedBefore: { nope: true },
    policy: { hub2: { target: 10, minQty: 5 } } });
  assert.equal(ok.dryRun, true);
});

// ── DRIFT ────────────────────────────────────────────────────────────────────
test("a stale editor is refused before anything is written", async () => {
  const db = makeFakeDb(world());
  // Somebody changed hub2 to 12 after this editor was opened.
  await db.ref("config/refillEngine/categoryPolicy/caps-beanies/hub2/target").set(12);
  await rejects(() => call(db, {
    categoryKey: "caps-beanies",
    expectedBefore: world().config.refillEngine.categoryPolicy["caps-beanies"],   // what the card rendered
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
  }), "failed-precondition");
  assert.equal(policyAt(db).hub2.target, 12, "the other person's change must survive");
  assert.deepEqual(history(db), []);
});

test("THE DRIFT CHECK — a change landing mid-save aborts the write and says so in the audit", async () => {
  // The window this protects is real: the preview pages the catalogue and can
  // take seconds. Move the world during it.
  let moved = false;
  const db = makeFakeDb(world(), {
    beforeRead: async (path, state) => {
      if (moved || !path.startsWith("products")) return;
      moved = true;
      state.root.config.refillEngine.categoryPolicy["caps-beanies"].hub2.target = 12;
    },
  });
  await rejects(() => call(db, {
    categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 2 } },
  }), "failed-precondition");
  // NOTHING was mutated…
  assert.equal(policyAt(db).hub2.target, 12);
  assert.equal(policyAt(db).hub2.reorderPoint, 0);
  // …and the abort is recorded, because a save that was attempted and refused
  // is exactly the event somebody will come looking for.
  const [h] = history(db);
  assert.equal(h.status, "aborted_on_drift");
  assert.equal(h.liveAtAbort.hub2.target, 12);
});

test("canonical equality ignores key order — a drift check that cries wolf gets switched off", () => {
  assert.equal(sameValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(sameValue(null, undefined), true);
  assert.equal(sameValue(0, null), false);
  assert.equal(sameValue({ reorderPoint: 0 }, {}), false, "absent and 0 are different policies");
});

// ── THE CENSUS ───────────────────────────────────────────────────────────────
// It exists so the card's list costs a few kilobytes instead of the catalogue
// plus the whole stock tree, downloaded onto a phone on a shop network every
// time the screen opens.
test("the census answers the list without the browser reading /products or /stock", async () => {
  invalidateCensusCache();
  const db = makeFakeDb(world());
  const res = await call(db, { action: "census" });
  assert.equal(res.action, "census");
  // Every taxonomy key AND every live map key, armed or not — an unarmed
  // category has to be visible or there is nothing to press "Set policy" on.
  const keys = res.categories.map((c) => c.key).sort();
  assert.deepEqual(keys, ["caps-beanies", "t-shirts", "visors"]);
  const cb = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(cb.products, 3);
  assert.equal(cb.units, 64);                       // 40+3+1 of c1, plus 20 of c3 at central
  assert.deepEqual(cb.armed.sort(), ["hub2", "marathon-pe"]);
  assert.equal(cb.carriage.hub2.carries, true);
  assert.equal(cb.carriage["marathon-pe"].carries, true);
  // Carriage is answered for exactly the locations the card can render — its
  // destinations, plus central. trophy is a real location but not a
  // destination in this config, so reading its stock would have been reading
  // it for nothing. Every location the editor offers a row for IS covered.
  assert.deepEqual(Object.keys(cb.carriage).sort(), ["central", "hub2", "marathon-pe"]);
  for (const loc of res.destinations) assert.ok(cb.carriage[loc], `carriage must cover destination ${loc}`);
  const ts = res.categories.find((c) => c.key === "t-shirts");
  assert.equal(ts.products, 0);
  assert.deepEqual(ts.armed, []);
  assert.equal(ts.entry, null);
  assert.equal(res.cap, 75);
  assert.deepEqual(res.destinations.sort(), ["hub2", "marathon-pe"]);
  // Read-only: a census must not be a way to write anything.
  assert.deepEqual(history(db), []);
  assert.equal(policyAt(db).hub2.reorderPoint, 0);
});

test("the census is behind the owner check too", async () => {
  const db = makeFakeDb(world());
  await rejects(() => applyCategoryPolicy({
    db, callerEmail: "ahmed@marathon.internal", adminEmail: OWNER, data: { action: "census" }, nowMs: NOW,
  }), "permission-denied");
});

test("an explicit row outranks the map, and the census counts it", async () => {
  // The thing that makes a map edit look like it did nothing.
  invalidateCensusCache();
  const w = world();
  w.stock_targets = { "marathon-pe": { c1: { _: { target: 9, minQty: 4 } } } };
  const db = makeFakeDb(w);
  const res = await call(db, { action: "census" });
  const cb = res.categories.find((c) => c.key === "caps-beanies");
  assert.equal(cb.overriddenProducts, 1);
  assert.equal(cb.overriddenCells, 1);
});

test("history comes back newest first, and an aborted save is in it", async () => {
  const db = makeFakeDb(world());
  await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } } });
  const res = await applyCategoryPolicy({
    db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", nowMs: NOW + 60000,
    data: { categoryKey: "caps-beanies", action: "census" },
  });
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].status, "applied");
  assert.equal(res.history[0].by, OWNER);
});

test("reverting a SUPERSEDED history entry is refused, not silently applied", async () => {
  // The card's Revert sends the entry's own `after` as expectedBefore. If the
  // category has moved on since — somebody made a second change, or a later
  // revert already ran — that no longer matches live and the write is refused.
  //
  // Without this the one-tap revert would be a one-tap way to silently discard
  // whatever happened after the entry being reverted, which is the opposite of
  // what a history list is for.
  const db = makeFakeDb(world());
  await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } } });
  const first = history(db).find((h) => h.status === "applied");
  // A second change lands on top.
  await applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", nowMs: NOW + 60000,
    data: { categoryKey: "caps-beanies", policy: { hub2: { target: 12, minQty: 6, reorderPoint: 2 } } } });
  assert.equal(policyAt(db).hub2.target, 12);

  await rejects(() => applyCategoryPolicy({
    db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", nowMs: NOW + 120000,
    data: { categoryKey: "caps-beanies", policy: first.before ?? null, expectedBefore: first.after ?? null },
  }), "failed-precondition");
  assert.equal(policyAt(db).hub2.target, 12, "the newer change must survive");

  // Reverting the LATEST entry still works — the guard is about being
  // superseded, not about reverts.
  const latest = history(db).filter((h) => h.status === "applied").sort((a, b) => b.at - a.at)[0];
  await applyCategoryPolicy({ db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u", nowMs: NOW + 180000,
    data: { categoryKey: "caps-beanies", policy: latest.before, expectedBefore: latest.after } });
  assert.equal(policyAt(db).hub2.target, 10);
});

// ── THE CENSUS CACHE ─────────────────────────────────────────────────────────
// A warm instance reuses the last answer for a couple of minutes, because the
// owner opening the screen, expanding a row, saving and looking again was four
// full catalogue reads in two minutes. It is per-instance and in-memory, so it
// is never shared between callers — but it IS shared between calls, which is
// precisely why the two ways it must be dropped are pinned here.
test("a warm instance reuses the census, and a save drops it", async () => {
  invalidateCensusCache();
  let productReads = 0;
  const db = makeFakeDb(world(), {
    beforeRead: (path) => { if (path === "products") productReads += 1; },
  });
  const first = await call(db, { action: "census" });
  assert.equal(first.cached, false);
  assert.equal(productReads, 1);

  const second = await call(db, { action: "census" });
  assert.equal(second.cached, true, "a second open inside the window must not re-read the catalogue");
  assert.equal(productReads, 1);

  // refresh:true is the owner asking for the truth right now.
  await call(db, { action: "census", refresh: true });
  assert.equal(productReads, 2);

  // A SAVE must never be followed by a stale list.
  await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 11, minQty: 6, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } } });
  const after = await call(db, { action: "census" });
  assert.equal(after.cached, false);
  assert.equal(after.categories.find((c) => c.key === "caps-beanies").entry.hub2.target, 11);
});

test("the audit trail is ALWAYS read live, never served from the cache", async () => {
  invalidateCensusCache();
  const db = makeFakeDb(world());
  await call(db, { action: "census" });
  await call(db, { categoryKey: "caps-beanies",
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 4 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } } });
  // Even on a cache hit the history must be current — a stale audit trail is
  // worse than a slow one.
  const a = await call(db, { action: "census" });
  const b = await call(db, { action: "census" });
  assert.equal(b.cached, true);
  assert.equal(b.history.length, 1);
  assert.deepEqual(a.history.map((h) => h.id), b.history.map((h) => h.id));
});

test("the census reads stock for destinations and central only", async () => {
  invalidateCensusCache();
  const read = [];
  const w = world();
  w.stock.trophy = { c1: { _: { qty: 7 } } };          // a real location the card cannot arm
  w.stock.in_transit = { c1: { _: { qty: 3 } } };
  const db = makeFakeDb(w, { beforeRead: (p) => { if (p.startsWith("stock/")) read.push(p); } });
  await call(db, { action: "census" });
  const locs = [...new Set(read.map((p) => p.split("/")[1]))].sort();
  // trophy and in_transit are not destinations in this config, so reading them
  // was reading them for nothing.
  assert.deepEqual(locs, ["central", "hub2", "marathon-pe"]);
});

// ── THE HOLE THAT HID THE HEADLINE NUMBER, AND THE DISTINCTION IT NEEDED ─────
// The engine's sizesFor STARTS from the explicit rows that already exist for a
// cell and then adds the map's sizes. A model that derived its size list from
// the map alone walked only "_", so a category whose products carry legacy
// LETTER rows reported "asks for nothing" while the engine issued real requests
// off those rows.
//
// Fixing that naively then over-corrected: it counted every such row as an
// OVERRIDE. Measured on the live estate, caps-beanies has 188 explicit rows on
// 94 products and every one is on a letter size left by the headwear one-size
// collapse — while the map is one-size and speaks only for "_". Reported as
// overrides that reads "94 products ignore your numbers" (false, and it would
// have stopped a correct change). So the two are counted separately.
test("a row on a size the map SPEAKS FOR is an override", async () => {
  invalidateCensusCache();
  const w = world();
  w.stock_targets = { "marathon-pe": { c1: { _: { target: 9, minQty: 4 } } } };
  const db = makeFakeDb(w);
  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3 } } });
  const pe = res.preview.after.legs.find((l) => l.loc === "marathon-pe");
  assert.equal(pe.overrides, 1, 'a "_" row in a one-size category beats the map');
  assert.equal(pe.legacyRows, 0);
  assert.equal(res.preview.after.overriddenProducts, 1);
});

test("a row on a size the map does NOT speak for is a legacy row, not an override", async () => {
  invalidateCensusCache();
  const w = world();
  w.products.c1.sizes = ["_", "L"];
  w.stock["marathon-pe"].c1 = { _: { qty: 1 }, L: { qty: 0 } };
  w.stock.hub2.c1 = { _: { qty: 3 }, L: { qty: 10 } };
  w.stock_targets = { "marathon-pe": { c1: { L: { target: 6, minQty: 3 } } } };
  const db = makeFakeDb(w);

  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5, reorderPoint: 2 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 2 } } });
  const pe = res.preview.after.legs.find((l) => l.loc === "marathon-pe");
  // The map is one-size; an "L" row contradicts nothing it says.
  assert.equal(pe.overrides, 0);
  assert.equal(res.preview.after.overriddenProducts, 0);
  assert.equal(pe.legacyRows, 1);
  assert.equal(res.preview.after.legacyRowProducts, 1);
  // …but it is still WALKED, and still produces the request the engine would:
  // PE wants 6 of L, holds none, hub2 has 10. This is the half the original
  // model missed entirely.
  assert.ok(pe.wouldRequest >= 1, "the legacy row's own deficit must be modelled");
  assert.ok(pe.unitsWanted >= 6);

  const cen = await call(db, { action: "census" });
  const cb = cen.categories.find((c) => c.key === "caps-beanies");
  assert.equal(cb.overriddenProducts, 0);
  assert.equal(cb.legacyRowProducts, 1);
});

test("a size declared twice under one encoded key is walked once", async () => {
  // "5.5" and "5 5" both encode to 5_5. Walked twice the cell is double-counted
  // and double-reserved against the source.
  invalidateCensusCache();
  const w = world();
  w.config.refillEngine.categoryPolicy["caps-beanies"].perSize = true;
  w.products.c1.sizes = ["5.5", "5 5"];
  w.stock.hub2.c1 = { "5_5": { qty: 0 } };
  w.stock["marathon-pe"].c1 = { "5_5": { qty: 0 } };
  w.stock.central.c1 = { "5_5": { qty: 40 } };
  const db = makeFakeDb(w);
  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { perSize: true, hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3 } } });
  const hub2 = res.preview.after.legs.find((l) => l.loc === "hub2");
  assert.equal(hub2.cells, 1, "one encoded key is one cell, however many ways it is spelled");
});

// ── ENGINE DEFAULTS, NOT CONVENIENT ONES ─────────────────────────────────────
test("an absent maxUnitsPerIntent models the engine's 20, not unlimited", async () => {
  invalidateCensusCache();
  const w = world();
  delete w.config.refillEngine.maxUnitsPerIntent;
  w.stock.central.c1 = { _: { qty: 500 } };
  w.stock.hub2.c1 = { _: { qty: 0 } };
  const db = makeFakeDb(w);
  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 200, minQty: 100 }, "marathon-pe": { target: 5, minQty: 3 } } });
  const hub2 = res.preview.after.legs.find((l) => l.loc === "hub2");
  // Each cell is 200 short with stock upstream — but the engine caps ONE intent
  // at 20 units. Reporting the raw deficit would have fabricated a Central
  // shortfall out of nothing.
  assert.ok(hub2.wouldRequest > 0);
  assert.equal(hub2.unitsWanted, hub2.wouldRequest * 20);
});

test("an absent maxIntentsPerRun models the engine's 200, so the cap warning still works", async () => {
  invalidateCensusCache();
  const w = world();
  delete w.config.refillEngine.maxIntentsPerRun;
  const db = makeFakeDb(w);
  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3 } } });
  // null here would have made exceedsCap permanently false AND left the card's
  // "Refills per scan" tile showing a loading ellipsis forever.
  assert.equal(res.preview.after.cap, 200);
  assert.equal(res.preview.after.exceedsCap, false);
});

// ── UN-ARMING MUST BE SAID, NOT IMPLIED ──────────────────────────────────────
test("omitting `policy` is refused; only an explicit null un-arms", async () => {
  const db = makeFakeDb(world());
  // A truncated payload, a renamed field, a half-built call — none of them may
  // be indistinguishable from "delete this category's policy".
  await rejects(() => call(db, { categoryKey: "caps-beanies" }), "invalid-argument");
  assert.equal(policyAt(db).hub2.target, 10, "a dropped field must not delete a live policy");
  assert.deepEqual(history(db), []);
  // The off switch itself still works, said out loud.
  await call(db, { categoryKey: "caps-beanies", policy: null });
  assert.equal(policyAt(db), null);
});

// ── AN ARMED LOCATION THAT IS NOT A CONFIGURED DESTINATION ───────────────────
// The census used to read /stock_targets only for Object.keys(config.mode). An
// armed location outside that set got no targets map at all, so resolveTarget
// found no explicit rows and the category reported "0 overridden" — while being
// fully overridden there.
test("overrides are counted at an armed location even if it is not in config.mode", async () => {
  invalidateCensusCache();
  const w = world();
  w.config.refillEngine.categoryPolicy["caps-beanies"].trophy = { target: 4, minQty: 2 };
  w.stock.trophy = { c1: { _: { qty: 0 } } };
  w.stock_targets = { trophy: { c1: { _: { target: 9, minQty: 4 } } } };
  const db = makeFakeDb(w);
  const res = await call(db, { action: "census" });
  const cb = res.categories.find((c) => c.key === "caps-beanies");
  assert.ok(cb.armed.includes("trophy"));
  assert.equal(cb.overriddenProducts, 1, "the trophy row must be seen even though trophy has no mode entry");
  assert.equal(cb.overriddenCells, 1);
  assert.ok(cb.carriage.trophy, "and carriage must be answered for it");
});

// ── THE FAKE'S OWN FIDELITY ──────────────────────────────────────────────────
// Two behaviours a convenient fake gets wrong, both of which would let a real
// bug pass here. Pinned because the fake is the only database these tests see.
test("the fake pages in RTDB's key order, not lexicographic order", async () => {
  const { rtdbKeyOrder } = require("./helpers/fake-rtdb.cjs");
  // Integer-parseable keys sort NUMERICALLY and come FIRST. Lexicographically
  // "10" < "9", which is what makes a paging cursor walk backwards forever.
  assert.deepEqual(rtdbKeyOrder({ "9": 1, "10": 1, "2": 1, b: 1, a: 1 }), ["2", "9", "10", "a", "b"]);

  // And the paged reader must return every record exactly once over such a node.
  const db = makeFakeDb({ n: Object.fromEntries([...Array(12)].map((_, i) => [String(i + 1), { v: i + 1 }])) });
  const { readMapPaged } = require("../lib/category-policy-write.cjs");
  const out = await readMapPaged(db, "n", 5);
  assert.equal(Object.keys(out).length, 12);
  assert.deepEqual(Object.keys(out).map(Number).sort((a, b) => a - b), [...Array(12)].map((_, i) => i + 1));
});

test("the fake leaves array holes rather than re-indexing, as RTDB does", () => {
  const { normalize } = require("./helpers/fake-rtdb.cjs");
  // RTDB stores an array as index-keyed children; dropping a null element
  // leaves a hole and the survivors keep their indices. A fake that compacted
  // would hand a dense array to a caller that will meet a sparse one in
  // production.
  const out = normalize([{ a: 1 }, null, { c: 3 }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].a, 1);
  assert.equal(1 in out, false, "index 1 must be a HOLE, not a shifted element");
  assert.equal(out[2].c, 3);
  assert.equal(normalize([null, null]), null);
});

// ── A LEG THE SCAN WILL NOT WRITE ────────────────────────────────────────────
test("a non-live destination's requests are reported separately from the live ones", async () => {
  invalidateCensusCache();
  const w = world();
  w.config.refillEngine.mode.hub1 = "shadow";
  w.config.refillEngine.routes.hub1 = "central";
  w.config.refillEngine.categoryPolicy["caps-beanies"].hub1 = { target: 6, minQty: 3 };
  w.locations.hub1 = { kind: "hub" };
  w.stock.hub1 = { c1: { _: { qty: 0 } } };
  const db = makeFakeDb(w);
  const res = await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3 }, hub1: { target: 6, minQty: 3 } } });
  const m = res.preview.after;
  const hub1 = m.legs.find((l) => l.loc === "hub1");
  assert.equal(hub1.mode, "shadow");
  assert.ok(hub1.wouldRequest > 0, "the engine still computes intents for a shadow destination");
  // …but the scan writes nothing for it, so the two numbers must differ and the
  // caller must be able to say so.
  assert.ok(m.liveRequests < m.totalRequests);
  assert.deepEqual(m.nonLiveLegs.map((l) => l.loc), ["hub1"]);
  assert.equal(m.nonLiveLegs[0].mode, "shadow");
});

// ── resolvesMapCells EXCLUDES BOTH KINDS OF EXPLICIT ROW ─────────────────────
test("a legacy row does not count as resolving the map", async () => {
  invalidateCensusCache();
  const w = world();
  w.products.c1.sizes = ["_", "L"];
  w.stock["marathon-pe"].c1 = { _: { qty: 1 }, L: { qty: 0 } };
  w.stock_targets = { "marathon-pe": { c1: { L: { target: 6, minQty: 3 } } } };
  const db = makeFakeDb(w);
  const res = await call(db, { action: "census" });
  const cb = res.categories.find((c) => c.key === "caps-beanies");
  // A legacy row resolves source:"explicit" exactly as an override does. It is
  // not the map answering, so it must not be counted as the map answering.
  assert.equal(cb.legacyRowCells, 1);
  assert.equal(cb.overriddenCells, 0);
  const totalCells = res.categories.find((c) => c.key === "caps-beanies");
  assert.ok(totalCells.resolvesMapCells >= 0);
  // The identity that must hold: map-resolved + overrides + legacy = all cells.
  const m = (await call(db, { categoryKey: "caps-beanies", dryRun: true,
    policy: { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3 } } })).preview.after;
  const cells = m.legs.reduce((n, l) => n + l.cells, 0);
  const ovr = m.legs.reduce((n, l) => n + l.overrides, 0);
  const leg = m.legs.reduce((n, l) => n + l.legacyRows, 0);
  assert.equal(cells - ovr - leg, cb.resolvesMapCells);
});

// ── PER-SIZE DIFFS AND THE NO-CHANGE BACKSTOP (PR #448 review) ───────────────
// The diff was blind to `sizes` maps: adding a tranche size, or editing one
// size's target through the card, diffed to [] and the no-change short-circuit
// silently DISCARDED the write. And a shape-only change the legs don't name —
// scrubbing the retired carriedOnly key — must still write, on the byte-same
// test, with a synthetic leg for the audit trail.
const { diffCategoryPolicy } = require("../lib/category-policy.cjs");

function perSizeWorld() {
  return {
    config: {
      refillEngine: {
        maxIntentsPerRun: 75, maxUnitsPerIntent: 20,
        mode: { hub1: "live" }, routes: { hub1: "central" },
        ruleBasedTargets: false,
        categoryPolicy: {
          sneakers: { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 } }, carriedOnly: true } },
        },
      },
    },
    products: {
      s1: { id: "s1", name: "Runner", category: "Footwear", categoryKey: "sneakers", sizes: ["3", "11"] },
    },
    stock: { hub1: { s1: { 3: { qty: 1 } } }, central: { s1: { 3: { qty: 5 } } } },
    stock_targets: {},
  };
}

test("a per-size edit produces a named diff leg (the card can never again discard it as no-change)", () => {
  const before = { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 } } } };
  const edited = { perSize: true, hub1: { sizes: { 3: { target: 5, minQty: 1, reorderPoint: 1 } } } };
  const legs = diffCategoryPolicy(before, edited);
  assert.ok(legs.some((l) => l.loc === "hub1" && l.field === "sizes.3.target" && l.from === 2 && l.to === 5),
    `expected a sizes.3.target leg, got ${JSON.stringify(legs)}`);
  const grown = { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 }, 11: { target: 2, minQty: 1, reorderPoint: 1 } } } };
  const trancheLegs = diffCategoryPolicy(before, grown);
  assert.ok(trancheLegs.some((l) => l.field === "sizes.11" && l.to === "armed"),
    `a tranche adding size 11 must diff, got ${JSON.stringify(trancheLegs)}`);
});

test("the carriedOnly scrub WRITES (byte-same is the only no-change), with a synthetic shape leg", async () => {
  const db = makeFakeDb(perSizeWorld());
  const scrubbed = { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 } } } };
  const res = await applyCategoryPolicy({
    db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u1",
    data: { categoryKey: "sneakers", policy: scrubbed },
    nowMs: NOW,
  });
  assert.equal(res.ok, true);
  assert.ok(!res.noChange, "a shape-only change must not be eaten as no-change");
  assert.ok(res.changes.some((l) => l.field === "shape"), "the synthetic leg names the scrub for the audit trail");
  const live = readAt(db.state.root, "config/refillEngine/categoryPolicy/sneakers");
  assert.deepEqual(live, scrubbed, "the stale flag is gone from the live entry");
});

test("a genuinely identical per-size save is still a clean no-change (no phantom history)", async () => {
  // The live entry here has no stale flag (post-scrub state) — an identical
  // save must short-circuit; the validator refuses the flag itself, so the
  // pre-scrub identical case can no longer even be submitted.
  const w = perSizeWorld();
  w.config.refillEngine.categoryPolicy.sneakers = { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 } } } };
  const db = makeFakeDb(w);
  const same = { perSize: true, hub1: { sizes: { 3: { target: 2, minQty: 1, reorderPoint: 1 } } } };
  const res = await applyCategoryPolicy({
    db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "u1",
    data: { categoryKey: "sneakers", policy: same },
    nowMs: NOW,
  });
  assert.equal(res.ok, true);
  assert.equal(res.noChange, true, "byte-same in, byte-same out");
});
