// ─── EFT POOL SEARCH — reference and payer name, nothing else ────────────────
// The search's contract, pinned:
//   · REFERENCE and PAYER NAME are the only keys. Amount is never one: "550"
//     does not find the R550.00 payment unless "550" appears in a reference
//     or a name. The amount is confirmation on the row, not a query.
//   · forgiving within that: case-blind, spaces and punctuation ignored,
//     substring anywhere, one near-miss (typo / transposition / dropped or
//     extra character) tolerated on tokens of five or more characters;
//   · under three characters nothing is searched — no browse list, no recent
//     payments, no default result set;
//   · at most ten results, best match first, then newest;
//   · used payments stay visible and searchable, carrying the settled summary
//     (date, slip, customer, cashier — or "settled outside POS", who, when,
//     why), never hidden;
//   · refusals (auth/parse/account) NEVER cross into a till result, and
//     neither do rawText, subject, sender, auth transcript or destination.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  publicEftView, searchPlan, scoreEftView, searchEftPool, nearestSubstringDistance,
  EFT_SEARCH_LIMIT, EFT_MIN_QUERY,
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

const keys = (pool, q) => searchEftPool(pool, q).results.map((r) => r.key);

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
  for (const outcome of ["refused-auth", "refused-parse", "refused-account", "unknown-bank"]) {
    assert.equal(publicEftView("k", recorded({ outcome })), null);
  }
  assert.equal(publicEftView("k", null), null);
  assert.equal(publicEftView("k", "junk"), null);
  // …not even through the search.
  assert.deepEqual(keys({ r: recorded({ outcome: "refused-parse" }) }, "junid"), []);
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
    // The whole amount, accounted for: fully applied, nothing left over.
    appliedCents: 55000, remainder: null,
    outsidePos: null,
  });
  // The settlement's uids and till context stay in the pool record.
  const s = JSON.stringify(v);
  assert.ok(!s.includes("u9") && !s.includes("till1"), s);
});

test("a payment settled OUTSIDE the POS says so: reason, who, when — never the actor's uid", () => {
  const v = publicEftView("k1", recorded({
    status: "used",
    used: {
      attemptId: "outside-pos-5000", at: 5000, cashierUid: "owner-uid", cashierName: "owner",
      storeId: null, tillId: null, customerId: null, customerName: null, appliedCents: 55000, sale: null,
      outsidePos: { reason: "Paid before the pool existed — slip 00099", actorUid: "owner-uid", actorName: "owner", at: 5000 },
    },
  }));
  assert.equal(v.status, "used");
  assert.deepEqual(v.used.outsidePos, { reason: "Paid before the pool existed — slip 00099", actorName: "owner", at: 5000 });
  assert.equal(v.used.saleId, null);
  assert.ok(!JSON.stringify(v).includes("owner-uid"));
  // And it is still found by the same search.
  assert.deepEqual(keys({ k1: recorded({ status: "used", used: v.used }) }, "junid"), ["k1"]);
});

// ─── AMOUNT IS NOT A KEY ─────────────────────────────────────────────────────
test("an amount never finds a payment — not bare, not with R, not with cents", () => {
  const pool = {
    a: recorded({ reference: null, payer: null, amountCents: 55000, at: 10 }),
    b: recorded({ reference: "OM82", payer: "J SOAP", amountCents: 55000, at: 20 }),
  };
  for (const q of ["550", "550.00", "R550", "R 550.00", "R550.00", "55000"]) {
    assert.deepEqual(keys(pool, q), [], `query "${q}" must not match by amount`);
  }
});

test("digits are text: they find a reference that CONTAINS them, never an amount that equals them", () => {
  const pool = {
    ref: recorded({ reference: "INV 550", amountCents: 12300, at: 10 }),
    amt: recorded({ reference: "OM82", amountCents: 55000, at: 20 }),
  };
  assert.deepEqual(keys(pool, "550"), ["ref"]);
});

test("searchPlan reads no amount from the query", () => {
  const plan = searchPlan("  junid   R550.00 ");
  assert.deepEqual(plan.tokens, ["JUNID", "R55000"]);
  assert.equal(plan.whole, "JUNIDR55000");
  // Tokens are bare text — there is no per-token amount and no whole-query
  // amount for anything downstream to compare with amountCents.
  for (const t of plan.tokens) assert.equal(typeof t, "string");
  assert.deepEqual(Object.keys(plan).sort(), ["tokens", "tooShort", "whole"]);
  assert.equal(searchPlan("a b c d e f g h i j k").tokens.length, 8);
});

// ─── NOTHING IS BROWSABLE ────────────────────────────────────────────────────
test("an empty or short query returns nothing — no recent list, no default set", () => {
  const pool = {
    oldUnmatched: recorded({ at: 10, bankTs: 100 }),
    used: recorded({ at: 30, bankTs: 50, status: "used", used: { at: 31, cashierName: "A", sale: null } }),
    newUnmatched: recorded({ at: 20, bankTs: 200 }),
  };
  for (const q of ["", "  ", "j", "ju", "J-U", " . ", null, undefined]) {
    const out = searchEftPool(pool, q);
    assert.deepEqual(out.results, [], `query ${JSON.stringify(q)}`);
    assert.equal(out.needQuery, true);
    assert.equal(out.searched, 3); // honest about what was there, silent about what it was
  }
  assert.equal(EFT_MIN_QUERY, 3);
  // Three letters IS a search.
  assert.deepEqual(keys(pool, "jun"), ["newUnmatched", "oldUnmatched", "used"]);
});

// ─── FORGIVING MATCHING ──────────────────────────────────────────────────────
test("partial reference matches, case-blind, ranked above payer hits", () => {
  const pool = {
    a: recorded({ reference: "JUNID1234", at: 10 }),
    b: recorded({ reference: "OM82", payer: "JUNID MOH", at: 20 }),
    c: recorded({ reference: "SOMETHING ELSE", payer: "A N OTHER", at: 30 }),
  };
  assert.deepEqual(keys(pool, "junid"), ["a", "b"]);
});

test("exact reference beats prefix beats substring beats near-miss", () => {
  const pool = {
    near: recorded({ reference: "JUNIX", at: 40 }),
    sub: recorded({ reference: "XXJUNID99", at: 30 }),
    exact: recorded({ reference: "JUNID", at: 10 }),
    prefix: recorded({ reference: "JUNID1234", at: 20 }),
  };
  assert.deepEqual(keys(pool, "JUNID"), ["exact", "prefix", "sub", "near"]);
});

test('"JUNID1234" is found by "junid", "junid123" and "juind1234"', () => {
  const pool = { a: recorded({ reference: "JUNID1234", payer: "J SOAP" }) };
  for (const q of ["junid", "junid123", "juind1234", "JUNID1234", "junid-1234", "junid 1234", "unid12", "JUNID12345"]) {
    assert.deepEqual(keys(pool, q), ["a"], `query "${q}"`);
  }
});

test("spaces and punctuation are ignored on both sides", () => {
  const pool = {
    a: recorded({ reference: "INV-2026/09 08", payer: "O'BRIEN, T." }),
  };
  assert.deepEqual(keys(pool, "inv2026"), ["a"]);
  assert.deepEqual(keys(pool, "INV 2026 09"), ["a"]);
  assert.deepEqual(keys(pool, "obrien"), ["a"]);
  assert.deepEqual(keys(pool, "o brien"), ["a"]);
});

test("payer name: whole name, one word of it, or a typo in it", () => {
  const pool = {
    a: recorded({ reference: "OM82", payer: "OUSMANE THIAM", at: 10 }),
    b: recorded({ reference: "OM83", payer: "SOMEBODY ELSE", at: 20 }),
  };
  assert.deepEqual(keys(pool, "thiam"), ["a"]);
  assert.deepEqual(keys(pool, "ousmane thiam"), ["a"]);
  assert.deepEqual(keys(pool, "ousmanethiam"), ["a"]);
  assert.deepEqual(keys(pool, "ousmani"), ["a"]);   // one substitution
  assert.deepEqual(keys(pool, "osumane"), ["a"]);   // one transposition
  assert.deepEqual(keys(pool, "ousmne"), ["a"]);    // one dropped character
});

test("near-miss tolerance needs five characters — a four-letter typo is a different word", () => {
  const pool = { a: recorded({ reference: "OM82", payer: "ABCD" }) };
  assert.deepEqual(keys(pool, "abxd"), []);
  assert.deepEqual(keys(pool, "abcd"), ["a"]);
  const five = { a: recorded({ reference: "OM82", payer: "ABCDE" }) };
  assert.deepEqual(keys(five, "abxde"), ["a"]);
});

test("two edits away is not a match", () => {
  const pool = { a: recorded({ reference: "JUNID1234", payer: "J SOAP" }) };
  assert.deepEqual(keys(pool, "jonad1234"), []);
  assert.deepEqual(keys(pool, "zzz9999"), []);
});

test("every token must land somewhere, unless the whole query does", () => {
  const pool = {
    hit: recorded({ payer: "JUNID MOH", reference: "OM82", at: 10 }),
    wrongName: recorded({ payer: "SOMEBODY", reference: "OM82", at: 30 }),
  };
  assert.deepEqual(keys(pool, "junid om82"), ["hit"]);
  assert.deepEqual(keys(pool, "junid zzzz"), []);
  assert.deepEqual(keys(pool, "junid moh"), ["hit"]);
});

test("the bank's own transaction id is NOT a search key", () => {
  const pool = { a: recorded({ bankRef: "4140542552", reference: "OM82", payer: "J SOAP" }) };
  assert.deepEqual(keys(pool, "414054"), []);
});

test("nearestSubstringDistance: substring 0, one typo 1, transposition 1, unrelated more", () => {
  assert.equal(nearestSubstringDistance("JUNID", "XXJUNID1234"), 0);
  assert.equal(nearestSubstringDistance("JUNIX", "JUNID1234"), 1);
  assert.equal(nearestSubstringDistance("JUIND1234", "JUNID1234"), 1);
  assert.equal(nearestSubstringDistance("JUNID12345", "JUNID1234"), 1);
  assert.equal(nearestSubstringDistance("JUND", "JUNID"), 1);
  assert.equal(nearestSubstringDistance("ABCDE", "VWXYZ"), 5);
  assert.equal(nearestSubstringDistance("", "ANY"), 0);
  assert.equal(nearestSubstringDistance("ABC", ""), 3);
});

// ─── RANK AND CAP ────────────────────────────────────────────────────────────
test("results are ranked by match strength, then newest first", () => {
  const pool = {
    olderExact: recorded({ reference: "JUNID", bankTs: 100, at: 1 }),
    newerExact: recorded({ reference: "JUNID", bankTs: 200, at: 2 }),
    newerSub: recorded({ reference: "XJUNIDX", bankTs: 300, at: 3 }),
  };
  assert.deepEqual(keys(pool, "junid"), ["newerExact", "olderExact", "newerSub"]);
});

test("results are capped at ten", () => {
  const pool = {};
  for (let i = 0; i < 60; i++) pool[`k${i}`] = recorded({ reference: "JUNID", at: i });
  const { results, searched } = searchEftPool(pool, "junid");
  assert.equal(EFT_SEARCH_LIMIT, 10);
  assert.equal(results.length, 10);
  assert.equal(searched, 60);
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

test("every row carries what the cashier confirms against: amount, payer, reference, date", () => {
  const { results } = searchEftPool({ a: recorded() }, "junid");
  const [r] = results;
  assert.equal(r.amountCents, 55000);
  assert.equal(r.payer, "J SOAP");
  assert.equal(r.reference, "JUNID1234");
  assert.equal(r.paidAt, 890);
});

test("scoreEftView: no tokens or too short → null, never everything", () => {
  const v = publicEftView("k", recorded());
  assert.equal(scoreEftView(v, searchPlan("")), null);
  assert.equal(scoreEftView(v, searchPlan("ju")), null);
  assert.ok(scoreEftView(v, searchPlan("jun")) > 0);
});

test("a partially-applied payment says where every rand went", () => {
  const v = publicEftView("k2", recorded({
    status: "used", amountCents: 10000,
    used: {
      at: 2000, cashierUid: "u9", cashierName: "Ahmed", storeId: "pe", tillId: "till1",
      customerId: "c1", customerName: "Mr Dlamini", appliedCents: 3000,
      sale: { saleId: "S-abc", receiptNumber: "00123", at: 2001 },
      remainder: {
        cents: 7000, disposition: "credit", customerId: "c1", customerName: "Mr Dlamini",
        creditId: "eftsc-k-2000", status: "issued",
      },
    },
  }));
  assert.equal(v.used.appliedCents, 3000);
  assert.deepEqual(v.used.remainder, {
    cents: 7000, disposition: "credit", status: "issued",
    customerName: "Mr Dlamini", creditId: "eftsc-k-2000",
  });
  // The customer id itself stays in the pool record, like the uids.
  assert.ok(!JSON.stringify(v).includes('"c1"'));
});
