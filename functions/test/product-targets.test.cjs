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
  assert.deepEqual(h.changes, [{ sizeKey: "M", field: "target", to: 4 }]);
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
