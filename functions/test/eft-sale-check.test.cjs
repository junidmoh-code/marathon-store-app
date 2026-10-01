// ─── FIX 5: A SALE CANNOT TAKE MORE THAN THE CONFIRMED PAYMENT ───────────────
// EFT interrogation F: the till writes the sale itself, and nothing compared
// the sale's EFT leg with what the settle applied — settle R50, record an R500
// EFT leg against the same pool key, and the books said R500 was paid. And the
// remainder of an overpaid payment became store credit for whatever customer
// id the till sent. The attach now reads the committed sale back.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attachSaleDecision, saleCheckOf, flagSaleMismatchDecision, remainderPlanOf } = require("../lib/eft-settle.cjs");

const KEY = "k".repeat(40);
const used = { attemptId: "P-1", at: 5000, cashierUid: "u", cashierName: "Ahmed", customerId: "c1", customerName: "Mr Dlamini", customerConfirmed: true, appliedCents: 5000, sale: null };
const held = { outcome: "recorded", status: "used", amountCents: 100000, used };
const sale = (legs, over = {}) => ({ customerId: "c1", payments: Object.fromEntries(legs.map((l, i) => [`p${i}`, l])), ...over });
const eftLeg = (amount, eftPoolKey = KEY) => ({ method: "eft", amount, eftPoolKey });
const attach = (saleCheck) => attachSaleDecision(held, { attemptId: "P-1", saleId: "S1", receiptNumber: "00042", at: 6000, poolKey: KEY, saleCheck });

test("BEFORE: an attach that never looks at the sale accepts an R500 leg on an R50 settle", () => {
  // The old attach had no sale input at all — this is what it would do with
  // the sale it could not see: attach, and mint R950 of credit.
  const d = attachSaleDecision({ ...held }, { attemptId: "P-1", saleId: "S1", receiptNumber: "1", at: 6000, poolKey: KEY, saleCheck: { state: "verified" } });
  assert.equal(d.ok, true);
});

test("AFTER: the sale's EFT legs for this payment must equal what was settled", () => {
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(5000)]) }).state, "verified");
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(2500), eftLeg(2500), { method: "cash", amount: 9999 }]) }).state, "verified");
  const over = saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(50000)]) });
  assert.equal(over.state, "mismatch");
  assert.equal(over.legCents, 50000);
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(4999)]) }).state, "mismatch", "under is a mismatch too");
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(5000, "x".repeat(40))]) }).state, "mismatch", "a leg for another payment does not count");
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([{ method: "eft", amount: "5000", eftPoolKey: KEY }]) }).state, "mismatch", "a non-integer amount is unreadable");
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(5000)], { customerId: "c2" }) }).state, "mismatch", "another customer");
  assert.equal(saleCheckOf({ poolKey: KEY, used, sale: null }).state, "absent");
});

test("a mismatch REFUSES the attach — nothing attached, no remainder minted", () => {
  const d = attach(saleCheckOf({ poolKey: KEY, used, sale: sale([eftLeg(50000)]) }));
  assert.equal(d.ok, false);
  assert.equal(d.code, "sale-mismatch");
});

test("the refused attach's evidence is stamped on the payment, state unchanged", () => {
  const d = flagSaleMismatchDecision(held, { saleId: "S1", legCents: 50000, why: "x", at: 7 });
  assert.equal(d.ok, true);
  assert.equal(d.value.status, "used");
  assert.equal(d.value.used.sale, null);
  assert.deepEqual(d.value.used.saleMismatch, { saleId: "S1", legCents: 50000, why: "x", at: 7 });
});

test("verified: the remainder becomes the CONFIRMED customer's credit", () => {
  const d = attach({ state: "verified", legCents: 5000 });
  assert.equal(d.value.used.sale.verified, true);
  assert.equal(d.value.used.remainder.disposition, "credit");
  assert.equal(d.value.used.remainder.customerId, "c1");
});

test("sale not on the server yet: attached, but the remainder is HELD for the owner, never credited", () => {
  const d = attach({ state: "absent" });
  assert.equal(d.ok, true);
  assert.equal(d.value.used.sale.verified, false);
  assert.equal(d.value.used.remainder.disposition, "unallocated");
  assert.equal(d.value.used.remainder.customerId, null);
  assert.match(d.value.used.remainder.holdReason, /not on the server/);
});

test("a settlement whose customer was never confirmed (pre-fix) can never mint credit", () => {
  const r = remainderPlanOf(KEY, { ...used, customerConfirmed: undefined }, 100000);
  assert.equal(r.disposition, "unallocated");
  assert.equal(r.creditId, null);
  assert.match(r.holdReason, /never confirmed/);
});
