// ─── applyMovementAdmin admits "return" (exchange returns, 2026-10-30) ─────────
// Run: cd functions && node --test test/admin-movement-return.test.cjs
//
// Junid, 29 Oct 2026: the returned items of an exchange go back into stock at
// Marathon PE as a movement marked "exchange return #<order>", "not a manual
// adjustment with no reason" (scripts/shipping/exchangeReturn.mjs). The type is
// the ledger's own `return +to`; these pin the server writer's half of it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");

const nowIso = "2026-10-30T16:00:00.000Z";
const base = { type: "return", productId: "p1", size: "8.5", qty: 1, to: "marathon-pe", reason: "exchange return #1793", movementId: "exret_x_p1_8_5_0", actor: "system:test" };

test("a return credits ONE cell (to) and writes the ledger row with its reason", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p1: { "8_5": { qty: 2, v: 4, mv: "seed", lastType: "sold" } } } } });
  const r = await applyMovementAdmin(db, base, { nowIso });
  assert.equal(r.ok, true);
  assert.equal(readAt(db.state.root, "stock/marathon-pe/p1/8_5/qty"), 3);
  assert.equal(readAt(db.state.root, "stock/marathon-pe/p1/8_5/lastType"), "return");
  const mv = readAt(db.state.root, "stock_movements/exret_x_p1_8_5_0");
  assert.deepEqual([mv.type, mv.reason, mv.before, mv.after], ["return", "exchange return #1793", { "marathon-pe": 2 }, { "marathon-pe": 3 }]);
});

test("the same id twice is one unit", async () => {
  const db = makeFakeDb({});
  await applyMovementAdmin(db, base, { nowIso });
  const again = await applyMovementAdmin(db, base, { nowIso });
  assert.equal(again.idempotent, true);
  assert.equal(readAt(db.state.root, "stock/marathon-pe/p1/8_5/qty"), 1);
});

test("a return needs a reason and a destination, and never debits", async () => {
  const db = makeFakeDb({});
  assert.equal((await applyMovementAdmin(db, { ...base, reason: " " }, { nowIso })).reason, "return_requires_reason");
  assert.equal((await applyMovementAdmin(db, { ...base, to: null }, { nowIso })).reason, "missing_location");
  assert.equal((await applyMovementAdmin(db, { ...base, from: "hub2" }, { nowIso })).reason, "missing_location");
  assert.equal(readAt(db.state.root, "stock"), null);
});

test("a negative cell is credited from zero, the debt recorded (the client's rule)", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p1: { "8_5": { qty: -1, v: 1, mv: "s", lastType: "sold" } } } } });
  await applyMovementAdmin(db, base, { nowIso });
  assert.equal(readAt(db.state.root, "stock/marathon-pe/p1/8_5/qty"), 1);
  assert.deepEqual(readAt(db.state.root, "stock_movements/exret_x_p1_8_5_0/negativeCleared"), { "marathon-pe": -1 });
});
