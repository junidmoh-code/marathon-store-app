// ─── EFT POOL SEARCH — the forgiving till-side search over pool records ──────
// The search's contract, pinned:
//   · partial reference matches ("Junid" finds "JUNID1234"), case-blind;
//   · amount matches STANDALONE ("550" finds the R550.00 payment with no
//     reference at all);
//   · every query token must land somewhere — reference, payer, bank ref or
//     amount — or the record is not a result;
//   · used payments stay visible and searchable, carrying the settled summary
//     (date, slip, customer, cashier), never hidden;
//   · refusals (auth/parse/account) NEVER cross into a till result, and
//     neither do rawText, subject, sender, auth transcript or destination.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  publicEftView, searchPlan, scoreEftView, searchEftPool, EFT_SEARCH_LIMIT,
} = require("../lib/eft-pool.cjs");

// A recorded pool record exactly as eftCore.mjs's eftPoolRecord stores it
// (fields the search doesn't read are included to prove they don't leak).
function recorded(over = {}) {
  return {
    at: 1000,
    receivedAt: 900,
    messageId: "<m@bank>",
    from: "notify@standardbank.co.za",
    subject: "Payment confirmation 4401",
    auth: { verdict: "pass", fromDomain: "standardbank.co.za", dkimDomain: "standardbank.co.za", detail: "dkim=pass" },
    rawText: "We confirm that the following payment…",
    reader: "standardbank",
    outcome: "recorded",
    status: "unmatched",
    amountCents: 55000,
    reference: "JUNID1234",
    payer: "J SOAP",
    bankTs: 890,
    bankRef: "4140542552",
    destination: { accountMask: "XXXXXXXXXXXX6625", beneficiaryName: "ATUGAR TRADING", destBankName: "FIRST NATIONAL BANK" },
    accountTail: "6625",
    ...over,
  };
}

test("publicEftView projects a payment and nothing else", () => {
  const v = publicEftView("k1", recorded());
  assert.equal(v.key, "k1");
  assert.equal(v.status, "unmatched");
  assert.equal(v.amountCents, 55000);
  assert.equal(v.reference, "JUNID1234");
  assert.equal(v.payer, "J SOAP");
  assert.equal(v.bankRef, "4140542552");
  assert.equal(v.paidAt, 890); // the bank's own timestamp wins
  assert.equal(v.used, null);
  // The owner-only material never crosses the line.
  const s = JSON.stringify(v);
  for (const leaked of ["rawText", "subject", "from", "auth", "destination", "accountTail", "messageId", "confirm that", "6625"]) {
    assert.ok(!s.includes(leaked), `leaked ${leaked}: ${s}`);
  }
});

test("refusals never become till results", () => {
  for (const outcome of ["refused-auth", "refused-parse", "refused-account"]) {
    assert.equal(publicEftView("k", recorded({ outcome })), null);
  }
  assert.equal(publicEftView("k", null), null);
  assert.equal(publicEftView("k", "junk"), null);
});

test("a used payment stays visible with its settled summary", () => {
  const v = publicEftView("k1", recorded({
    status: "used",
    used: {
      at: 2000, cashierUid: "u9", cashierName: "Ahmed", storeId: "pe", tillId: "till1",
      customerId: "c1", customerName: "Mr Dlamini", appliedCents: 55000,
      sale: { saleId: "S-abc", receiptNumber: "00123", at: 2001 },
    },
  }));
  assert.equal(v.status, "used");
  assert.deepEqual(v.used, {
    at: 2000, cashierName: "Ahmed", customerName: "Mr Dlamini",
    saleId: "S-abc", receiptNumber: "00123",
  });
  // The settlement's uids and till context stay in the pool record.
  const s = JSON.stringify(v);
  assert.ok(!s.includes("u9") && !s.includes("till1"), s);
});

test("partial reference matches, case-blind, ranked above payer hits", () => {
  const pool = {
    a: recorded({ reference: "JUNID1234", at: 10 }),
    b: recorded({ reference: "OM82", payer: "JUNID MOH", at: 20 }),
    c: recorded({ reference: "SOMETHING ELSE", payer: "A N OTHER", at: 30 }),
  };
  const { results } = searchEftPool(pool, "junid");
  assert.deepEqual(results.map((r) => r.key), ["a", "b"]);
});

test("exact reference beats prefix beats substring", () => {
  const pool = {
    sub: recorded({ reference: "XXJUNID99", at: 30 }),
    exact: recorded({ reference: "JUNID", at: 10 }),
    prefix: recorded({ reference: "JUNID1234", at: 20 }),
  };
  const { results } = searchEftPool(pool, "JUNID");
  assert.deepEqual(results.map((r) => r.key), ["exact", "prefix", "sub"]);
});

test("amount search works standalone — no reference required", () => {
  const pool = {
    a: recorded({ reference: null, payer: null, amountCents: 55000, at: 10 }),
    b: recorded({ reference: "OM82", amountCents: 10000, at: 20 }),
  };
  for (const q of ["550", "550.00", "R550", "R 550.00"]) {
    const { results } = searchEftPool(pool, q);
    assert.deepEqual(results.map((r) => r.key), ["a"], `query ${q}`);
  }
});

test("mixed query: every token must land somewhere (name + amount)", () => {
  const pool = {
    hit: recorded({ payer: "JUNID MOH", reference: null, amountCents: 55000, at: 10 }),
    wrongAmount: recorded({ payer: "JUNID MOH", reference: null, amountCents: 12300, at: 20 }),
    wrongName: recorded({ payer: "SOMEBODY", reference: null, amountCents: 55000, at: 30 }),
  };
  const { results } = searchEftPool(pool, "junid 550");
  assert.deepEqual(results.map((r) => r.key), ["hit"]);
});

test("bank transaction id is searchable too", () => {
  const pool = { a: recorded({ bankRef: "4140542552", reference: "OM82" }) };
  assert.equal(searchEftPool(pool, "414054").results.length, 1);
});

test("an amount-looking token still matches a reference that contains it", () => {
  // "1234" is both money (R12.34? no — R1,234.00) and a reference fragment.
  const pool = { a: recorded({ reference: "JUNID1234", amountCents: 99900 }) };
  assert.equal(searchEftPool(pool, "1234").results.length, 1);
});

test("empty query lists recent payments, unmatched before used, newest first", () => {
  const pool = {
    oldUnmatched: recorded({ at: 10 }),
    used: recorded({ at: 30, status: "used", used: { at: 31, cashierName: "A", sale: null } }),
    newUnmatched: recorded({ at: 20 }),
    refused: recorded({ at: 40, outcome: "refused-auth" }),
  };
  const { results, searched } = searchEftPool(pool, "");
  assert.deepEqual(results.map((r) => r.key), ["newUnmatched", "oldUnmatched", "used"]);
  assert.equal(searched, 3); // the refusal was never a payment
});

test("used payments come back from a real search as well, marked used", () => {
  const pool = {
    u: recorded({
      reference: "JUNID1234", status: "used",
      used: { at: 5, cashierName: "Ahmed", customerName: "Mr D", sale: { saleId: "s1", receiptNumber: "00042" } },
    }),
  };
  const { results } = searchEftPool(pool, "junid");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "used");
  assert.equal(results[0].used.receiptNumber, "00042");
});

test("results are capped at the screen's worth", () => {
  const pool = {};
  for (let i = 0; i < 60; i++) pool[`k${i}`] = recorded({ at: i });
  const { results, searched } = searchEftPool(pool, "");
  assert.equal(results.length, EFT_SEARCH_LIMIT);
  assert.equal(searched, 60);
});

test("a query nothing matches returns no results, not everything", () => {
  const pool = { a: recorded() };
  assert.equal(searchEftPool(pool, "zzz9999").results.length, 0);
});

test("searchPlan reads amounts per token and caps token count", () => {
  const plan = searchPlan("  junid   R550.00 ");
  assert.equal(plan.tokens.length, 2);
  assert.equal(plan.tokens[0].text, "JUNID");
  assert.equal(plan.tokens[0].amountCents, null);
  assert.equal(plan.tokens[1].amountCents, 55000);
  assert.equal(searchPlan("a b c d e f g h i j k").tokens.length, 8);
});

test("scoreEftView: a zero amount never matches by amount", () => {
  const v = publicEftView("k", recorded({ amountCents: 0, reference: null, payer: null, bankRef: null }));
  assert.equal(scoreEftView(v, searchPlan("0")), null);
});
