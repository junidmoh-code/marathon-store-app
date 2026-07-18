// ─── DISPLAY CHECKS — wake sweep integration tests (node --test) ─────────────
// Drives runWakeSweep (displayChecks/wakeHeldChecks.js) over the FLAT held index
// (`displayChecks_held/{store}/{dedupeKey}`), against a fake RTDB that reproduces
// Cloud-Function COLD-CACHE transaction semantics (update fn called with null
// FIRST; undefined aborts before the server). Covers stock_seen, activate +
// RELOCATE into the day node, grace, re_held (+ fence), the pre-activation stock
// re-read, self-heal of a crashed relocation, double-fire idempotency, disabled
// store. Run: cd functions && node --test

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
  api.ref = (path = "") => ({
    async once() {
      const v = structuredClone(get(path) ?? null);
      if (api._afterRead && api._afterRead.path === path) { const h = api._afterRead; api._afterRead = null; h.fn(set); }
      return { val: () => v };
    },
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
const heldNode = (db) => db.state.displayChecks_held?.["marathon-pe"]?.[DK];
const dayCheck = (db) => db.state.displayChecks?.["marathon-pe"]?.[SA]?.c1;
const events = (db) => Object.values(db.state.displayChecks_log?.["marathon-pe"]?.["2026-07"] || {}).map((e) => e.type);

// ── stock_seen ───────────────────────────────────────────────────────────────
test("stock present + not seen → stock_seen set on the flat record (still held)", async () => {
  const db = fakeDb({ displayChecks_held: idx(heldRecord()), stock: stock(3) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 1, activated: 0, reHeld: 0, relocated: 0 });
  assert.equal(heldNode(db).status, "held");
  assert.equal(heldNode(db).stockSeenAt, NOW);
  assert.equal(heldNode(db).wakeAt, NOW + D);
  assert.deepEqual(events(db), ["stock_seen"]);
});

test("still no stock → untouched", async () => {
  const db = fakeDb({ displayChecks_held: idx(heldRecord()), stock: stock(0) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, relocated: 0 });
  assert.equal(heldNode(db).stockSeenAt, undefined);
});

// ── activate + RELOCATE ──────────────────────────────────────────────────────
test("grace elapsed + stock → RELOCATED to today's day node as open; flat entry deleted", async () => {
  const seenAt = NOW - D - 1000;
  const db = fakeDb({ displayChecks_held: idx(heldRecord({ stockSeenAt: seenAt, wakeAt: seenAt + D })), stock: stock(2) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 1, reHeld: 0, relocated: 0 });
  assert.equal(heldNode(db), undefined);            // gone from the flat index
  const c = dayCheck(db);                            // now in today's day node
  assert.equal(c.status, "open");
  assert.equal(c.activatedAt, NOW);
  assert.equal(c.stockSeenAt, undefined);           // grace fields stripped
  assert.equal(c.wakeAt, undefined);
  assert.equal(c.checkId, "c1");
  assert.deepEqual(events(db), ["activated"]);
});

test("CROSS-DAY wake: a record held days ago relocates into TODAY's node, not its origin day", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks_held: idx(heldRecord({ heldAt: Date.parse("2026-07-13T09:00:00Z"), stockSeenAt: seenAt })),
    stock: stock(1),
  });
  await runWakeSweep({ db, nowMs: NOW });
  assert.ok(db.state.displayChecks["marathon-pe"][SA].c1, "landed in today's (2026-07-16) node");
  assert.equal(heldNode(db), undefined);
});

test("locked roster assigns the weekday person at activation", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({
    displayChecks_held: idx(heldRecord({ stockSeenAt: seenAt })),
    stock: stock(1),
    displayChecks_settings: { "marathon-pe": { roster: { locked: true, days: { thu: { uid: "u-lihle", name: "Lihle" } } } } },
  });
  await runWakeSweep({ db, nowMs: NOW }); // 2026-07-16 is a Thursday
  assert.deepEqual(dayCheck(db).assignedTo, { uid: "u-lihle", name: "Lihle" });
});

test("inside grace → no activation", async () => {
  const seenAt = NOW - 5 * 60000;
  const db = fakeDb({ displayChecks_held: idx(heldRecord({ stockSeenAt: seenAt })), stock: stock(2) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, relocated: 0 });
  assert.equal(heldNode(db).status, "held");
});

// ── P1: stock re-read immediately before activation ──────────────────────────
test("stock sells to zero during the roster reads → NOT activated; re-decided re_held", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({ displayChecks_held: idx(heldRecord({ stockSeenAt: seenAt })), stock: stock(1) });
  db._afterRead = { path: `stock/marathon-pe/p1/M/qty`, fn: (set) => set(`stock/marathon-pe/p1/M/qty`, 0) };
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 1, relocated: 0 });
  assert.equal(heldNode(db).status, "held");        // never left the flat index
  assert.equal(heldNode(db).stockSeenAt, undefined); // grace cleared
  assert.equal(dayCheck(db), undefined);            // nothing in the feed
});

// ── re_held (+ fence) ────────────────────────────────────────────────────────
test("seen + stock vanished before wake → stockSeenAt cleared on the flat record", async () => {
  const db = fakeDb({ displayChecks_held: idx(heldRecord({ stockSeenAt: 555, wakeAt: 555 + D })), stock: stock(0) });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 1, relocated: 0 });
  assert.equal(heldNode(db).stockSeenAt, undefined);
  assert.equal(heldNode(db).status, "held");
  assert.deepEqual(events(db), ["re_held"]);
});

// ── self-heal ────────────────────────────────────────────────────────────────
test("SELF-HEAL: an `open` record stuck in the flat index (crashed relocation) is relocated", async () => {
  const db = fakeDb({
    displayChecks_held: idx(heldRecord({ status: "open", activatedAt: NOW - 60000 })),
    stock: stock(2),
  });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, relocated: 1 });
  assert.equal(heldNode(db), undefined);
  assert.equal(dayCheck(db).status, "open");
  assert.deepEqual(events(db), ["activated"]);
});

// ── idempotency ──────────────────────────────────────────────────────────────
test("double-fire does not double-activate: second run finds it already relocated", async () => {
  const seenAt = NOW - D - 1;
  const db = fakeDb({ displayChecks_held: idx(heldRecord({ stockSeenAt: seenAt })), stock: stock(2) });
  const r1 = await runWakeSweep({ db, nowMs: NOW });
  const r2 = await runWakeSweep({ db, nowMs: NOW + 1000 });
  assert.equal(r1.activated, 1);
  assert.deepEqual(r2, { stockSeen: 0, activated: 0, reHeld: 0, relocated: 0 }); // flat index empty now
  assert.equal(events(db).filter((e) => e === "activated").length, 1);
});

// ── scope ────────────────────────────────────────────────────────────────────
test("disabled store (marathon-pine) is never processed", async () => {
  const db = fakeDb({ displayChecks_held: { "marathon-pine": { [DK]: heldRecord() } }, stock: { "marathon-pine": { p1: { M: { qty: 9 } } } } });
  const r = await runWakeSweep({ db, nowMs: NOW });
  assert.deepEqual(r, { stockSeen: 0, activated: 0, reHeld: 0, relocated: 0 });
});
