// ─── EFT POOL CALLABLES — the two gates only the callable layer enforces ─────
// The pure modules are tested on their own; this pins the wall the callables
// put in front of them, because a regression here ships silently:
//   · eftPoolSearch REFUSES a request that carries an amount field, outright —
//     "amount is not a search key" is a contract, not an absence;
//   · eftPoolSearch refuses to read the pool for a query under three
//     letters/digits;
//   · eftPoolSettle's "markUsed" is the owner's, OR a uid the owner has given
//     the eftReview capability to, decided server-side and re-read from the
//     database on every call — an active POS identity without the flag is
//     refused before any transaction runs, and revoking the flag takes effect
//     on the very next call with nothing cached to ride past.
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
      // The update function is RUN, against whatever record the test stands up
      // at dbState.txCurrent (null by default — the Admin SDK's cold-cache
      // first call), so a test can assert what would actually be written.
      transaction: async (fn) => {
        dbState.transactions++;
        dbState.txNext = typeof fn === "function" ? fn(dbState.txCurrent ?? null) : undefined;
        return { committed: false };
      },
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
const { eftPoolSearch, eftPoolSettle, eftPoolReverse } = require("../eftPool/eftPool.js");

const OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: true } } };
const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
dbState.reads["users/cashier-uid/posAccess/isActive"] = true;
dbState.reads["users/cashier-uid/posAccess/displayName"] = "Ahmed";
dbState.reads["users/cashier-uid/posAccess"] = { isActive: true, displayName: "Ahmed", role: "cashier" };

// A staff member the OWNER has given eftReview to: an active POS account with
// the flag. Everything about that comes off the record, never off the token.
const REVIEWER = { auth: { uid: "reviewer-uid", token: { email: "ibrahim@marathon.internal" } } };
dbState.reads["users/reviewer-uid/posAccess/isActive"] = true;
dbState.reads["users/reviewer-uid/posAccess/displayName"] = "ibrahim";
dbState.reads["users/reviewer-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager", eftReview: true };

// The same person, DEACTIVATED. The capability must go with the account.
const SUSPENDED = { auth: { uid: "suspended-uid", token: { email: "x@marathon.internal" } } };
dbState.reads["users/suspended-uid/posAccess/isActive"] = true;
dbState.reads["users/suspended-uid/posAccess"] = { isActive: false, displayName: "x", eftReview: true };

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

test("markUsed refuses an active cashier WITHOUT eftReview, before any transaction", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  const e = await rejects(eftPoolSettle({ ...CASHIER, data: { action: "markUsed", poolKey: key, reason: "paid in June" } }), "permission-denied");
  assert.match(e.message, /EFT review/);
  assert.equal(dbState.transactions, 0);
});

test("markUsed lets an eftReview holder through — and STAMPS THEIR NAME, not \"owner\"", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  // A real unmatched payment for the transaction to act on, so the assertion is
  // about what WOULD BE WRITTEN, not merely about the gate opening.
  dbState.txCurrent = { outcome: "recorded", status: "unmatched", amountCents: 10000, at: 1, payer: "P", reference: "R" };
  await eftPoolSettle({ ...REVIEWER, data: { action: "markUsed", poolKey: key, reason: "paid at the shop in June" } }).catch(() => {});
  assert.equal(dbState.transactions, 1, "the gate opened and the transaction ran");
  const mark = dbState.txNext?.used?.outsidePos;
  assert.ok(mark, "the transaction stamps an outside-POS mark");
  // THE RECORD NAMES THE PERSON. It used to stamp the literal "owner" because
  // the owner was the only caller; a staff mark that said "owner" would make
  // the owner's own review list useless.
  assert.equal(mark.actorName, "ibrahim");
  assert.equal(mark.actorUid, "reviewer-uid");
  assert.equal(mark.reason, "paid at the shop in June");
  dbState.txCurrent = null;
});

test("REVOKING THE FLAG TAKES EFFECT ON THE NEXT CALL — nothing is cached", async () => {
  const key = "a".repeat(40);
  // The holder is through…
  dbState.transactions = 0;
  await eftPoolSettle({ ...REVIEWER, data: { action: "markUsed", poolKey: key, reason: "paid at the shop" } }).catch(() => {});
  assert.equal(dbState.transactions, 1);
  // …the owner takes the capability away…
  const restore = dbState.reads["users/reviewer-uid/posAccess"];
  dbState.reads["users/reviewer-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager" };
  dbState.transactions = 0;
  // …and the VERY NEXT call is refused, with no transaction reached.
  await rejects(eftPoolSettle({ ...REVIEWER, data: { action: "markUsed", poolKey: key, reason: "paid at the shop" } }), "permission-denied");
  assert.equal(dbState.transactions, 0);
  dbState.reads["users/reviewer-uid/posAccess"] = restore;
});

test("a DEACTIVATED account keeps the flag on the record and loses the capability", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  await rejects(eftPoolSettle({ ...SUSPENDED, data: { action: "markUsed", poolKey: key, reason: "paid at the shop" } }), "permission-denied");
  assert.equal(dbState.transactions, 0);
});

test("REVERSAL IS THE OWNER ALONE — an eftReview holder is refused server-side", async () => {
  const key = "a".repeat(40);
  dbState.transactions = 0;
  for (const who of [REVIEWER, CASHIER]) {
    const e = await rejects(eftPoolReverse({ ...who, data: { poolKey: key, reason: "wrong one" } }), "permission-denied");
    assert.match(e.message, /Only the owner can reverse/);
  }
  assert.equal(dbState.transactions, 0, "no reversal transaction is ever reached");
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
