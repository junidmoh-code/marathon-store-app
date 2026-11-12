// ─── PINE SHOP COUNT CLEAR — the Hub 3 reset library in PINE_SCOPE ────────────
// scripts/pine-count-clear.mjs drives scripts/lib/hub3CountReset.mjs with
// PINE_SCOPE. Pins: every marathon-pine cell lands on 0 through the REAL server
// writer, with reason "pine-count-clear" and pineclear_* ids; Hub 3, Concrete,
// PE, Trophy, Hub 1/2, Central and in_transit never move; no count marker or
// flag is written; a Hub 3-scoped plan is refused at Pine and vice versa; a
// plan saved before scopes existed still verifies as Hub 3.
// Run: cd functions && node --test test/pine-count-clear.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");

const LIB = pathToFileURL(path.join(__dirname, "..", "..", "scripts", "lib", "hub3CountReset.mjs")).href;
const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const cell = (qty, extra = {}) => ({ qty, v: 3, mv: "old", lastType: "sold", ...extra });
const OTHERS = ["hub3", "concrete", "marathon-pe", "trophy", "hub1", "hub2", "central", "in_transit"];

function world() {
  const stock = { "marathon-pine": { pA: { "8": cell(3), "9": cell(0), "5_5": cell(1) }, pB: { _: cell(4, { trusted: true }) } } };
  for (const l of OTHERS) stock[l] = { pA: { "8": cell(5) } };
  return makeFakeDb({
    locations: { "marathon-pine": { id: "marathon-pine", label: "Marathon Pine" } },
    stock,
    settings: { hubSneakerCount: { countMode: { hub3: true } } },
    config: { refillEngine: { pausedLocations: { "marathon-pine": true } } },
  });
}
const root = (db) => db.state.root;

test("plan: Pine cells only, ids and paths in Pine's scope", async () => {
  const lib = await import(LIB);
  const p = lib.planReset(root(world()).stock["marathon-pine"], { resetId: "1", scope: lib.PINE_SCOPE });
  assert.equal(p.hub, "marathon-pine");
  assert.deepEqual([p.summary.cells, p.summary.nonZeroCells, p.summary.positiveUnits], [4, 3, 8]);
  assert.ok(p.cells.every((c) => c.path.startsWith("stock/marathon-pine/") && c.movementId.startsWith("pineclear_1_")));
  assert.throws(() => lib.assertOnlyLocation({ ...p, cells: [...p.cells, { path: "stock/hub3/pA/8" }] }), /REFUSED/);
  // A Hub 3 plan cannot be pointed at Pine paths.
  const h3 = lib.planReset(root(world()).stock["marathon-pine"], { resetId: "1" });
  assert.throws(() => lib.assertOnlyLocation({ ...h3, cells: p.cells }), /outside stock\/hub3\//);
});

test("apply: Pine → 0 with reason pine-count-clear; every other location, marker and flag untouched", async () => {
  const lib = await import(LIB);
  const db = world();
  const before = JSON.parse(JSON.stringify(root(db)));
  const plan = lib.planReset(root(db).stock["marathon-pine"], { resetId: "1794390000000", scope: lib.PINE_SCOPE });
  const r = await lib.applyReset({ db, plan, applyMovementAdmin, nowMs: NOW });
  assert.equal(r.refused.length, 0);
  assert.equal(r.removed, 8);
  for (const [pid, sizes] of Object.entries(root(db).stock["marathon-pine"])) for (const k of Object.keys(sizes)) assert.equal(sizes[k].qty, 0, `${pid}/${k}`);
  for (const l of OTHERS) assert.deepEqual(root(db).stock[l], before.stock[l], l);
  assert.deepEqual(root(db).settings, before.settings);
  assert.deepEqual(root(db).config, before.config);
  const rows = Object.values(root(db).stock_movements || {});
  assert.equal(rows.length, 3);
  for (const m of rows) {
    assert.equal(m.reason, "pine-count-clear");
    assert.equal(m.from, "marathon-pine");
    assert.equal(m.to ?? null, null);
    assert.equal(m.actor, "system:pine-count-clear");
  }
  const v = await lib.verifyReset({ db, plan });
  assert.equal(v.pass, true, JSON.stringify(v.problems));
});

test("a plan saved before scopes existed still verifies against Hub 3", async () => {
  const lib = await import(LIB);
  const db = makeFakeDb({ stock: { hub3: { pA: { "8": cell(2) } }, "marathon-pine": { pA: { "8": cell(2) } } } });
  const plan = lib.planReset(root(db).stock.hub3, { resetId: "7" });
  await lib.applyReset({ db, plan, applyMovementAdmin, nowMs: NOW });
  const old = JSON.parse(JSON.stringify(plan)); delete old.scope;   // the 6 Nov file shape
  const v = await lib.verifyReset({ db, plan: old });
  assert.equal(v.pass, true, JSON.stringify(v.problems));
  assert.equal(root(db).stock["marathon-pine"].pA["8"].qty, 2);
});
