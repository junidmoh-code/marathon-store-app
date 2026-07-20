// ─── DISPLAY CHECKS — the guarded transaction primitive + its honest guarantees ─
// (1) The two modes behave as specified. (2) The latch aborts on a LATER
// authoritative null at ALL FOUR guardedMutate sites, using each site's REAL
// mutation. (3) The mode split is enforced both directions. (4) The HONEST scope:
// the latch does NOT close the cold-cache single-round-trip delete race — that is
// closed by the never-delete-an-active-record invariant, which has its own guard.
// Run: cd functions && node --test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { guardedMutate, guardedCreate } = require("../displayChecks/guardedTransaction.cjs");
const { bumpTxn, applyWakeTransition, isStaleTombstone, completionFlipMutation } = require("../displayChecks/lib.cjs");
const { makeNode, assertLatchAbortsOnAuthoritativeNull, assertNeverDeletesActiveRecord } = require("./helpers/guarded-txn.cjs");

const NOW = Date.parse("2026-07-19T09:00:00.000Z");
const SA = "2026-07-19";
const D = 20 * 60000;
const openCheck = (o = {}) => ({ checkId: "cA", productId: "p1", size: "M", sizeKey: "M", dedupeKey: "p1__M",
  status: "open", saleCount: 1, appliedMovements: { mv0: true }, activatedSaDate: "2026-07-18", ...o });

// ── The primitive contract ────────────────────────────────────────────────────
test("guardedMutate: cold-null → preRead; a LATER authoritative null → abort, never resurrect", async () => {
  const cold = makeNode(openCheck({ saleCount: 5 }));
  const r1 = await guardedMutate(cold.ref, openCheck({ saleCount: 5 }), (c) => ({ ...c, saleCount: c.saleCount + 1 }));
  assert.equal(cold.coldAborts, 0);
  assert.equal(r1.committed, true);
  assert.equal(cold.value.saleCount, 6);
  const gone = makeNode(openCheck());
  gone.deleteAfterRetry = true;
  const r2 = await guardedMutate(gone.ref, openCheck(), (c) => ({ ...c, saleCount: 99 }));
  assert.equal(r2.committed, false);
  assert.equal(gone.value, null); // not resurrected via the retry path
});

test("guardedMutate: a mutation returning null DELETES (conditional-delete callers, e.g. reap)", async () => {
  const node = makeNode(openCheck({ status: "completed" }));
  const r = await guardedMutate(node.ref, openCheck({ status: "completed" }), () => null);
  assert.equal(r.committed, true);
  assert.equal(node.value, null);
});

test("guardedCreate: WRITES on an authoritative null — the create shape", async () => {
  const node = makeNode(null);
  const fresh = { checkId: "cNew", status: "held" };
  const r = await guardedCreate(node.ref, (cur) => (cur === null || cur.status === "completed") ? fresh : undefined);
  assert.equal(r.committed, true);
  assert.deepEqual(node.value, fresh);
});

// ── GUARD 1 applied to every guardedMutate site, with its REAL mutation ────────
test("SITE #1 bumpCheck: latch aborts on a later authoritative null", async () => {
  await assertLatchAbortsOnAuthoritativeNull({
    label: "bumpCheck",
    preRead: openCheck({ status: "open", saleCount: 2 }),
    mutate: (c) => bumpTxn(c, { qty: 1, movementTs: "2026-07-19T09:00:00.000Z", movementId: "mvX", expectedCheckId: "cA" }),
  });
});

test("SITE #4 wake held→open flip (applyInPlace): latch aborts on a later authoritative null", async () => {
  await assertLatchAbortsOnAuthoritativeNull({
    label: "applyInPlace/activate",
    preRead: openCheck({ status: "held", stockSeenAt: NOW - D - 1 }),
    mutate: (c) => applyWakeTransition(c, "activate", { nowMs: NOW, delayMs: D, assignedTo: null, activatedSaDate: SA }),
  });
});

test("SITE #5 reapTombstone: latch aborts on a later authoritative null", async () => {
  await assertLatchAbortsOnAuthoritativeNull({
    label: "reapTombstone",
    preRead: openCheck({ status: "completed", completedAt: Date.parse("2026-07-18T12:00:00.000Z"), completedSaDate: "2026-07-18" }),
    mutate: (c) => (isStaleTombstone(c, SA) ? null : undefined),
  });
});

test("SITE #6 completeDisplayCheck flip: latch aborts on a later authoritative null (REAL completionFlipMutation)", async () => {
  await assertLatchAbortsOnAuthoritativeNull({
    label: "completeDisplayCheck/flip",
    preRead: openCheck({ status: "open" }),
    mutate: completionFlipMutation({ expectedCheckId: "cA", result: "confirmed", nowMs: NOW, saDate: SA, actor: { uid: "u" }, overridden: false, stockQty: 0 }),
  });
});

// ── The HONEST limitation: the cold-both-null race the latch CANNOT close ──────
test("LIMITATION: the cold-cache SINGLE-round-trip delete race resurrects — the latch cannot stop it; the never-delete invariant does", async () => {
  // The record existed at preRead but is already gone at the transaction's first
  // server response (server null, expected-hash null → CAS commits on the first
  // callback; no re-invocation, so the latch never runs).
  const node = makeNode(null);                     // authoritatively empty at txn time
  const preRead = openCheck({ status: "open" });   // read a moment earlier, now deleted
  const res = await guardedMutate(node.ref, preRead, (c) => ({ ...c, saleCount: 99 }));
  assert.equal(res.committed, true);
  assert.deepEqual(node.value, { ...preRead, saleCount: 99 }); // RESURRECTED — the latch could not prevent this
  // Safe in THIS module ONLY because nothing deletes an active record within a
  // transaction window: the sole deleter (prior-day tombstone reaping) can't touch
  // a record a mutation is holding. That invariant — not the latch — closes this
  // case, and assertNeverDeletesActiveRecord guards it.
});

// ── The mode split is enforced BOTH directions ────────────────────────────────
test("a create wrongly routed through guardedMutate FAILS to create (aborts on the empty slot)", async () => {
  const node = makeNode(null);
  const r = await guardedMutate(node.ref, null, () => ({ checkId: "cNew", status: "held" }));
  assert.equal(r.committed, false);
  assert.equal(node.value, null); // creation broken in the wrong mode
});

test("bumpTxn(null) returns undefined — so guardedMutate's null-abort is a clean no-op, never a throw (SITE #1 equivalence)", () => {
  assert.equal(bumpTxn(null, { qty: 1, movementId: "m", expectedCheckId: "cA" }), undefined);
});

// ── GUARD 2 (never-delete invariant) has teeth: it catches a violating delete ──
test("assertNeverDeletesActiveRecord: passes a completed-only delete, FAILS a delete that removes an active record", async () => {
  const seed = () => ({ state: { displayChecks_active: { pe: {
    heldK: { checkId: "h", status: "held" }, openK: { checkId: "o", status: "open" }, doneK: { checkId: "d", status: "completed" },
  } } } });
  const paths = { held: "displayChecks_active/pe/heldK", open: "displayChecks_active/pe/openK" };
  // compliant: deletes only the completed tombstone → both active records survive
  const okDb = seed();
  await assertNeverDeletesActiveRecord({ db: okDb, activePaths: paths, run: (db) => { delete db.state.displayChecks_active.pe.doneK; } });
  // violating: deletes an OPEN active record → the guard must throw
  const badDb = seed();
  await assert.rejects(
    () => assertNeverDeletesActiveRecord({ db: badDb, activePaths: paths, run: (db) => { delete db.state.displayChecks_active.pe.openK; } }),
    /never-delete invariant VIOLATED/,
  );
});
