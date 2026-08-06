// ─── LABEL ALIASES — fuzzy identity, proven against the owner's mandates ─────
// The mandatory proofs live here: the same label read two different ways
// resolves to the same product; two different shoes never match at any band;
// a confirmed middle-band match files a new alias and the next scan of that
// reading resolves silently; a genuinely unknown label lands low.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  LABEL_ALIASES_PATH, BANDS, normaliseAliasTokens, tokensToMap, tokensFromNode,
  overlap, scoreAliases, bandFor, isDuplicateAlias,
} = require("../lib/label-alias.cjs");
const { runLabelAlias } = require("../labelAlias/labelAlias.js");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };

// Faithful RTDB fake: empty arrays/objects are DELETED on write, exactly like
// production — the prior fingerprint-cache bug shipped because a fake didn't.
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
    push() { const id = `al${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
  });
  return { data, ref: makeRef };
}

// Two READS of the SAME On Cloud label: the second frame split one word and
// dropped another — the real OCR variance the equality design died on.
const READ_A = ["CLOUDNOVA", "MONO", "UNDYED", "WHITE"];
const READ_B = ["CLOUDNOVAM", "ONO", "UNDYED", "WHITE"];   // split token
const READ_C = ["CLOUDNOVA", "MONO", "WHITE"];             // dropped token
// A DIFFERENT shoe from the same brand — shares boilerplate-ish colour tokens.
const OTHER_SHOE = ["CLOUDMONSTER", "EVERGREEN", "WHITE"];

const aliasNode = (productId, tokens, id) => ({ [id]: { productId, t: Object.fromEntries(tokens.map((t) => [t, true])), n: tokens.length, addedAt: 1, addedBy: "x" } });

// ─── THE BANDS ───────────────────────────────────────────────────────────────
test("the SAME label read two different ways resolves to the same product", () => {
  const aliases = aliasNode("pShoe", READ_A, "a1");
  // dropped-token read: containment 3/3 = 1.0 → HIGH, silent.
  const scoredC = scoreAliases(READ_C, aliases);
  assert.strictEqual(bandFor(scoredC), "high");
  assert.strictEqual(scoredC[0].productId, "pShoe");
  // split-token read: shares UNDYED+WHITE (2 of min 4) → 0.5 → MID: the human
  // is shown the candidate and confirms — never a dead end.
  const scoredB = scoreAliases(READ_B, aliases);
  assert.strictEqual(bandFor(scoredB), "mid");
  assert.strictEqual(scoredB[0].productId, "pShoe");
});

test("two different shoes do NOT match each other at any resolving band", () => {
  const aliases = aliasNode("pNova", READ_A, "a1");
  const scored = scoreAliases(OTHER_SHOE, aliases);
  // They share one colour token — containment 1/3 ≈ 0.33 → LOW.
  assert.strictEqual(bandFor(scored), "low");
});

test("a confirmed MID match files the new reading — and the next scan of it is silent", async () => {
  const db = fakeDb({ products: { pShoe: { id: "pShoe", name: "Cloudnova" } }, [LABEL_ALIASES_PATH]: aliasNode("pShoe", READ_A, "a1") });
  // First scan of the split reading: MID (asked, not silent).
  const before = await runLabelAlias(db, { action: "match", tokens: READ_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(before.band, "mid");
  // Human taps YES → the reading becomes another alias.
  const added = await runLabelAlias(db, { action: "add", productId: "pShoe", tokens: READ_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(added.ok, true);
  assert.ok(added.aliasId);
  // The SAME reading now resolves silently — accuracy improved with use.
  const after = await runLabelAlias(db, { action: "match", tokens: READ_B, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(after.band, "high");
  assert.strictEqual(after.candidates[0].productId, "pShoe");
});

test("a genuinely unknown label lands LOW — the calm never-registered path", async () => {
  const db = fakeDb({ [LABEL_ALIASES_PATH]: aliasNode("pShoe", READ_A, "a1") });
  const out = await runLabelAlias(db, { action: "match", tokens: ["SAMBA", "LEATHER", "GUM"], actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.band, "low");
});

test("AMBIGUITY DOWNGRADE: two products both over the silent bar → the human decides", () => {
  const aliases = {
    ...aliasNode("pA", ["ALPHA", "BRAVO", "CHARLIE", "DELTA"], "a1"),
    ...aliasNode("pB", ["ALPHA", "BRAVO", "CHARLIE", "ECHO"], "a2"),
  };
  const scored = scoreAliases(["ALPHA", "BRAVO", "CHARLIE"], aliases);
  assert.ok(scored[0].score >= BANDS.HIGH && scored[1].score >= BANDS.HIGH);
  assert.strictEqual(bandFor(scored), "mid", "a silent wrong match is unrecoverable — never guess between two");
});

test("tiny token sets can never match silently — the shared-token floor", () => {
  const aliases = aliasNode("pShoe", ["NOVA", "AIR"], "a1");
  const scored = scoreAliases(["NOVA", "AIR"], aliases);
  assert.strictEqual(scored[0].score, 1, "perfect containment…");
  assert.strictEqual(bandFor(scored), "mid", "…but only 2 shared tokens — below MIN_SHARED, so the human confirms");
});

// ─── THE STORE ───────────────────────────────────────────────────────────────
test("tokens are stored as a MAP — the shape real RTDB cannot silently delete", async () => {
  const db = fakeDb({ products: { pShoe: { id: "pShoe" } } });
  await runLabelAlias(db, { action: "add", productId: "pShoe", tokens: READ_A, actor: ACTOR, nowMs: NOW });
  const rec = Object.values(db.data[LABEL_ALIASES_PATH])[0];
  assert.deepStrictEqual(rec.t, { CLOUDNOVA: true, MONO: true, UNDYED: true, WHITE: true });
  assert.strictEqual(rec.n, 4);
  assert.strictEqual(rec.addedAt, NOW);
  assert.strictEqual(rec.addedBy, "staff1");
});

test("a near-identical reading for the same product de-dupes instead of piling up", async () => {
  const db = fakeDb({ products: { pShoe: { id: "pShoe" } }, [LABEL_ALIASES_PATH]: aliasNode("pShoe", READ_A, "a1") });
  const out = await runLabelAlias(db, { action: "add", productId: "pShoe", tokens: READ_C, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.deduped, true);
  assert.strictEqual(Object.keys(db.data[LABEL_ALIASES_PATH]).length, 1, "no second row");
});

test("an alias for a merged-away product lands on its SURVIVOR", async () => {
  const db = fakeDb({
    products: { pOld: { id: "pOld", mergedInto: "pNew" }, pNew: { id: "pNew" } },
  });
  const out = await runLabelAlias(db, { action: "add", productId: "pOld", tokens: READ_A, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.productId, "pNew");
  assert.strictEqual(Object.values(db.data[LABEL_ALIASES_PATH])[0].productId, "pNew");
});

test("add refuses a ghost product and a token set too small to be an identity", async () => {
  const db = fakeDb({ products: { pShoe: { id: "pShoe" } } });
  await assert.rejects(() => runLabelAlias(db, { action: "add", productId: "pGone", tokens: READ_A, actor: ACTOR, nowMs: NOW }));
  await assert.rejects(() => runLabelAlias(db, { action: "add", productId: "pShoe", tokens: ["X1"], actor: ACTOR, nowMs: NOW }));
});

test("match with too few usable tokens is LOW without reading anything", async () => {
  const db = fakeDb({});
  const out = await runLabelAlias(db, { action: "match", tokens: ["8", "42"], actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.band, "low");
  assert.strictEqual(out.candidates.length, 0);
});

// ─── Hygiene ─────────────────────────────────────────────────────────────────
test("token normalisation: uppercase, alnum-only, numeric-only dropped, bounded, sorted", () => {
  assert.deepStrictEqual(normaliseAliasTokens(["cloud-nova", "MONO", "mono", "42", "8.5", "a"]), ["CLOUDNOVA", "MONO"]);
  const many = normaliseAliasTokens(Array.from({ length: 100 }, (_, i) => `TOK${i}X`));
  assert.ok(many.length <= 40);
});

test("tokensFromNode reads maps and legacy arrays alike", () => {
  assert.deepStrictEqual(tokensFromNode({ MONO: true, CLOUDNOVA: true }), ["CLOUDNOVA", "MONO"]);
  assert.deepStrictEqual(tokensFromNode(["MONO", "CLOUDNOVA"]), ["CLOUDNOVA", "MONO"]);
  assert.deepStrictEqual(tokensFromNode(null), []);
});
