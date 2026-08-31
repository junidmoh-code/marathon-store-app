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

// ─── THE SIDE WRITES, EACH IDEMPOTENT ON ITS OWN ─────────────────────────────
// The POS mint applies mirror + audit + ledger in one multi-path update after
// the canonical create — which leaves a known crash window where the canonical
// credit exists and the sides never land (and a repair pass cannot tell "not
// yet" from "half"). This minter is RETRIED (by the till, the owner and
// eftRemainderScan), so every side write here is individually create-only:
// re-running heals exactly what is missing and can never double-apply.
// (CodeRabbit, this PR.)
//
//   mirror  customers/{id}/storeCredit/{creditId} — create-only is LOAD-
//           BEARING: redemptions decrement remainingAmount, so a blind re-set
//           would restore money the customer already spent.
//   audit   pos/audit/store_credit_issued/{id}/sc_{creditId} — the event key
//           is the deterministic txn id, not a push key, so a retry cannot
//           write the event twice.
//   ledger  ONE transaction on pos/creditLedger/{customerId} that records the
//           txn AND moves the balance together, guarded by the txn id — the
//           balance increment is exactly-once by construction. (The node is
//           one customer's ledger — bounded, not a whole-node read.)

/** The mirror record the till spends from — same shape as the POS mint's. */
function eftCreditMirrorRecord(claim, serverTs) {
  return { remainingAmount: claim.amount, issuedAt: serverTs };
}

/** The audit event — same fields as the POS mintSideWrites'. */
function eftCreditAuditRecord(claim, serverTs) {
  return {
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
  };
}

/**
 * The ledger transaction's update function: record the txn and move the
 * balance in ONE atomic decision, or leave the node be when the txn already
 * exists. Null current is a valid empty ledger (the Admin SDK's cold-cache
 * first call returns a real value here because a created node CASes against
 * the server and re-runs on mismatch).
 */
function ledgerApplyDecision(current, claim, serverTs) {
  const txnId = `sc_${claim.creditId}`;
  if (current?.txns?.[txnId]) return undefined; // already applied — exactly once
  return {
    ...(current ?? {}),
    balance: (Number.isInteger(current?.balance) ? current.balance : 0) + claim.amount,
    txns: {
      ...(current?.txns ?? {}),
      [txnId]: {
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
    },
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
  eftCreditMirrorRecord,
  eftCreditAuditRecord,
  ledgerApplyDecision,
  buildUnallocatedRecord,
};
