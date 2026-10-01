// ─── EFT SEARCH — PROPERTY FUZZ (the locked-down contract, fix 2) ────────────
// Random pools and random queries against invariants the spec states outright:
//   1. AMOUNT IS NEVER A KEY.
//   2. AT MOST ONE RESULT, and it is the ORACLE's answer: the spec's matching
//      rules (exact reference or bank id; else one typo on a long reference)
//      and its ambiguity rule, restated independently below.
//   3. NO RESULT EVER CARRIES A FULL PAYER NAME, a bank id, or owner material.
//   4. SHORT QUERIES ANSWER NOTHING.
//   5. osaDistance agrees with a brute-force recursive OSA.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { searchEftPool, publicEftView, normaliseText, osaDistance } = require("../lib/eft-pool.cjs");

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = LETTERS + "0123456789";
function word(r, alphabet, min, max) {
  const n = min + Math.floor(r() * (max - min + 1));
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}
function moneyStrings(cents) {
  const rands = Math.floor(cents / 100), c = String(cents % 100).padStart(2, "0");
  return [`${rands}`, `${rands}.${c}`, `R${rands}`, `R ${rands}.${c}`, `R${rands}.${c}`, `${cents}`];
}
function randomRecord(r, i, alphabet) {
  const outcome = r() < 0.15
    ? ["refused-auth", "refused-parse", "refused-account", "unknown-bank", "held-duplicate", "held-no-bankref"][Math.floor(r() * 6)]
    : "recorded";
  const used = outcome === "recorded" && r() < 0.3;
  return {
    at: 1000 + i, bankTs: 500 + Math.floor(r() * 5000), outcome,
    status: outcome === "recorded" ? (used ? "used" : "unmatched") : undefined,
    amountCents: 100 + Math.floor(r() * 200000),
    // A small vocabulary so collisions (ambiguity) actually happen.
    reference: r() < 0.1 ? null : (r() < 0.4 ? ["NKOSI", "JUNID1234", "TEST", "OM82"][Math.floor(r() * 4)] : word(r, alphabet, 3, 12)),
    bankRef: r() < 0.1 ? null : word(r, ALNUM, 6, 10),
    payer: r() < 0.1 ? null : `PAYERNAME${i} ` + word(r, LETTERS, 3, 9),
    rawText: "secret", subject: "secret", from: "secret", auth: { verdict: "pass" },
    used: used ? { at: 2000, cashierName: "secret-cashier", customerName: "secret-customer", sale: { receiptNumber: "1" } } : undefined,
  };
}
// Recursive OSA from the definition (front-to-back, unlike the module's
// table), memoised so the oracle stays fast on 12-character references.
const osaMemo = new Map();
function osaBrute(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const k = `${a}\u0000${b}`;
  if (osaMemo.has(k)) return osaMemo.get(k);
  let best = Math.min(osaBrute(a.slice(1), b) + 1, osaBrute(a, b.slice(1)) + 1,
    osaBrute(a.slice(1), b.slice(1)) + (a[0] === b[0] ? 0 : 1));
  if (a.length > 1 && b.length > 1 && a[0] === b[1] && a[1] === b[0]) best = Math.min(best, osaBrute(a.slice(2), b.slice(2)) + 1);
  osaMemo.set(k, best);
  return best;
}
// The spec, restated independently of lib/eft-pool.cjs.
function oracle(pool, q) {
  const whole = String(q).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (whole.length < 3) return { keys: [], needQuery: true };
  const pays = Object.entries(pool).filter(([, x]) => x.outcome === "recorded");
  const norm = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const exact = pays.filter(([, x]) => (norm(x.reference) && norm(x.reference) === whole) || (norm(x.bankRef) && norm(x.bankRef) === whole));
  const near = pays.filter(([, x]) => whole.length >= 6 && norm(x.reference).length >= 6 && osaBrute(whole, norm(x.reference)) <= 1);
  const cands = exact.length ? exact : near;
  if (!cands.length) return { keys: [] };
  const un = cands.filter(([, x]) => x.status === "unmatched");
  if (un.length === 1) return { keys: [un[0][0]] };
  if (un.length === 0 && cands.length === 1) return { keys: [cands[0][0]] };
  return { keys: [], ambiguous: true };
}

test("fuzz: osaDistance agrees with a brute-force recursive OSA", () => {
  const r = rng(5);
  for (let i = 0; i < 400; i++) {
    const a = word(r, "ABC", 0, 6), b = word(r, "ABC", 0, 6);
    assert.equal(osaDistance(a, b), osaBrute(a, b), `${a} vs ${b}`);
  }
});

test("fuzz: an amount string never finds a payment by its amount", () => {
  const r = rng(11);
  for (let round = 0; round < 200; round++) {
    const pool = {};
    for (let i = 0; i < 40; i++) pool[`k${i}`] = { ...randomRecord(r, i, LETTERS), bankRef: word(r, LETTERS, 6, 9) };
    const target = Object.values(pool).find((x) => x.outcome === "recorded") ?? pool.k0;
    for (const q of moneyStrings(target.amountCents)) {
      assert.deepEqual(searchEftPool(pool, q).results, [], `query "${q}" matched by amount`);
    }
  }
});

test("fuzz: at most one result, exactly the oracle's, and never a name or owner material", () => {
  const r = rng(23);
  for (let round = 0; round < 400; round++) {
    const pool = {};
    const size = 1 + Math.floor(r() * 40);
    for (let i = 0; i < size; i++) pool[`k${i}`] = randomRecord(r, i, ALNUM);
    const src = pool[`k${Math.floor(r() * size)}`];
    const roll = r();
    let q = roll < 0.4 ? (src.reference ?? "zzz") : roll < 0.7 ? (src.bankRef ?? "zzz") : roll < 0.85 ? (src.payer ?? "zzz") : word(r, ALNUM, 0, 10);
    if (r() < 0.3 && q.length > 5) { const i = Math.floor(r() * (q.length - 1)); q = q.slice(0, i) + q[i + 1] + q[i] + q.slice(i + 2); }
    if (r() < 0.3) q = q.toLowerCase().replace(/(.)(.)/, "$1 $2");
    const out = searchEftPool(pool, q);
    const want = oracle(pool, q);
    assert.deepEqual(out.results.map((v) => v.key), want.keys, `"${q}"`);
    assert.equal(Boolean(out.ambiguous), Boolean(want.ambiguous), `ambiguity for "${q}"`);
    assert.equal(Boolean(out.needQuery), Boolean(want.needQuery));
    const s = JSON.stringify(out);
    for (const leaked of ["secret", "PAYERNAME"]) assert.ok(!s.includes(leaked), `${leaked} leaked for "${q}"`);
    for (const v of out.results) assert.ok(!s.includes(normaliseText(pool[v.key].bankRef) || "\u0000"), "bank id echoed");
  }
});

test("fuzz: under three letters/digits nothing is ever returned, whatever the pool", () => {
  const r = rng(31);
  for (let round = 0; round < 100; round++) {
    const pool = {};
    for (let i = 0; i < 20; i++) pool[`k${i}`] = randomRecord(r, i, ALNUM);
    const q = word(r, ALNUM + "-. /", 0, 2);
    const out = searchEftPool(pool, q);
    if (normaliseText(q).length < 3) {
      assert.deepEqual(out.results, [], `query "${q}"`);
      assert.equal(out.needQuery, true);
    }
  }
});

test("fuzz: publicEftView never carries a name, bank id or owner material, whatever the record holds", () => {
  const r = rng(41);
  for (let i = 0; i < 500; i++) {
    const rec = randomRecord(r, i, ALNUM);
    rec.destination = { accountMask: "XXXX6625" }; rec.accountTail = "6625"; rec.messageId = "<secret>";
    if (rec.used) rec.used.cashierUid = "secret-uid";
    const v = publicEftView("k", rec);
    if (!v) { assert.notEqual(rec.outcome, "recorded"); continue; }
    const s = JSON.stringify(v);
    for (const leaked of ["secret", "6625", "accountTail", "destination", "rawText", "PAYERNAME"]) assert.ok(!s.includes(leaked), leaked);
    if (rec.bankRef) assert.ok(!s.includes(rec.bankRef), "bank id");
  }
});
