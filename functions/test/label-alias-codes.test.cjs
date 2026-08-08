// ─── CODE ALIASES — every token on a multi-token label is the same shoe ──────
// (Owner spec 2026-08-08, the Diesel Big D incident: 190935-505 AND 740750-35
// on ONE label, two operators tapping differently → two identities.) The
// mandatory proofs live here:
//   • tapping EITHER token files both → the same product answers for both;
//   • a later scan of the UNTAPPED token resolves to that product;
//   • a token another product already claims routes to the duplicate flow
//     and is NEVER attached;
//   • merge pointers are followed; lookups fail closed on disagreement.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  LABEL_ALIASES_PATH, normaliseAliasCodes, codesToMap, codeAliasOwner, isDuplicateCodeAlias,
} = require("../lib/label-alias.cjs");
const { runLabelAlias } = require("../labelAlias/labelAlias.js");
const { DUPLICATE_CANDIDATES_PATH, STYLE_CODE_INDEX_PATH } = require("../styleCode/resolveStyleCode.js");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };

// The Diesel Big D Green Orange label, as read: two code-shaped tokens.
const TOKEN_A = "190935505"; // numeric-6-3 — the one the first operator tapped
const TOKEN_B = "74075035";  // puma-6-2   — the one a colleague might tap

// Faithful RTDB fake: empty arrays/objects are DELETED on write, exactly like
// production (same contract as label-alias.test.cjs), plus the transaction
// the duplicate-pair upsert and the layout learner run through.
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  let pushN = 0;
  const at = (p) => String(p).split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (p, v) => {
    const parts = String(p).split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (v === null) delete node[last]; else node[last] = v;
  };
  const strip = (v) => {
    if (!v || typeof v !== "object") return v;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) {
      if ((Array.isArray(x) && x.length === 0) || (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0)) continue;
      out[k] = strip(x);
    }
    return out;
  };
  const makeRef = (p) => ({
    async get() { const v = at(p); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { put(p, strip(v)); },
    async update(patch) { for (const [k, v] of Object.entries(patch)) put(`${p}/${k}`, v); },
    push() { const id = `al${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
    async transaction(fn) {
      const cur = at(p);
      const out = fn(cur === undefined ? null : cur);
      if (out === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      put(p, strip(out));
      return { committed: true, snapshot: { val: () => out } };
    },
  });
  return { data, ref: makeRef };
}

const baseDb = (extra = {}) => fakeDb({
  products: {
    pDiesel: { id: "pDiesel", name: "Diesel Big D Green Orange" },
    pOther: { id: "pOther", name: "Some Other Shoe" },
  },
  ...extra,
});

// ─── The pure half ───────────────────────────────────────────────────────────
test("normaliseAliasCodes keeps only format-valid shapes, deduped and sorted", () => {
  assert.deepStrictEqual(normaliseAliasCodes(["190935-505", "740750-35", "190935505", "NOT A CODE", ""]),
    [TOKEN_A, TOKEN_B].sort());
  assert.strictEqual(codesToMap(["junk", null]), null);
});

test("codeAliasOwner answers exactly, and FAILS CLOSED when records disagree", () => {
  const aliases = {
    a1: { productId: "pDiesel", c: { [TOKEN_B]: true }, n: 1 },
  };
  assert.deepStrictEqual(codeAliasOwner(TOKEN_B, aliases), { productId: "pDiesel", aliasId: "a1" });
  assert.strictEqual(codeAliasOwner(TOKEN_A, aliases), null);
  // Two records, two different products, one code → nobody answers.
  aliases.a2 = { productId: "pOther", c: { [TOKEN_B]: true }, n: 1 };
  assert.strictEqual(codeAliasOwner(TOKEN_B, aliases), null);
});

// ─── THE OWNER'S CORE PROOF: the tap does not matter ─────────────────────────
test("tapping EITHER token on a two-token label resolves to the same product", async () => {
  // Operator 1 taps token A. Every token files.
  const db1 = baseDb();
  const r1 = await runLabelAlias(db1, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.conflicts, []);
  const lookB = await runLabelAlias(db1, { action: "codeLookup", code: TOKEN_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(lookB.productId, "pDiesel", "the UNTAPPED token must resolve to the same product");

  // A different operator taps token B instead — the SAME outcome.
  const db2 = baseDb();
  await runLabelAlias(db2, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_B, otherCodes: [TOKEN_A], actor: ACTOR, nowMs: NOW,
  });
  const lookA = await runLabelAlias(db2, { action: "codeLookup", code: TOKEN_A, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(lookA.productId, "pDiesel");
});

test("a later scan of the untapped token survives a product merge", async () => {
  const db = baseDb();
  await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  // pDiesel is later merged away — the alias must answer with the survivor.
  db.data.products.pDiesel.mergedInto = "pOther";
  const look = await runLabelAlias(db, { action: "codeLookup", code: TOKEN_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(look.productId, "pOther");
});

test("an already-claimed other token routes to the DUPLICATE flow, never attaches", async () => {
  const db = baseDb({
    [STYLE_CODE_INDEX_PATH]: { [TOKEN_B]: { productId: "pOther", claimedAt: 1, claimedBy: "x" } },
  });
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(res.conflicts, [{ code: TOKEN_B, ownerId: "pOther" }]);
  assert.deepStrictEqual(res.attached, [TOKEN_A], "the unclaimed token still files");
  // The pair landed in the duplicate queue, open, with the colliding code.
  const pair = db.data[DUPLICATE_CANDIDATES_PATH] && db.data[DUPLICATE_CANDIDATES_PATH]["pDiesel__pOther"];
  assert.ok(pair, "a /duplicate_candidates pair row must exist");
  assert.strictEqual(pair.status, "open");
  assert.strictEqual(pair.styleCodeNormalised, TOKEN_B);
  // And the claimed token did NOT become an alias of pDiesel.
  const look = await runLabelAlias(db, { action: "codeLookup", code: TOKEN_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(look.productId, null);
});

test("a token already ALIASED to a different product is a conflict too", async () => {
  const db = baseDb({
    [LABEL_ALIASES_PATH]: { a0: { productId: "pOther", c: { [TOKEN_B]: true }, n: 1, addedAt: 1, addedBy: "x" } },
  });
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(res.conflicts, [{ code: TOKEN_B, ownerId: "pOther" }]);
  assert.ok(db.data[DUPLICATE_CANDIDATES_PATH]["pDiesel__pOther"], "surfaced as a possible duplicate");
});

test("a token the target itself already claims is neither attached nor a conflict", async () => {
  const db = baseDb({
    [STYLE_CODE_INDEX_PATH]: { [TOKEN_A]: { productId: "pDiesel", claimedAt: 1, claimedBy: "x" } },
  });
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(res.conflicts, []);
  assert.deepStrictEqual(res.attached, [TOKEN_B], "only the unclaimed token needs an alias");
});

test("re-filing the same label is deduped — one record, not a pile", async () => {
  const db = baseDb();
  const args = {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  };
  await runLabelAlias(db, args);
  await runLabelAlias(db, args);
  const records = Object.values(db.data[LABEL_ALIASES_PATH] || {});
  assert.strictEqual(records.length, 1);
  assert.ok(isDuplicateCodeAlias([TOKEN_A, TOKEN_B], "pDiesel", db.data[LABEL_ALIASES_PATH]));
});

test("disagreeing alias records fail closed AND land in the duplicate queue — never a silent permanent dead end", async () => {
  // The write race: two devices attached the same token to two products.
  const db = baseDb({
    [LABEL_ALIASES_PATH]: {
      a1: { productId: "pDiesel", c: { [TOKEN_B]: true }, n: 1, addedAt: 1, addedBy: "x" },
      a2: { productId: "pOther", c: { [TOKEN_B]: true }, n: 1, addedAt: 2, addedBy: "y" },
    },
  });
  const look = await runLabelAlias(db, { action: "codeLookup", code: TOKEN_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(look.productId, null, "nobody resolves — a human decides");
  const pair = db.data[DUPLICATE_CANDIDATES_PATH] && db.data[DUPLICATE_CANDIDATES_PATH]["pDiesel__pOther"];
  assert.ok(pair && pair.status === "open", "the disagreement is surfaced for review, not swallowed");

  // …but a disagreement that COLLAPSES through merge pointers resolves fine.
  const db2 = baseDb({
    [LABEL_ALIASES_PATH]: {
      a1: { productId: "pDiesel", c: { [TOKEN_B]: true }, n: 1, addedAt: 1, addedBy: "x" },
      a2: { productId: "pOther", c: { [TOKEN_B]: true }, n: 1, addedAt: 2, addedBy: "y" },
    },
  });
  db2.data.products.pOther.mergedInto = "pDiesel";
  const look2 = await runLabelAlias(db2, { action: "codeLookup", code: TOKEN_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(look2.productId, "pDiesel");
  assert.strictEqual(db2.data[DUPLICATE_CANDIDATES_PATH], undefined, "a merge artifact is not a duplicate");
});

test("a DISPUTED token (two alias records, two products) is a conflict for a third filer — never attached", async () => {
  const db = baseDb({
    products: {
      pDiesel: { id: "pDiesel", name: "Diesel" },
      pOther: { id: "pOther", name: "Other" },
      pThird: { id: "pThird", name: "Third" },
    },
    [LABEL_ALIASES_PATH]: {
      a1: { productId: "pDiesel", c: { [TOKEN_B]: true }, n: 1, addedAt: 1, addedBy: "x" },
      a2: { productId: "pOther", c: { [TOKEN_B]: true }, n: 1, addedAt: 2, addedBy: "y" },
    },
  });
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pThird",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  assert.ok(!res.attached.includes(TOKEN_B), "a disputed token must not gain a third record");
  assert.strictEqual(res.conflicts.length, 1);
  assert.strictEqual(res.conflicts[0].code, TOKEN_B);
});

test("token-set scoring and code records cannot bleed into each other", async () => {
  const db = baseDb();
  await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pDiesel",
    chosenCode: TOKEN_A, otherCodes: [TOKEN_B], actor: ACTOR, nowMs: NOW,
  });
  // A fuzzy token match over the node ignores the code record entirely.
  const match = await runLabelAlias(db, { action: "match", tokens: ["DIESEL", "GREEN", "ORANGE"], actor: ACTOR, nowMs: NOW });
  assert.strictEqual(match.band, "low");
  assert.deepStrictEqual(match.candidates, []);
});
