// ─── HUB 3 COUNT RESET — scripts/lib/hub3CountReset.mjs over the fake RTDB ────
// Drives the REAL server writer (lib/admin-movement.cjs) against the fake that
// deletes the way RTDB does. Pins: every Hub 3 cell lands on 0 (positives and
// negatives), nothing at any other location moves, held shipments untouched,
// markers cleared, flags ON, a sale in the gap is re-read and still zeroed, a
// re-run never applies twice, and verify PASSes / FAILs honestly.
// Run: cd functions && node --test test/hub3-count-reset.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");

const LIB = pathToFileURL(path.join(__dirname, "..", "..", "scripts", "lib", "hub3CountReset.mjs")).href;
const NOW = Date.parse("2026-11-06T09:00:00.000Z");
const cell = (qty, extra = {}) => ({ qty, v: 3, mv: "old", lastType: "sold", ...extra });

function world() {
  return makeFakeDb({
    locations: { hub3: { id: "hub3", label: "Hub 3" } },
    stock: {
      hub3: { pA: { "8": cell(3), "5_5": cell(-2), "9": cell(0) }, pB: { _: cell(-7, { trusted: true }) }, pC: { M: cell(1) } },
      "marathon-pine": { pA: { "8": cell(2) } },
      concrete: { pA: { "8": cell(-1) } },
      hub2: { pA: { "8": cell(5) } },
      central: { pA: { "8": cell(9) } },
      in_transit: { pA: { "8": cell(4) } },
    },
    settings: {
      stockHold: { held: { h1: { to: "hub3", productId: "pA", size: "8", qty: 4 } } },
      hubSneakerCount: {
        counted: { hub3: { s1: { "pA::8": { actual: 3 } } }, hub2: { s9: { "pA::8": { actual: 5 } } } },
        sessions: { hub3: { sessionId: "s1", doneCells: 1 }, hub2: { sessionId: "s9" } },
        register: { hub3: { pA__8: { qty: 1 } }, hub2: { pA__8: { qty: 1 } } },
      },
    },
  });
}
const root = (db) => db.state.root;

test("plan: positives and negatives both planned; zeros and other locations never", async () => {
  const lib = await import(LIB);
  const db = world();
  const p = lib.planReset(root(db).stock.hub3, { resetId: "1" });
  assert.deepEqual(p.summary, { cells: 5, units: -5, nonZeroCells: 4, positives: 2, negatives: 2, positiveUnits: 4, negativeUnits: 9 });
  assert.ok(p.cells.every((c) => c.path.startsWith("stock/hub3/")));
  assert.throws(() => lib.assertOnlyHub3({ cells: [...p.cells, { path: "stock/marathon-pine/pA/8" }] }), /REFUSED/);
  assert.throws(() => lib.assertOnlyHub3({ cells: [{ path: "stock/hub3/pA" }] }), /REFUSED/);
});

test("apply: every Hub 3 cell → 0 through guarded adjustments; nothing else touched; markers cleared; flags ON", async () => {
  const lib = await import(LIB);
  const db = world();
  const before = JSON.parse(JSON.stringify(root(db)));
  const plan = lib.planReset(root(db).stock.hub3, { resetId: "1730883600000" });
  const r = await lib.applyReset({ db, plan, applyMovementAdmin, nowMs: NOW });
  assert.equal(r.refused.length, 0);
  assert.deepEqual([r.removed, r.added], [4, 9]);
  await db.ref().update(lib.markerClearUpdate({ nowIso: new Date(NOW).toISOString() }));
  const s = root(db);
  for (const [pid, sizes] of Object.entries(s.stock.hub3)) for (const [k, c] of Object.entries(sizes)) assert.equal(c.qty, 0, `${pid}/${k}`);
  // every other location, held shipments and other hubs' markers: byte-identical
  for (const loc of ["marathon-pine", "concrete", "hub2", "central", "in_transit"]) assert.deepEqual(s.stock[loc], before.stock[loc], loc);
  assert.deepEqual(s.settings.stockHold, before.settings.stockHold);
  assert.deepEqual(s.settings.hubSneakerCount.counted.hub2, before.settings.hubSneakerCount.counted.hub2);
  assert.deepEqual(s.settings.hubSneakerCount.register.hub2, before.settings.hubSneakerCount.register.hub2);
  assert.equal(s.settings.hubSneakerCount.counted.hub3, undefined);
  assert.equal(s.settings.hubSneakerCount.sessions.hub3, undefined);
  assert.equal(s.settings.hubSneakerCount.register.hub3, undefined);
  assert.equal(s.settings.hubSneakerCount.countMode.hub3, true);
  assert.equal(s.config.refillEngine.pausedLocations.hub3, true);
  // the ledger: type adjustment, reason, the before qty in link, a negative cleared by a +leg
  const neg = s.stock_movements[lib.movementIdFor("1730883600000", "pB", "_")];
  assert.deepEqual({ t: neg.type, r: neg.reason, to: neg.to, from: neg.from ?? null, q: neg.qty, b: neg.link.countResetBefore, size: neg.size },
    { t: "adjustment", r: "hub3_count_reset", to: "hub3", from: null, q: 7, b: -7, size: "_" });
  const half = s.stock_movements[lib.movementIdFor("1730883600000", "pA", "5_5")];
  assert.equal(half.size, "5.5");
  assert.equal(s.stock.hub3.pB._.trusted, true, "the reset changes qty only — no other cell field");
  // verify
  const v = await lib.verifyReset({ db, plan });
  assert.equal(v.pass, true, JSON.stringify(v.problems));
  assert.deepEqual([v.rows, v.ledgerNet, v.expectedNet], [4, 5, 5]);
  // a re-run of the SAME plan applies nothing twice
  const again = await lib.applyReset({ db, plan, applyMovementAdmin, nowMs: NOW });
  assert.ok(again.done.every((d) => d.idempotent));
  for (const [, sizes] of Object.entries(root(db).stock.hub3)) for (const c of Object.values(sizes)) assert.equal(c.qty, 0);
});

test("a sale in the gap: the cell is re-read ALONE and still lands on 0", async () => {
  const lib = await import(LIB);
  const db = world();
  const plan = lib.planReset(root(db).stock.hub3, { resetId: "2" });
  await db.ref("stock/hub3/pA/8/qty").set(2);   // a POS sale after the read
  const r = await lib.applyReset({ db, plan, applyMovementAdmin, nowMs: NOW });
  assert.equal(r.refused.length, 0);
  assert.equal(root(db).stock.hub3.pA["8"].qty, 0);
  assert.equal(r.removed, 3);   // 2 + 1
  const applied = new Map(r.done.map((d) => [d.movementId, d.applied]));
  for (const c of plan.cells) c.applied = applied.get(c.movementId);
  const v = await lib.verifyReset({ db, plan });
  assert.equal(v.pass, true, JSON.stringify(v.problems));
});

test("verify FAILs when a cell was never zeroed", async () => {
  const lib = await import(LIB);
  const db = world();
  const plan = lib.planReset(root(db).stock.hub3, { resetId: "3" });
  const v = await lib.verifyReset({ db, plan });
  assert.equal(v.pass, false);
  assert.ok(v.problems.length >= 4);
});
