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
      // The one-time fingerprint backfill pages /eft_pool by key.
      orderByKey: () => {
        const q = { startAfter: (c) => { dbState.backfillCursor = c; return q; }, limitToFirst: (n) => { dbState.backfillLimit = n; return q; },
          once: async () => ({
            val: () => dbState.backfillPage ?? null,
            forEach: (fn) => { for (const key of Object.keys(dbState.backfillPage ?? {})) fn({ key }); },
          }) };
        return q;
      },
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
      set: async (v) => { (dbState.sets ??= {})[path] = v; }, remove: async () => {}, update: async () => {},
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
const { eftPoolSearch, eftPoolSettle, eftPoolReverse, eftRemainderScan } = require("../eftPool/eftPool.js");

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
// `individual`: the owner confirmed this login is one person's own (fix 4).
dbState.reads["users/reviewer-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager", eftReview: true, individual: true };

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
  dbState.reads["users/reviewer-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager", individual: true };
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

test("markUsed needs a REASON — owner and reviewer alike, refused before any transaction (fix 4)", async () => {
  const key = "a".repeat(40);
  for (const who of [OWNER, REVIEWER]) {
    for (const data of [
      { action: "markUsed", poolKey: key },
      { action: "markUsed", poolKey: key, reason: "" },
      { action: "markUsed", poolKey: key, reason: "  ok " },
    ]) {
      dbState.transactions = 0;
      const e = await rejects(eftPoolSettle({ ...who, data }), "invalid-argument");
      assert.equal(e.details.code, "bad-reason");
      assert.equal(dbState.transactions, 0, JSON.stringify(data));
    }
  }
});

test("markUsed refuses eftReview on a login NOT confirmed as one person's — a shared till login (fix 4)", async () => {
  const key = "a".repeat(40);
  const SHARED = { auth: { uid: "shared-uid", token: { email: "pe-till@marathon.internal", name: "PE Till" } } };
  dbState.reads["users/shared-uid/posAccess/isActive"] = true;
  dbState.reads["users/shared-uid/posAccess"] = { isActive: true, displayName: "PE Till", role: "cashier", eftReview: true };
  dbState.transactions = 0;
  const e = await rejects(eftPoolSettle({ ...SHARED, data: { action: "markUsed", poolKey: key, reason: "paid in June" } }), "permission-denied");
  assert.equal(e.details.code, "not-individual");
  assert.equal(dbState.transactions, 0);
  // Confirmed individual but nameless: refused — never a token fallback.
  dbState.reads["users/shared-uid/posAccess"] = { isActive: true, displayName: "  ", eftReview: true, individual: true };
  const e2 = await rejects(eftPoolSettle({ ...SHARED, data: { action: "markUsed", poolKey: key, reason: "paid in June" } }), "permission-denied");
  assert.equal(e2.details.code, "no-actor-name");
  assert.equal(dbState.transactions, 0);
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
// …EXCEPT (Junid, 19 Oct 2026) a payment consumed WHOLE, found by its
// reference: nothing is left over to belong to anyone. The callable re-runs
// the cashier's query through the very search they used and settles only when
// it resolves to THIS payment. Never on the amount; never with money left over.
test("settle with no customer and no re-resolving query is refused before any claim", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY };
  for (const matchQuery of [undefined, null, "", "550", "55000", "zzzz", "OTHERREF"]) {
    const e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery })), "failed-precondition");
    assert.equal(e.details.code, "not-matched", JSON.stringify(matchQuery));
  }
  assert.deepEqual(dbState.txPaths, [], "nothing claimed, nothing settled");
});

test("settle with no customer: the whole payment, found by its reference again → settles for nobody, saying how", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY };
  dbState.txCurrent = PAY;
  const out = await eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery: "junid 1234" }));
  assert.equal(out.ok, true);
  assert.equal(dbState.txNext?.status, "used");
  assert.equal(dbState.txNext?.used.customerId, null);
  assert.equal(dbState.txNext?.used.customerConfirmed, false);
  assert.equal(dbState.txNext?.used.wholePaymentMatched, true);
  assert.equal(dbState.txNext?.used.appliedCents, 50000);
  // A forgiving query that still resolves to this one payment is enough —
  // forgiving on spelling, never on which payment.
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY; dbState.tail = { [K1]: PAY }; dbState.txCurrent = PAY;
  const typo = await eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery: "junid1235" }));
  assert.equal(typo.ok, true);
  resetPool();
});

test("a customer-less settle RETRIED by the same attempt (lost response) is success, not a refusal", async () => {
  resetPool();
  const held = { ...PAY, status: "used", used: { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", cashierName: "Ahmed", customerId: null, customerName: null, customerConfirmed: false, wholePaymentMatched: true, appliedCents: 50000, sale: null } };
  dbState.pool[`eft_pool/${K1}`] = held;
  dbState.tail = { [K1]: held };
  dbState.txCurrent = held;
  dbState.fingerprints[`eft_pool_fingerprints/${paymentFingerprint(PAY)}`] = { poolKey: K1, at: 5 };
  const out = await eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery: "junid1234" }));
  assert.equal(out.ok, true);
  assert.equal(out.already, true);
  assert.equal(dbState.txNext, undefined, "nothing rewritten");
  // A DIFFERENT attempt still loses.
  const e = await rejects(eftPoolSettle(settleReq(K1, { attemptId: "P-2", customerId: null, confirmedCustomerId: null, matchQuery: "junid1234" })), "failed-precondition");
  assert.equal(e.details.code, "not-matched");
  resetPool();
});

test("a malformed amount on a customer-less settle is bad-amount, never a leftover message", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY };
  for (const appliedCents of [undefined, 0, -5, 50001, "50000"]) {
    const e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, appliedCents, matchQuery: "junid1234" })), "failed-precondition");
    assert.equal(e.details.code, "bad-amount", String(appliedCents));
  }
  assert.deepEqual(dbState.txPaths, []);
});

test("settle with no customer and money LEFT OVER is refused — the remainder must belong to someone", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY };
  const e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, appliedCents: 30000, matchQuery: "junid1234" })), "failed-precondition");
  assert.equal(e.details.code, "no-customer");
  assert.match(e.message, /R200[.,]00 of this payment is left over/);
  assert.deepEqual(dbState.txPaths, []);
});

test("NEVER on the amount: a query that resolves to a DIFFERENT payment, or to two, settles nothing", async () => {
  resetPool();
  const other = { ...PAY, reference: "OTHER9999", bankRef: "Z9Z9Z9Z9", at: 2 };
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY, [K2]: other };
  // The query names the OTHER payment (same amount) — this key is refused.
  let e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery: "other9999" })), "failed-precondition");
  assert.equal(e.details.code, "not-matched");
  // Two payments with the same reference: ambiguous → refused for either.
  dbState.tail = { [K1]: PAY, [K2]: { ...PAY, bankRef: "Z9Z9Z9Z9", at: 2 } };
  e = await rejects(eftPoolSettle(settleReq(K1, { customerId: null, confirmedCustomerId: null, matchQuery: "junid1234" })), "failed-precondition");
  assert.equal(e.details.code, "not-matched");
  assert.deepEqual(dbState.txPaths, []);
});

test("with a customer on the sale, the confirmed-customer rule is exactly as before", async () => {
  resetPool();
  dbState.pool[`eft_pool/${K1}`] = PAY;
  dbState.tail = { [K1]: PAY };
  dbState.txCurrent = PAY;
  await eftPoolSettle(settleReq(K1, { appliedCents: 30000, matchQuery: "junid1234" })).catch(() => {});
  assert.equal(dbState.txNext?.used.customerId, "0821234567");
  assert.equal(dbState.txNext?.used.customerConfirmed, true);
  assert.equal(dbState.txNext?.used.wholePaymentMatched, undefined);
  resetPool();
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

// ─── FIX 5: ATTACH READS THE COMMITTED SALE BACK ─────────────────────────────
test("attach refuses a sale whose EFT leg exceeds what was settled — and stamps the evidence", async () => {
  resetPool();
  const usedRec = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", cashierName: "Ahmed", customerId: "0821234567", customerConfirmed: true, appliedCents: 5000, sale: null };
  dbState.pool[`eft_pool/${K1}/used`] = usedRec;
  dbState.reads["pos/sales/S-big"] = { customerId: "0821234567", payments: { p1: { method: "eft", amount: 50000, eftPoolKey: K1 } } };
  dbState.txCurrent = { ...PAY, status: "used", used: usedRec, amountCents: 100000 };
  const realTxn = dbState.txPaths;
  const e = await rejects(eftPoolSettle({ ...CASHIER, data: { action: "attach", poolKey: K1, attemptId: "P-1", saleId: "S-big", receiptNumber: "00042" } }), "failed-precondition");
  assert.equal(e.details.code, "sale-mismatch");
  assert.equal(realTxn.filter((p) => p === `eft_pool/${K1}`).length, 2, "the evidence stamp, then the refused attach");
  resetPool();
});

test("attach refuses a malformed sale id before any read", async () => {
  resetPool();
  await rejects(eftPoolSettle({ ...CASHIER, data: { action: "attach", poolKey: K1, attemptId: "P-1", saleId: "../users" } }), "invalid-argument");
  assert.deepEqual(dbState.txPaths, []);
});

test("the scan verifies an attach made before its sale reached the server — and flags a bigger leg", async () => {
  resetPool();
  const usedRec = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", customerId: "0821234567", customerConfirmed: true, appliedCents: 5000,
    sale: { saleId: "S-late", receiptNumber: "1", at: 6, verified: false } };
  dbState.reads["eft_pending_sale_checks"] = { [K1]: { at: Date.now() - 60_000, saleId: "S-late" } };
  // The scan reads the whole pool RECORD (one record, never the node) — the
  // promotion of a held remainder needs its status and amount, not just used.
  dbState.pool[`eft_pool/${K1}`] = { ...PAY, status: "used", used: usedRec, amountCents: 100000 };
  dbState.reads["pos/sales/S-late"] = { customerId: "0821234567", payments: { p: { method: "eft", amount: 50000, eftPoolKey: K1 } } };
  dbState.txCurrent = { ...PAY, status: "used", used: usedRec, amountCents: 100000 };
  await eftRemainderScan();
  assert.equal(dbState.txNext?.used?.saleMismatch?.legCents, 50000);
  // …and the right leg is marked verified instead.
  dbState.reads["pos/sales/S-late"] = { customerId: "0821234567", payments: { p: { method: "eft", amount: 5000, eftPoolKey: K1 } } };
  await eftRemainderScan();
  assert.equal(dbState.txNext?.used?.sale?.verified, true);
  delete dbState.reads["eft_pending_sale_checks"];
  delete dbState.reads["pos/sales/S-late"];
  resetPool();
});

// Deran's R1,000 (21 Oct 2026): the attach ran before the outbox landed the
// sale, so the remainder was HELD; the scan's later check must turn it into the
// confirmed customer's credit — breadcrumb first, then the promoted plan.
test("the scan PROMOTES a remainder held only because the sale was not on the server yet", async () => {
  resetPool();
  dbState.sets = {};
  const usedRec = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", customerId: "27785056874", customerName: "Deran", customerConfirmed: true, appliedCents: 15000, storeId: "pe", tillId: "till-2",
    sale: { saleId: "S-46291", receiptNumber: "S-46291", at: 6, verified: false },
    remainder: { cents: 100000, disposition: "unallocated", customerId: null, customerName: null, creditId: null, status: "held",
      holdReason: "the sale was not on the server when the payment was attached, so it could not be checked" } };
  const rec = { ...PAY, status: "used", amountCents: 115000, used: usedRec };
  dbState.reads["eft_pending_sale_checks"] = { [K1]: { at: Date.now() - 60_000, saleId: "S-46291" } };
  dbState.pool[`eft_pool/${K1}`] = rec;
  dbState.reads["pos/sales/S-46291"] = { customerId: "27785056874", payments: { p: { method: "eft", amount: 15000, eftPoolKey: K1 } } };
  dbState.txCurrent = rec;
  await eftRemainderScan();
  assert.ok(dbState.sets[`eft_pending_remainders/${K1}`], "the remainder breadcrumb is down before the promotion");
  const r = dbState.txNext?.used?.remainder;
  assert.equal(r?.disposition, "credit");
  assert.equal(r?.customerId, "27785056874");
  assert.equal(r?.cents, 100000);
  assert.equal(dbState.txNext.used.sale.verified, true);
  delete dbState.reads["eft_pending_sale_checks"];
  delete dbState.reads["pos/sales/S-46291"];
  resetPool();
});

test("the scan KEEPS the sale check when a verified sale's hold is still pending — a later pass promotes it", async () => {
  resetPool();
  dbState.sets = {};
  const usedRec = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", customerId: "27785056874", customerConfirmed: true, appliedCents: 15000,
    sale: { saleId: "S-46291", receiptNumber: "S-46291", at: 6, verified: false },
    remainder: { cents: 100000, disposition: "unallocated", status: "pending",
      holdReason: "the sale was not on the server when the payment was attached, so it could not be checked" } };
  const rec = { ...PAY, status: "used", amountCents: 115000, used: usedRec };
  dbState.reads["eft_pending_sale_checks"] = { [K1]: { at: Date.now() - 60_000, saleId: "S-46291" } };
  dbState.pool[`eft_pool/${K1}`] = rec;
  dbState.reads["pos/sales/S-46291"] = { customerId: "27785056874", payments: { p: { method: "eft", amount: 15000, eftPoolKey: K1 } } };
  dbState.txCurrent = rec;
  const realLog = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(" ")); };
  try { await eftRemainderScan(); } finally { console.log = realLog; }
  assert.equal(dbState.txNext?.used?.remainder?.disposition, "unallocated", "not promoted under a pending follow-up");
  assert.match(lines.find((l) => l.startsWith("eftRemainderScan done")) ?? "", /"waited":[1-9]/, "the sale check is kept (waited), not cleared");
  delete dbState.reads["eft_pending_sale_checks"];
  delete dbState.reads["pos/sales/S-46291"];
  resetPool();
});

test("the scan backfills spent pre-fix payments one bounded page at a time, then stops", async () => {
  resetPool();
  delete dbState.reads["_migrations/eftFingerprintBackfill"];
  dbState.backfillPage = { [K1]: { ...PAY, status: "used", used: {} }, [K2]: { ...PAY, bankRef: "OTHER999" }, z: { outcome: "refused-auth" } };
  dbState.sets = {};
  await eftRemainderScan();
  const fp = paymentFingerprint(PAY);
  assert.deepEqual(dbState.fingerprints[`eft_pool_fingerprints/${fp}`].spentBy, K1, "the used one is stamped");
  assert.equal(Object.keys(dbState.fingerprints).length, 1, "unused and refused records are not");
  assert.equal(dbState.backfillLimit, 100);
  assert.equal(dbState.sets["_migrations/eftFingerprintBackfill"].done, true, "a short page ends it");
  dbState.reads["_migrations/eftFingerprintBackfill"] = { done: true };
  dbState.backfillLimit = null;
  await eftRemainderScan();
  assert.equal(dbState.backfillLimit, null, "never runs again");
  delete dbState.reads["_migrations/eftFingerprintBackfill"];
  dbState.backfillPage = null;
  resetPool();
});
