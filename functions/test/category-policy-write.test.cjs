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
const { applyCategoryPolicy, normalizePolicy, sameValue } = require("../lib/category-policy-write.cjs");
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
    },
    stock: {
      central: { c1: { _: { qty: 40 } }, c2: { _: { qty: 0 } } },
      hub2: { c1: { _: { qty: 3 } }, c2: { _: { qty: 0 } } },
      "marathon-pe": { c1: { _: { qty: 1 } }, c2: { _: { qty: 0 } } },
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
  assert.equal(res.preview.after.products, 2);
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
  assert.equal(res.preview.after.centralOnHand, 40);
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
