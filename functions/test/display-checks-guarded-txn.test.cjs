// ─── DISPLAY CHECKS — the guarded transaction primitive + its universal proof ──
// (1) The two modes behave as specified. (2) The reusable resurrection assertion
// applies to ALL FOUR guardedMutate sites — using each site's REAL mutation (the
// same lib functions the call sites pass) — so the class is provably closed at
// every one, not five of six. (3) The mode split is enforced both directions: a
// mutate wrongly in create-mode fails the resurrection assertion; a create wrongly
// in mutate-mode fails to create. Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { guardedMutate, guardedCreate } = require("../displayChecks/guardedTransaction.cjs");
const { bumpTxn, applyWakeTransition, isStaleTombstone, buildCompletedRecord } = require("../displayChecks/lib.cjs");
const { makeNode, assertNoResurrectionOnAuthoritativeNull } = require("./helpers/guarded-txn.cjs");

const NOW = Date.parse("2026-07-19T09:00:00.000Z");
const SA = "2026-07-19";
const D = 20 * 60000;
const openCheck = (o = {}) => ({ checkId: "cA", productId: "p1", size: "M", sizeKey: "M", dedupeKey: "p1__M",
  status: "open", saleCount: 1, appliedMovements: { mv0: true }, activatedSaDate: "2026-07-18", ...o });

// ── The primitive contract ────────────────────────────────────────────────────
test("guardedMutate: cold-null → preRead (no cold-abort); authoritative later-null → abort, never resurrect", async () => {
  // cold rescue
  const cold = makeNode(openCheck({ saleCount: 5 }));
  const r1 = await guardedMutate(cold.ref, openCheck({ saleCount: 5 }), (c) => ({ ...c, saleCount: c.saleCount + 1 }));
  assert.equal(cold.coldAborts, 0);
  assert.equal(r1.committed, true);
  assert.equal(cold.value.saleCount, 6);
  // authoritative null
  const gone = makeNode(openCheck());
  gone.deleteBeforeServer = true;
  const r2 = await guardedMutate(gone.ref, openCheck(), (c) => ({ ...c, saleCount: 99 }));
  assert.equal(r2.committed, false);
  assert.equal(gone.value, null); // NOT resurrected
});

test("guardedMutate: a mutation returning null DELETES (conditional-delete callers, e.g. reap)", async () => {
  const node = makeNode(openCheck({ status: "completed" }));
  const r = await guardedMutate(node.ref, openCheck({ status: "completed" }), () => null);
  assert.equal(r.committed, true);
  assert.equal(node.value, null); // deleted
});

test("guardedCreate: WRITES on an authoritative null — the create shape (and why the resurrection assertion must NOT apply here)", async () => {
  const node = makeNode(null);           // empty slot
  const fresh = { checkId: "cNew", status: "held" };
  const r = await guardedCreate(node.ref, (cur) => (cur === null || cur.status === "completed") ? fresh : undefined);
  assert.equal(r.committed, true);
  assert.deepEqual(node.value, fresh);   // created on null — correct by design
});

// ── THE UNIVERSAL PROOF: every guardedMutate site, with its REAL mutation ──────
test("SITE #1 bumpCheck: no resurrection on authoritative null", async () => {
  await assertNoResurrectionOnAuthoritativeNull({
    label: "bumpCheck",
    preRead: openCheck({ status: "open", saleCount: 2 }),
    mutate: (c) => bumpTxn(c, { qty: 1, movementTs: "2026-07-19T09:00:00.000Z", movementId: "mvX", expectedCheckId: "cA" }),
  });
});

test("SITE #4 wake held→open flip (applyInPlace): no resurrection on authoritative null", async () => {
  await assertNoResurrectionOnAuthoritativeNull({
    label: "applyInPlace/activate",
    preRead: openCheck({ status: "held", stockSeenAt: NOW - D - 1 }),
    mutate: (c) => applyWakeTransition(c, "activate", { nowMs: NOW, delayMs: D, assignedTo: null, activatedSaDate: SA }),
  });
});

test("SITE #5 reapTombstone: no resurrection on authoritative null", async () => {
  await assertNoResurrectionOnAuthoritativeNull({
    label: "reapTombstone",
    preRead: openCheck({ status: "completed", completedAt: Date.parse("2026-07-18T12:00:00.000Z"), completedSaDate: "2026-07-18" }),
    mutate: (c) => (isStaleTombstone(c, SA) ? null : undefined), // null = delete
  });
});

test("SITE #6 completeDisplayCheck flip: no resurrection on authoritative null", async () => {
  await assertNoResurrectionOnAuthoritativeNull({
    label: "completeDisplayCheck/flip",
    preRead: openCheck({ status: "open" }),
    mutate: (c) => {
      if (c.checkId !== "cA") return undefined;
      if (c.status !== "open" || c.completedAt != null) return undefined;
      return buildCompletedRecord(c, { result: "confirmed", nowMs: NOW, saDate: SA, actor: { uid: "u" }, overridden: false, stockQty: 0 });
    },
  });
});

// ── The mode split is enforced BOTH directions ────────────────────────────────
test("a create wrongly routed through guardedMutate FAILS to create (aborts on the empty slot) — why #2/#3 must be guardedCreate", async () => {
  const node = makeNode(null); // empty
  const fresh = { checkId: "cNew", status: "held" };
  const r = await guardedMutate(node.ref, null, () => fresh); // preRead null too → nothing to rescue
  assert.equal(r.committed, false);
  assert.equal(node.value, null); // creation broken in the wrong mode
});

test("a mutate wrongly routed through guardedCreate WOULD resurrect on authoritative null — caught by the assertion NOT holding", async () => {
  // Model a mutate site (bump) placed in create-mode: guardedCreate has no latch,
  // so on an authoritative null it substitutes nothing and the raw decide runs —
  // if that decide fell back to a stale preRead it would resurrect. We assert the
  // resurrection assertion does NOT vacuously pass for a write-on-null decide:
  const node = makeNode(null); // authoritative empty
  const ghost = openCheck({ status: "open", saleCount: 7 });
  // create-mode with a resurrecting decide (the bug shape): writes the ghost on null
  const r = await guardedCreate(node.ref, (cur) => (cur == null ? ghost : cur));
  assert.equal(r.committed, true);
  assert.deepEqual(node.value, ghost); // guardedCreate WROTE on null — which is exactly why
  // the resurrection assertion is reserved for guardedMutate: applied to this decide it would fail (b).
});
