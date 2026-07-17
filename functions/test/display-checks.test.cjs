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
const mkDay = (checks) => Object.fromEntries(checks.map((c, i) => [`c${i}`, c]));

test("open check absorbs the sale (sale_bumped)", () => {
  const day = mkDay([{ dedupeKey: KEY, status: "open" }]);
  assert.deepEqual(lib.resolveSale(day, KEY, 0), { kind: "bump", checkId: "c0", logType: "sale_bumped" });
});

test("held check absorbs the sale LOUDLY (held_resale), never creates", () => {
  const day = mkDay([{ dedupeKey: KEY, status: "held" }]);
  assert.deepEqual(lib.resolveSale(day, KEY, 0), { kind: "bump", checkId: "c0", logType: "held_resale" });
});

test("active check wins over a completed one — no repeat while a card is live", () => {
  const day = mkDay([
    { dedupeKey: KEY, status: "completed", result: "confirmed", completedAt: 100 },
    { dedupeKey: KEY, status: "open" },
  ]);
  assert.equal(lib.resolveSale(day, KEY, 200).kind, "bump");
});

test("completed confirmed → repeat_detected with interval + followedResult", () => {
  const day = mkDay([{ dedupeKey: KEY, status: "completed", result: "confirmed", completedAt: 10 * 60000 }]);
  const r = lib.resolveSale(day, KEY, 22 * 60000);
  assert.equal(r.kind, "create");
  assert.deepEqual(r.repeat, {
    repeatOf: "c0", followedResult: "confirmed",
    repeatWithinMinutes: 12, logType: "repeat_detected",
  });
});

test("completed no_stock → CONTRADICTION, not repeat (till proves the item existed)", () => {
  const day = mkDay([{ dedupeKey: KEY, status: "completed", result: "no_stock", completedAt: 0 }]);
  const r = lib.resolveSale(day, KEY, 5 * 60000);
  assert.equal(r.repeat.logType, "contradiction_detected");
  assert.equal(r.repeat.followedResult, "no_stock");
  assert.equal(r.repeat.repeatWithinMinutes, 5);
});

test("multiple completions: the LATEST result is the one followed", () => {
  const day = mkDay([
    { dedupeKey: KEY, status: "completed", result: "confirmed", completedAt: 100 },
    { dedupeKey: KEY, status: "completed", result: "no_stock", completedAt: 200 },
  ]);
  assert.equal(lib.resolveSale(day, KEY, 300).repeat.logType, "contradiction_detected");
});

test("different SKU or empty day → plain create; other keys never interfere", () => {
  assert.deepEqual(lib.resolveSale(null, KEY, 0), { kind: "create", repeat: null });
  const day = mkDay([{ dedupeKey: "p2__L", status: "open" }]);
  assert.deepEqual(lib.resolveSale(day, KEY, 0), { kind: "create", repeat: null });
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
