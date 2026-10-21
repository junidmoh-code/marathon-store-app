// ─── EFT LEFTOVER CREDIT LANDS — Deran's R1,000, 21 Oct 2026 ─────────────────
// R1,150 EFT, R150 sale S-46291 at PE till-2, customer confirmed. The till's
// outbox had not landed the sale when the attach read it back, so the R1,000
// was HELD "could not be checked"; the scan verified the sale four minutes
// later and left the hold standing. These pin the replay: the hold whose only
// reason was the missing sale becomes the customer's credit when the sale
// verifies, and that credit is spendable at a DIFFERENT store.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attachSaleDecision, saleCheckOf, laterSaleCheckDecision, allocateRemainderDecision,
  promotableHoldOf, SALE_ABSENT_HOLD, eftCreditIdOf,
} = require("../lib/eft-settle.cjs");
const { buildEftCreditClaim, eftCreditMirrorRecord, ledgerApplyDecision } = require("../lib/eft-credit.cjs");
const { creditSpendableAt, issuingStamp, SEED_REGISTRY } = require("../lib/network-registry.cjs");

const KEY = "78a7321f06c0b50667c396a73b11088f134dc57b";
const USED_AT = 1792566411036;
const deranUsed = {
  attemptId: "E-mvhrqc3r-f3v120", at: USED_AT, cashierUid: "58ay", cashierName: "yasmin",
  customerId: "27785056874", customerName: "Deran", customerConfirmed: true,
  appliedCents: 15000, storeId: "pe", tillId: "till-2", sale: null,
};
const settled = { outcome: "recorded", status: "used", amountCents: 115000, reference: "D MOODLEY", used: deranUsed };
const s46291 = { customerId: "27785056874", storeId: "pe", payments: { p: { method: "eft", amount: 15000, eftPoolKey: KEY } } };

const attachWith = (sale) => attachSaleDecision(settled, {
  attemptId: deranUsed.attemptId, saleId: "-P4SHAvwnmdQDATJh7KJ", receiptNumber: "S-46291", at: USED_AT + 716, poolKey: KEY,
  saleCheck: saleCheckOf({ poolKey: KEY, used: deranUsed, sale }),
});
const later = (current, sale, extra = {}) => laterSaleCheckDecision(current, {
  saleId: "-P4SHAvwnmdQDATJh7KJ", saleCheck: saleCheckOf({ poolKey: KEY, used: current.used, sale }),
  at: USED_AT + 252_000, ageMs: 252_000, maxAgeMs: 86_400_000, poolKey: KEY, ...extra,
});

test("REPLAY 21 Oct: the attach that ran before the queued sale landed HELD the R1,000", () => {
  const d = attachWith(null);
  assert.equal(d.ok, true);
  const r = d.value.used.remainder;
  assert.equal(r.cents, 100000);
  assert.equal(r.disposition, "unallocated");
  assert.equal(r.holdReason, SALE_ABSENT_HOLD);
  assert.equal(promotableHoldOf({ ...d.value, used: { ...d.value.used, remainder: { ...r, status: "held" } } }), true);
});

test("BEFORE the fix the later check only stamped verified (pinned: no poolKey → no promotion)", () => {
  const heldRec = attachWith(null).value;
  heldRec.used.remainder.status = "held";
  const d = later(heldRec, s46291, { poolKey: null });
  assert.equal(d.outcome, "done");
  assert.equal(d.promoted, undefined);
  assert.equal(d.value.used.remainder.disposition, "unallocated", "the R1,000 stayed held — the bug");
});

test("AFTER: the later check PROMOTES the R1,150/R150 hold to R1,000 of credit on Deran", () => {
  const heldRec = attachWith(null).value;
  heldRec.used.remainder.status = "held";
  const d = later(heldRec, s46291);
  assert.equal(d.ok, true);
  assert.equal(d.promoted, true);
  assert.equal(d.value.used.sale.verified, true);
  const r = d.value.used.remainder;
  assert.equal(r.disposition, "credit");
  assert.equal(r.cents, 100000);
  assert.equal(r.customerId, "27785056874");
  assert.equal(r.status, "pending", "finishRemainder mints it next");
  assert.equal(r.creditId, eftCreditIdOf(KEY, USED_AT), "the same deterministic id a verified attach would mint — never twice");
  assert.equal(r.holdReason, undefined);
  assert.equal(r.promotedFrom, "sale-verified");
});

test("AFTER: a hold left by an EARLIER pass that already verified the sale is promoted too", () => {
  const heldRec = attachWith(null).value;
  heldRec.used.remainder.status = "held";
  heldRec.used.sale = { ...heldRec.used.sale, verified: true, verifiedAt: USED_AT + 252_000 };
  const d = later(heldRec, s46291);
  assert.equal(d.promoted, true);
  assert.equal(d.value.used.remainder.disposition, "credit");
  // …and once promoted, a further pass is a no-op.
  const again = later(d.value, s46291);
  assert.equal(again.already, true);
  assert.equal(again.promoted, undefined);
});

test("NEVER promoted: Junid issued it by hand, the owner allocated it, no confirmed customer, or another hold reason", () => {
  const base = attachWith(null).value;
  base.used.remainder.status = "held";
  const variants = {
    resolvedByHand: { ...base, used: { ...base.used, remainder: { ...base.used.remainder, resolvedByHand: { creditId: "-P4SIKbsY4LFM8pN5TMQ", by: "Junid" } } } },
    allocated: { ...base, used: { ...base.used, remainder: { ...base.used.remainder, allocatedAt: 1 } } },
    unconfirmed: { ...base, used: { ...base.used, customerConfirmed: false } },
    otherReason: { ...base, used: { ...base.used, remainder: { ...base.used.remainder, holdReason: "the settlement's customer was never confirmed at the till" } } },
  };
  for (const [name, rec] of Object.entries(variants)) {
    const d = later(rec, s46291);
    assert.notEqual(d.promoted, true, name);
    assert.equal((d.value ?? rec).used.remainder.disposition, "unallocated", name);
  }
  // A mismatching sale is flagged, never promoted.
  const bigger = { ...s46291, payments: { p: { method: "eft", amount: 115000, eftPoolKey: KEY } } };
  const m = later(base, bigger);
  assert.equal(m.outcome, "flagged");
  assert.equal(m.value.used.remainder.disposition, "unallocated");
});

test("allocate refuses a remainder Junid already issued by hand — never paid twice", () => {
  const base = attachWith(null).value;
  base.used.remainder = { ...base.used.remainder, status: "held", resolvedByHand: { creditId: "-P4SIKbsY4LFM8pN5TMQ", by: "Junid" } };
  const d = allocateRemainderDecision(base, { poolKey: KEY, at: 9, customerId: "27785056874", customerName: "Deran" });
  assert.equal(d.ok, false);
  assert.equal(d.code, "resolved-by-hand");
});

test("a VERIFIED attach (Junid's R200/R100 test) still mints at once, unchanged", () => {
  const d = attachWith(s46291);
  assert.equal(d.value.used.remainder.disposition, "credit");
  assert.equal(d.value.used.remainder.cents, 100000);
});

test("the promoted credit, minted at PE, is spendable at a DIFFERENT store (Trophy, and across sections)", () => {
  const heldRec = attachWith(null).value;
  heldRec.used.remainder.status = "held";
  const promoted = later(heldRec, s46291).value;
  const claim = buildEftCreditClaim(KEY, promoted, USED_AT + 252_000);
  assert.equal(claim.customerId, "27785056874");
  assert.equal(claim.amount, 100000);
  assert.equal(claim.storeId, "pe");
  const registry = SEED_REGISTRY;
  const stamp = issuingStamp(registry, "pe");
  const mirror = eftCreditMirrorRecord(claim, 1, stamp);
  assert.equal(mirror.remainingAmount, 100000, "the till spends from this — the customer's balance");
  const ledger = ledgerApplyDecision({ balance: 0, txns: {} }, claim, 1, stamp);
  assert.equal(ledger.balance, 100000);
  // Live: /network/creditScope is unset → "shared" → every store.
  for (const store of ["trophy", "marathon-pe", "marathon-pine", "concrete"]) {
    assert.equal(creditSpendableAt(registry, mirror, store), true, store);
  }
});
