// ─── DISPLAY CHECKS — pure trigger-logic tests (node --test) ─────────────────
// Covers displayChecks/lib.cjs: the sale-resolution order (bump vs held_resale
// vs repeat vs contradiction vs create), the assignment resolver's real order
// (cover → LOCKED roster → null), the classifier + size-key mirrors, and the
// SA date/month anchors. Run: cd functions && npm test

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../displayChecks/lib.cjs");

// ── store flags ──────────────────────────────────────────────────────────────
test("trigger store flags: PE + Trophy on, Pine dark, hubs/non-shops off", () => {
  assert.equal(lib.isTriggerStoreEnabled("marathon-pe"), true);
  assert.equal(lib.isTriggerStoreEnabled("trophy"), true);
  assert.equal(lib.isTriggerStoreEnabled("marathon-pine"), false);
  assert.equal(lib.isTriggerStoreEnabled("hub2"), false);
  assert.equal(lib.isTriggerStoreEnabled("central"), false);
  assert.equal(lib.isTriggerStoreEnabled(undefined), false);
});

// ── size-key mirror (contract examples from src/utils/sizeKey.js tests) ──────
test("stockSizeKey mirror matches the cross-app cell contract", () => {
  assert.equal(lib.stockSizeKey("M"), "M");
  assert.equal(lib.stockSizeKey("5.5"), "5_5");
  assert.equal(lib.stockSizeKey(5.5), "5_5");
  assert.equal(lib.stockSizeKey(null), "_");
  assert.equal(lib.stockSizeKey(""), "_");
  assert.equal(lib.stockSizeKey("ONE SIZE"), "ONE_SIZE");
});

// ── clothing classifier mirror ───────────────────────────────────────────────
test("classifier: explicit productType wins; size heuristic covers legacy", () => {
  assert.equal(lib.isClothingSale({ productType: "clothing" }, "9"), true);
  assert.equal(lib.isClothingSale({ productType: "sneaker" }, "M"), false);
  assert.equal(lib.isClothingSale(null, "M"), true);       // heuristic
  assert.equal(lib.isClothingSale(null, "xxl"), true);     // case-insensitive
  assert.equal(lib.isClothingSale(null, "9"), false);      // numeric → sneaker
  // Known inherited bound: no productType + size outside S..XXXL → not clothing
  assert.equal(lib.isClothingSale(null, "4XL"), false);
  assert.equal(lib.isClothingSale({ productType: "clothing" }, "4XL"), true);
});

// ── SA anchors ───────────────────────────────────────────────────────────────
test("saDateStringFromMs: UTC+2 day slice (mirror of functions/index.js:562)", () => {
  // 2026-07-15T22:00Z is midnight SA on the 16th
  assert.equal(lib.saDateStringFromMs(Date.parse("2026-07-15T22:00:00.000Z")), "2026-07-16");
  assert.equal(lib.saDateStringFromMs(Date.parse("2026-07-15T21:59:59.999Z")), "2026-07-15");
  assert.equal(lib.saMonthOfDate("2026-07-16"), "2026-07");
});

test("weekdayOfSaDate: 2026-07-16 is a Thursday", () => {
  assert.equal(lib.weekdayOfSaDate("2026-07-16"), "thu");
  assert.equal(lib.weekdayOfSaDate("2026-07-19"), "sun");
});

// ── dedupe key ───────────────────────────────────────────────────────────────
test("dedupeKey: productId + encoded size, no colour dimension", () => {
  assert.equal(lib.dedupeKey("p123", "M"), "p123__M");
  assert.equal(lib.dedupeKey("p123", "5.5"), "p123__5_5");
  assert.equal(lib.dedupeKey("p123", null), "p123___");
});

// ── resolution order ─────────────────────────────────────────────────────────
const KEY = "p1__M";
// resolveSale now takes the SINGLE active record for the SKU (O(1) keyed get on
// /displayChecks_active/{store}/{dedupeKey}) — no day-node scan.
const active = (over) => ({ dedupeKey: KEY, checkId: "c0", ...over });

test("open active record absorbs the sale (sale_bumped)", () => {
  assert.deepEqual(lib.resolveSale(active({ status: "open" }), KEY, 0),
    { kind: "bump", checkId: "c0", logType: "sale_bumped" });
});

test("held active record absorbs the sale LOUDLY (held_resale) — works ACROSS days (dateless index)", () => {
  assert.deepEqual(lib.resolveSale(active({ status: "held", heldAt: 1 }), KEY, 0),
    { kind: "bump", checkId: "c0", logType: "held_resale" });
});

test("null active record → fresh create", () => {
  assert.deepEqual(lib.resolveSale(null, KEY, 0), { kind: "create", repeat: null, overwrite: false });
});

test("a record for a DIFFERENT key is ignored (the keyed get is per-SKU)", () => {
  assert.deepEqual(lib.resolveSale(active({ dedupeKey: "p9__S", status: "held" }), KEY, 0),
    { kind: "create", repeat: null, overwrite: false });
});

test("completed tombstone → repeat_detected + OVERWRITE (archive the tombstone first)", () => {
  const r = lib.resolveSale(active({ status: "completed", result: "confirmed", completedAt: 10 * 60000 }), KEY, 22 * 60000);
  assert.equal(r.kind, "create");
  assert.equal(r.overwrite, true);
  assert.equal(r.archiveCheckId, "c0");
  assert.deepEqual(r.repeat, { repeatOf: "c0", followedResult: "confirmed", repeatWithinMinutes: 12, logType: "repeat_detected" });
});

test("completed no_stock tombstone → CONTRADICTION, not repeat (till proves the item existed)", () => {
  const r = lib.resolveSale(active({ status: "completed", result: "no_stock", completedAt: 0 }), KEY, 5 * 60000);
  assert.equal(r.repeat.logType, "contradiction_detected");
  assert.equal(r.repeat.followedResult, "no_stock");
  assert.equal(r.repeat.repeatWithinMinutes, 5);
  assert.equal(r.overwrite, true);
});

// ── WINDOW #1: feed keys on the STATUS FIELD, not "present in the active index" ─
test("isActiveCheck: held/open render; a completed tombstone NEVER renders however long it lingers", () => {
  assert.equal(lib.isActiveCheck({ status: "held" }), true);
  assert.equal(lib.isActiveCheck({ status: "open" }), true);
  assert.equal(lib.isActiveCheck({ status: "completed", completedAt: 0 }), false); // yesterday's tombstone, still keyed
  assert.equal(lib.isActiveCheck(null), false);
  assert.equal(lib.isActiveCheck({ status: "moved" }), false);
});

// ── WINDOW #2: stale completed tombstones are reapable ─────────────────────────
test("isStaleTombstone: a completed record from a PRIOR SA day is reapable; today's is not", () => {
  const TODAY = "2026-07-18";
  const yesterdayMs = Date.parse("2026-07-17T14:00:00.000Z"); // SA 2026-07-17
  const todayMs = Date.parse("2026-07-18T06:00:00.000Z");     // SA 2026-07-18
  assert.equal(lib.isStaleTombstone({ status: "completed", completedAt: yesterdayMs }, TODAY), true);
  assert.equal(lib.isStaleTombstone({ status: "completed", completedAt: todayMs }, TODAY), false);
  assert.equal(lib.isStaleTombstone({ status: "open" }, TODAY), false);           // never reap active
  assert.equal(lib.isStaleTombstone({ status: "held" }, TODAY), false);
  assert.equal(lib.isStaleTombstone({ status: "completed" }, TODAY), true);       // undated → safe to reap
});

// ── assignment resolver: cover → LOCKED roster → null ────────────────────────
const ROSTER = {
  locked: true,
  days: { thu: { uid: "u-roster", name: "Roster Person" } },
};

test("cover for today wins over the roster", () => {
  const a = lib.resolveAssignment({
    cover: { uid: "u-cover", name: "Cover Person" },
    roster: ROSTER, saDate: "2026-07-16",
  });
  assert.deepEqual(a, { uid: "u-cover", name: "Cover Person" });
});

test("locked roster assigns its weekday person", () => {
  const a = lib.resolveAssignment({ cover: null, roster: ROSTER, saDate: "2026-07-16" });
  assert.deepEqual(a, { uid: "u-roster", name: "Roster Person" });
});

test("UNLOCKED roster does not assign — drafts don't put names on records", () => {
  const a = lib.resolveAssignment({
    cover: null, roster: { ...ROSTER, locked: false }, saDate: "2026-07-16",
  });
  assert.equal(a, null);
});

test("no cover, no roster, or unassigned weekday → null (PR 11 is data, not surgery)", () => {
  assert.equal(lib.resolveAssignment({ cover: null, roster: null, saDate: "2026-07-16" }), null);
  assert.equal(lib.resolveAssignment({ cover: null, roster: ROSTER, saDate: "2026-07-19" }), null);
});

// ── processed-claim: idempotency lease (stable saDate, recoverable) ──────────
test("lease: first fire claims with frozen saDate; done → skip forever", () => {
  const now = 1_000_000;
  assert.deepEqual(
    lib.processedClaimDecision({ cur: null, nowMs: now, saDate: "2026-07-16" }),
    { at: now, saDate: "2026-07-16", done: false }
  );
  assert.equal(
    lib.processedClaimDecision({ cur: { at: 1, saDate: "2026-07-16", done: true }, nowMs: now, saDate: "2026-07-17" }),
    undefined
  );
});

test("lease: fresh in-flight claim → skip (concurrent execution holds it)", () => {
  const now = 1_000_000;
  assert.equal(
    lib.processedClaimDecision({
      cur: { at: now - 5_000, saDate: "2026-07-16", done: false }, nowMs: now, saDate: "2026-07-16",
    }),
    undefined
  );
});

test("lease: failure-after-claim is retryable — stale lease steals, movement not dropped", () => {
  const now = 10_000_000;
  const stale = { at: now - lib.PROCESS_LEASE_MS - 1, saDate: "2026-07-16", done: false };
  assert.deepEqual(
    lib.processedClaimDecision({ cur: stale, nowMs: now, saDate: "2026-07-17" }),
    { at: now, saDate: "2026-07-16", done: false }
  );
});

test("lease: retry ACROSS MIDNIGHT keeps the FIRST claim's saDate (day node stays stable)", () => {
  const now = 10_000_000;
  const stale = { at: now - lib.PROCESS_LEASE_MS - 1, saDate: "2026-07-16", done: false };
  const stolen = lib.processedClaimDecision({ cur: stale, nowMs: now, saDate: "2026-07-17" });
  assert.equal(stolen.saDate, "2026-07-16"); // NOT the new day
  // malformed record without saDate falls back to the caller's current day
  const malformed = { at: now - lib.PROCESS_LEASE_MS - 1, done: false };
  assert.equal(lib.processedClaimDecision({ cur: malformed, nowMs: now, saDate: "2026-07-17" }).saDate, "2026-07-17");
});

// ── bump transaction body: atomic status validation + monotonic lastSoldAt ───
test("bumpTxn: bumps open and held; adds units; keeps lastSoldAt monotonic", () => {
  const open = { status: "open", saleCount: 3, lastSoldAt: "2026-07-16T10:00:00.000Z" };
  const next = lib.bumpTxn(open, { qty: 2, movementTs: "2026-07-16T11:00:00.000Z" });
  assert.equal(next.saleCount, 5);
  assert.equal(next.lastSoldAt, "2026-07-16T11:00:00.000Z");
  // an OLDER ts must not regress lastSoldAt (out-of-order executions)
  const regressed = lib.bumpTxn(next, { qty: 1, movementTs: "2026-07-16T09:00:00.000Z" });
  assert.equal(regressed.lastSoldAt, "2026-07-16T11:00:00.000Z");
  // a null ts must not clear it
  assert.equal(lib.bumpTxn(next, { qty: 1, movementTs: null }).lastSoldAt, "2026-07-16T11:00:00.000Z");
});

test("bumpTxn: aborts on completed (immutable), absent, and PARTIAL (no status) nodes", () => {
  assert.equal(lib.bumpTxn({ status: "completed", saleCount: 1 }, { qty: 1, movementTs: null }), undefined);
  assert.equal(lib.bumpTxn(null, { qty: 1, movementTs: null }), undefined);
  assert.equal(lib.bumpTxn({ saleCount: 1 }, { qty: 1, movementTs: null }), undefined); // winner mid-publish
});

test("bumpTxn: MOVEMENT FENCE — a lease-reclaimed replay is a committed no-op, never a double count", () => {
  const open = { status: "open", saleCount: 2, appliedMovements: { mvA: true } };
  // replay of an already-absorbed movement → unchanged node (commit, no bump)
  assert.deepEqual(lib.bumpTxn(open, { qty: 2, movementTs: null, movementId: "mvA" }), open);
  // a NEW movement bumps and joins the fence
  const next = lib.bumpTxn(open, { qty: 3, movementTs: null, movementId: "mvB" });
  assert.equal(next.saleCount, 5);
  assert.deepEqual(next.appliedMovements, { mvA: true, mvB: true });
});

// ── new-check body ───────────────────────────────────────────────────────────
const BASE = {
  productId: "p1", product: { name: "Nike Tee", photoUrl: "https://x/p.jpg", productType: "clothing" },
  rawSize: "M", key: "p1__M", movementId: "mv1", saleId: "s1",
  movementTs: "2026-07-16T10:00:00.000Z", qty: 2, assignedTo: null, repeat: null, nowMs: 1000,
};

test("open check: activatedAt + frozen assignment slot; units not events", () => {
  const c = lib.buildNewCheck({ ...BASE, status: "open", assignedTo: { uid: "u1", name: "A" } });
  assert.equal(c.status, "open");
  assert.equal(c.saleCount, 2);                 // qty-2 cell = 2 units
  // fence seeded with the creating movement — a reclaimed replay no-ops
  assert.deepEqual(c.appliedMovements, { mv1: true });
  assert.equal(c.activatedAt, 1000);
  assert.deepEqual(c.assignedTo, { uid: "u1", name: "A" });
  assert.equal(c.heldAt, undefined);
  assert.equal(c.result, null);
  assert.equal(c.triggerMovementId, "mv1");
  assert.equal(c.firstSoldAt, "2026-07-16T10:00:00.000Z");
});

test("held check: heldAt, no assignment, no activation", () => {
  const c = lib.buildNewCheck({ ...BASE, status: "held" });
  assert.equal(c.heldAt, 1000);
  assert.equal(c.activatedAt, undefined);
  assert.equal(c.assignedTo, undefined);
});

test("repeat fields ride the new check verbatim", () => {
  const repeat = { repeatOf: "c9", followedResult: "no_stock", repeatWithinMinutes: 7, logType: "contradiction_detected" };
  const c = lib.buildNewCheck({ ...BASE, status: "open", repeat });
  assert.equal(c.repeatOf, "c9");
  assert.equal(c.followedResult, "no_stock");
  assert.equal(c.repeatWithinMinutes, 7);
  assert.equal(c.logType, undefined);           // log type is an event, not a check field
});

test("one-size sale: display size falls back to the sentinel, photoUrl carried", () => {
  const c = lib.buildNewCheck({ ...BASE, rawSize: null, key: "p1___", status: "open" });
  assert.equal(c.size, "_");
  assert.equal(c.sizeKey, "_");
  assert.equal(c.photoUrl, "https://x/p.jpg");  // full-size — thumbnail TODO in lib.cjs
});
// ── wake sweep: pure transition decision ─────────────────────────────────────
const HELD = (over = {}) => ({ status: "held", productId: "p1", size: "M", sizeKey: "M", ...over });
const D = 20 * 60000; // 20-min grace

test("wakeTransition: non-held check is always a no-op (idempotent guard)", () => {
  assert.equal(lib.wakeTransition({ status: "open" }, { qty: 5, nowMs: 0, delayMs: D }), null);
  assert.equal(lib.wakeTransition({ status: "completed" }, { qty: 5, nowMs: 0, delayMs: D }), null);
  assert.equal(lib.wakeTransition(null, { qty: 5, nowMs: 0, delayMs: D }), null);
});

test("wakeTransition: held + no stock + not seen → wait (null)", () => {
  assert.equal(lib.wakeTransition(HELD(), { qty: 0, nowMs: 0, delayMs: D }), null);
  assert.equal(lib.wakeTransition(HELD(), { qty: NaN, nowMs: 0, delayMs: D }), null);
});

test("wakeTransition: held + stock appears + not seen → stock_seen", () => {
  assert.deepEqual(lib.wakeTransition(HELD(), { qty: 3, nowMs: 100, delayMs: D }), { action: "stock_seen" });
});

test("wakeTransition: seen + stock + inside grace → null; at/after grace → activate", () => {
  const seenAt = 1_000_000;
  const c = HELD({ stockSeenAt: seenAt });
  assert.equal(lib.wakeTransition(c, { qty: 2, nowMs: seenAt + D - 1, delayMs: D }), null);
  assert.deepEqual(lib.wakeTransition(c, { qty: 2, nowMs: seenAt + D, delayMs: D }), { action: "activate" });
});

test("wakeTransition: seen + stock GONE → re_held carrying the cleared stockSeenAt", () => {
  const c = HELD({ stockSeenAt: 555 });
  assert.deepEqual(lib.wakeTransition(c, { qty: 0, nowMs: 9_999_999, delayMs: D }),
    { action: "re_held", clearedStockSeenAt: 555 });
});

test("wakeDelayMs: default 20 when config absent/invalid/BLANK; honours a valid value incl. 0", () => {
  assert.equal(lib.wakeDelayMs(null), 20 * 60000);
  assert.equal(lib.wakeDelayMs({}), 20 * 60000);
  // Blank values must NOT collapse the grace window to zero (CodeRabbit #243):
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: null }), 20 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: "" }), 20 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: "   " }), 20 * 60000); // whitespace-only (Codex)
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: true }), 20 * 60000);  // non-numeric type
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: undefined }), 20 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: " 30 " }), 30 * 60000); // trimmed numeric string
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: "x" }), 20 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: -5 }), 20 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: 30 }), 30 * 60000);
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: "45" }), 45 * 60000); // numeric string honoured
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: 0 }), 0);             // explicit 0 honoured
  assert.equal(lib.wakeDelayMs({ wakeDelayMinutes: Number.MAX_VALUE }), 20 * 60000); // overflow → default (CodeRabbit)
});

test("applyWakeTransition activate: a stale assignedTo on the held record is CLEARED when it reopens unassigned (CodeRabbit)", () => {
  const seenAt = 1_000;
  const stale = { status: "held", stockSeenAt: seenAt, assignedTo: { uid: "ghost", name: "Ghost" } };
  const next = lib.applyWakeTransition(stale, "activate", { nowMs: seenAt + D, delayMs: D, assignedTo: null, activatedSaDate: "2026-07-16" });
  assert.equal(next.assignedTo, null); // not the ghost — reopened unassigned
});

// ── applyWakeTransition: the in-transaction re-validation (concurrency guard) ─
test("applyWakeTransition stock_seen: sets both fields atomically; aborts if already seen or moved", () => {
  const held = { status: "held", productId: "p1" };
  assert.deepEqual(
    lib.applyWakeTransition(held, "stock_seen", { nowMs: 100, delayMs: D }),
    { status: "held", productId: "p1", stockSeenAt: 100, wakeAt: 100 + D }
  );
  // a concurrent sweep already claimed stockSeenAt → abort
  assert.equal(lib.applyWakeTransition({ ...held, stockSeenAt: 50 }, "stock_seen", { nowMs: 100, delayMs: D }), undefined);
  // completed/open under us → abort
  assert.equal(lib.applyWakeTransition({ status: "open" }, "stock_seen", { nowMs: 100, delayMs: D }), undefined);
});

test("applyWakeTransition activate: flips atomically; aborts if not ready or already flipped", () => {
  const seenAt = 1_000_000;
  const c = { status: "held", stockSeenAt: seenAt };
  const next = lib.applyWakeTransition(c, "activate", { nowMs: seenAt + D, delayMs: D, assignedTo: { uid: "u", name: "N" } });
  assert.equal(next.status, "open");
  assert.equal(next.activatedAt, seenAt + D);
  assert.deepEqual(next.assignedTo, { uid: "u", name: "N" });
  // not ready yet → abort
  assert.equal(lib.applyWakeTransition(c, "activate", { nowMs: seenAt + D - 1, delayMs: D }), undefined);
  // grace cleared under us (re_held raced) → abort
  assert.equal(lib.applyWakeTransition({ status: "held" }, "activate", { nowMs: seenAt + D, delayMs: D }), undefined);
  // already open (another sweep won) → abort
  assert.equal(lib.applyWakeTransition({ status: "open", stockSeenAt: seenAt }, "activate", { nowMs: seenAt + D, delayMs: D }), undefined);
  // null assignedTo → field omitted, not written as null
  const un = lib.applyWakeTransition(c, "activate", { nowMs: seenAt + D, delayMs: D, assignedTo: null });
  assert.equal("assignedTo" in un, false);
});

test("applyWakeTransition re_held: clears both fields; aborts if already cleared or moved", () => {
  const c = { status: "held", stockSeenAt: 555, wakeAt: 555 + D, saleCount: 2 };
  const next = lib.applyWakeTransition(c, "re_held", { nowMs: 0, delayMs: D });
  assert.equal("stockSeenAt" in next, false);
  assert.equal("wakeAt" in next, false);
  assert.equal(next.saleCount, 2);          // other fields preserved
  // already cleared → abort (idempotent)
  assert.equal(lib.applyWakeTransition({ status: "held" }, "re_held", { nowMs: 0, delayMs: D }), undefined);
  // activated under us → abort
  assert.equal(lib.applyWakeTransition({ status: "open", stockSeenAt: 555 }, "re_held", { nowMs: 0, delayMs: D }), undefined);
});

test("applyWakeTransition re_held FENCES on the observed stockSeenAt (Codex P2)", () => {
  // A delayed no-stock decision observed stockSeenAt=555; by commit time a newer
  // grace (999) is running. Must NOT cancel it.
  assert.equal(
    lib.applyWakeTransition({ status: "held", stockSeenAt: 999 }, "re_held", { nowMs: 0, delayMs: D, clearedStockSeenAt: 555 }),
    undefined
  );
  // Same observed timestamp still present → clears it.
  const next = lib.applyWakeTransition({ status: "held", stockSeenAt: 555 }, "re_held", { nowMs: 0, delayMs: D, clearedStockSeenAt: 555 });
  assert.equal("stockSeenAt" in next, false);
});
