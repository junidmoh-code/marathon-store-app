// ─── EFT REMAINDER → STORE CREDIT — the records must be the POS's records ────
// One credit system. These tests pin the builders in lib/eft-credit.cjs to the
// exact shapes marathon-pos-app's functions/storeCredit.js writes (claim →
// canonical → mirror + audit + ledger), because a drifted field here is a
// credit the till cannot spend or the history cannot show. The expected
// literals below are transcribed from that file — if the POS mint changes
// shape, this test is the tripwire.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CREDIT_SOURCE, buildEftCreditClaim, buildEftCreditRecord, eftCreditSideWrites, buildUnallocatedRecord,
} = require("../lib/eft-credit.cjs");
const { eftCreditIdOf } = require("../lib/eft-settle.cjs");

const KEY = "b".repeat(40);
const TS = { ".sv": "timestamp" }; // stand-in sentinel — injected, never imported

function usedRecord() {
  return {
    at: 1000, outcome: "recorded", status: "used",
    amountCents: 10000, reference: "JUNID1234", payer: "J SOAP",
    used: {
      attemptId: "P-a1", at: 5000, cashierUid: "uA", cashierName: "Ahmed",
      storeId: "pe", tillId: "till1", customerId: "c1", customerName: "Mr Dlamini",
      appliedCents: 3000,
      sale: { saleId: "S-1", receiptNumber: "00042", at: 6000 },
      remainder: {
        cents: 7000, disposition: "credit", customerId: "c1", customerName: "Mr Dlamini",
        creditId: eftCreditIdOf(KEY, 5000), status: "pending",
      },
    },
  };
}

test("the claim satisfies the POS assertValidClaim contract and anchors on the pool", () => {
  const claim = buildEftCreditClaim(KEY, usedRecord(), 7777);
  // What the POS assertValidClaim checks: creditId/customerId strings, amount
  // a positive integer (cents), a known source.
  assert.equal(claim.creditId, `eftsc-${KEY}-5000`);
  assert.equal(claim.customerId, "c1");
  assert.equal(claim.amount, 7000);
  assert.equal(claim.source, CREDIT_SOURCE);
  assert.equal(CREDIT_SOURCE, "eft_overpayment");
  // The anchor the POS sweep verifies against: the pool record itself.
  assert.equal(claim.poolKey, KEY);
  assert.equal(claim.at, 7777);
  // Who and where — for the audit event the mint writes.
  assert.equal(claim.issuedByUid, "uA");
  assert.equal(claim.cashierName, "Ahmed");
  assert.equal(claim.storeId, "pe");
  assert.equal(claim.tillId, "till1");
  assert.equal(claim.saleId, "S-1");
  // The reason a human reads in the credit history.
  assert.match(claim.reason, /paid R100\.00/);
  assert.match(claim.reason, /took R30\.00/);
  assert.match(claim.reason, /slip 00042/);
});

test("the canonical record matches the POS buildCreditRecord shape", () => {
  const claim = buildEftCreditClaim(KEY, usedRecord(), 7777);
  const rec = buildEftCreditRecord(claim, TS);
  assert.deepEqual(rec, {
    creditId: claim.creditId,
    customerId: "c1",
    issuedAmount: 7000,
    remainingAmount: 7000,
    status: "active",
    redemptions: {},
    issuedAt: TS,
    issuedByUid: "uA",
    source: "eft_overpayment",
    reason: claim.reason,
  });
});

test("the side writes hit the mirror, the audit and the ledger — the POS paths exactly", () => {
  const claim = buildEftCreditClaim(KEY, usedRecord(), 7777);
  const inc = (n) => ({ ".sv": { increment: n } });
  const updates = eftCreditSideWrites(claim, { eventKey: "EV1", serverTs: TS, increment: inc });
  assert.deepEqual(Object.keys(updates).sort(), [
    `customers/c1/storeCredit/${claim.creditId}`,
    "pos/audit/store_credit_issued/c1/EV1",
    "pos/creditLedger/c1/balance",
    `pos/creditLedger/c1/txns/sc_${claim.creditId}`,
  ].sort());
  // The mirror is what the till spends from — remainingAmount + issuedAt only.
  assert.deepEqual(updates[`customers/c1/storeCredit/${claim.creditId}`], {
    remainingAmount: 7000, issuedAt: TS,
  });
  const audit = updates["pos/audit/store_credit_issued/c1/EV1"];
  assert.equal(audit.amount, 7000);
  assert.equal(audit.source, "eft_overpayment");
  assert.equal(audit.issuedBy, "server");
  assert.equal(audit.cashierName, "Ahmed");
  const txn = updates[`pos/creditLedger/c1/txns/sc_${claim.creditId}`];
  assert.equal(txn.kind, "credit");
  assert.equal(txn.amount, 7000);
  assert.equal(txn.staffUid, "uA");
  assert.deepEqual(updates["pos/creditLedger/c1/balance"], inc(7000));
});

test("the unallocated hold carries everything the owner needs to resolve it", () => {
  const rec = usedRecord();
  rec.used.customerId = null;
  rec.used.customerName = null;
  rec.used.remainder = { cents: 7000, disposition: "unallocated", customerId: null, customerName: null, creditId: null, status: "pending" };
  const hold = buildUnallocatedRecord(KEY, rec, 8888);
  assert.deepEqual(hold, {
    poolKey: KEY,
    amountCents: 7000,
    paymentCents: 10000,
    appliedCents: 3000,
    payer: "J SOAP",
    reference: "JUNID1234",
    cashierName: "Ahmed",
    storeId: "pe",
    tillId: "till1",
    saleId: "S-1",
    receiptNumber: "00042",
    settledAt: 5000,
    at: 8888,
  });
});
