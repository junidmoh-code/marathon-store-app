// ─── EFT POOL CALLABLES — the two gates only the callable layer enforces ─────
// The pure modules are tested on their own; this pins the wall the callables
// put in front of them, because a regression here ships silently:
//   · eftPoolSearch REFUSES a request that carries an amount field, outright —
//     "amount is not a search key" is a contract, not an absence;
//   · eftPoolSearch refuses to read the pool for a query under three
//     letters/digits;
//   · eftPoolSettle's "markUsed" is the OWNER's alone, decided server-side —
//     an active POS identity that is not the owner is refused before any
//     transaction runs.
// firebase-functions and firebase-admin are stubbed through require.cache:
// onCall hands back its handler, and the database fake answers only what
// these gates read. (Independent architect review, this PR.)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const dbState = { reads: {}, transactions: 0, poolReads: 0 };
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => ({
      once: async () => ({ val: () => (path.startsWith("eft_pool") ? (dbState.poolReads++, {}) : (dbState.reads[path] ?? null)) }),
      orderByChild: () => ({ limitToLast: () => ({ once: async () => { dbState.poolReads++; return { val: () => ({}) }; } }) }),
      transaction: async () => { dbState.transactions++; return { committed: false }; },
      set: async () => {}, remove: async () => {}, update: async () => {},
    }),
    getRules: async () => "{}",
  }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const path = require.resolve(name);
  require.cache[path] = { id: path, filename: path, loaded: true, exports: exportsObj };
}
// Resolve through the functions package so the names match what eftPool.js requires.
stub("firebase-functions/v2/https", { onCall: (_opts, handler) => handler, HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_opts, handler) => handler });
stub("firebase-admin", fakeAdmin);
const { eftPoolSearch, eftPoolSettle } = require("../eftPool/eftPool.js");

const OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: true } } };
const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
dbState.reads["users/cashier-uid/posAccess/isActive"] = true;
dbState.reads["users/cashier-uid/posAccess/displayName"] = "Ahmed";

async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected a ${code} refusal`);
}

test("eftPoolSearch refuses a request carrying an amount — before any read", async () => {
  for (const data of [{ query: "junid", amount: 550 }, { query: "junid", amountCents: 55000 }, { query: "junid", amount: "550" }]) {
    dbState.poolReads = 0;
    const e = await rejects(eftPoolSearch({ ...CASHIER, data }), "invalid-argument");
    assert.match(e.message, /Amount is not a search key/);
    assert.equal(dbState.poolReads, 0, "the pool must not be read for a refused request");
  }
});

test("eftPoolSearch does not read the pool for a query under three letters/digits", async () => {
  for (const query of ["", "ju", "j-u", " . ", "  a "]) {
    dbState.poolReads = 0;
    const out = await eftPoolSearch({ ...CASHIER, data: { query } });
    assert.deepEqual(out, { results: [], searched: 0, needQuery: true }, JSON.stringify(query));
    assert.equal(dbState.poolReads, 0);
  }
  dbState.poolReads = 0;
  const out = await eftPoolSearch({ ...CASHIER, data: { query: "jun" } });
  assert.equal(dbState.poolReads, 1);
  assert.deepEqual(out.results, []);
});

test("eftPoolSearch needs an active POS identity or the owner", async () => {
  await rejects(eftPoolSearch({ auth: { uid: "stranger", token: {} }, data: { query: "junid" } }), "permission-denied");
  await rejects(eftPoolSearch({ data: { query: "junid" } }), "permission-denied");
  dbState.poolReads = 0;
  await eftPoolSearch({ ...OWNER, data: { query: "junid" } });
  assert.equal(dbState.poolReads, 1);
});

test("markUsed is the owner's alone — an active cashier is refused before any transaction", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  const e = await rejects(eftPoolSettle({ ...CASHIER, data: { action: "markUsed", poolKey: key, reason: "paid in June" } }), "permission-denied");
  assert.match(e.message, /Only the owner/);
  assert.equal(dbState.transactions, 0);
});

test("markUsed by the owner needs a reason of three characters; then it runs the pool transaction", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  await rejects(eftPoolSettle({ ...OWNER, data: { action: "markUsed", poolKey: key, reason: " ok " } }), "invalid-argument");
  await rejects(eftPoolSettle({ ...OWNER, data: { action: "markUsed", poolKey: key } }), "invalid-argument");
  assert.equal(dbState.transactions, 0);
  // With a reason, the transaction runs; the fake never commits and captures
  // no decision, so the callable reports the record as gone — the point here
  // is only that the gate opened and the transaction was reached.
  await rejects(eftPoolSettle({ ...OWNER, data: { action: "markUsed", poolKey: key, reason: "paid in June" } }), "failed-precondition").catch(() => {});
  assert.equal(dbState.transactions, 1);
});

test("markUsed refuses a malformed pool key before anything else", async () => {
  dbState.transactions = 0;
  await rejects(eftPoolSettle({ ...OWNER, data: { action: "markUsed", poolKey: "../users", reason: "paid in June" } }), "invalid-argument");
  assert.equal(dbState.transactions, 0);
});

test.after(() => { Module._cache = require.cache; });
