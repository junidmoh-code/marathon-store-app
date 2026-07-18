// ─── DISPLAY CHECKS — bumpCheck cold-cache regression (node --test) ──────────
// Proves the live undercount fix: bumpCheck's transaction must survive the
// Cloud-Function COLD-CACHE first run (update fn called with null before the
// server is consulted; returning undefined there aborts WITHOUT a server
// round-trip). Before the fix, bumpTxn(null) → undefined → the bump was
// silently dropped and saleCount stuck at 1. Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bumpCheck } = require("../displayChecks/onClothingSale.js");

const NOW = Date.parse("2026-07-18T09:00:00.000Z");
const SA = "2026-07-18";

// Fake RTDB with the cold-cache transaction contract (mirrors
// hold-reveal-sweep.test.cjs). `.get()` returns the current value but does NOT
// warm the transaction cache, exactly like the real SDK — so the transaction's
// first run still sees null. `trackColdAborts` counts transactions that aborted
// on the cold-null run (the bug signature).
function fakeDb(initial) {
  const state = structuredClone(initial);
  let pushSeq = 0;
  const api = { state, coldAborts: 0 };
  const get = (p) => (p === "" ? state : p.split("/").reduce((n, k) => (n == null ? n : n[k]), state));
  const set = (p, v) => {
    const parts = p.split("/"); const last = parts.pop();
    let n = state; for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (v === null) delete n[last]; else n[last] = v;
  };
  api.ref = (path = "") => ({
    async get() { return { val: () => structuredClone(get(path) ?? null), exists: () => get(path) != null }; },
    async once() { return { val: () => structuredClone(get(path) ?? null) }; },
    push() { return { key: `ev_${++pushSeq}` }; },
    async update(patch) { for (const [k, v] of Object.entries(patch)) set(k, v); },
    async transaction(fn) {
      const cold = fn(null);                       // cold-cache FIRST run
      if (cold === undefined) { api.coldAborts++; return { committed: false, snapshot: { val: () => get(path) ?? null } }; }
      const server = get(path) ?? null;            // CAS re-run against the real value
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      set(path, final);
      return { committed: true, snapshot: { val: () => final } };
    },
  });
  return api;
}

const openCheck = (over = {}) => ({
  productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M", dedupeKey: "p1__M",
  status: "open", result: null, saleCount: 1, appliedMovements: { mvFirst: true },
  createdAt: NOW - 60000, activatedAt: NOW - 60000, ...over,
});
const dbWith = (check) => fakeDb({
  displayChecks: { "marathon-pe": { [SA]: { c1: check } } },
  stock: { "marathon-pe": { p1: { M: { qty: 0 } } } },
});
const logTypes = (db) => Object.values(db.state.displayChecks_log?.["marathon-pe"]?.["2026-07"] || {}).map((e) => e.type);

test("bump survives the cold-cache null first run: saleCount increments, log written", async () => {
  const db = dbWith(openCheck());
  const res = await bumpCheck(db, {
    store: "marathon-pe", saDate: SA, checkId: "c1",
    qty: 2, movementId: "mvSecond", movementTs: "2026-07-18T09:00:00.000Z", nowMs: NOW,
  });
  assert.equal(res.ok, true);
  assert.equal(res.logType, "sale_bumped");
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.saleCount, 3); // 1 + 2, NOT stuck at 1
  assert.equal(db.coldAborts, 0);                                          // the bug signature is gone
  assert.deepEqual(logTypes(db), ["sale_bumped"]);
});

test("held check bump is LOUD (held_resale) and still survives the cold run", async () => {
  const db = dbWith(openCheck({ status: "held", activatedAt: undefined, heldAt: NOW - 60000 }));
  const res = await bumpCheck(db, {
    store: "marathon-pe", saDate: SA, checkId: "c1",
    qty: 1, movementId: "mvSecond", movementTs: "2026-07-18T09:00:00.000Z", nowMs: NOW,
  });
  assert.equal(res.ok, true);
  assert.equal(res.logType, "held_resale");
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.saleCount, 2);
  assert.deepEqual(logTypes(db), ["held_resale"]);
});

test("movement fence holds through the cold run: a replayed movement is a no-op, not a double count", async () => {
  const db = dbWith(openCheck({ saleCount: 5, appliedMovements: { mvFirst: true, mvDup: true } }));
  const res = await bumpCheck(db, {
    store: "marathon-pe", saDate: SA, checkId: "c1",
    qty: 3, movementId: "mvDup", movementTs: "2026-07-18T09:00:00.000Z", nowMs: NOW,
  });
  assert.equal(res.ok, true);
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.saleCount, 5); // unchanged — fenced replay
});

test("a completed check aborts the bump (write-once respected) — committed:false, no log", async () => {
  const db = dbWith(openCheck({ status: "completed", result: "confirmed", completedAt: NOW - 1000 }));
  const res = await bumpCheck(db, {
    store: "marathon-pe", saDate: SA, checkId: "c1",
    qty: 2, movementId: "mvSecond", movementTs: "2026-07-18T09:00:00.000Z", nowMs: NOW,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, "completed");
  assert.equal(db.state.displayChecks["marathon-pe"][SA].c1.saleCount, 1); // untouched
  assert.deepEqual(logTypes(db), []);
});
