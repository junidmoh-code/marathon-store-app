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
const dbState = { reads: {}, transactions: 0, poolReads: 0, pool: {}, tail: {}, fingerprints: {}, txPaths: [] };
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => ({
      once: async () => ({ val: () => (path.startsWith("eft_pool") ? (dbState.poolReads++, dbState.pool[path] ?? {}) : (dbState.reads[path] ?? null)) }),
      orderByChild: () => ({ limitToLast: () => ({ once: async () => { dbState.poolReads++; return { val: () => dbState.tail }; } }) }),
      // The update function is RUN, against whatever record the test stands up
      // at dbState.txCurrent (null by default — the Admin SDK's cold-cache
      // first call), so a test can assert what would actually be written.
      transaction: async (fn) => {
        dbState.txPaths.push(path);
        // The fingerprint claim (fix 1) is its own node: run it against the
        // claim the test stood up, and keep what it would write.
        if (path.startsWith("eft_pool_fingerprints/")) {
          const out = fn(dbState.fingerprints[path] ?? null);
          if (out !== undefined && dbState.fingerprints[path] == null) dbState.fingerprints[path] = out;
          return { committed: out !== undefined };
        }
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

test("markUsed ANSWERS with what it stamped, so a caller need not invent it", async () => {
  const key = "a".repeat(40);
  dbState.txCurrent = { outcome: "recorded", status: "unmatched", amountCents: 10000, at: 1, payer: "P", reference: "R" };
  const before = Date.now();
  const out = await eftPoolSettle({ ...REVIEWER, data: { action: "markUsed", poolKey: key, reason: "paid at the shop" } }).catch(() => null);
  dbState.txCurrent = null;
  assert.ok(out, "the mark went through");
  assert.equal(out.actorName, "ibrahim");
  assert.equal(out.reason, "paid at the shop");
  assert.ok(out.at >= before, "the moment is the server's own");
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

test("markUsed by the owner needs NO reason — two taps and no keyboard", async () => {
  const key = "a".repeat(40);
  // No reason field at all, and a blank one: both reach the transaction. A
  // required sentence is what stops this being done at a counter.
  for (const data of [
    { action: "markUsed", poolKey: key },
    { action: "markUsed", poolKey: key, reason: "" },
    { action: "markUsed", poolKey: key, reason: "   " },
  ]) {
    dbState.transactions = 0;
    await eftPoolSettle({ ...OWNER, data }).catch(() => {});
    assert.equal(dbState.transactions, 1, JSON.stringify(data));
  }
});

test("markUsed refuses a malformed pool key before anything else", async () => {
  dbState.transactions = 0;
  await rejects(eftPoolSettle({ ...OWNER, data: { action: "markUsed", poolKey: "../users", reason: "paid in June" } }), "invalid-argument");
  assert.equal(dbState.transactions, 0);
});

test.after(() => { Module._cache = require.cache; });

// ─── FIX 1: THE SETTLE WALL CHECKS THE BANK'S TRANSACTION ID ─────────────────
const { paymentFingerprint } = require("../lib/eft-fingerprint.cjs");
const PAY = { outcome: "recorded", status: "unmatched", amountCents: 50000, at: 1, reader: "fnb", bankRef: "5TG59DVQ", reference: "JUNID1234", payer: "J SOAP" };
const K1 = "1".repeat(40);
const K2 = "2".repeat(40);
const settleReq = (key, over = {}) => ({ ...CASHIER, data: { action: "settle", poolKey: key, attemptId: "P-1", appliedCents: 50000, customerId: "0821234567", confirmedCustomerId: "0821234567", ...over } });
dbState.reads["customers/0821234567"] = { name: "Mr Dlamini" };
function resetPool() {
  dbState.pool = {}; dbState.tail = {}; dbState.fingerprints = {}; dbState.txPaths = []; dbState.transactions = 0; dbState.txCurrent = null;
}

test("settle refuses a payment with NO bank transaction id — before the settle transaction", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = { ...PAY, bankRef: null };
  const e = await rejects(eftPoolSettle(settleReq(K1)), "failed-precondition");
  assert.equal(e.details.code, "no-bank-id");
  assert.equal(dbState.transactions, 0, "no settle transaction ran");
});

test("settle refuses the RESENT copy whose fingerprint the original holds", async () => {
  resetPool();
  const fp = paymentFingerprint(PAY);
  dbState.pool[`eft_pool/${K2}`] = { ...PAY, at: 2 };
  dbState.fingerprints[`eft_pool_fingerprints/${fp}`] = { poolKey: K1, at: 1 };
  const e = await rejects(eftPoolSettle(settleReq(K2)), "failed-precondition");
  assert.equal(e.details.code, "duplicate");
  assert.equal(dbState.transactions, 0);
  assert.deepEqual(dbState.fingerprints[`eft_pool_fingerprints/${fp}`], { poolKey: K1, at: 1 }, "the claim is untouched");
});

test("settle refuses a pre-fix copy of a payment that is already USED (no claim exists yet)", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K2}`] = { ...PAY, at: 2 };
  dbState.tail = { [K1]: { ...PAY, status: "used" }, [K2]: { ...PAY, at: 2 } };
  const e = await rejects(eftPoolSettle(settleReq(K2)), "failed-precondition");
  assert.equal(e.details.code, "duplicate-used");
  assert.equal(dbState.transactions, 0);
});

test("the original settles: the claim is taken for it and the fingerprint reaches the transaction", async () => {
  resetPool();
  const fp = paymentFingerprint(PAY);
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.txCurrent = PAY;
  await eftPoolSettle(settleReq(K1)).catch(() => {});
  assert.equal(dbState.fingerprints[`eft_pool_fingerprints/${fp}`].poolKey, K1);
  assert.deepEqual(dbState.txPaths, [`eft_pool_fingerprints/${fp}`, `eft_pool/${K1}`], "claim first, then the settle");
  assert.equal(dbState.txNext?.status, "used");
  resetPool();
});

test("releaseHold is the OWNER alone", async () => {
  resetPool();
  await rejects(eftPoolSettle({ ...REVIEWER, data: { action: "releaseHold", poolKey: K1, reason: "on the statement" } }), "permission-denied");
  await rejects(eftPoolSettle({ ...CASHIER, data: { action: "releaseHold", poolKey: K1, reason: "on the statement" } }), "permission-denied");
  assert.equal(dbState.transactions, 0);
  dbState.txCurrent = { ...PAY, bankRef: null, outcome: "held-no-bankref" };
  await eftPoolSettle({ ...OWNER, data: { action: "releaseHold", poolKey: K1, reason: "on FNB statement" } }).catch(() => {});
  assert.equal(dbState.txNext?.outcome, "recorded");
  assert.equal(dbState.txNext?.releasedFromHold?.reason, "on FNB statement");
  resetPool();
});

// ─── FIX 3: A PAYMENT IS APPLIED ONLY TO A CONFIRMED, RESOLVED CUSTOMER ──────
test("settle with no customer on the sale is refused before anything is read or claimed", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  const e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null })), "failed-precondition");
  assert.equal(e.details.code, "no-customer");
  assert.deepEqual(dbState.txPaths, []);
});

test("settle without the cashier's explicit confirmation of THAT customer is refused", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  for (const confirmedCustomerId of [undefined, null, "", "0829999999"]) {
    const e = await rejects(eftPoolSettle(settleReq(K1, { confirmedCustomerId })), "failed-precondition");
    assert.equal(e.details.code, "not-confirmed");
  }
  assert.deepEqual(dbState.txPaths, []);
});

test("settle refuses a customer id that is not a real customer record", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  await rejects(eftPoolSettle(settleReq(K1, { customerId: "0820000000", confirmedCustomerId: "0820000000" })), "not-found");
  assert.deepEqual(dbState.txPaths, []);
});

test("the settlement names the customer from /customers, never the till's text", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.txCurrent = PAY;
  await eftPoolSettle(settleReq(K1, { customerName: "Somebody Else" })).catch(() => {});
  assert.equal(dbState.txNext?.used?.customerName, "Mr Dlamini");
  assert.equal(dbState.txNext?.used?.customerId, "0821234567");
  assert.equal(dbState.txNext?.used?.customerConfirmed, true);
  resetPool();
});
