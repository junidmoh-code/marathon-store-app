// ─── CONFIRM LATENCY — how many database round trips a till's confirm costs ──
// Junid, 19 Oct 2026: "confirming an EFT takes too long". The live logs put
// the server's own work at 0.1–0.3 s warm; what the cashier waited on was a
// cold start (2.4–3.7 s, in front of nearly every settle, because settles are
// rare and the service scales to zero) and a chain of SEQUENTIAL reads inside
// the settle and the attach. The cold start is handled by the till's warm-up
// call (action "warm" below). This file pins the second half: the number of
// dependent database round trips — "waves" — each lifecycle call makes.
//
// A wave is one set of database operations in flight together; the next wave
// can only start when the previous one has answered. The fake database here
// never answers by itself: the driver releases every pending operation at once
// and counts how many times it had to, until the callable settles. That count
// is the call's critical-path length in round trips — independent of the
// clock, and exactly what a 170 ms link from the till to europe-west1 pays per
// wave.
//
//   settle  BEFORE: identity → name → customer → record → tail → claim → settle
//           = 7 waves.  AFTER: identity → [name, customer, record, tail] →
//           claim → settle = 4.
//   attach  BEFORE: identity → record → [sale, used] → merges → attach →
//           record (finishRemainder) = 6.  AFTER, exact cover, no customer:
//           identity → [record, sale] → attach = 3.
//   warm    identity only = 1, and nothing else is touched.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

// ─── THE WAVE-COUNTING FAKE DATABASE ─────────────────────────────────────────
const state = { reads: {}, tail: {}, txValues: {}, pending: [], ops: [] };
const hold = (label) => new Promise((resolve) => state.pending.push({ label, resolve }));
const snap = (v) => ({ val: () => (v === undefined ? null : v) });

function ref(path) {
  const api = {
    // A read sees what a transaction committed (the follow-up IO re-reads the
    // record it just stamped).
    once: async () => { state.ops.push(`read ${path}`); await hold(path); return snap(path in state.txValues ? state.txValues[path] : state.reads[path]); },
    orderByChild: () => ({ limitToLast: () => ({ once: async () => { state.ops.push("read tail"); await hold("tail"); return snap(state.tail); } }) }),
    transaction: async (fn) => {
      state.ops.push(`txn ${path}`);
      await hold(path);
      // The Admin SDK's first run is against null; the real value follows.
      let out = fn(null);
      out = fn(state.txValues[path] ?? null);
      if (out !== undefined && out !== null) state.txValues[path] = out;
      return { committed: out !== undefined };
    },
    set: async (v) => { state.ops.push(`set ${path}`); await hold(path); state.reads[path] = v; },
    update: async () => { state.ops.push(`update ${path}`); await hold(path); },
    remove: async () => { state.ops.push(`remove ${path}`); await hold(path); },
  };
  return api;
}
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  database: Object.assign(() => ({ ref }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const path = require.resolve(name);
  require.cache[path] = { id: path, filename: path, loaded: true, exports: exportsObj };
}
stub("firebase-functions/v2/https", { onCall: (_opts, handler) => handler, HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_opts, handler) => handler });
stub("firebase-admin", fakeAdmin);
const { eftPoolSettle } = require("../eftPool/eftPool.js");

/** Drive `promise` to completion, releasing every pending database operation
 *  together each time the callable has nothing else it can do. Returns the
 *  number of waves it took — the sequential round-trip count. */
async function waves(promise) {
  let settled = false;
  let outcome;
  promise.then((v) => { settled = true; outcome = { ok: true, value: v }; }, (e) => { settled = true; outcome = { ok: false, error: e }; });
  let n = 0;
  for (let guard = 0; guard < 100; guard++) {
    // Let the callable run until it is blocked on the database.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    if (settled) break;
    if (!state.pending.length) continue;
    const batch = state.pending;
    state.pending = [];
    n++;
    for (const p of batch) p.resolve();
  }
  if (!settled) throw new Error(`the callable never settled; pending: ${state.pending.map((p) => p.label).join(", ")}`);
  return { n, outcome };
}

const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
const K = "a".repeat(40);
const PAY = { outcome: "recorded", status: "unmatched", amountCents: 50000, at: 1, reader: "fnb", bankRef: "5TG59DVQ", reference: "JUNID1234", payer: "J SOAP" };

function reset() {
  state.reads = {
    "users/cashier-uid/posAccess/isActive": true,
    "users/cashier-uid/posAccess/displayName": "Ahmed",
    "customers/0821234567": { name: "Mr Dlamini" },
    [`eft_pool/${K}`]: PAY,
  };
  state.tail = { [K]: PAY };
  state.txValues = { [`eft_pool/${K}`]: PAY };
  state.pending = [];
  state.ops = [];
}

test("warm: one round trip (the identity check), nothing read or written past it", async () => {
  reset();
  const { n, outcome } = await waves(eftPoolSettle({ ...CASHIER, data: { action: "warm" } }));
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.deepEqual(outcome.value, { ok: true, warm: true, at: outcome.value.at });
  assert.equal(n, 1);
  assert.deepEqual(state.ops, ["read users/cashier-uid/posAccess/isActive"]);
});

test("settle with a confirmed customer: 4 round trips, down from 7 — the checks still run on the same values", async () => {
  reset();
  const req = { ...CASHIER, data: { action: "settle", poolKey: K, attemptId: "P-1", appliedCents: 50000, customerId: "0821234567", confirmedCustomerId: "0821234567", storeId: "pe", tillId: "till-1" } };
  const { n, outcome } = await waves(eftPoolSettle(req));
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.equal(n, 4, `waves: ${n}; ops: ${state.ops.join(" | ")}`);
  // The second wave carries the four independent lookups together.
  const reads = state.ops.filter((o) => o.startsWith("read")).map((o) => o.slice(5));
  assert.deepEqual(reads.sort(), ["customers/0821234567", `eft_pool/${K}`, "tail", "users/cashier-uid/posAccess/displayName", "users/cashier-uid/posAccess/isActive"].sort());
  // Claim first, then the settle — the order fix 1 pinned.
  const txns = state.ops.filter((o) => o.startsWith("txn"));
  assert.equal(txns.length, 2);
  assert.match(txns[0], /^txn eft_pool_fingerprints\//);
  assert.equal(txns[1], `txn eft_pool/${K}`);
  const settled = state.txValues[`eft_pool/${K}`];
  assert.equal(settled.status, "used");
  assert.equal(settled.used.customerName, "Mr Dlamini");
  assert.equal(settled.used.cashierName, "Ahmed");
});

test("settle still refuses before any claim when the customer id is malformed — with the reads in one wave", async () => {
  reset();
  // A well-formed id the server cannot find yet now SETTLES for that id (Junid,
  // 21 Oct 2026 — eft-pool-callables.test.cjs); only a malformed one is no customer.
  const req = { ...CASHIER, data: { action: "settle", poolKey: K, attemptId: "P-1", appliedCents: 50000, customerId: "../x", confirmedCustomerId: "../x" } };
  const { outcome } = await waves(eftPoolSettle(req));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "not-found");
  assert.deepEqual(state.ops.filter((o) => o.startsWith("txn")), [], "nothing was claimed or settled");
});

test("attach on an exact cover: 4 round trips, down from 6 — no remainder, so no follow-up read", async () => {
  reset();
  const used = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", cashierName: "Ahmed", customerId: "0821234567", customerName: "Mr Dlamini", customerConfirmed: true, appliedCents: 50000, sale: null };
  const held = { ...PAY, status: "used", used };
  state.reads[`eft_pool/${K}`] = held;
  state.txValues[`eft_pool/${K}`] = held;
  state.reads["pos/sales/S1"] = { customerId: "0821234567", payments: { p1: { method: "eft", amount: 50000, eftPoolKey: K } } };
  const req = { ...CASHIER, data: { action: "attach", poolKey: K, attemptId: "P-1", saleId: "S1", receiptNumber: "00042" } };
  const { n, outcome } = await waves(eftPoolSettle(req));
  assert.equal(outcome.ok, true, outcome.error?.message);
  // identity → [record, sale] → merge walk for the sale's customer → attach
  assert.equal(n, 4, `waves: ${n}; ops: ${state.ops.join(" | ")}`);
  assert.equal(outcome.value.remainder, null);
  assert.equal(state.txValues[`eft_pool/${K}`].used.sale.receiptNumber, "00042");
  assert.equal(state.txValues[`eft_pool/${K}`].used.sale.verified, true);
  assert.equal(state.ops.filter((o) => o === `read eft_pool/${K}`).length, 1, "the record is read once");
});

test("attach on an exact cover with no customer on the sale: 3 round trips (no merge walk)", async () => {
  reset();
  const used = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", cashierName: "Ahmed", customerId: null, customerName: null, customerConfirmed: true, appliedCents: 50000, sale: null };
  const held = { ...PAY, status: "used", used };
  state.reads[`eft_pool/${K}`] = held;
  state.txValues[`eft_pool/${K}`] = held;
  state.reads["pos/sales/S2"] = { customerId: null, payments: { p1: { method: "eft", amount: 50000, eftPoolKey: K } } };
  const req = { ...CASHIER, data: { action: "attach", poolKey: K, attemptId: "P-1", saleId: "S2", receiptNumber: "00043" } };
  const { n, outcome } = await waves(eftPoolSettle(req));
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.equal(n, 3, `waves: ${n}; ops: ${state.ops.join(" | ")}`);
  assert.equal(state.txValues[`eft_pool/${K}`].used.sale.verified, true);
});

test("attach with a remainder still writes the breadcrumb first and finishes the plan", async () => {
  reset();
  const used = { attemptId: "P-1", at: 5, cashierUid: "cashier-uid", cashierName: "Ahmed", customerId: "0821234567", customerName: "Mr Dlamini", customerConfirmed: true, appliedCents: 30000, sale: null };
  const held = { ...PAY, status: "used", used };
  state.reads[`eft_pool/${K}`] = held;
  state.txValues[`eft_pool/${K}`] = held;
  state.reads["pos/sales/S3"] = { customerId: "0821234567", payments: { p1: { method: "eft", amount: 30000, eftPoolKey: K } } };
  const req = { ...CASHIER, data: { action: "attach", poolKey: K, attemptId: "P-1", saleId: "S3", receiptNumber: "00044" } };
  const { outcome } = await waves(eftPoolSettle(req));
  assert.equal(outcome.ok, true, outcome.error?.message);
  const crumb = state.ops.indexOf(`set eft_pending_remainders/${K}`);
  const attach = state.ops.indexOf(`txn eft_pool/${K}`);
  assert.ok(crumb >= 0 && crumb < attach, `breadcrumb before the attach transaction: ${state.ops.join(" | ")}`);
  assert.equal(state.txValues[`eft_pool/${K}`].used.remainder?.cents, 20000);
  assert.ok(state.ops.some((o) => o.startsWith("txn pos/storeCredits/eftsc-")), "the remainder follow-up ran (credit mint)");
});
