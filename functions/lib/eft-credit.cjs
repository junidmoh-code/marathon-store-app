// ─── EFT OVERPAYMENT → STORE CREDIT — the claim and the records (PURE) ───────
// When a consumed payment exceeds the sale it settled, the difference becomes
// the customer's STORE CREDIT — the shops give store credit, never refunds, and
// there is exactly ONE credit system. These builders produce the SAME records
// the POS mint produces, byte-compatible with marathon-pos-app's
// functions/storeCredit.js + functions/lib/storeCreditLogic.js:
//
//   claim   /pos/storeCreditQueue/{creditId} — the durable ask, written FIRST.
//           source "eft_overpayment", anchored on the pool record (poolKey):
//           the POS sweepStoreCreditQueue verifies the claim against
//           /eft_pool/{poolKey}.used.remainder and finishes the mint if the
//           immediate mint here crashed — the same backstop pattern every
//           refund credit already relies on.
//   record  /pos/storeCredits/{creditId} — the canonical credit, created by a
//           create-if-absent transaction so the immediate mint and the sweep
//           can both run and exactly one wins (the creditId is deterministic:
//           eft-settle.cjs eftCreditIdOf).
//   sides   the mirror the till spends from (customers/{id}/storeCredit/…),
//           the audit event and the unified ledger txn + balance increment —
//           the exact shape of the POS mintSideWrites, so every existing
//           reader (credit history, balance, remove-credit) just works.
//
// PURE by the house rule: no firebase-admin, no clock — the callable injects
// the server sentinels; tested in test/eft-credit.test.cjs.
"use strict";

const CREDIT_SOURCE = "eft_overpayment";

/**
 * The queue claim for an EFT remainder. `record` is the committed pool record
 * whose used.remainder says disposition "credit"; `poolKey` its key.
 * `at` is the server's ms now (the claim's staleness clock for the sweep).
 */
function buildEftCreditClaim(poolKey, record, at) {
  const used = record?.used ?? {};
  const r = used.remainder ?? {};
  return {
    creditId: r.creditId,
    customerId: r.customerId,
    customerCode: null,
    customerName: r.customerName ?? null,
    amount: r.cents,
    source: CREDIT_SOURCE,
    poolKey,
    issuedByUid: used.cashierUid ?? null,
    cashierName: used.cashierName ?? null,
    reason: `EFT overpayment — paid ${fmtRands(record?.amountCents)}, sale took ${fmtRands(used.appliedCents)}${used.sale?.receiptNumber ? ` (slip ${used.sale.receiptNumber})` : ""}`,
    notes: null,
    storeId: used.storeId ?? null,
    tillId: used.tillId ?? null,
    saleId: used.sale?.saleId ?? null,
    at,
  };
}

/** cents → "R123.45" for the claim's human-readable reason line. */
function fmtRands(cents) {
  if (!Number.isInteger(cents)) return "R?";
  return `R${Math.floor(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

/** The canonical /pos/storeCredits record — byte-compatible with the POS
 *  buildCreditRecord (storeCreditLogic.js). serverTs injected for purity. */
function buildEftCreditRecord(claim, serverTs) {
  return {
    creditId: claim.creditId,
    customerId: claim.customerId,
    issuedAmount: claim.amount,
    remainingAmount: claim.amount,
    status: "active",
    redemptions: {},
    issuedAt: serverTs,
    issuedByUid: claim.issuedByUid ?? null,
    source: claim.source,
    // The POS builder stamps the anchoring sale when a claim carries one, and
    // this claim does — the two minters (here and the POS sweep) must produce
    // the SAME record, or which one won a race becomes observable data.
    ...(claim.saleId ? { originalRefundSaleId: claim.saleId } : {}),
    ...(claim.reason ? { reason: claim.reason } : {}),
  };
}

/**
 * The multi-path side writes of a mint — mirror + audit + unified ledger —
 * byte-compatible with the POS mintSideWrites. The audit event key and the
 * server sentinels are injected so this stays pure:
 *   eventKey    a push key under pos/audit/store_credit_issued/{customerId}
 *   serverTs    the server-timestamp sentinel
 *   increment   (n) => the server increment sentinel
 */
function eftCreditSideWrites(claim, { eventKey, serverTs, increment }) {
  const txnId = `sc_${claim.creditId}`;
  return {
    [`customers/${claim.customerId}/storeCredit/${claim.creditId}`]: {
      remainingAmount: claim.amount,
      issuedAt: serverTs,
    },
    [`pos/audit/store_credit_issued/${claim.customerId}/${eventKey}`]: {
      managerUid: null,
      managerName: null,
      cashierUid: claim.issuedByUid ?? null,
      cashierName: claim.cashierName ?? null,
      customerId: claim.customerId,
      customerCode: claim.customerCode ?? null,
      customerName: claim.customerName ?? null,
      amount: claim.amount,
      reason: claim.reason ?? null,
      notes: claim.notes ?? null,
      at: serverTs,
      storeId: claim.storeId ?? null,
      tillId: claim.tillId ?? null,
      creditId: claim.creditId,
      source: claim.source,
      issuedBy: "server",
    },
    [`pos/creditLedger/${claim.customerId}/txns/${txnId}`]: {
      txnId,
      amount: claim.amount,
      source: claim.source,
      kind: "credit",
      at: serverTs,
      staffUid: claim.issuedByUid ?? null,
      storeId: claim.storeId ?? null,
      tillId: claim.tillId ?? null,
      ref: claim.reason ?? claim.saleId ?? null,
    },
    [`pos/creditLedger/${claim.customerId}/balance`]: increment(claim.amount),
  };
}

/** What /eft_unallocated/{poolKey} holds while a remainder has no customer —
 *  everything the owner needs to resolve it without opening the pool record. */
function buildUnallocatedRecord(poolKey, record, at) {
  const used = record?.used ?? {};
  const r = used.remainder ?? {};
  return {
    poolKey,
    amountCents: r.cents,
    paymentCents: record?.amountCents ?? null,
    appliedCents: used.appliedCents ?? null,
    payer: record?.payer ?? null,
    reference: record?.reference ?? null,
    cashierName: used.cashierName ?? null,
    storeId: used.storeId ?? null,
    tillId: used.tillId ?? null,
    saleId: used.sale?.saleId ?? null,
    receiptNumber: used.sale?.receiptNumber ?? null,
    settledAt: used.at ?? null,
    at,
  };
}

module.exports = {
  CREDIT_SOURCE,
  buildEftCreditClaim,
  buildEftCreditRecord,
  eftCreditSideWrites,
  buildUnallocatedRecord,
};
