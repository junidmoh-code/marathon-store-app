// ─── DISPLAY CHECKS — wake sweep integration (node --test) ───────────────────
// Drives runWakeSweep over the ACTIVE index (/displayChecks_active/{store}/{key})
// in the never-null model: held checks flip to open IN PLACE (no move), stale
// completed tombstones are reaped, open checks are left alone. Fake RTDB models
// Cloud-Function cold-cache transaction semantics. Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runWakeSweep } = require("../displayChecks/wakeHeldChecks.js");
const { saDateStringFromMs } = require("../displayChecks/lib.cjs");

const NOW = Date.parse("2026-07-16T10:00:00.000Z");
const SA = saDateStringFromMs(NOW);
const D = 20 * 60000;
const DK = "p1__M";

function fakeDb(initial) {
  const state = structuredClone(initial);
  let pushSeq = 0;
  const api = { state, _afterRead: null };
  const get = (p) => (p === "" ? state : p.split("/").reduce((n, k) => (n == null ? n : n[k]), state));
  const set = (p, v) => {
    const parts = p.split("/"); const last = parts.pop();
    let n = state; for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (v === null) delete n[last]; else n[last] = v;
  };
  const read = (p) => { const v = structuredClone(get(p) ?? null); if (api._afterRead && api._afterRead.path === p) { const h = api._afterRead; api._afterRead = null; h.fn(set); } return v; };
  api.ref = (path = "") => ({
    async once() { return { val: () => read(path) }; },
    async get() { const v = read(path); return { val: () => v, exists: () => v != null }; },
    push() { return { key: `ev_${++pushSeq}` }; },
    async update(patch) { for (const [k, v] of Object.entries(patch)) set(k, v); },
    async transaction(fn) {
      const cold = fn(null);
      if (cold === undefined) return { committed: false, snapshot: { val: () => get(path) ?? null } };
      const server = get(path) ?? null;
      const final = fn(server);
      if (final === undefined) return { committed: false, snapshot: { val: () => server } };
      set(path, final);
      return { committed: true, snapshot: { val: () => final } };
    },
  });
  return api;
}

const heldRecord = (over = {}) => ({
  checkId: "c1", productId: "p1", productName: "Boss Tee", size: "M", sizeKey: "M", dedupeKey: DK,
  status: "held", heldAt: NOW - 3600e3, createdAt: NOW - 3600e3, saleCount: 1, ...over,
});
const idx = (rec) => ({ "marathon-pe": { [DK]: rec } });
const stock = (qty) => ({ "marathon-pe": { p1: { M: { qty } } } });
const node = (db) => db.state.displayChecks_active?.["marathon-pe"]?.[DK];
const events = (db) => Object.values(db.state.displayChecks_log?.["marathon-pe"]?.["2026-07"] || {}).map((e) => e.type);

// ── stock_seen ───────────────────────────────────────────────────────────────
test("stock present + not seen → stock_seen on the active record (still held, in place)", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord()), stock: stock(3) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 1, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(node(db).status, "held");
  assert.equal(node(db).stockSeenAt, NOW);
  assert.equal(node(db).wakeAt, NOW + D);
  assert.deepEqual(events(db), ["stock_seen"]);
});

test("still no stock → untouched", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord()), stock: stock(0) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(node(db).stockSeenAt, undefined);
});

// ── activate IN PLACE (no move) ──────────────────────────────────────────────
test("grace elapsed + stock → flips held→open IN PLACE; stays at its dedupeKey; grace stripped; activatedSaDate stamped", async () => {
  const seenAt = NOW - D - 1000;
  const db = fakeDb({ displayChecks_active: idx(heldRecord({ stockSeenAt: seenAt, wakeAt: seenAt + D })), stock: stock(2) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 1, reHeld: 0, reaped: 0 });
  const c = node(db);
  assert.equal(c.status, "open");                 // in place — same key, no move
  assert.equal(c.activatedAt, NOW);
  assert.equal(c.activatedSaDate, SA);            // window #3 anchor
  assert.equal(c.stockSeenAt, undefined);
  assert.equal(c.wakeAt, undefined);
  assert.equal(c.checkId, "c1");
  assert.equal(db.state.displayChecks?.["marathon-pe"], undefined); // NOTHING moved to a day node
  assert.deepEqual(events(db), ["activated"]);
});

test("locked roster assigns the weekday person at the in-place activation", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks_active: idx(heldRecord({ stockSeenAt: seenAt })), stock: stock(1),
    displayChecks_settings: { "marathon-pe": { roster: { locked: true, days: { thu: { uid: "u-lihle", name: "Lihle" } } } } },
  });
  await runWakeSweep({ db, nowMs: NOW }); // 2026-07-16 is a Thursday
  assert.deepEqual(node(db).assignedTo, { uid: "u-lihle", name: "Lihle" });
});

test("inside grace → no activation", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord({ stockSeenAt: NOW - 5 * 60000 })), stock: stock(2) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 });
  assert.equal(node(db).status, "held");
});

// ── P1: stock re-read immediately before activation ──────────────────────────
test("stock sells to zero during the roster reads → NOT activated; re-decided re_held", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord({ stockSeenAt: NOW - D - 1 })), stock: stock(1) });
  db._afterRead = { path: `stock/marathon-pe/p1/M/qty`, fn: (set) => set(`stock/marathon-pe/p1/M/qty`, 0) };
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 1, reaped: 0 });
  assert.equal(node(db).status, "held");
  assert.equal(node(db).stockSeenAt, undefined);
});

// ── re_held ──────────────────────────────────────────────────────────────────
test("seen + stock vanished before wake → stockSeenAt cleared in place", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord({ stockSeenAt: 555, wakeAt: 555 + D })), stock: stock(0) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 1, reaped: 0 });
  assert.equal(node(db).stockSeenAt, undefined);
  assert.equal(node(db).status, "held");
  assert.deepEqual(events(db), ["re_held"]);
});

// ── idempotency ──────────────────────────────────────────────────────────────
test("double-fire does not double-activate: second run sees it already open (in place) and skips", async () => {
  const db = fakeDb({ displayChecks_active: idx(heldRecord({ stockSeenAt: NOW - D - 1 })), stock: stock(2) });
  const r1 = await runWakeSweep({ db, nowMs: NOW });
  const r2 = await runWakeSweep({ db, nowMs: NOW + 1000 });
  assert.equal(r1.activated, 1);
  assert.deepEqual(r2, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 }); // open → sweep skips
  assert.equal(node(db).activatedAt, NOW);
  assert.equal(events(db).filter((e) => e === "activated").length, 1);
});

// ── WINDOW #2: stale completed tombstone cleanup ─────────────────────────────
test("a completed tombstone from a PRIOR SA day is REAPED; today's is kept; open is never reaped", async () => {
  const yesterday = Date.parse("2026-07-15T14:00:00.000Z"); // SA 2026-07-15 < SA 2026-07-16
  const today = Date.parse("2026-07-16T06:00:00.000Z");
  const db = fakeDb({
    displayChecks_active: {
      "marathon-pe": {
        "old__M": { checkId: "cOld", dedupeKey: "old__M", status: "completed", completedAt: yesterday },
        "today__M": { checkId: "cToday", dedupeKey: "today__M", status: "completed", completedAt: today },
        "openp__M": heldRecord({ status: "open", dedupeKey: "openp__M", checkId: "cOpen" }),
      },
    },
    stock: stock(0),
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.equal(r.reaped, 1);
  assert.equal(db.state.displayChecks_active["marathon-pe"]["old__M"], undefined);      // reaped
  assert.ok(db.state.displayChecks_active["marathon-pe"]["today__M"]);                  // kept (today)
  assert.ok(db.state.displayChecks_active["marathon-pe"]["openp__M"]);                  // never reaped (open)
  assert.deepEqual(events(db), ["tombstone_reaped"]);
});

// ── scope ────────────────────────────────────────────────────────────────────
test("disabled store (marathon-pine) is never processed", async () => {
  const db = fakeDb({ displayChecks_active: { "marathon-pine": { [DK]: heldRecord() } }, stock: { "marathon-pine": { p1: { M: { qty: 9 } } } } });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, reaped: 0 });
});
