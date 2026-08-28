// ─── setProductTargets — the per-product row write ───────────────────────────
// Run: cd functions && node --test test/product-targets.test.cjs
//
// This is the ONE action behind every explicit-row change the Engine Policy
// card makes: arming a product, overriding one size, switching a location off,
// clearing an override, re-seating. The client half is
// src/components/stock/targetOverride.js and its own suite; this file pins the
// half that decides what actually lands on /stock_targets.
//
// Load-bearing beyond their own subject, and mutation-proven in
// scripts/mutation-proof-target-override.mjs:
//
//   M-DRIFT-ROW    deleting the per-size drift check must make tests fail
//   M-FOREIGN      deleting the foreign-row confirmation must make tests fail
//   M-NEST         deleting the prevRow non-nesting rule must make tests fail
//   M-ZERO         refusing target 0 must make tests fail (it is the off switch)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyCategoryPolicy } = require("../lib/category-policy-write.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");

const OWNER = "gunidmoh@gmail.com";
const NOW = Date.parse("2026-08-28T09:00:00.000Z");
const OVERRIDE_SOURCE = "policy_target";

function world(overrides = {}) {
  return {
    config: {
      refillEngine: {
        maxIntentsPerRun: 75,
        mode: { hub2: "live", trophy: "live" },
        routes: { trophy: "hub2", hub2: "central" },
        ruleBasedTargets: false,
        categoryPolicy: {
          "soccer-jerseys": { perSize: true, trophy: { sizes: {
            S: { target: 1, minQty: 1 }, M: { target: 2, minQty: 1 }, L: { target: 2, minQty: 1 },
          } } },
        },
      },
    },
    settings: { productTaxonomy: { cats: {
      "soccer-jerseys": { key: "soccer-jerseys", label: "Soccer Jerseys", sizeMode: "list", sizes: ["S", "M", "L"] },
    } } },
    locations: { central: { kind: "hub" }, hub2: { kind: "hub" }, trophy: { kind: "shop" } },
    products: { j1: { name: "Home Jersey", categoryKey: "soccer-jerseys", sizes: ["S", "M", "L"], productType: "clothing" } },
    stock: { trophy: { j1: { S: { qty: 1 }, M: { qty: 0 }, L: { qty: 1 } } }, central: { j1: { M: { qty: 20 } } } },
    ...overrides,
  };
}

const call = (db, data, opts = {}) => applyCategoryPolicy({
  db, callerEmail: OWNER, adminEmail: OWNER, callerUid: "owner-uid", data, nowMs: NOW, ...opts,
});
const rowsAt = (db, loc = "trophy", pid = "j1") => readAt(db.state.root, `stock_targets/${loc}/${pid}`) || {};
const history = (db) => Object.values(readAt(db.state.root, "engine_policy_history") || {});

async function rejects(fn, code) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.httpsCode, code, `expected ${code}, got ${e.httpsCode}: ${e.message}`);
    return true;
  });
}

const base = (extra = {}) => ({ action: "setProductTargets", loc: "trophy", pid: "j1", ...extra });

// ── ARMING ONE PRODUCT, SIZE BY SIZE ─────────────────────────────────────────
test("writes one row per size, each with its own numbers", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, base({
    rows: [
      { sizeKey: "S", target: 1, minQty: 1 },
      { sizeKey: "M", target: 3, minQty: 2 },
      { sizeKey: "L", target: 2, minQty: 1 },
    ],
    expected: { S: null, M: null, L: null },
  }));
  assert.equal(res.ok, true);
  const rows = rowsAt(db);
  assert.deepEqual(Object.keys(rows).sort(), ["L", "M", "S"]);
  assert.equal(rows.M.target, 3);
  assert.equal(rows.M.minQty, 2);
  assert.equal(rows.M.source, OVERRIDE_SOURCE);
  assert.equal(rows.M.prevAbsent, true);
  assert.equal(rows.M.setBy, OWNER);
  // THE SERVER'S CLOCK, never the caller's. Every till and every browser on
  // this estate disagrees with the database about the time.
  assert.equal(rows.M.setAt, new Date(NOW).toISOString());
});

// ── target 0 IS THE OFF SWITCH AND MUST BE ACCEPTED (M-ZERO) ──────────────────
test("target 0 is legal — it is what switching a shop off writes", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, base({
    rows: [{ sizeKey: "S", target: 0, minQty: 0 }, { sizeKey: "M", target: 0, minQty: 0 }, { sizeKey: "L", target: 0, minQty: 0 }],
    expected: { S: null, M: null, L: null },
  }));
  assert.equal(res.ok, true);
  assert.equal(rowsAt(db).M.target, 0);
  // and the engine's answer for that cell is now an explicit stop
  assert.equal(res.preview.sizes.find((s) => s.sizeKey === "M").after, 0);
  assert.equal(res.preview.sizes.find((s) => s.sizeKey === "M").afterSource, "explicit");
});

test("a negative target, a fraction and a minQty above target are all refused", async () => {
  const db = makeFakeDb(world());
  for (const row of [{ sizeKey: "S", target: -1, minQty: 0 }, { sizeKey: "S", target: 1.5, minQty: 1 },
    { sizeKey: "S", target: 501, minQty: 1 }, { sizeKey: "S", target: 2, minQty: 3 }]) {
    await rejects(() => call(db, base({ rows: [row], expected: { S: null } })), "invalid-argument");
  }
  assert.deepEqual(rowsAt(db), {});
});

test('"Ask at" must be below Keep, and a size key must be in its stored form', async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 2, minQty: 1, reorderPoint: 2 }], expected: { S: null } })), "invalid-argument");
  await rejects(() => call(db, base({ rows: [{ sizeKey: "5.5", target: 2, minQty: 1 }], expected: { "5.5": null } })), "invalid-argument");
});

// ── THE PREVIEW IS THE ENGINE'S OWN ANSWER ───────────────────────────────────
test("a dry run writes nothing and says what the next scan would resolve", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, base({
    rows: [{ sizeKey: "M", target: 9, minQty: 5 }], expected: { M: null }, dryRun: true,
  }));
  assert.equal(res.dryRun, true);
  assert.deepEqual(rowsAt(db), {});
  assert.equal(history(db).length, 0);
  const m = res.preview.sizes.find((s) => s.sizeKey === "M");
  // BEFORE is the category policy; AFTER is the explicit row that beats it.
  assert.equal(m.before, 2);
  assert.equal(m.beforeSource, "category_policy");
  assert.equal(m.after, 9);
  assert.equal(m.afterSource, "explicit");
  // and the sizes nobody touched do not move
  assert.equal(res.preview.sizes.filter((s) => s.changed).length, 1);
});

test("the preview counts the open refills a 0 would retract", async () => {
  const db = makeFakeDb(world());
  const res = await call(db, base({
    rows: [{ sizeKey: "S", target: 0, minQty: 0 }, { sizeKey: "L", target: 0, minQty: 0 }],
    expected: { S: null, L: null }, dryRun: true,
  }));
  assert.equal(res.preview.retracts, 2);
});

// ── BLANK MEANS INHERIT: A REMOVAL IS A REAL DELETE, AND IT IS AUDITED ───────
test("clearing a size removes its row, and the size falls back to the category", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 9, minQty: 5, source: OVERRIDE_SOURCE, prevAbsent: true },
  } } } }));
  const res = await call(db, base({ rows: [], remove: ["M"], expected: { M: { target: 9, minQty: 5, reorderPoint: null } } }));
  assert.equal(res.ok, true);
  assert.equal(rowsAt(db).M, undefined);
  const m = res.preview.sizes.find((s) => s.sizeKey === "M");
  assert.equal(m.after, 2);
  assert.equal(m.afterSource, "category_policy");
  // the full previous row is in the history, so one tap puts it back
  const h = history(db)[0];
  assert.equal(h.kind, "targets");
  assert.equal(h.status, "applied");
  assert.deepEqual(h.before.find((b) => b.sizeKey === "M").row.target, 9);
});

// ── M-FOREIGN: A ROW THIS CARD DID NOT WRITE IS NOT REMOVED SILENTLY ─────────
test("removing a hand-made row needs an explicit confirmation", async () => {
  const w = world({ stock_targets: { trophy: { j1: { M: { target: 6, minQty: 3, source: "hand" } } } } });
  const db = makeFakeDb(w);
  await rejects(() => call(db, base({ rows: [], remove: ["M"], expected: { M: { target: 6, minQty: 3, reorderPoint: null } } })),
    "failed-precondition");
  assert.equal(rowsAt(db).M.target, 6, "nothing was removed");
  // With the confirmation the screen collected, it goes — and the row is in the
  // history in full.
  const res = await call(db, base({ rows: [], remove: ["M"],
    expected: { M: { target: 6, minQty: 3, reorderPoint: null } }, allowRemoveForeign: true }));
  assert.equal(res.ok, true);
  assert.equal(rowsAt(db).M, undefined);
  assert.deepEqual(history(db)[0].before[0].row, { target: 6, minQty: 3, source: "hand" });
});

test("a row this card wrote is cleared without any confirmation", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 0, minQty: 0, source: "seating_off", prevAbsent: true },
  } } } }));
  const res = await call(db, base({ rows: [], remove: ["M"], expected: { M: { target: 0, minQty: 0, reorderPoint: null } } }));
  assert.equal(res.ok, true);
  assert.equal(rowsAt(db).M, undefined);
});

// ── M-NEST: THE ROW A ROW REPLACED IS CARRIED THROUGH, NEVER NESTED ─────────
test("overriding twice still remembers the ORIGINAL row", async () => {
  const hand = { target: 6, minQty: 3, source: "hand" };
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: { M: hand } } } }));
  await call(db, base({ rows: [{ sizeKey: "M", target: 4, minQty: 2 }], expected: { M: { target: 6, minQty: 3, reorderPoint: null } } }));
  assert.deepEqual(rowsAt(db).M.prevRow, hand);
  await call(db, base({ rows: [{ sizeKey: "M", target: 5, minQty: 3 }],
    expected: { M: { target: 4, minQty: 2, reorderPoint: null } } }));
  // NOT the { target: 4 } row this card wrote a moment ago.
  assert.deepEqual(rowsAt(db).M.prevRow, hand);
  assert.equal(rowsAt(db).M.prevAbsent, undefined);
});

// ── M-DRIFT-ROW ──────────────────────────────────────────────────────────────
test("a row that changed underneath is refused, per size, and nothing is written", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: { M: { target: 6, minQty: 3, source: "hand" } } } } }));
  await rejects(() => call(db, base({
    rows: [{ sizeKey: "S", target: 1, minQty: 1 }, { sizeKey: "M", target: 4, minQty: 2 }],
    expected: { S: null, M: { target: 2, minQty: 1, reorderPoint: null } },   // stale
  })), "failed-precondition");
  assert.equal(rowsAt(db).S, undefined, "the whole batch is refused, not just the drifted size");
  assert.equal(rowsAt(db).M.target, 6);
});

// The EARLY check is what makes a drift refusal cost nothing: it fires before
// the history entry, before the preview's reads, before anything is written
// anywhere. Asserting only that the call is refused proves nothing about it —
// the late check would refuse it too, one history entry later. (M-DRIFT-ROW.)
test("the drift refusal fires BEFORE any history entry is written", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: { M: { target: 6, minQty: 3, source: "hand" } } } } }));
  await rejects(() => call(db, base({
    rows: [{ sizeKey: "M", target: 4, minQty: 2 }],
    expected: { M: { target: 2, minQty: 1, reorderPoint: null } },
  })), "failed-precondition");
  assert.equal(history(db).length, 0, "a refusal this cheap must leave no trace at all");
});

// And the LATE one is what actually protects the write: the preview above
// issues live reads and takes real time, and a concurrent write landing in that
// window would otherwise be reverted with no error and no trace. Proven by
// changing the row AFTER the early check has read it. (M-DRIFT-LATE.)
test("a row that changes between the check and the write aborts, and says so in the history", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: { M: { target: 6, minQty: 3, source: "hand" } } } } }));
  const path = "stock_targets/trophy/j1/M";
  const realRef = db.ref.bind(db);
  let reads = 0;
  db.ref = (p) => {
    if (p === path) {
      reads += 1;
      // The second read of this row is the re-check immediately before the
      // mutation. Somebody else's write lands in that window.
      if (reads === 2) db.state.root.stock_targets.trophy.j1.M = { target: 99, minQty: 9, source: "someone-else" };
    }
    return realRef(p);
  };
  await rejects(() => call(db, base({
    rows: [{ sizeKey: "M", target: 4, minQty: 2 }],
    expected: { M: { target: 6, minQty: 3, reorderPoint: null } },
  })), "failed-precondition");
  assert.equal(readAt(db.state.root, path).target, 99, "nothing was written over it");
  assert.equal(history(db)[0].status, "aborted_on_drift");
  assert.equal(history(db)[0].driftedSize, "M");
});

test("expected is required, and must name every size the call touches", async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 1, minQty: 1 }] })), "invalid-argument");
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 1, minQty: 1 }, { sizeKey: "M", target: 1, minQty: 1 }],
    expected: { S: null } })), "invalid-argument");
});

test("a size named twice, or both written and cleared, is refused", async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 1, minQty: 1 }, { sizeKey: "S", target: 2, minQty: 1 }], expected: { S: null } })), "invalid-argument");
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 1, minQty: 1 }], remove: ["S"], expected: { S: null } })), "invalid-argument");
});

test("an unknown location and a path-shaped key are refused before any read", async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, base({ loc: "nowhere", rows: [{ sizeKey: "S", target: 1, minQty: 1 }], expected: { S: null } })), "invalid-argument");
  await rejects(() => call(db, base({ pid: "a/b", rows: [{ sizeKey: "S", target: 1, minQty: 1 }], expected: { S: null } })), "invalid-argument");
});

// ── NO-CHANGE, AND THE HISTORY ───────────────────────────────────────────────
test("re-saving the same numbers writes nothing and no history entry", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: { M: { target: 4, minQty: 2, source: OVERRIDE_SOURCE } } } } }));
  const res = await call(db, base({ rows: [{ sizeKey: "M", target: 4, minQty: 2 }], expected: { M: { target: 4, minQty: 2, reorderPoint: null } } }));
  assert.equal(res.noChange, true);
  assert.equal(history(db).length, 0);
});

test("the history entry is written BEFORE the mutation and names the product", async () => {
  const db = makeFakeDb(world());
  await call(db, base({ rows: [{ sizeKey: "M", target: 4, minQty: 2 }], expected: { M: null } }));
  const h = history(db)[0];
  assert.equal(h.kind, "targets");
  assert.equal(h.loc, "trophy");
  assert.equal(h.pid, "j1");
  assert.equal(h.by, OWNER);
  assert.equal(h.status, "applied");
  // `from: null` is written and read back ABSENT — RTDB does not store a null.
  // Asserting the stored shape rather than the in-memory one is the point: this
  // is what a revert six weeks from now actually reads.
  assert.deepEqual(h.changes, [
    { sizeKey: "M", field: "target", to: 4 },
    { sizeKey: "M", field: "minQty", to: 2 },
  ]);
  // The state this write PRODUCED, beside the state it replaced — what a revert
  // drift-checks against.
  assert.deepEqual(h.after, [{ sizeKey: "M", row: { target: 4, minQty: 2 } }]);
});

// ── PROVENANCE THE ROW CARRIED IS NOT DROPPED ────────────────────────────────
test("fields the engine does not read are preserved on an edit", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 2, minQty: 1, source: "manual", batchId: "decision-queue", approvedAt: "2026-01-01" },
  } } } }));
  await call(db, base({ rows: [{ sizeKey: "M", target: 5, minQty: 3 }], expected: { M: { target: 2, minQty: 1, reorderPoint: null } } }));
  assert.equal(rowsAt(db).M.batchId, "decision-queue");
  assert.equal(rowsAt(db).M.approvedAt, "2026-01-01");
  assert.equal(rowsAt(db).M.source, OVERRIDE_SOURCE, "the stamp says who wrote the numbers that are there now");
});

test("a blank Ask at REMOVES the field rather than leaving a stale one behind", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 4, minQty: 2, reorderPoint: 1, source: OVERRIDE_SOURCE },
  } } } }));
  await call(db, base({ rows: [{ sizeKey: "M", target: 6, minQty: 3 }], expected: { M: { target: 4, minQty: 2, reorderPoint: 1 } } }));
  assert.equal("reorderPoint" in rowsAt(db).M, false);
});

// ── THE CALLER CHECK APPLIES HERE TOO ────────────────────────────────────────
test("a caller without engine_policy is refused before anything is read", async () => {
  const db = makeFakeDb(world());
  await rejects(() => call(db, base({ rows: [{ sizeKey: "S", target: 1, minQty: 1 }], expected: { S: null } }),
    { callerEmail: "someone@else.com", callerUid: "u2" }), "permission-denied");
  assert.deepEqual(rowsAt(db), {});
});

// ═════════════════════════════════════════════════════════════════════════════
// ARMING KIDS SHOES WITH ADULT NUMBERS ARMS NOTHING — PROVEN AGAINST THE ENGINE
// ═════════════════════════════════════════════════════════════════════════════
// This is the reason kids-shoes is armed as its own category and never inside
// the adult footwear group. The adult run is 3-13; the kids run is 26-33; they
// share not one size. A group is ONE set of numbers keyed by size, so a kids
// product under adult numbers resolves nothing at all — silently, with an armed
// chip on the screen saying it is managed.
const { resolveTarget } = require("../lib/refill-engine.cjs");

test("adult numbers on a kids-shoes product resolve NOTHING, size by size", () => {
  const products = {
    kid: { name: "Kids Runner", categoryKey: "kids-shoes", category: "Footwear", sizes: ["26", "27", "28"] },
    adult: { name: "Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8"] },
  };
  const stock = { hub2: { kid: { 26: { qty: 1 }, 27: { qty: 1 } }, adult: { 7: { qty: 1 } } } };
  const adultRun = { 3: { target: 2, minQty: 1 }, 7: { target: 3, minQty: 2 }, 8: { target: 3, minQty: 2 },
    11: { target: 2, minQty: 1 } };
  const config = {
    mode: { hub2: "live" },
    policyGroups: { "footwear-all": {
      label: "Sneakers", armed: true,
      memberCategoryKeys: ["kids-shoes", "sneakers"],
      policy: { perSize: true, hub2: { sizes: adultRun } },
    } },
  };
  const ctx = { targets: {}, config, products, stock };
  // The adult member is armed…
  assert.equal(resolveTarget(ctx, "hub2", "adult", "7").target, 3);
  // …and every kids size resolves nothing, from the same armed group.
  for (const size of ["26", "27", "28"]) {
    assert.equal(resolveTarget(ctx, "hub2", "kid", size), null, `size ${size} must resolve nothing`);
  }
});

test("its OWN numbers, on its OWN run, arm it", () => {
  const products = { kid: { name: "Kids Runner", categoryKey: "kids-shoes", category: "Footwear", sizes: ["26", "27"] } };
  const stock = { hub2: { kid: { 26: { qty: 1 }, 27: { qty: 0 } } } };
  const config = { mode: { hub2: "live" }, categoryPolicy: { "kids-shoes": { perSize: true, hub2: { sizes: {
    26: { target: 2, minQty: 1 }, 27: { target: 2, minQty: 1 },
  } } } } };
  const ctx = { targets: {}, config, products, stock };
  assert.equal(resolveTarget(ctx, "hub2", "kid", "26").target, 2);
  // 27 has no units anywhere: the dead-size rule resolves an explicit stop, and
  // arms itself the day real units arrive. Not "nothing" — a decision.
  assert.equal(resolveTarget(ctx, "hub2", "kid", "27").target, 0);
});

// ── AND A PER-PRODUCT ROW STILL BEATS THE GROUP ──────────────────────────────
test("an explicit row beats an armed group, whatever the number", () => {
  const products = { adult: { name: "Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["7"] } };
  const stock = { hub2: { adult: { 7: { qty: 1 } } } };
  const config = { mode: { hub2: "live" }, policyGroups: { g: { label: "F", armed: true,
    memberCategoryKeys: ["sneakers"], policy: { perSize: true, hub2: { sizes: { 7: { target: 3, minQty: 2 } } } } } } };
  assert.equal(resolveTarget({ targets: { hub2: { adult: { 7: { target: 9, minQty: 5 } } } }, config, products, stock },
    "hub2", "adult", "7").target, 9);
  assert.equal(resolveTarget({ targets: { hub2: { adult: { 7: { target: 0, minQty: 0 } } } }, config, products, stock },
    "hub2", "adult", "7").target, 0);
});

// ── A minQty-ONLY EDIT IS A REAL EDIT ────────────────────────────────────────
// `changes` is not only the human-facing list: an empty one returns noChange and
// never applies the update. A Minimum-only edit therefore reported a successful
// save and wrote nothing. (CodeRabbit, PR #497.)
test("changing only the Minimum is written, not reported as no change", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 4, minQty: 2, source: OVERRIDE_SOURCE },
  } } } }));
  const res = await call(db, base({
    rows: [{ sizeKey: "M", target: 4, minQty: 4 }],
    expected: { M: { target: 4, minQty: 2, reorderPoint: null } },
  }));
  assert.equal(res.noChange, undefined);
  assert.equal(rowsAt(db).M.minQty, 4);
  assert.deepEqual(res.changes, [{ sizeKey: "M", field: "minQty", from: 2, to: 4 }]);
});

// ── THE AFTER-STATE A REVERT DRIFT-CHECKS AGAINST ────────────────────────────
test("a removal records that it leaves NO row, as a flag rather than a null", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: 4, minQty: 2, source: OVERRIDE_SOURCE, prevAbsent: true },
  } } } }));
  await call(db, base({ rows: [], remove: ["M"], expected: { M: { target: 4, minQty: 2, reorderPoint: null } } }));
  // RTDB deletes a key written null, so `row: null` would read back as an entry
  // that simply forgot to say what it left behind.
  assert.deepEqual(history(db)[0].after, [{ sizeKey: "M", absent: true }]);
});

// ── A ROW A SCRIPT WROTE CAN STILL BE CLEARED ────────────────────────────────
// Admin-SDK scripts bypass the rule that requires numbers, so a stored
// `target: "4"` exists on the live node. The drift check compares the caller's
// expectation against shapeOf(live), and shapeOf passes a string through — so
// the caller must too, or clearing such a row fails with a bare
// failed-precondition and no way forward. (CodeRabbit, PR #497.)
test("a string target drift-checks as itself, and the row can be cleared", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: "4", minQty: 2, source: "script" },
  } } } }));
  const res = await call(db, base({
    rows: [], remove: ["M"],
    expected: { M: { target: "4", minQty: 2, reorderPoint: null } },
    allowRemoveForeign: true,
  }));
  assert.equal(res.ok, true);
  assert.equal(rowsAt(db).M, undefined);
});

test("…and coercing it to a number in the expectation is refused, not silently accepted", async () => {
  const db = makeFakeDb(world({ stock_targets: { trophy: { j1: {
    M: { target: "4", minQty: 2, source: "script" },
  } } } }));
  await rejects(() => call(db, base({
    rows: [], remove: ["M"],
    expected: { M: { target: 4, minQty: 2, reorderPoint: null } },   // claims a number the row does not hold
    allowRemoveForeign: true,
  })), "failed-precondition");
  assert.equal(rowsAt(db).M.target, "4");
});
