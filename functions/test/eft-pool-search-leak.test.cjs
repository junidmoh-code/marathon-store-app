// ─── FIX 2: THE TILL SEARCH NEVER SHOWS ANOTHER CUSTOMER'S PAYMENT ───────────
// EFT interrogation H: three characters at the till ("082", "jun", a common
// surname) listed up to ten OTHER customers' full names, amounts and bank
// references — and, for used payments, who they were sold to and by whom.
// The search is now an exact (or one-typo, on long references) match on the
// payment's REFERENCE or the bank's TRANSACTION ID, answering with AT MOST ONE
// payment, the payer as initials only, and nothing at all when the answer is
// ambiguous. These run the real searchEftPool over a pool of five customers.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { searchEftPool, publicEftView } = require("../lib/eft-pool.cjs");

const pay = (over) => ({ outcome: "recorded", status: "unmatched", at: 1, amountCents: 10000, reader: "fnb", ...over });
const POOL = {
  k1: pay({ reference: "JUNID1234", payer: "JUNID MOHAMMED", bankRef: "5TG59DVQ", amountCents: 55000, at: 5 }),
  k2: pay({ reference: "0821234567", payer: "THANDI NKOSI", bankRef: "4140542552", amountCents: 120000, at: 4 }),
  k3: pay({ reference: "0827654321", payer: "SIPHO NKOSI", bankRef: "80D2F2AB5A-1", amountCents: 30000, at: 3 }),
  k4: pay({ reference: "NKOSI", payer: "LERATO NKOSI", bankRef: "599784", amountCents: 75000, at: 2 }),
  k5: pay({
    reference: "OUSMANE", payer: "OUSMANE THIAM", bankRef: "500001", amountCents: 9900, at: 1, status: "used",
    used: { at: 9, cashierName: "Ahmed", customerName: "Mr Thiam", customerId: "c5", appliedCents: 9900, sale: { saleId: "s5", receiptNumber: "00123" }, remainder: null },
  }),
};

const NAMES = ["JUNID", "MOHAMMED", "THANDI", "SIPHO", "LERATO", "NKOSI", "OUSMANE", "THIAM", "Ahmed", "Mr Thiam"];
function leakedNames(out) {
  const text = JSON.stringify(out.results);
  return NAMES.filter((n) => text.includes(n) && !String(out.results[0]?.reference ?? "").includes(n));
}

test("three characters of a phone prefix list nobody", () => {
  for (const q of ["082", "0821", "jun", "nko", "thandi", "nkosi thandi", "mohammed"]) {
    const out = searchEftPool(POOL, q);
    assert.deepEqual(out.results, [], `"${q}" must not list payments`);
  }
});

test("a payer's NAME is never a search key", () => {
  assert.deepEqual(searchEftPool(POOL, "THANDI NKOSI").results, []);
  assert.deepEqual(searchEftPool(POOL, "Junid Mohammed").results, []);
});

test("the exact reference finds that one payment — and the payer only as initials", () => {
  const out = searchEftPool(POOL, "junid1234");
  assert.equal(out.results.length, 1);
  const [r] = out.results;
  assert.equal(r.key, "k1");
  assert.equal(r.amountCents, 55000);
  assert.equal(r.payer, undefined, "no full payer name");
  assert.equal(r.payerInitials, "J M");
  assert.equal(r.bankRef, undefined, "the bank's id is not handed back");
  assert.deepEqual(leakedNames(out), []);
});

test("the bank's transaction id from the customer's proof of payment finds it too", () => {
  const out = searchEftPool(POOL, "5tg5 9dvq");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].key, "k1");
  assert.equal(out.results[0].matchedOn, "bankRef");
});

test("one typo in a LONG reference is tolerated; in a short one it is not", () => {
  assert.equal(searchEftPool(POOL, "juind1234").results[0]?.key, "k1");  // transposition
  assert.equal(searchEftPool(POOL, "junid123").results[0]?.key, "k1");   // one dropped char
  assert.deepEqual(searchEftPool(POOL, "nkosa").results, [], "five chars: exact only");
  assert.deepEqual(searchEftPool(POOL, "junid12").results, [], "two edits away");
});

test("AMBIGUOUS → nothing at all, and the till is told to ask for the bank's transaction id", () => {
  const pool = { ...POOL, k6: pay({ reference: "NKOSI", payer: "ZANELE NKOSI", bankRef: "77777777", amountCents: 1, at: 7 }) };
  const out = searchEftPool(pool, "nkosi");
  assert.deepEqual(out.results, []);
  assert.equal(out.ambiguous, true);
  assert.equal(JSON.stringify(out).includes("ZANELE"), false);
  // …and the bank id settles it.
  assert.equal(searchEftPool(pool, "77777777").results[0]?.key, "k6");
});

test("a used payment comes back as USED — when and which slip, never whose sale or which cashier", () => {
  const out = searchEftPool(POOL, "ousmane");
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.status, "used");
  assert.deepEqual(r.used, { at: 9, receiptNumber: "00123", outsidePos: false });
  for (const s of ["Ahmed", "Mr Thiam", "c5", "OUSMANE THIAM"]) assert.equal(JSON.stringify(r).includes(s), false, s);
});

test("an amount is never a key, and digits must be a whole reference or bank id", () => {
  for (const q of ["550", "550.00", "R550", "55000", "1200", "120000"]) {
    assert.deepEqual(searchEftPool(POOL, q).results, [], q);
  }
});

test("held and refused records are never a till result, even on an exact id", () => {
  const pool = {
    h1: { ...pay({ reference: "HELDREF1", bankRef: "HELD0001" }), outcome: "held-duplicate", status: undefined },
    h2: { ...pay({ reference: "HELDREF2", bankRef: null }), outcome: "held-no-bankref", status: undefined },
    r1: { outcome: "refused-auth", reference: "FORGED01" },
  };
  for (const q of ["HELDREF1", "HELD0001", "HELDREF2", "FORGED01"]) assert.deepEqual(searchEftPool(pool, q).results, [], q);
});

test("publicEftView carries no payer name, bank id, customer, cashier or reason", () => {
  const v = publicEftView("k5", { ...POOL.k5, used: { ...POOL.k5.used, outsidePos: { reason: "refunded to Thandi", actorName: "Ibrahim", actorUid: "u", at: 3 } } });
  const text = JSON.stringify(v);
  for (const s of ["OUSMANE THIAM", "500001", "Ahmed", "Mr Thiam", "Thandi", "Ibrahim"]) assert.equal(text.includes(s), false, s);
  assert.equal(v.used.outsidePos, true);
});
