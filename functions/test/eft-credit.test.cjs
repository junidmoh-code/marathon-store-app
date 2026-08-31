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
  CREDIT_SOURCE, buildEftCreditClaim, buildEftCreditRecord,
  eftCreditMirrorRecord, eftCreditAuditRecord, ledgerApplyDecision, buildUnallocatedRecord,
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
    // Same as the POS builder given the same claim: the anchoring sale lands
    // as originalRefundSaleId, so both minters produce identical records.
    originalRefundSaleId: "S-1",
    reason: claim.reason,
  });
});

test("the side writes carry the POS shapes — mirror, audit, ledger txn", () => {
  const claim = buildEftCreditClaim(KEY, usedRecord(), 7777);
  // The mirror is what the till spends from — remainingAmount + issuedAt only.
  assert.deepEqual(eftCreditMirrorRecord(claim, TS), { remainingAmount: 7000, issuedAt: TS });
  const audit = eftCreditAuditRecord(claim, TS);
  assert.equal(audit.amount, 7000);
  assert.equal(audit.source, "eft_overpayment");
  assert.equal(audit.issuedBy, "server");
  assert.equal(audit.cashierName, "Ahmed");
  assert.equal(audit.creditId, claim.creditId);
});

test("ledgerApplyDecision records the txn and moves the balance ONCE, atomically", () => {
  const claim = buildEftCreditClaim(KEY, usedRecord(), 7777);
  const txnId = `sc_${claim.creditId}`;
  // Empty ledger (and the Admin SDK's cold-cache null): txn + balance together.
  const first = ledgerApplyDecision(null, claim, TS);
  assert.equal(first.balance, 7000);
  assert.equal(first.txns[txnId].amount, 7000);
  assert.equal(first.txns[txnId].kind, "credit");
  assert.equal(first.txns[txnId].staffUid, "uA");
  // An existing ledger: prior txns and balance survive, this txn adds on.
  const existing = { balance: 500, txns: { sc_other: { txnId: "sc_other", amount: 500 } } };
  const second = ledgerApplyDecision(existing, claim, TS);
  assert.equal(second.balance, 7500);
  assert.equal(Object.keys(second.txns).length, 2);
  // A RE-RUN against a ledger that already holds this txn aborts — the
  // balance can never move twice for one credit, no matter how many retries.
  assert.equal(ledgerApplyDecision(second, claim, TS), undefined);
  // A corrupted balance is treated as zero, never NaN.
  assert.equal(ledgerApplyDecision({ balance: "junk" }, claim, TS).balance, 7000);
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
