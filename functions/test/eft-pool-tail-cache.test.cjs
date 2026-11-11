// ─── THE TILL SEARCH'S HELD POOL TAIL ────────────────────────────────────────
// Pins lib/eft-pool-tail-cache.cjs and its wiring into eftPoolSearch:
//   · a typing burst costs ONE tail read plus one-record probes, not a tail
//     read per keystroke (the ~1 MB-per-keystroke line in the download bill);
//   · a payment that lands mid-burst is found on the very next search — the
//     probe sees it and the tail is read again at once (selling path: never
//     slower than before);
//   · the held tail is dropped after the TTL whatever the probe says, so a
//     payment spent at another till stops being offered within seconds;
//   · a failed read is never held, and a failed probe falls back to the read;
//   · the SETTLE never uses the held copy — it reads the tail fresh.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPoolTailCache, EFT_SEARCH_TAIL_TTL_MS } = require("../lib/eft-pool-tail-cache.cjs");

const rec = (at, extra = {}) => ({ outcome: "recorded", status: "unmatched", amountCents: 50000, at, reference: `REF${at}`, ...extra });

/** A pool that answers the two queries the way the database does: ordered by
 *  `at`, the last N. Counts each kind of read. */
function fakePool(initial = {}) {
  const pool = { ...initial };
  const reads = { tail: 0, newest: 0 };
  const lastN = (n) => Object.fromEntries(Object.entries(pool).sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : 1)).slice(-n));
  return {
    pool, reads,
    // Deep copies, like two separate snapshots off the wire.
    readTail: async () => { reads.tail++; return structuredClone(lastN(400)); },
    readNewest: async () => { reads.newest++; return structuredClone(lastN(1)); },
  };
}

test("the TTL is short: seconds, not minutes", () => {
  assert.ok(EFT_SEARCH_TAIL_TTL_MS >= 5_000 && EFT_SEARCH_TAIL_TTL_MS <= 30_000, String(EFT_SEARCH_TAIL_TTL_MS));
});

test("a typing burst: one tail read, then one-record probes", async () => {
  const db = fakePool({ a: rec(1), b: rec(2) });
  let t = 1_000_000;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t });
  const first = await cache.get();
  assert.deepEqual(Object.keys(first).sort(), ["a", "b"]);
  for (let i = 0; i < 9; i++) { t += 1_000; assert.deepEqual(await cache.get(), first); }
  assert.deepEqual(db.reads, { tail: 1, newest: 9 });
  assert.deepEqual(cache.stats(), { full: 1, probes: 9, hits: 9 });
});

test("a payment landing mid-burst is found on the NEXT search — the tail is re-read at once", async () => {
  const db = fakePool({ a: rec(1) });
  let t = 5_000;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t });
  await cache.get();
  t += 200;                       // well inside the TTL
  db.pool.b = rec(2);             // the customer's payment arrives
  const after = await cache.get();
  assert.ok(after.b, "the new payment must be in the answer");
  assert.equal(db.reads.tail, 2);
  // …and the burst carries on from the fresh tail without another full read.
  t += 200;
  assert.ok((await cache.get()).b);
  assert.equal(db.reads.tail, 2);
});

test("the newest record CHANGING (used, released) also re-reads the tail", async () => {
  const db = fakePool({ a: rec(1), b: rec(2) });
  let t = 0;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t });
  await cache.get();
  db.pool.b = rec(2, { status: "used", used: { at: 9 } });
  t += 100;
  assert.equal((await cache.get()).b.status, "used");
  assert.equal(db.reads.tail, 2);
});

test("an OLDER record changing is seen once the TTL passes — and not later than that", async () => {
  const db = fakePool({ a: rec(1), b: rec(2) });
  let t = 0;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t, ttlMs: 15_000 });
  await cache.get();
  db.pool.a = rec(1, { status: "used", used: { at: 9 } }); // spent at another till
  t = 14_999;
  assert.equal((await cache.get()).a.status, "unmatched", "inside the TTL the probe cannot see an older record");
  t = 15_000;
  assert.equal((await cache.get()).a.status, "used", "at the TTL the tail is read again, probe or no probe");
  assert.equal(db.reads.tail, 2);
});

test("an empty pool is held like any other — and the first payment into it is seen at once", async () => {
  const db = fakePool({});
  let t = 0;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t });
  assert.deepEqual(await cache.get(), {});
  t += 10;
  assert.deepEqual(await cache.get(), {});
  assert.equal(db.reads.tail, 1);
  db.pool.a = rec(1);
  t += 10;
  assert.ok((await cache.get()).a);
  assert.equal(db.reads.tail, 2);
});

test("a null tail (the node does not exist) is an empty tail, not a crash", async () => {
  const cache = createPoolTailCache({ readTail: async () => null, readNewest: async () => null, now: () => 0 });
  assert.deepEqual(await cache.get(), {});
  assert.deepEqual(await cache.get(), {});
  assert.equal(cache.stats().full, 1);
});

test("callers arriving while the tail read is in flight share that one read", async () => {
  let release;
  let tails = 0;
  const cache = createPoolTailCache({
    readTail: () => { tails++; return new Promise((r) => { release = () => r({ a: rec(1) }); }); },
    readNewest: async () => { throw new Error("no probe expected: nothing is held yet"); },
    now: () => 0,
  });
  const all = [cache.get(), cache.get(), cache.get()];
  await new Promise((r) => setImmediate(r));
  release();
  const out = await Promise.all(all);
  assert.equal(tails, 1);
  for (const tail of out) assert.ok(tail.a);
});

test("a FAILED tail read is not held: the caller sees the error and the next call reads again", async () => {
  let fail = true;
  let tails = 0;
  const cache = createPoolTailCache({
    readTail: async () => { tails++; if (fail) throw new Error("database unavailable"); return { a: rec(1) }; },
    readNewest: async () => ({ a: rec(1) }),
    now: () => 0,
  });
  await assert.rejects(() => cache.get(), /database unavailable/);
  fail = false;
  assert.ok((await cache.get()).a);
  assert.equal(tails, 2);
});

test("a FAILED probe falls back to reading the tail — never a stale answer by default", async () => {
  const db = fakePool({ a: rec(1) });
  let t = 0;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: async () => { throw new Error("probe failed"); }, now: () => t });
  await cache.get();
  db.pool.b = rec(2);
  t += 10;
  assert.ok((await cache.get()).b);
  assert.equal(db.reads.tail, 2);
});

test("a clock that steps backwards does not turn the held tail immortal", async () => {
  const db = fakePool({ a: rec(1) });
  let t = 100_000;
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => t });
  await cache.get();
  t = 50_000;
  await cache.get();
  assert.equal(db.reads.tail, 2);
});

test("clear() forgets the held tail", async () => {
  const db = fakePool({ a: rec(1) });
  const cache = createPoolTailCache({ readTail: db.readTail, readNewest: db.readNewest, now: () => 0 });
  await cache.get();
  cache.clear();
  await cache.get();
  assert.equal(db.reads.tail, 2);
});

// ─── THE WIRING — eftPoolSearch uses it, eftPoolSettle does not ──────────────
class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const wire = { pool: {}, limits: [], reads: {} };
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => ({
      once: async () => ({ val: () => (path.startsWith("eft_pool/") ? (wire.pool[path.slice(9)] ?? null) : (wire.reads[path] ?? null)) }),
      orderByChild: (child) => ({
        limitToLast: (n) => ({
          once: async () => {
            assert.equal(path, "eft_pool");
            assert.equal(child, "at");
            wire.limits.push(n);
            const last = Object.entries(wire.pool).sort((a, b) => a[1].at - b[1].at).slice(-n);
            return { val: () => (last.length ? structuredClone(Object.fromEntries(last)) : null) };
          },
        }),
      }),
      transaction: async () => ({ committed: false }),
      set: async () => {}, remove: async () => {}, update: async () => {},
    }),
  }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const path = require.resolve(name);
  require.cache[path] = { id: path, filename: path, loaded: true, exports: exportsObj };
}
stub("firebase-functions/v2/https", { onCall: (_opts, handler) => handler, HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_opts, handler) => handler });
stub("firebase-admin", fakeAdmin);
const { eftPoolSearch, eftPoolSettle, _resetSearchTail } = require("../eftPool/eftPool.js");
const { EFT_SEARCH_WINDOW } = require("../lib/eft-pool.cjs");

const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
const key = (c) => c.repeat(40);
const payment = (at, reference, extra = {}) => ({ outcome: "recorded", status: "unmatched", amountCents: 50000, at, reader: "fnb", bankRef: `BANK${at}XYZ`, reference, payer: "J SOAP", ...extra });
function resetWire() {
  wire.pool = { [key("a")]: payment(1, "JUNID1234") };
  wire.limits = [];
  wire.reads = { "users/cashier-uid/posAccess/isActive": true, "users/cashier-uid/posAccess/displayName": "Ahmed" };
  _resetSearchTail();
}

test("eftPoolSearch: typing J-U-N-I-D reads the 400-tail ONCE; every later keystroke is a one-record probe", async () => {
  resetWire();
  for (const query of ["jun", "juni", "junid", "junid1", "junid12", "junid123", "junid1234"]) {
    const out = await eftPoolSearch({ ...CASHIER, data: { query } });
    assert.equal(out.results.length, 1, query);
    assert.equal(out.results[0].reference, "JUNID1234");
  }
  assert.deepEqual(wire.limits, [EFT_SEARCH_WINDOW, 1, 1, 1, 1, 1, 1]);
});

test("eftPoolSearch: the customer's payment lands between two keystrokes — the next search answers with it", async () => {
  resetWire();
  assert.deepEqual((await eftPoolSearch({ ...CASHIER, data: { query: "sipho99" } })).results, []);
  wire.pool[key("b")] = payment(2, "SIPHO99");
  const out = await eftPoolSearch({ ...CASHIER, data: { query: "sipho99" } });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].key, key("b"));
  // tail, then probe → the probe saw a record the held tail lacks → tail again.
  assert.deepEqual(wire.limits, [EFT_SEARCH_WINDOW, 1, EFT_SEARCH_WINDOW]);
});

test("eftPoolSearch: the answer is the same with the held tail as with a fresh read", async () => {
  resetWire();
  wire.pool[key("b")] = payment(2, "RENT", { status: "used", used: { at: 5, sale: { receiptNumber: "S-1" } } });
  wire.pool[key("c")] = payment(3, "RENT");
  const cold = await eftPoolSearch({ ...CASHIER, data: { query: "rent" } });
  const warm = await eftPoolSearch({ ...CASHIER, data: { query: "rent" } });
  assert.deepEqual(warm, cold);
  assert.deepEqual(wire.limits, [EFT_SEARCH_WINDOW, 1]);
});

test("eftPoolSearch: a refused search (too short, or carrying an amount) still reads nothing at all", async () => {
  resetWire();
  await eftPoolSearch({ ...CASHIER, data: { query: "ju" } });
  await assert.rejects(() => eftPoolSearch({ ...CASHIER, data: { query: "junid", amount: 500 } }), (e) => e.code === "invalid-argument");
  assert.deepEqual(wire.limits, []);
});

test("eftPoolSettle never rides the search's held tail: it reads the full tail itself, every time", async () => {
  resetWire();
  await eftPoolSearch({ ...CASHIER, data: { query: "junid1234" } }); // the search now holds a tail
  wire.limits = [];
  const req = { ...CASHIER, data: { action: "settle", poolKey: key("a"), attemptId: "P-1", appliedCents: 50000, storeId: "pe", tillId: "till-1" } };
  // The fake commits nothing, so the settle ends in a refusal — what matters
  // here is the read it made on the way.
  await eftPoolSettle(req).catch(() => {});
  await eftPoolSettle(req).catch(() => {});
  assert.deepEqual(wire.limits, [EFT_SEARCH_WINDOW, EFT_SEARCH_WINDOW]);
});
