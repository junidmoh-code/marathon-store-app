// ─── DISPLAY CHECKS — completion (PR 7) regression tests ─────────────────────
// The compliance core: write-once close, the no-stock soft-block/override, and
// THE HARD GATE — "completion NEVER deletes the active record." That last one is
// the whole foundation of the cold-cache resurrection close: completion must
// COPY to the day node and FLIP the active record to a `completed` tombstone in
// place, never remove it. The gate test FAILS if runComplete ever deletes
// instead of overwrites-to-tombstone. Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../displayChecks/lib.cjs");
const { runComplete } = require("../displayChecks/completeCheck.js");

const NOW = Date.parse("2026-07-19T09:00:00.000Z"); // SA 2026-07-19
const SA = lib.saDateStringFromMs(NOW);
const STORE = "marathon-pe";
const KEY = "p1__M";
const ACTOR = { uid: "u-nomusa", name: "Nomusa", email: "nomusa@marathon.internal" };
const ACTOR2 = { uid: "u-zee", name: "Zee", email: "zee@marathon.internal" };

// Fake RTDB with Cloud-Function cold-cache transaction semantics + get/set.
function fakeDb(initial) {
  const state = structuredClone(initial);
  const api = { state, coldAborts: 0 };
  const get = (p) => (p === "" ? state : p.split("/").reduce((n, k) => (n == null ? n : n[k]), state));
  const set = (p, v) => {
    const parts = p.split("/"); const last = parts.pop();
    let n = state; for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (v === null) delete n[last]; else n[last] = v;
  };
  api.ref = (path = "") => ({
    async get() { const v = structuredClone(get(path) ?? null); return { val: () => v, exists: () => v != null }; },
    async set(v) { set(path, structuredClone(v)); },
    async transaction(fn) {
      const cold = fn(null);                       // cold-cache FIRST run
      if (cold === undefined) { api.coldAborts++; return { committed: false, snapshot: { val: () => get(path) ?? null } }; }
      const server = get(path) ?? null;
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      set(path, final);
      return { committed: true, snapshot: { val: () => final } };
    },
  });
  return api;
}

const openCheck = (over = {}) => ({
  checkId: "cA", productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M", dedupeKey: KEY,
  status: "open", saleCount: 1, appliedMovements: { mv0: true }, createdAt: NOW - 3600e3,
  activatedAt: NOW - 3600e3, activatedSaDate: "2026-07-18", assignedTo: null, ...over,
});
const dbWith = (record, qty = 0) => fakeDb({
  displayChecks_active: { [STORE]: { [KEY]: record } },
  stock: { [STORE]: { p1: { M: { qty } } } },
});
const active = (db) => db.state.displayChecks_active[STORE][KEY];
const dayNode = (db, saDate = SA) => db.state.displayChecks?.[STORE]?.[saDate]?.cA;
const call = (db, over) => runComplete(db, { store: STORE, key: KEY, checkId: "cA", result: "confirmed", override: false, actor: ACTOR, nowMs: NOW, ...over });

// ── THE HARD GATE ─────────────────────────────────────────────────────────────
test("completion NEVER deletes the active record — it flips to a completed tombstone in place", async () => {
  const db = dbWith(openCheck());
  const r = await call(db, { result: "confirmed" });
  assert.equal(r.kind, "ok");
  // The active slot MUST still hold a record — a completed tombstone, not a hole.
  assert.ok("p1__M" in db.state.displayChecks_active[STORE], "the active key must NOT be deleted");
  const rec = active(db);
  assert.ok(rec, "active record still present (never null)");
  assert.equal(rec.status, "completed");
  assert.equal(rec.result, "confirmed");
  assert.equal(rec.checkId, "cA");                    // same identity, same slot
  assert.equal(rec.completedAt, NOW);
  assert.deepEqual(rec.completedBy, ACTOR);           // logged-in user, NO PIN
  assert.notEqual(active(db), null);
});

test("completion COPIES to the day node under the completion SA day, keyed by checkId", async () => {
  const db = dbWith(openCheck());
  await call(db, { result: "confirmed" });
  const arch = dayNode(db);
  assert.ok(arch, "archived to /displayChecks/{store}/{saDate}/{checkId}");
  assert.equal(arch.status, "completed");
  assert.equal(arch.result, "confirmed");
  assert.deepEqual(arch, active(db), "archive == the committed active tombstone (no divergence)");
});

test("activatedSaDate (the PR-12 marks anchor) survives completion into BOTH copies", async () => {
  const db = dbWith(openCheck({ activatedSaDate: "2026-07-18" }));
  await call(db, { result: "confirmed" });
  assert.equal(active(db).activatedSaDate, "2026-07-18");
  assert.equal(dayNode(db).activatedSaDate, "2026-07-18");
});

// ── WRITE-ONCE ────────────────────────────────────────────────────────────────
test("write-once: a second completion is rejected and the first result stands", async () => {
  const db = dbWith(openCheck());
  const r1 = await call(db, { result: "confirmed", actor: ACTOR });
  assert.equal(r1.kind, "ok");
  const firstCompletedAt = active(db).completedAt;
  const r2 = await call(db, { result: "no_stock", actor: ACTOR2, override: true });
  assert.equal(r2.kind, "reject");
  assert.equal(r2.code, "already-completed");
  // Untouched: still the first actor's confirmed result.
  assert.equal(active(db).result, "confirmed");
  assert.deepEqual(active(db).completedBy, ACTOR);
  assert.equal(active(db).completedAt, firstCompletedAt);
});

test("write-once holds even against a record that only carries completedAt (no status change yet)", async () => {
  const db = dbWith(openCheck({ completedAt: NOW - 1000 }));
  const r = await call(db, { result: "confirmed" });
  assert.equal(r.kind, "reject");
  assert.equal(r.code, "already-completed");
});

// ── NO-STOCK SOFT-BLOCK ───────────────────────────────────────────────────────
test("no_stock over real stock is SOFT-BLOCKED (needs_override); the check stays open, nothing archived", async () => {
  const db = dbWith(openCheck(), 3);                  // inventory shows 3 × M
  const r = await call(db, { result: "no_stock", override: false });
  assert.equal(r.kind, "needs_override");
  assert.equal(r.stockQty, 3);
  assert.equal(active(db).status, "open");            // NOT completed
  assert.equal(dayNode(db), undefined);               // nothing archived
});

test("no_stock over real stock WITH override completes, flags resultOverridden, logs the qty evidence", async () => {
  const db = dbWith(openCheck(), 3);
  const r = await call(db, { result: "no_stock", override: true });
  assert.equal(r.kind, "ok");
  assert.equal(r.overridden, true);
  assert.equal(active(db).status, "completed");
  assert.equal(active(db).result, "no_stock");
  assert.equal(active(db).resultOverridden, true);
  const log = Object.values(db.state.displayChecks_log[STORE]["2026-07"])[0];
  assert.equal(log.type, "completed_no_stock");
  assert.equal(log.payload.stockQty, 3);              // the number is the evidence
  assert.equal(log.payload.overridden, true);
});

test("no_stock with genuinely zero stock completes normally (no override needed, not flagged)", async () => {
  const db = dbWith(openCheck(), 0);
  const r = await call(db, { result: "no_stock", override: false });
  assert.equal(r.kind, "ok");
  assert.equal(active(db).result, "no_stock");
  assert.equal(active(db).resultOverridden, false);
});

// ── GUARDS ────────────────────────────────────────────────────────────────────
test("a held check cannot be completed (not-open)", async () => {
  const db = dbWith(openCheck({ status: "held" }));
  const r = await call(db);
  assert.equal(r.kind, "reject");
  assert.equal(r.code, "not-open");
  assert.equal(active(db).status, "held");
});

test("a stale checkId (slot overwritten by a fresh check) is rejected, the current check untouched", async () => {
  const db = dbWith(openCheck({ checkId: "cB" }));    // slot now holds cB
  const r = await call(db, { checkId: "cA" });        // caller resolved cA
  assert.equal(r.kind, "reject");
  assert.equal(r.code, "stale-check");
  assert.equal(active(db).checkId, "cB");
  assert.equal(active(db).status, "open");            // cB not completed
});

test("a missing record is rejected (not-found)", async () => {
  const db = fakeDb({ displayChecks_active: { [STORE]: {} }, stock: {} });
  const r = await call(db);
  assert.equal(r.kind, "reject");
  assert.equal(r.code, "not-found");
});

// ── PURE DECISION ─────────────────────────────────────────────────────────────
test("completionDecision covers the branch table", () => {
  const open = { checkId: "cA", status: "open" };
  assert.equal(lib.completionDecision({ record: null, expectedCheckId: "cA", result: "confirmed" }).code, "not-found");
  assert.equal(lib.completionDecision({ record: { checkId: "cB", status: "open" }, expectedCheckId: "cA", result: "confirmed" }).code, "stale-check");
  assert.equal(lib.completionDecision({ record: { checkId: "cA", status: "completed" }, expectedCheckId: "cA", result: "confirmed" }).code, "already-completed");
  assert.equal(lib.completionDecision({ record: { checkId: "cA", status: "open", completedAt: 5 }, expectedCheckId: "cA", result: "confirmed" }).code, "already-completed");
  assert.equal(lib.completionDecision({ record: { checkId: "cA", status: "held" }, expectedCheckId: "cA", result: "confirmed" }).code, "not-open");
  assert.equal(lib.completionDecision({ record: open, expectedCheckId: "cA", result: "maybe" }).code, "bad-result");
  assert.equal(lib.completionDecision({ record: open, expectedCheckId: "cA", result: "no_stock", override: false, stockQty: 4 }).kind, "needs_override");
  assert.equal(lib.completionDecision({ record: open, expectedCheckId: "cA", result: "no_stock", override: true, stockQty: 4 }).overridden, true);
  assert.equal(lib.completionDecision({ record: open, expectedCheckId: "cA", result: "no_stock", override: false, stockQty: 0 }).kind, "complete");
  assert.equal(lib.completionDecision({ record: open, expectedCheckId: "cA", result: "confirmed" }).kind, "complete");
});

test("buildCompletedRecord preserves the record, stamps completion, strips grace fields", () => {
  const rec = { checkId: "cA", status: "open", activatedSaDate: "2026-07-18", saleCount: 2, stockSeenAt: 5, wakeAt: 9 };
  const c = lib.buildCompletedRecord(rec, { result: "confirmed", nowMs: NOW, saDate: SA, actor: ACTOR, overridden: false });
  assert.equal(c.status, "completed");
  assert.equal(c.completedSaDate, SA);
  assert.equal(c.activatedSaDate, "2026-07-18");     // anchor preserved
  assert.equal(c.saleCount, 2);
  assert.equal(c.resultOverridden, false);
  assert.equal("stockSeenAt" in c, false);
  assert.equal("wakeAt" in c, false);
});
