// ─── DISPLAY CHECKS — wake sweep integration tests (node --test) ─────────────
// Drives runWakeSweep (displayChecks/wakeHeldChecks.js) against a fake RTDB that
// reproduces Cloud-Function COLD-CACHE transaction semantics (the update fn is
// called with null FIRST; returning undefined there aborts BEFORE the server is
// consulted — the branch the null-tolerant leaf-CAS claims must avoid). Same
// discipline as functions/test/hold-reveal-sweep.test.cjs.
// Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runWakeSweep } = require("../displayChecks/wakeHeldChecks.js");
const { saDateStringFromMs } = require("../displayChecks/lib.cjs");

const NOW = Date.parse("2026-07-16T10:00:00.000Z");
const SA = saDateStringFromMs(NOW);
const D = 20 * 60000;

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// Nested-object state; path get/set by "/". Supports once("value"),
// transaction(fn) with cold-cache semantics, root update(patch) with
// path-keyed entries, and push().key.
function fakeDb(initial, { failUpdates = 0 } = {}) {
  const state = structuredClone(initial);
  let pushSeq = 0;
  let updateFailsLeft = failUpdates; // transient log-write failures to simulate

  const get = (path) => (path === "" ? state : path.split("/").reduce((n, k) => (n == null ? n : n[k]), state));
  const set = (path, value) => {
    const parts = path.split("/");
    const last = parts.pop();
    let node = state;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (value === null) delete node[last]; else node[last] = value;
  };

  const api = { state, transactionAttempts: 0, logKeys: () => Object.keys(get(`displayChecks_log`) || {}) };
  api.ref = (path = "") => ({
    async once() { return { val: () => structuredClone(get(path) ?? null) }; },
    push() { return { key: `push_${++pushSeq}` }; },
    async update(patch) {
      if (updateFailsLeft > 0) { updateFailsLeft--; throw new Error("transient RTDB update failure"); }
      for (const [k, v] of Object.entries(patch)) set(k, v);
    },
    async transaction(fn) {
      api.transactionAttempts++;
      const cold = fn(null);                 // cold-cache first run
      if (cold === undefined) return { committed: false, snapshot: { val: () => get(path) ?? null } };
      // Interleave hook: a concurrent sweep can commit HERE, between our cold
      // run and our CAS re-run against the true value — exactly the race a
      // whole-node transaction must survive. Fires once, then clears.
      if (api._beforeRerun) { const h = api._beforeRerun; api._beforeRerun = null; h(path, set, get); }
      const server = get(path) ?? null;      // CAS re-run against the true value
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      set(path, final);
      return { committed: true, snapshot: { val: () => final } };
    },
  });
  return api;
}

const heldCheck = (over = {}) => ({
  productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M",
  dedupeKey: "p1__M", status: "held", heldAt: NOW - 60 * 60000, createdAt: NOW - 60 * 60000, ...over,
});
const withStock = (qty) => ({ p1: { M: { qty } } });
const dayNode = (checks) => ({ "marathon-pe": { [SA]: checks } });

function eventsOf(db) {
  const log = db.state.displayChecks_log?.["marathon-pe"]?.["2026-07"] || {};
  return Object.entries(log).map(([id, e]) => ({ id, type: e.type, checkId: e.checkId }));
}

// ── stock_seen ───────────────────────────────────────────────────────────────
test("held + stock present + not seen → stock_seen set, grace clock started, logged", async () => {
  const db = fakeDb({ displayChecks: dayNode({ c1: heldCheck() }), stock: { "marathon-pe": withStock(3) } });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 1, activated: 0, reHeld: 0 });
  const c = db.state.displayChecks["marathon-pe"][SA].c1;
  assert.equal(c.status, "held");            // NOT activated yet — grace window
  assert.equal(c.stockSeenAt, NOW);
  assert.equal(c.wakeAt, NOW + D);
  assert.deepEqual(eventsOf(db), [{ id: "c1_stock_seen_" + NOW, type: "stock_seen", checkId: "c1" }]);
});

test("held + still no stock → untouched, no reads spent beyond the qty get", async () => {
  const db = fakeDb({ displayChecks: dayNode({ c1: heldCheck() }), stock: { "marathon-pe": withStock(0) } });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 });
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.stockSeenAt, undefined);
  assert.equal(eventsOf(db).length, 0);
});

// ── activate ─────────────────────────────────────────────────────────────────
test("seen + stock + grace elapsed → status open, activatedAt, no roster → assignedTo omitted", async () => {
  const seenAt = NOW - D - 1000;
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt, wakeAt: seenAt + D }) }),
    stock: { "marathon-pe": withStock(2) },
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 1, reHeld: 0 });
  const c = db.state.displayChecks["marathon-pe"][SA].c1;
  assert.equal(c.status, "open");
  assert.equal(c.activatedAt, NOW);
  assert.equal(c.assignedTo, undefined);     // roster/cover absent → null → omitted
  assert.deepEqual(eventsOf(db), [{ id: "c1_activated", type: "activated", checkId: "c1" }]);
});

test("seen + stock + still inside grace → no activation", async () => {
  const seenAt = NOW - 5 * 60000; // 5 min ago, 20-min grace
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt, wakeAt: seenAt + D }) }),
    stock: { "marathon-pe": withStock(2) },
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 });
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.status, "held");
});

test("locked roster assigns the weekday person at activation, frozen onto the check", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt }) }),
    stock: { "marathon-pe": withStock(1) },
    displayChecks_settings: {
      "marathon-pe": { roster: { locked: true, days: { thu: { uid: "u-lihle", name: "Lihle" } } } },
    },
  });
  await runWakeSweep({ db, nowMs: NOW }); // 2026-07-16 is a Thursday
  assert.deepEqual(db.state.displayChecks["marathon-pe"][SA].c1.assignedTo, { uid: "u-lihle", name: "Lihle" });
});

// ── re_held ──────────────────────────────────────────────────────────────────
test("seen + stock vanished before wake → stockSeenAt/wakeAt cleared, re_held logged", async () => {
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: 555, wakeAt: 555 + D }) }),
    stock: { "marathon-pe": withStock(0) },
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 1 });
  const c = db.state.displayChecks["marathon-pe"][SA].c1;
  assert.equal(c.stockSeenAt, undefined);
  assert.equal(c.wakeAt, undefined);
  assert.equal(c.status, "held");
  assert.deepEqual(eventsOf(db), [{ id: "c1_re_held_555", type: "re_held", checkId: "c1" }]);
});

// ── idempotency ──────────────────────────────────────────────────────────────
test("double-fire does not double-activate: second run is a no-op, one activation total", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt }) }),
    stock: { "marathon-pe": withStock(2) },
  });
  const r1 = await runWakeSweep({ db, nowMs: NOW });
  const r2 = await runWakeSweep({ db, nowMs: NOW + 1000 });
  assert.deepEqual(r1, { stockSeen: 0, activated: 1, reHeld: 0 });
  assert.deepEqual(r2, { stockSeen: 0, activated: 0, reHeld: 0 }); // already open → wakeTransition null
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.activatedAt, NOW);
  assert.equal(eventsOf(db).filter((e) => e.type === "activated").length, 1);
});

test("INTERLEAVE: a concurrent sweep activates first → our transaction aborts, no partial state, one activation", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt }) }),
    stock: { "marathon-pe": withStock(2) },
  });
  // Between our cold run and CAS re-run, "another sweep" atomically activates c1.
  db._beforeRerun = (_path, set) => {
    set(`displayChecks/marathon-pe/${SA}/c1`, {
      ...db.state.displayChecks["marathon-pe"][SA].c1, status: "open", activatedAt: NOW - 1,
    });
  };
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 }); // our commit aborted
  const c = db.state.displayChecks["marathon-pe"][SA].c1;
  assert.equal(c.status, "open");
  assert.equal(c.activatedAt, NOW - 1);  // the OTHER sweep's stamp survived — no overwrite, no partial
  assert.equal(eventsOf(db).filter((e) => e.type === "activated").length, 0); // we logged nothing on abort
});

test("INTERLEAVE: a concurrent stock_seen claims first → our stock_seen aborts (single claim)", async () => {
  const db = fakeDb({ displayChecks: dayNode({ c1: heldCheck() }), stock: { "marathon-pe": withStock(3) } });
  db._beforeRerun = (_path, set) => {
    set(`displayChecks/marathon-pe/${SA}/c1/stockSeenAt`, NOW - 500);
    set(`displayChecks/marathon-pe/${SA}/c1/wakeAt`, NOW - 500 + D);
  };
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 });
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.stockSeenAt, NOW - 500); // the other claim held
  assert.equal(eventsOf(db).filter((e) => e.type === "stock_seen").length, 0);
});

test("double-fire stock_seen writes one deterministic log entry, one stockSeenAt", async () => {
  const db = fakeDb({ displayChecks: dayNode({ c1: heldCheck() }), stock: { "marathon-pe": withStock(4) } });
  await runWakeSweep({ db, nowMs: NOW });
  const seenAfter1 = db.state.displayChecks["marathon-pe"][SA].c1.stockSeenAt;
  // A second run at the SAME instant: stockSeenAt already set → wakeTransition
  // sees it, still inside grace → null; no second stock_seen.
  await runWakeSweep({ db, nowMs: NOW });
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.stockSeenAt, seenAfter1);
  assert.equal(eventsOf(db).filter((e) => e.type === "stock_seen").length, 1);
});

// ── audit-log durability ─────────────────────────────────────────────────────
test("a transient log-write failure is retried — the audit event still lands (Codex)", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb(
    { displayChecks: dayNode({ c1: heldCheck({ stockSeenAt: seenAt }) }), stock: { "marathon-pe": withStock(2) } },
    { failUpdates: 1 } // first log update() throws, retry succeeds
  );
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 1, reHeld: 0 });
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.status, "open"); // state committed
  assert.deepEqual(eventsOf(db), [{ id: "c1_activated", type: "activated", checkId: "c1" }]); // log recovered
});

// ── scope ────────────────────────────────────────────────────────────────────
test("store with no held checks is skipped (no config/stock reads)", async () => {
  const db = fakeDb({
    displayChecks: dayNode({ c1: heldCheck({ status: "open" }) }),
    stock: { "marathon-pe": withStock(5) },
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 });
  assert.equal(db.transactionAttempts, 0);
});

test("disabled store (marathon-pine) is never processed", async () => {
  const db = fakeDb({
    displayChecks: { "marathon-pine": { [SA]: { c1: heldCheck() } } },
    stock: { "marathon-pine": withStock(9) },
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0 });
  assert.equal(db.state.displayChecks["marathon-pine"][SA].c1.stockSeenAt, undefined);
});
