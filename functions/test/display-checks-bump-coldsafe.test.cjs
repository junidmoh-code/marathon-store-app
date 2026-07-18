// ─── DISPLAY CHECKS — bumpCheck cold-cache + checkId-fence regression ────────
// Two invariants, one file:
//  (1) COLD-CACHE: bumpCheck's transaction survives the CF cold-null first run
//      (undefined there aborts before the server — the PR-2a undercount).
//  (2) CHECKID FENCE (the class-killer): the active index is keyed by dedupeKey,
//      so a SKU's slot can be OVERWRITTEN by a fresh check after the old one
//      completes. A stale bump resolved against the OLD checkId must NEVER bump
//      the NEW check, and — because active records are overwritten, not deleted
//      — must never resurrect a ghost. Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bumpCheck } = require("../displayChecks/onClothingSale.js");

const NOW = Date.parse("2026-07-18T09:00:00.000Z");
const SA = "2026-07-18";
const DK = "p1__M";

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
    async get() { const v = structuredClone(get(path) ?? null); return { val: () => v, exists: () => v != null }; },
    push() { return { key: `ev_${++pushSeq}` }; },
    async update(patch) { for (const [k, v] of Object.entries(patch)) set(k, v); },
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

const rec = (over = {}) => ({
  checkId: "cA", productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M", dedupeKey: DK,
  status: "open", saleCount: 1, appliedMovements: { mv0: true }, ...over,
});
const dbWith = (record) => fakeDb({ displayChecks_active: { "marathon-pe": { [DK]: record } }, stock: { "marathon-pe": { p1: { M: { qty: 0 } } } } });
const call = (db, over) => bumpCheck(db, { store: "marathon-pe", saDate: SA, key: DK, expectedCheckId: "cA", qty: 1, movementId: "mvNew", movementTs: "2026-07-18T09:00:00.000Z", nowMs: NOW, ...over });
const logTypes = (db) => Object.values(db.state.displayChecks_log?.["marathon-pe"]?.["2026-07"] || {}).map((e) => e.type);

test("bump survives the cold-cache null first run: saleCount increments, log written", async () => {
  const db = dbWith(rec({ saleCount: 1 }));
  const r = await call(db, { qty: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.logType, "sale_bumped");
  assert.equal(db.state.displayChecks_active["marathon-pe"][DK].saleCount, 3); // NOT stuck at 1
  assert.equal(db.coldAborts, 0);
  assert.deepEqual(logTypes(db), ["sale_bumped"]);
});

test("held bump is LOUD (held_resale) and survives the cold run", async () => {
  const db = dbWith(rec({ status: "held" }));
  const r = await call(db);
  assert.equal(r.logType, "held_resale");
  assert.equal(db.state.displayChecks_active["marathon-pe"][DK].saleCount, 2);
});

test("movement fence: a replayed movement is a committed no-op through the cold run", async () => {
  const db = dbWith(rec({ saleCount: 5, appliedMovements: { mv0: true, mvNew: true } }));
  const r = await call(db, { qty: 3 });
  assert.equal(r.ok, true);
  assert.equal(db.state.displayChecks_active["marathon-pe"][DK].saleCount, 5); // fenced
});

test("a completed tombstone aborts the bump (resolveSale never routes one here anyway)", async () => {
  const db = dbWith(rec({ status: "completed", completedAt: NOW - 1000 }));
  const r = await call(db);
  assert.equal(r.ok, false);
  assert.equal(db.state.displayChecks_active["marathon-pe"][DK].saleCount, 1);
  assert.deepEqual(logTypes(db), []);
});

// ── THE MEANEST ONE: the checkId fence under overwrite + cold cache ───────────
test("MEANEST: a stale bump for the OLD checkId hits a slot OVERWRITTEN by a NEW check — must NOT bump the new check, must NOT resurrect the old", async () => {
  // Old check cA completed and was overwritten by a fresh active check cB (same
  // dedupeKey slot, different checkId, its own units). A sale that resolved
  // against cA now fires bumpCheck(expectedCheckId: cA). The slot holds cB. The
  // fence must reject it — cB keeps its own saleCount, cA is not resurrected,
  // the sale re-resolves elsewhere (ok:false).
  const cB = rec({ checkId: "cB", status: "open", saleCount: 7, appliedMovements: { mvB0: true } });
  const db = dbWith(cB);
  const r = await call(db, { expectedCheckId: "cA", qty: 4, movementId: "mvStale" });
  assert.equal(r.ok, false, "stale bump for cA must abort against cB");
  const slot = db.state.displayChecks_active["marathon-pe"][DK];
  assert.equal(slot.checkId, "cB", "slot still holds cB");
  assert.equal(slot.saleCount, 7, "cB's count is untouched — no cross-check credit");
  assert.equal("mvStale" in slot.appliedMovements, false, "the stale movement never landed on cB");
  // The fence rejects on the pre-read itself (checkIds are unique push keys and
  // never repeat, so a mismatched pre-read means the server has moved on too —
  // aborting early is correct, no legitimate bump is at risk).
  assert.deepEqual(logTypes(db), [], "no log for an aborted bump");
});

test("checkId fence holds through a HELD slot overwrite too (stale bump vs a fresh held check)", async () => {
  const db = dbWith(rec({ checkId: "cB", status: "held", saleCount: 2, appliedMovements: { mvB0: true } }));
  const r = await call(db, { expectedCheckId: "cA", qty: 9, movementId: "mvStale" });
  assert.equal(r.ok, false);
  assert.equal(db.state.displayChecks_active["marathon-pe"][DK].saleCount, 2);
});
