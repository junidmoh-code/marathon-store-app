// ─── EFT SEARCH — PROPERTY FUZZ ─────────────────────────────────────────────
// The independent second-brain slot (Kimi) was down for this PR, so its
// substitute runs here as a property fuzz of the search core, the way the
// house rule says: not a green tick from a tool that did not run, but random
// pools and random queries against invariants the spec states outright.
//
//   1. AMOUNT IS NEVER A KEY. For any pool and any query that is the exact
//      money string of some record's amount, no record answers by amount:
//      every result's reference or payer must contain (or near-miss) the
//      query as text. A pool whose references and payers are pure letters can
//      never answer a digits-only query at all.
//   2. NEAR-MISS IS EXACTLY OSA ≤ 1 OVER SUBSTRINGS: the DP is checked against
//      a brute-force oracle (every substring, plain OSA distance).
//   3. RESULTS ARE SOUND: every result lands (some token or the whole query
//      lands on reference or payer under the rules), refusals never appear,
//      the cap holds, the order is score-then-recency.
//   4. SHORT QUERIES ANSWER NOTHING.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  searchEftPool, searchPlan, scoreEftView, publicEftView, normaliseText, nearestSubstringDistance,
  EFT_SEARCH_LIMIT,
} = require("../lib/eft-pool.cjs");

// Deterministic PRNG so a failure reproduces.
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
  const outcome = r() < 0.15 ? ["refused-auth", "refused-parse", "refused-account", "unknown-bank"][Math.floor(r() * 4)] : "recorded";
  const used = outcome === "recorded" && r() < 0.3;
  return {
    at: 1000 + i, bankTs: 500 + Math.floor(r() * 5000), outcome,
    status: outcome === "recorded" ? (used ? "used" : "unmatched") : undefined,
    amountCents: 100 + Math.floor(r() * 200000),
    reference: r() < 0.1 ? null : word(r, alphabet, 2, 12) + (r() < 0.3 ? " " + word(r, alphabet, 1, 6) : ""),
    payer: r() < 0.1 ? null : word(r, LETTERS, 3, 8) + " " + word(r, LETTERS, 3, 9),
    rawText: "secret", subject: "secret", from: "secret", auth: { verdict: "pass" },
    used: used ? { at: 2000, cashierName: "X", sale: null } : undefined,
  };
}

// Brute-force OSA distance (Damerau, optimal string alignment) between two strings.
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function oracleNearest(needle, hay) {
  if (!needle.length) return 0;
  let best = needle.length; // the empty substring
  for (let i = 0; i <= hay.length; i++) {
    for (let j = i; j <= hay.length; j++) best = Math.min(best, osa(needle, hay.slice(i, j)));
  }
  return best;
}
// The oracle's notion of "token lands on field" — the spec's rules, restated.
function landsOracle(token, field) {
  if (!field || !token) return false;
  if (field.includes(token)) return true;
  return token.length >= 5 && oracleNearest(token, field) <= 1;
}

test("fuzz: nearestSubstringDistance agrees with a brute-force OSA-over-substrings oracle", () => {
  const r = rng(7);
  for (let n = 0; n < 1500; n++) {
    const needle = word(r, "ABC12", 0, 7);
    const hay = word(r, "ABC12", 0, 12);
    assert.equal(nearestSubstringDistance(needle, hay), oracleNearest(needle, hay), `needle=${needle} hay=${hay}`);
  }
});

test("fuzz: an amount string never finds a payment by its amount", () => {
  const r = rng(11);
  for (let round = 0; round < 200; round++) {
    // Letters-only references and payers: digits can only ever come from an amount.
    const pool = {};
    for (let i = 0; i < 40; i++) pool[`k${i}`] = randomRecord(r, i, LETTERS);
    const target = Object.values(pool).find((x) => x.outcome === "recorded") ?? pool.k0;
    for (const q of moneyStrings(target.amountCents)) {
      assert.deepEqual(searchEftPool(pool, q).results, [], `query "${q}" matched by amount`);
    }
  }
});

test("fuzz: every result lands on reference or payer as TEXT; refusals never appear; cap and order hold", () => {
  const r = rng(23);
  for (let round = 0; round < 300; round++) {
    const pool = {};
    const size = 1 + Math.floor(r() * 60);
    for (let i = 0; i < size; i++) pool[`k${i}`] = randomRecord(r, i, ALNUM);
    // A query built from a real field (so there are hits), sometimes mangled.
    const src = pool[`k${Math.floor(r() * size)}`];
    const base = (r() < 0.5 ? src.reference : src.payer) || word(r, ALNUM, 3, 8);
    let q = base.slice(Math.floor(r() * 2), base.length - Math.floor(r() * 2)).toLowerCase();
    if (r() < 0.3 && q.length > 5) { const i = Math.floor(r() * (q.length - 1)); q = q.slice(0, i) + q[i + 1] + q[i] + q.slice(i + 2); } // transpose
    if (r() < 0.2) q = q.replace(/(.)/, "$1-");
    const { results } = searchEftPool(pool, q);
    const plan = searchPlan(q);
    assert.ok(results.length <= EFT_SEARCH_LIMIT);
    let prev = null;
    for (const v of results) {
      const rec = pool[v.key];
      assert.equal(rec.outcome, "recorded", "a refusal reached the till");
      assert.ok(!JSON.stringify(v).includes("secret"), "owner material leaked");
      const ref = normaliseText(rec.reference), payer = normaliseText(rec.payer);
      const landsAll = plan.tokens.every((t) => landsOracle(t, ref) || landsOracle(t, payer));
      const landsWhole = landsOracle(plan.whole, ref) || landsOracle(plan.whole, payer);
      assert.ok(landsAll || landsWhole, `result ${v.key} (${rec.reference} / ${rec.payer}) does not answer "${q}"`);
      // Order: score descending, then paidAt descending.
      const score = scoreEftView(v, plan);
      if (prev) assert.ok(prev.score > score || (prev.score === score && (prev.paidAt ?? 0) >= (v.paidAt ?? 0)), "order broken");
      prev = { score, paidAt: v.paidAt };
    }
    // Completeness against the oracle within the window (when under the cap).
    if (results.length < EFT_SEARCH_LIMIT && !plan.tooShort) {
      for (const [key, rec] of Object.entries(pool)) {
        if (rec.outcome !== "recorded") continue;
        const ref = normaliseText(rec.reference), payer = normaliseText(rec.payer);
        const should = plan.tokens.every((t) => landsOracle(t, ref) || landsOracle(t, payer))
          || landsOracle(plan.whole, ref) || landsOracle(plan.whole, payer);
        assert.equal(results.some((v) => v.key === key), should, `${key} (${rec.reference} / ${rec.payer}) vs "${q}"`);
      }
    }
  }
});

test("fuzz: under three letters/digits nothing is ever returned, whatever the pool", () => {
  const r = rng(31);
  for (let round = 0; round < 100; round++) {
    const pool = {};
    for (let i = 0; i < 20; i++) pool[`k${i}`] = randomRecord(r, i, ALNUM);
    const q = word(r, ALNUM + "-. /", 0, 2).replace(/[A-Z0-9]{3,}/g, "AB");
    const out = searchEftPool(pool, q);
    if (normaliseText(q).length < 3) {
      assert.deepEqual(out.results, [], `query "${q}"`);
      assert.equal(out.needQuery, true);
    }
  }
});

test("fuzz: publicEftView never carries the owner's material, whatever the record holds", () => {
  const r = rng(41);
  for (let i = 0; i < 500; i++) {
    const rec = randomRecord(r, i, ALNUM);
    rec.destination = { accountMask: "XXXX6625" }; rec.accountTail = "6625"; rec.messageId = "<secret>";
    if (rec.used) rec.used.cashierUid = "secret-uid";
    const v = publicEftView("k", rec);
    if (!v) { assert.notEqual(rec.outcome, "recorded"); continue; }
    const s = JSON.stringify(v);
    for (const leaked of ["secret", "6625", "accountTail", "destination", "rawText"]) assert.ok(!s.includes(leaked), leaked);
  }
});
