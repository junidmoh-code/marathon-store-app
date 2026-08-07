// ─── STYLE CODE SIBLINGS — one code, several colourways, mutation-proved ─────
// The owner-spec guarantees this file pins (2026-08-07, HF5509-002 evidence):
//   1. one code can own several products with NONE flagged as duplicates
//   2. answering "different colourway" creates a sibling and NO duplicate row
//   3. answering "same shoe" records the answer and reaches the merge flow
//      (the /duplicate_candidates pair row the merge UI feeds from)
//   4. existing one-owner claims survive untouched — the legacy shape IS the
//      one-owner case of the new shape (the "migration" is a no-op, proven)
//   5. a merge never leaves a survivor listed twice as an owner
//   6. velocity/repeat flags are LOGGED, never acted on
// Every fake models real RTDB behaviour where it matters — in particular a
// transaction() with first-writer-wins semantics, and null-pruning on set.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  claimOwnerIds, isSiblingPair, partitionPairs, buildSiblingEntry,
  siblingVelocity, repeatAnswerCount,
  ANSWER_SAME_SHOE, ANSWER_DIFFERENT_COLOURWAY, SIBLING_EVENTS_PATH,
} = require("../lib/style-code-siblings.cjs");
const { runSibling } = require("../styleCode/styleCodeSibling.js");
const { runResolve, DUPLICATE_CANDIDATES_PATH, STYLE_CODE_INDEX_PATH } = require("../styleCode/resolveStyleCode.js");
const { claimIndexServerSide } = require("../styleCode/processCapture.js");
const { performMerge } = require("../lib/product-merge.cjs");

const NOW = 1754500000000;

// ── The fake RTDB — path tree + transaction with real first-writer-wins ──────
// set(null) DELETES the node, exactly as real RTDB does; a transaction's
// callback aborts by returning undefined. push() mints increasing keys.
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const writes = [];
  let pushSeq = 0;
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (value === null) delete node[last];       // real RTDB: null deletes
    else node[last] = value;
  };
  const db = {
    data, writes,
    ref(path = "") {
      return {
        async get() {
          const v = at(path);
          const val = v === undefined ? null : v;
          return { val: () => val, exists: () => val !== null };
        },
        async set(value) { writes.push({ path, value }); put(path, value); },
        async update(patch) {
          for (const [k, v] of Object.entries(patch)) {
            const full = path ? `${path}/${k}` : k;
            writes.push({ path: full, value: v });
            put(full, v);
          }
        },
        push(value) {
          const key = `push${String(++pushSeq).padStart(3, "0")}`;
          const child = { key, async set(v) { writes.push({ path: `${path}/${key}`, value: v }); put(`${path}/${key}`, v); } };
          if (value !== undefined) { child.set(value); }
          return child;
        },
        async transaction(fn) {
          const cur = at(path);
          const out = fn(cur === undefined ? null : cur);
          if (out === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
          writes.push({ path, value: out });
          put(path, out);
          return { committed: true, snapshot: { val: () => out } };
        },
        orderByChild(field) {
          return { equalTo(target) { return { async get() {
            const node = at(path) || {};
            const hit = {};
            for (const [k, v] of Object.entries(node)) if (v && v[field] === target) hit[k] = v;
            return { val: () => (Object.keys(hit).length ? hit : null) };
          } }; } };
        },
      };
    },
  };
  return db;
}

const noProviders = []; // resolver tier walk with nothing behind it
const actor = { uid: "uStaff" };

const CODE = "HF5509002"; // the owner's photographed evidence code, normalised

function productsFixture() {
  return {
    pWhite: { id: "pWhite", name: "Nike Court White", styleCodeNormalised: CODE, photoUrl: "https://x/w.jpg" },
    pBlack: { id: "pBlack", name: "Nike Court Black", styleCodeNormalised: CODE, photoUrl: "https://x/b.jpg" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The pure model
// ─────────────────────────────────────────────────────────────────────────────

test("a LEGACY claim (no siblings child) reads as exactly one owner — the migration is this fact", () => {
  const legacy = { productId: "p1", claimedAt: 5, claimedBy: "u1" };
  assert.deepStrictEqual(claimOwnerIds(legacy), ["p1"]);
  // And nothing about the node changed to make that true: the shape is untouched.
  assert.deepStrictEqual(legacy, { productId: "p1", claimedAt: 5, claimedBy: "u1" });
});

test("owners = primary + siblings, deduped, primary first", () => {
  const node = { productId: "p1", claimedAt: 5, siblings: { p3: { addedAt: 6 }, p2: { addedAt: 7 }, p1: { addedAt: 8 } } };
  assert.deepStrictEqual(claimOwnerIds(node), ["p1", "p2", "p3"]);
});

test("isSiblingPair: both owners → true; one outsider → false; same id → false", () => {
  const node = { productId: "p1", siblings: { p2: { addedAt: 1 } } };
  assert.strictEqual(isSiblingPair(node, "p1", "p2"), true);
  assert.strictEqual(isSiblingPair(node, "p1", "p9"), false);
  assert.strictEqual(isSiblingPair(node, "p1", "p1"), false);
  assert.strictEqual(isSiblingPair(null, "p1", "p2"), false);
});

test("partitionPairs splits sibling pairs from genuine collisions", () => {
  const node = { productId: "a", siblings: { b: { addedAt: 1 } } };
  const pairs = [
    { pairId: "a__b", productIdA: "a", productIdB: "b" },
    { pairId: "a__c", productIdA: "a", productIdB: "c" },
  ];
  const { sibling, collision } = partitionPairs(node, pairs);
  assert.deepStrictEqual(sibling.map((p) => p.pairId), ["a__b"]);
  assert.deepStrictEqual(collision.map((p) => p.pairId), ["a__c"]);
});

test("buildSiblingEntry is constructed field by field — nothing extra can ride in", () => {
  const e = buildSiblingEntry({ addedBy: "u1", nowMs: NOW, origin: "registration", extra: "nope" });
  assert.deepStrictEqual(Object.keys(e).sort(), ["addedAt", "addedBy", "origin"]);
});

test("velocity flags owner-count and adds-in-24h — and only flags", () => {
  const quiet = { productId: "p1", siblings: { p2: { addedAt: NOW - 90e6 } } };
  assert.strictEqual(siblingVelocity(quiet, NOW).flag, false);
  const burst = { productId: "p1", siblings: { p2: { addedAt: NOW - 1000 }, p3: { addedAt: NOW - 2000 } } };
  assert.deepStrictEqual(siblingVelocity(burst, NOW).reasons, ["adds-in-24h"]);
  const many = { productId: "p1", siblings: { p2: { addedAt: 1 }, p3: { addedAt: 2 }, p4: { addedAt: 3 } } };
  assert.ok(siblingVelocity(many, NOW).reasons.includes("owner-count"));
});

test("repeatAnswerCount counts different-colourway answers for the same pair, either order", () => {
  const events = {
    e1: { code: CODE, productId: "a", otherId: "b", answer: ANSWER_DIFFERENT_COLOURWAY },
    e2: { code: CODE, productId: "b", otherId: "a", answer: ANSWER_DIFFERENT_COLOURWAY },
    e3: { code: CODE, productId: "a", otherId: "b", answer: ANSWER_SAME_SHOE },
    e4: { code: "OTHER1", productId: "a", otherId: "b", answer: ANSWER_DIFFERENT_COLOURWAY },
  };
  assert.strictEqual(repeatAnswerCount(events, CODE, "a", "b"), 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 1 — one code owns several products; NONE are flagged as duplicates
// ─────────────────────────────────────────────────────────────────────────────

test("resolver: two registered siblings on one code are NOT a duplicate and write NO pair row", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2, addedBy: "u1" } } },
    },
  });
  const out = await runResolve(db, { code: CODE, providers: noProviders, actor, nowMs: NOW });
  assert.strictEqual(out.kind, "ok");
  assert.strictEqual(out.duplicate, false);
  assert.deepStrictEqual(out.duplicatePairIds, []);
  assert.deepStrictEqual(out.owners, ["pWhite", "pBlack"]);
  assert.strictEqual(out.claim.productId, "pWhite");
  assert.deepStrictEqual(out.claim.siblingIds, ["pBlack"]);
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
});

test("resolver: two stamped products WITHOUT siblingship are still flagged — the guard did not soften", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  const out = await runResolve(db, { code: CODE, providers: noProviders, actor, nowMs: NOW });
  assert.strictEqual(out.duplicate, true);
  assert.deepStrictEqual(out.duplicatePairIds, ["pBlack__pWhite"]);
  assert.ok(db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"]);
});

test("resolver: three-way — two siblings plus one interloper flags ONLY the interloper's pair", async () => {
  const db = fakeDb({
    products: {
      ...productsFixture(),
      pRogue: { id: "pRogue", name: "Rogue twin", styleCodeNormalised: CODE },
    },
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pBlack", claimedAt: 1, siblings: { pWhite: { addedAt: 2 } } },
    },
  });
  const out = await runResolve(db, { code: CODE, providers: noProviders, actor, nowMs: NOW });
  assert.strictEqual(out.duplicate, true);
  // Pair anchoring sorts ids: anchor is pBlack; pBlack__pWhite is a sibling
  // pair (skipped), pBlack__pRogue is the collision (flagged).
  assert.deepStrictEqual(out.duplicatePairIds, ["pBlack__pRogue"]);
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"], undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOFS for the callable — the collision question's two answers
// ─────────────────────────────────────────────────────────────────────────────

test("differentColourway registers a sibling, stamps the empty slot, writes NO duplicate row", async () => {
  const db = fakeDb({
    products: {
      pWhite: { id: "pWhite", name: "White", styleCodeNormalised: CODE },
      pNew: { id: "pNew", name: "Black (new)" }, // empty code slot
    },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  const out = await runSibling(db, { action: "differentColourway", code: CODE, productId: "pNew", actor, nowMs: NOW });
  assert.strictEqual(out.registered, true);
  assert.deepStrictEqual(out.owners, ["pWhite", "pNew"]);
  // The sibling entry landed under the claim, the claim itself untouched.
  const node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.strictEqual(node.productId, "pWhite");
  assert.strictEqual(node.claimedAt, 1);
  assert.ok(node.siblings.pNew.addedAt === NOW);
  // The empty slot was stamped; a colourway sibling carries the code like any owner.
  assert.strictEqual(db.data.products.pNew.styleCodeNormalised, CODE);
  // NOTHING landed in /duplicate_candidates.
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
  // The answer was recorded.
  const events = Object.values(db.data[SIBLING_EVENTS_PATH][CODE]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].answer, ANSWER_DIFFERENT_COLOURWAY);
  assert.strictEqual(events[0].flagged, false);
});

test("sameShoe records the answer and upserts the pair row the merge flow feeds from", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  const out = await runSibling(db, {
    action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pWhite", actor, nowMs: NOW,
  });
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(out.pairId, "pBlack__pWhite");
  const row = db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"];
  assert.strictEqual(row.status, "open");
  assert.strictEqual(row.reason, "styleCodeCollision");
  assert.strictEqual(row.answeredSameShoeBy, "uStaff");
  // NO sibling was created — same-shoe is the merge path, not the sibling path.
  assert.strictEqual(db.data[STYLE_CODE_INDEX_PATH][CODE].siblings, undefined);
  const events = Object.values(db.data[SIBLING_EVENTS_PATH][CODE]);
  assert.strictEqual(events[0].answer, ANSWER_SAME_SHOE);
});

test("sameShoe never reopens a pair a human closed", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
    [DUPLICATE_CANDIDATES_PATH]: {
      pBlack__pWhite: { productIdA: "pBlack", productIdB: "pWhite", reason: "styleCodeCollision", status: "dismissed", detectedAt: 7 },
    },
  });
  await runSibling(db, { action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pWhite", actor, nowMs: NOW });
  const row = db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"];
  assert.strictEqual(row.status, "dismissed");
  assert.strictEqual(row.detectedAt, 7);
});

test("differentColourway is idempotent — an existing owner comes back alreadyOwner, nothing rewritten", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2 } } },
    },
  });
  const before = JSON.stringify(db.data[STYLE_CODE_INDEX_PATH]);
  const out = await runSibling(db, { action: "differentColourway", code: CODE, productId: "pBlack", actor, nowMs: NOW });
  assert.strictEqual(out.registered, false);
  assert.strictEqual(out.alreadyOwner, true);
  assert.strictEqual(JSON.stringify(db.data[STYLE_CODE_INDEX_PATH]), before);
});

test("differentColourway REFUSES a product that already carries a different code — immutability is not ours to resolve", async () => {
  const db = fakeDb({
    products: {
      pWhite: { id: "pWhite", styleCodeNormalised: CODE },
      pOther: { id: "pOther", styleCodeNormalised: "CT8527016" },
    },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  await assert.rejects(
    runSibling(db, { action: "differentColourway", code: CODE, productId: "pOther", actor, nowMs: NOW }),
    /different style code/
  );
  assert.strictEqual(db.data[STYLE_CODE_INDEX_PATH][CODE].siblings, undefined);
});

test("an UNCLAIMED code with a stamped conflicting owner bootstraps the claim for THAT owner, then siblings", async () => {
  // Codes that pre-date the index: the collision is real, the index is empty.
  const db = fakeDb({
    products: {
      pLegacy: { id: "pLegacy", styleCodeNormalised: CODE }, // stamped, never claimed
      pNew: { id: "pNew" },
    },
  });
  const out = await runSibling(db, {
    action: "differentColourway", code: CODE, productId: "pNew", otherId: "pLegacy", actor, nowMs: NOW,
  });
  assert.strictEqual(out.registered, true);
  const node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.strictEqual(node.productId, "pLegacy"); // the product that carried it first
  assert.ok(node.siblings.pNew);
});

test("an unclaimed code with NO valid other is refused — this callable is not a claim bypass", async () => {
  const db = fakeDb({ products: { pNew: { id: "pNew" } } });
  await assert.rejects(
    runSibling(db, { action: "differentColourway", code: CODE, productId: "pNew", actor, nowMs: NOW }),
    /not claimed yet/
  );
});

test("PROOF 6 — velocity flags are LOGGED, never acted on: the 4th owner still registers", async () => {
  const db = fakeDb({
    products: { p4: { id: "p4" }, p1: { id: "p1", styleCodeNormalised: CODE } },
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "p1", claimedAt: 1, siblings: { p2: { addedAt: NOW - 1000 }, p3: { addedAt: NOW - 2000 } } },
    },
  });
  const out = await runSibling(db, { action: "differentColourway", code: CODE, productId: "p4", actor, nowMs: NOW });
  assert.strictEqual(out.registered, true);   // NOT blocked
  assert.strictEqual(out.flagged, true);      // but flagged for a human's eyes
  const ev = Object.values(db.data[SIBLING_EVENTS_PATH][CODE]).find((e) => e.productId === "p4");
  assert.strictEqual(ev.flagged, true);
  assert.ok(ev.flagReasons.length >= 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// The capture worker and the merge learn siblingship
// ─────────────────────────────────────────────────────────────────────────────

test("claimIndexServerSide: a registered SIBLING is entitled to carry the code — stamp allowed", async () => {
  const db = fakeDb({
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2 } } },
    },
  });
  const asSibling = await claimIndexServerSide(db, CODE, "pBlack", "u1", NOW);
  assert.strictEqual(asSibling.claimed, true);
  const asStranger = await claimIndexServerSide(db, CODE, "pRogue", "u1", NOW);
  assert.strictEqual(asStranger.claimed, false);
  assert.strictEqual(asStranger.ownerId, "pWhite");
});

test("merge: a merged-away SIBLING's entry follows the survivor — and never double-lists an owner", async () => {
  const db = fakeDb({
    products: {
      pWhite: { id: "pWhite", styleCodeNormalised: CODE },
      pBlack: { id: "pBlack", styleCodeNormalised: CODE },
      pSurv: { id: "pSurv" },
    },
    locations: { central: true },
    stock: {},
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2, addedBy: "u1" } } },
    },
  });
  // pBlack (a sibling) merges into pSurv (not an owner): entry moves.
  await performMerge(db, { loserId: "pBlack", survivorId: "pSurv", actor: { uid: "admin" }, nowMs: NOW });
  let node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.strictEqual(node.siblings.pBlack, undefined);
  assert.ok(node.siblings.pSurv);
  assert.strictEqual(node.productId, "pWhite");

  // Now pWhite (the primary) merges into pSurv (already a sibling): pSurv is
  // promoted to primary and its sibling entry is removed — owners list it ONCE.
  await performMerge(db, { loserId: "pWhite", survivorId: "pSurv", actor: { uid: "admin" }, nowMs: NOW + 1 });
  node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.strictEqual(node.productId, "pSurv");
  assert.deepStrictEqual(claimOwnerIds(node), ["pSurv"]);
});

test("merge: a sibling merging into a FELLOW OWNER just drops its entry — ownership already present", async () => {
  const db = fakeDb({
    products: {
      pWhite: { id: "pWhite", styleCodeNormalised: CODE },
      pBlack: { id: "pBlack", styleCodeNormalised: CODE },
    },
    locations: { central: true },
    stock: {},
    [STYLE_CODE_INDEX_PATH]: {
      [CODE]: { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2 } } },
    },
  });
  await performMerge(db, { loserId: "pBlack", survivorId: "pWhite", actor: { uid: "admin" }, nowMs: NOW });
  const node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.deepStrictEqual(claimOwnerIds(node), ["pWhite"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 10 — existing claims survive: the resolver reads a legacy claim
// byte-identically to before the sibling change
// ─────────────────────────────────────────────────────────────────────────────

test("a legacy one-owner claim resolves exactly as before — same owner, no flags, node untouched", async () => {
  const legacyNode = { productId: "pWhite", claimedAt: 111, claimedBy: "uOld" };
  const db = fakeDb({
    products: { pWhite: { id: "pWhite", name: "White", styleCodeNormalised: CODE } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { ...legacyNode } },
  });
  const out = await runResolve(db, { code: CODE, providers: noProviders, actor, nowMs: NOW });
  assert.strictEqual(out.claim.productId, "pWhite");
  assert.strictEqual(out.claim.claimedAt, 111);
  assert.deepStrictEqual(out.claim.siblingIds, []);
  assert.deepStrictEqual(out.owners, ["pWhite"]);
  assert.strictEqual(out.duplicate, false);
  // The node itself was not migrated, rewritten or touched.
  assert.deepStrictEqual(db.data[STYLE_CODE_INDEX_PATH][CODE], legacyNode);
});

// ─────────────────────────────────────────────────────────────────────────────
// CodeRabbit findings, PR #331 — each fix pinned so it cannot regress
// ─────────────────────────────────────────────────────────────────────────────

test("sameShoe REFUSES a self-pair — a p__p row would offer a self-merge", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  await assert.rejects(
    runSibling(db, { action: "sameShoe", code: CODE, productId: "pWhite", otherId: "pWhite", actor, nowMs: NOW }),
    /different product/
  );
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
});

test("sameShoe REFUSES a phantom or merged-away other — no pair row pointing at nothing", async () => {
  const db = fakeDb({
    products: { ...productsFixture(), pGone: { id: "pGone", mergedInto: "pWhite" } },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  await assert.rejects(
    runSibling(db, { action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pNope", actor, nowMs: NOW }),
    /no longer exists/
  );
  await assert.rejects(
    runSibling(db, { action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pGone", actor, nowMs: NOW }),
    /merged away/
  );
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
});

test("the answered-same-shoe evidence SURVIVES re-detection by the resolver", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  await runSibling(db, { action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pWhite", actor, nowMs: NOW });
  const before = db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"];
  assert.strictEqual(before.answeredSameShoeBy, "uStaff");
  // A later scan re-detects the same collision and rewrites the same row —
  // the human's answer must ride through, exactly like status/detectedAt do.
  const out = await runResolve(db, { code: CODE, providers: noProviders, actor: { uid: "uOther" }, nowMs: NOW + 5000 });
  assert.strictEqual(out.duplicate, true);
  const after = db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"];
  assert.strictEqual(after.answeredSameShoeBy, "uStaff");
  assert.strictEqual(after.answeredSameShoeAt, NOW);
});

test("three-way: answering per pair registers the stamped-but-unindexed OTHER too, and records each pair", async () => {
  // Three products stamped with one code; only pA is in the index. The UI
  // answers once per other: (pNew vs pA), then (pNew vs pB).
  const db = fakeDb({
    products: {
      pA: { id: "pA", styleCodeNormalised: CODE },
      pB: { id: "pB", styleCodeNormalised: CODE },
      pNew: { id: "pNew" },
    },
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pA", claimedAt: 1 } },
  });
  await runSibling(db, { action: "differentColourway", code: CODE, productId: "pNew", otherId: "pA", actor, nowMs: NOW });
  const second = await runSibling(db, { action: "differentColourway", code: CODE, productId: "pNew", otherId: "pB", actor, nowMs: NOW + 1 });
  assert.strictEqual(second.alreadyOwner, true);
  assert.strictEqual(second.otherRegistered, true);
  // ALL THREE are owners now — no pair of them is a collision any more.
  const node = db.data[STYLE_CODE_INDEX_PATH][CODE];
  assert.deepStrictEqual(claimOwnerIds(node), ["pA", "pB", "pNew"]);
  // Both answered pairs are on the record.
  const events = Object.values(db.data[SIBLING_EVENTS_PATH][CODE]);
  assert.strictEqual(events.length, 2);
  // And nothing was flagged as a duplicate.
  assert.strictEqual(db.data[DUPLICATE_CANDIDATES_PATH], undefined);
});

test("RACE: a same-shoe answer landing between detection and the pair rewrite SURVIVES (transaction, not stale set)", async () => {
  const db = fakeDb({
    products: productsFixture(),
    [STYLE_CODE_INDEX_PATH]: { [CODE]: { productId: "pWhite", claimedAt: 1 } },
  });
  // Interleave: the instant the resolver's pair-row transaction runs, a
  // same-shoe answer has ALREADY landed on the row (written after the
  // resolver read its snapshot). A stale-snapshot set() would erase it; the
  // transaction derives from the current value and must keep it.
  const realRef = db.ref.bind(db);
  db.ref = (path) => {
    const r = realRef(path);
    if (path === `${DUPLICATE_CANDIDATES_PATH}/pBlack__pWhite`) {
      const realTxn = r.transaction.bind(r);
      r.transaction = async (fn) => {
        await runSibling(db2Passthrough, {
          action: "sameShoe", code: CODE, productId: "pBlack", otherId: "pWhite",
          actor: { uid: "uAnswerer" }, nowMs: NOW - 10,
        });
        return realTxn(fn);
      };
    }
    return r;
  };
  // runSibling needs the UNwrapped ref (or it would recurse into the interleave).
  const db2Passthrough = { ...db, ref: realRef };

  const out = await runResolve(db, { code: CODE, providers: noProviders, actor, nowMs: NOW });
  assert.strictEqual(out.duplicate, true);
  const row = db.data[DUPLICATE_CANDIDATES_PATH]["pBlack__pWhite"];
  assert.strictEqual(row.answeredSameShoeBy, "uAnswerer"); // the racing answer survived
  assert.strictEqual(row.answeredSameShoeAt, NOW - 10);
  assert.strictEqual(row.status, "open");
});
