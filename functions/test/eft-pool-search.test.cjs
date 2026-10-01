// ─── EFT POOL SEARCH — the locked-down contract (fix 2) ──────────────────────
// Pinned here, next to the attack scenarios in eft-pool-search-leak.test.cjs:
//   · the key is the payment's REFERENCE or the bank's TRANSACTION ID, whole —
//     case, spaces and punctuation ignored, nothing else; one typo tolerated
//     only on a LONG reference (both ≥ 6), never on the bank id;
//   · the payer's name is never a key and comes back as initials only;
//   · at most ONE payment; several candidates → nothing, `ambiguous`;
//   · amount is never a key; under three letters/digits nothing is searched;
//   · used payments answer as used (when, which slip) — never whose sale,
//     which cashier, where a remainder went or a typed reason;
//   · refusals and holds never cross into a till result, and neither do
//     rawText, subject, sender, auth transcript or destination.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  publicEftView, payerInitials, searchPlan, searchEftPool, osaDistance, matchOf,
  EFT_SEARCH_LIMIT, EFT_MIN_QUERY, NEAR_MISS_MIN_LENGTH,
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
  assert.deepEqual(Object.keys(v).sort(), ["amountCents", "at", "key", "needsOwner", "paidAt", "payerInitials", "reference", "reversals", "status", "used"]);
  assert.equal(v.amountCents, 55000);
  assert.equal(v.reference, "JUNID1234");
  assert.equal(v.payerInitials, "J S");
  assert.equal(v.paidAt, 890); // the bank's own timestamp wins
  assert.equal(v.used, null);
  const s = JSON.stringify(v);
  for (const leaked of ["rawText", "subject", "from", "auth", "destination", "accountTail", "messageId", "confirm that", "6625", "SOAP", "4140542552"]) {
    assert.ok(!s.includes(leaked), `leaked ${leaked}: ${s}`);
  }
});

test("payer initials: letters only, at most four, null when there is no name", () => {
  assert.equal(payerInitials("MARA-THONE TRADING"), "M T T");
  assert.equal(payerInitials("mr j m atugar holdings pty"), "M J M A");
  assert.equal(payerInitials(null), null);
  assert.equal(payerInitials("123"), null);
});

test("refusals and holds never become till results", () => {
  for (const outcome of ["refused-auth", "refused-parse", "refused-account", "unknown-bank", "held-duplicate", "held-no-bankref"]) {
    assert.equal(publicEftView("k", recorded({ outcome })), null);
    assert.deepEqual(keys({ r: recorded({ outcome }) }, "junid1234"), [], outcome);
  }
  assert.equal(publicEftView("k", null), null);
  assert.equal(publicEftView("k", "junk"), null);
});

test("a used payment says when and which slip — nothing about whose sale", () => {
  const v = publicEftView("k1", recorded({
    status: "used",
    used: {
      at: 2000, cashierUid: "u9", cashierName: "Ahmed", storeId: "pe", tillId: "till1",
      customerId: "c1", customerName: "Mr Dlamini", appliedCents: 30000,
      sale: { saleId: "S-abc", receiptNumber: "00123", at: 2001 },
      remainder: { cents: 25000, disposition: "credit", customerName: "Mr Dlamini", creditId: "eftsc-x", status: "issued" },
    },
  }));
  assert.deepEqual(v.used, { at: 2000, receiptNumber: "00123", outsidePos: false });
  const s = JSON.stringify(v);
  for (const leaked of ["u9", "till1", "Ahmed", "Dlamini", "S-abc", "eftsc"]) assert.ok(!s.includes(leaked), leaked);
});

test("a payment settled OUTSIDE the POS says only that", () => {
  const v = publicEftView("k1", recorded({
    status: "used",
    used: {
      attemptId: "outside-pos-5000", at: 5000, cashierUid: "owner-uid", cashierName: "owner", appliedCents: 55000, sale: null,
      outsidePos: { reason: "Refunded to Mr Dlamini in cash", actorUid: "owner-uid", actorName: "Ibrahim", at: 5000 },
    },
  }));
  assert.deepEqual(v.used, { at: 5000, receiptNumber: null, outsidePos: true });
  for (const leaked of ["owner-uid", "Dlamini", "Ibrahim"]) assert.ok(!JSON.stringify(v).includes(leaked), leaked);
});

test("an amount never finds a payment — not bare, not with R, not with cents", () => {
  const pool = {
    a: recorded({ reference: null, payer: null, amountCents: 55000, at: 10 }),
    b: recorded({ reference: "OM82", payer: "J SOAP", amountCents: 55000, at: 20 }),
  };
  for (const q of ["550", "550.00", "R550", "R 550.00", "R550.00", "55000"]) {
    assert.deepEqual(keys(pool, q), [], `query "${q}" must not match by amount`);
  }
});

test("digits find a payment only when they ARE its reference or bank id", () => {
  const pool = { a: recorded({ reference: "0821234567", bankRef: "4140542552" }) };
  assert.deepEqual(keys(pool, "082"), []);
  assert.deepEqual(keys(pool, "0821234"), []);
  assert.deepEqual(keys(pool, "082 123 4567"), ["a"]);
  assert.deepEqual(keys(pool, "4140542552"), ["a"]);
  assert.deepEqual(keys(pool, "414054255"), [], "a bank id must be exact");
});

test("searchPlan reads no amount and no words — only the whole query", () => {
  assert.deepEqual(searchPlan(" Junid-1234 "), { whole: "JUNID1234", tooShort: false });
  assert.deepEqual(searchPlan("ju"), { whole: "JU", tooShort: true });
  assert.equal(EFT_MIN_QUERY, 3);
  assert.equal(EFT_SEARCH_LIMIT, 1);
});

test("an empty or short query returns nothing — no recent list, no default set", () => {
  const pool = { a: recorded({ reference: "AB" }) };
  for (const q of ["", "  ", "a", "ab", "a-b", ". ."]) {
    const out = searchEftPool(pool, q);
    assert.deepEqual(out.results, [], JSON.stringify(q));
    assert.equal(out.needQuery, true);
  }
});

test("prefix and substring are NOT matches", () => {
  const pool = { a: recorded({ reference: "JUNID1234" }) };
  for (const q of ["junid", "junid12", "nid1234", "1234"]) assert.deepEqual(keys(pool, q), [], q);
  assert.deepEqual(keys(pool, "Junid 1234"), ["a"]);
});

test("near-exact: exactly one edit, on a reference of six or more, never on the bank id", () => {
  const pool = { a: recorded({ reference: "JUNID1234", bankRef: "5TG59DVQ" }) };
  assert.deepEqual(keys(pool, "juind1234"), ["a"]); // transposition
  assert.deepEqual(keys(pool, "junid12345"), ["a"]); // one extra
  assert.deepEqual(keys(pool, "junld1234"), ["a"]); // one substitution
  assert.deepEqual(keys(pool, "jnuid1324"), [], "two edits");
  assert.deepEqual(keys(pool, "5tg59dvx"), [], "the bank id is exact or nothing");
  assert.equal(NEAR_MISS_MIN_LENGTH, 6);
  const short = { b: recorded({ reference: "OM82X" }) };
  assert.deepEqual(keys(short, "om82y"), [], "under six characters, exact only");
});

test("an exact match outranks near-misses — they are not even candidates", () => {
  const pool = {
    exact: recorded({ reference: "JUNID1234", at: 1 }),
    near: recorded({ reference: "JUNID1235", bankRef: "X1", at: 2 }),
  };
  assert.deepEqual(keys(pool, "junid1234"), ["exact"]);
  // With no exact match, two near-misses are ambiguous.
  assert.equal(searchEftPool(pool, "junid1236").ambiguous, true);
});

test("one unmatched beside used copies of the same reference: the unmatched one answers alone", () => {
  const pool = {
    old: recorded({ status: "used", used: { at: 1, sale: { receiptNumber: "00001" } }, bankRef: "A1111", at: 1 }),
    now: recorded({ bankRef: "B2222", at: 2 }),
  };
  assert.deepEqual(keys(pool, "junid1234"), ["now"]);
  // Two used, none unmatched: ambiguous — ask for the bank id.
  const twoUsed = { ...pool, now: { ...pool.now, status: "used", used: { at: 2, sale: null } } };
  assert.equal(searchEftPool(twoUsed, "junid1234").ambiguous, true);
  assert.deepEqual(keys(twoUsed, "b2222"), ["now"]);
});

test("matchOf names what matched", () => {
  const rec = recorded({ reference: "JUNID1234", bankRef: "5TG59DVQ" });
  assert.equal(matchOf(rec, searchPlan("junid1234")), "reference");
  assert.equal(matchOf(rec, searchPlan("5tg59dvq")), "bankRef");
  assert.equal(matchOf(rec, searchPlan("juind1234")), "near");
  assert.equal(matchOf(rec, searchPlan("nothing")), null);
});

test("osaDistance: identical 0, one typo 1, transposition 1, unrelated more", () => {
  assert.equal(osaDistance("JUNID1234", "JUNID1234"), 0);
  assert.equal(osaDistance("JUNID1234", "JUNLD1234"), 1);
  assert.equal(osaDistance("JUNID1234", "JUIND1234"), 1);
  assert.equal(osaDistance("JUNID1234", "JUNID123"), 1);
  assert.equal(osaDistance("JUNID", ""), 5);
  assert.ok(osaDistance("JUNID1234", "OUSMANE") > 1);
});

test("a reversed payment says so on its row", () => {
  const v = publicEftView("k1", recorded({ reversals: { 1: {}, 2: {} } }));
  assert.equal(v.reversals, 2);
});

test("searched counts the payments in the window, refusals and holds excluded", () => {
  const pool = { a: recorded(), b: recorded({ outcome: "refused-auth" }), c: recorded({ outcome: "held-duplicate" }) };
  assert.equal(searchEftPool(pool, "nothing").searched, 1);
});

// ─── REVIEW FOLLOW-UPS ───────────────────────────────────────────────────────
test("copies of ONE bank transaction (pre-fix resends) are one payment, not an ambiguity", () => {
  const pool = {
    a: recorded({ at: 1, bankRef: "5TG59DVQ", reader: "fnb" }),
    b: recorded({ at: 2, bankRef: "5TG59DVQ", reader: "fnb" }),
  };
  assert.deepEqual(keys(pool, "junid1234"), ["a"], "the OLDEST copy — the one the settle claim favours");
  const spent = { ...pool, b: { ...pool.b, status: "used", used: { at: 3, sale: { receiptNumber: "9" } } } };
  const out = searchEftPool(spent, "junid1234");
  assert.deepEqual(out.results.map((r) => r.key), ["b"], "a used copy stands for the group: the money is spent");
  assert.equal(out.results[0].status, "used");
  // Different bank ids are still two payments → ambiguous.
  const two = { ...pool, b: { ...pool.b, bankRef: "OTHER999" } };
  assert.equal(searchEftPool(two, "junid1234").ambiguous, true);
});

test("a near match never echoes the stored reference", () => {
  const out = searchEftPool({ a: recorded({ reference: "JUNID1234" }) }, "juind1234");
  assert.equal(out.results[0].matchedOn, "near");
  assert.equal(out.results[0].reference, null);
});

test("a payment with no bank id that the owner never released says so (needsOwner)", () => {
  assert.equal(publicEftView("k", recorded({ bankRef: null })).needsOwner, true);
  assert.equal(publicEftView("k", recorded()).needsOwner, false);
  assert.equal(publicEftView("k", recorded({ bankRef: null, releasedFromHold: { at: 1 } })).needsOwner, false);
});
