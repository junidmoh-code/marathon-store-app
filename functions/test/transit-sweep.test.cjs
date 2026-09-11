// ─── strandedTransitSweep — a parked unit lands on its own ───────────────────
// Against the fake RTDB (deletes empties like the real one). Pins:
//   • a held line past its window is released without a tap (switch on, +24h);
//   • with the switch OFF every held line is released at the next run;
//   • inside the grace window the line is pending and untouched;
//   • archived-but-not-moved (the 4 Sep Hub 2 shape) is completed under the
//     tap's own movement id, so a tap that DID land is a no-op;
//   • an orphan cell (movement, no line) is released after an hour;
//   • a deleted product is REFUSED and reported, never credited;
//   • a manual transit-lane parking (no holdDest) is not touched;
//   • the release credits from zero on a negative hub cell (negative base);
//   • the archive is only written when the ledger row is really there.
//
// Run: cd functions && node --test test/transit-sweep.test.cjs
// Mutation-proved in scripts/mutation-proof-fulfil-credit-gap.mjs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { _runSweep } = require("../strandedTransitSweep.cjs");
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");
const { RELEASE_GRACE_MS, ORPHAN_MIN_AGE_MS } = require("../lib/transit-sweep.cjs");

const H = 3600000;
// 2026-09-04_1400 SA = 2026-09-04T12:00Z
const WINDOW_MS = Date.parse("2026-09-04T12:00:00.000Z");
const PARKED = "2026-09-04T08:09:39.657Z";

const parking = (pid, size, dest, qty = 1) => ({
  type: "transfer_out", productId: pid, size, qty, from: "central", to: "in_transit",
  before: { central: 1, in_transit: 0 }, after: { central: 0, in_transit: qty },
  actor: "staff", ts: PARKED, appliedAt: PARKED, reason: `${dest}_auto_refill`,
  link: { refillId: `req_${pid}_${size}`, holdDest: dest },
});
const heldLine = (pid, size, dest, shipmentId = "2026-09-04_1400", qty = 1) => ({
  productId: pid, productName: pid, size, sizeKey: size, qty, dest, shipmentId, windowLabel: "14:00",
  refillId: `req_${pid}_${size}`, movementId: `rrf_req_${pid}_${size}`, heldAt: PARKED, heldBy: "staff",
});

function world({ config = { enabled: true }, held = {}, released = {}, products = {}, hub2 = {}, extraMovements = {} } = {}) {
  return makeFakeDb({
    products,
    settings: { stockHold: { config, held, released } },
    stock: {
      in_transit: { nb: { 7: { qty: 1, v: 0, mv: "rrf_req_nb_7", lastType: "transfer_out", updatedAt: PARKED } } },
      hub2,
    },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2"), ...extraMovements },
  });
}
const cell = (db, loc, pid, sk) => db.ref(`stock/${loc}/${pid}/${sk}`).once("value").then((s) => s.val());
const val = (db, p) => db.ref(p).once("value").then((s) => s.val());

test("held line, switch ON, window +24h past → released automatically, archived, held line gone", async () => {
  const db = world({ products: { nb: { id: "nb", name: "NB" } }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } });
  const out = await _runSweep(db, WINDOW_MS + RELEASE_GRACE_MS + H);
  assert.equal(out.released, 1);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 0);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  const rel = await val(db, "stock_movements/rel_rrf_req_nb_7");
  assert.equal(rel.type, "transfer_in"); assert.equal(rel.to, "hub2"); assert.equal(rel.link.autoReleased, true);
  assert.equal(await val(db, "settings/stockHold/held"), null);
  const arch = await val(db, "settings/stockHold/released/hub2/2026-09-04_1400/rrf_req_nb_7");
  assert.equal(arch.releaseMovementId, "rel_rrf_req_nb_7"); assert.equal(arch.autoReleased, true);
  assert.equal((await val(db, "stock_exceptions/strandedTransit")).released, 1);
});

test("held line, switch ON, inside the grace window → pending, nothing moves", async () => {
  const db = world({ products: { nb: { id: "nb" } }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 0);
  assert.equal(out.pending.length, 1);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 1);
  assert.equal(await val(db, "stock_movements/rel_rrf_req_nb_7"), null);
});

test("held line, switch OFF → NOT before the window (the box has not left), released as soon as it passes", async () => {
  const db = world({ config: { enabled: false }, products: { nb: { id: "nb" } }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } });
  const early = await _runSweep(db, WINDOW_MS - 3 * H);
  assert.equal(early.released, 0);
  assert.match(early.pending[0].why, /not left yet/);
  assert.equal(await val(db, "stock/hub2"), null);
  const out = await _runSweep(db, WINDOW_MS + 60000);
  assert.equal(out.released, 1);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
});

test("a line a human marked NOT ARRIVED waits for the shipment it was carried to", async () => {
  const carried = { ...heldLine("nb", "7", "hub2", "2026-09-05_0600"), carriedFrom: "2026-09-04_1400", notArrivedAt: "2026-09-04T12:30:00.000Z" };
  const db = world({ config: { enabled: false }, products: { nb: { id: "nb" } }, held: { hub2: { rrf_req_nb_7: carried } } });
  const out = await _runSweep(db, WINDOW_MS + 5 * H);          // old window long past, new one not yet
  assert.equal(out.released, 0);
  assert.equal(out.pending.length, 1);
  const later = await _runSweep(db, Date.parse("2026-09-05T04:00:00.000Z") + 60000);
  assert.equal(later.released, 1);
});

test("a HELD line whose release movement is already in the ledger is RETIRED — archived, nothing moved", async () => {
  const relRow = { type: "transfer_in", productId: "nb", size: "7", qty: 1, from: "in_transit", to: "hub2", before: { in_transit: 1, hub2: 0 }, after: { in_transit: 0, hub2: 1 }, actor: "owner", ts: PARKED, appliedAt: PARKED, reason: "stock_hold_release", link: {} };
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } } },
    stock: { in_transit: { nb: { 7: { qty: 0, v: 1, mv: "rel_rrf_req_nb_7", lastType: "transfer_in" } } }, hub2: { nb: { 7: { qty: 1, v: 1, mv: "rel_rrf_req_nb_7", lastType: "transfer_in" } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2"), rel_rrf_req_nb_7: relRow },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 0);
  assert.equal(out.retired, 1);
  assert.equal(await val(db, "settings/stockHold/held"), null);
  assert.equal((await val(db, "settings/stockHold/released/hub2/2026-09-04_1400/rrf_req_nb_7")).retiredBookkeeping, true);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);   // untouched
});

test("one cell, two lines, only ONE unit parked → the first is released, the second is refused as phantom (never overdrawn)", async () => {
  const a = heldLine("nb", "7", "hub2"); const b = { ...heldLine("nb", "7", "hub2"), refillId: "req_b", movementId: "rrf_req_b" };
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: a, rrf_req_b: b } } } },
    stock: { in_transit: { nb: { 7: { qty: 1, v: 0, mv: "rrf_req_b", lastType: "transfer_out", updatedAt: PARKED } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2"), rrf_req_b: parking("nb", "7", "hub2") },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 1);
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].why, /phantom line/);
  assert.equal(out.failures.length, 0);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 0);
});

test("a one-size line (size 'Free Size', cell '_') is released from the '_' cell — never a phantom 'Free_Size' cell", async () => {
  const line = { ...heldLine("hat", "Free Size", "hub2"), sizeKey: "_", movementId: "rrf_req_hat" };
  const db = makeFakeDb({
    products: { hat: { id: "hat" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_hat: line } } } },
    stock: { in_transit: { hat: { _: { qty: 1, v: 0, mv: "rrf_req_hat", lastType: "transfer_out", updatedAt: PARKED } } } },
    stock_movements: { rrf_req_hat: { ...parking("hat", "Free Size", "hub2"), link: { refillId: "req_hat", holdDest: "hub2" } } },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 1);
  assert.equal((await cell(db, "hub2", "hat", "_")).qty, 1);
  assert.equal(await val(db, "stock/hub2/hat/Free_Size"), null);
  assert.equal(await val(db, "stock/in_transit/hat/Free_Size"), null);
});

test("a malformed held line (no productId) is reported, and the run's summary still lands", async () => {
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2"), broken: { size: "7", qty: 1, shipmentId: "2026-09-04_1400" } } } } },
    stock: { in_transit: { nb: { 7: { qty: 1, v: 0, mv: "rrf_req_nb_7", lastType: "transfer_out", updatedAt: PARKED } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2") },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 1);
  assert.ok(await val(db, "stock_exceptions/strandedTransit"));
});

test("a crash between the two legs is completed on the next run — never a double credit, honest before/after", async () => {
  // Simulate: the in_transit leg landed (stamped relMv), the hub leg and the ledger row did not.
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } } },
    stock: { in_transit: { nb: { 7: { qty: 0, v: 1, mv: "rel_rrf_req_nb_7", relMv: "rel_rrf_req_nb_7", relBefore: 1, lastType: "transfer_in", updatedAt: PARKED } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2") },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 1);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 0);          // not debited twice
  assert.deepEqual((await val(db, "stock_movements/rel_rrf_req_nb_7")).before, { in_transit: 1, hub2: 0 });
  const again = await _runSweep(db, WINDOW_MS + 2 * H);
  assert.equal(again.released, 0);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
});

test("a POS sale landing on the hub cell while the sweep runs is never overwritten — the credit composes on the sold value", async () => {
  let sold = false;
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } } },
    stock: { in_transit: { nb: { 7: { qty: 1, v: 0, mv: "rrf_req_nb_7", lastType: "transfer_out", updatedAt: PARKED } } }, hub2: { nb: { 7: { qty: 3, v: 4, mv: "x", lastType: "received" } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2") },
  }, {
    // the sale lands after planning, right before the hub cell's transaction reads it
    beforeRead: async (path, state) => {
      if (!sold && path === "stock/hub2/nb/7") { sold = true; state.root.stock.hub2.nb[7] = { qty: 2, v: 5, mv: "sold:s1", lastType: "sold" }; }
    },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 1);
  const hub = await cell(db, "hub2", "nb", "7");
  assert.equal(hub.qty, 3);      // 2 (after the sale) + 1, not 3 + 1 from the stale read
  assert.equal(hub.v, 6);
  assert.deepEqual((await val(db, "stock_movements/rel_rrf_req_nb_7")).before, { in_transit: 1, hub2: 2 });
});

test("archived as released with NO movement (the 4 Sep shape) → completed under the tap's id; a landed tap is a no-op", async () => {
  const archived = { ...heldLine("nb", "7", "hub2"), releasedAt: "2026-09-04T11:51:02.888Z", releasedBy: "owner", releaseMovementId: "rel_rrf_req_nb_7" };
  const db = world({ products: { nb: { id: "nb" } }, released: { hub2: { "2026-09-04_1400": { rrf_req_nb_7: archived } } } });
  const out = await _runSweep(db, WINDOW_MS + 7 * 24 * H);
  assert.equal(out.released, 1);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 0);
  const arch = await val(db, "settings/stockHold/released/hub2/2026-09-04_1400/rrf_req_nb_7");
  assert.equal(arch.releasedBy, "owner");                 // the human's archive stands
  assert.ok(arch.autoRepairedAt);
  // run again: idempotent — nothing more moves
  const again = await _runSweep(db, WINDOW_MS + 8 * 24 * H);
  assert.equal(again.released, 0);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
});

test("archived-but-unmoved line whose cell was re-parked by a NEWER line → pending, not spent on the old claim", async () => {
  const archived = { ...heldLine("nb", "7", "hub2"), releasedAt: "2026-09-04T11:51:02.888Z", releasedBy: "owner", releaseMovementId: "rel_rrf_req_nb_7" };
  const db = world({ config: { enabled: false }, products: { nb: { id: "nb" } }, released: { hub2: { "2026-09-04_1400": { rrf_req_nb_7: archived } } },
    extraMovements: { rrf_newer: { ...parking("nb", "7", "hub2"), link: { refillId: "newer", holdDest: "hub2" } } } });
  await db.ref("stock/in_transit/nb/7").set({ qty: 1, v: 1, mv: "rrf_newer", lastType: "transfer_out", updatedAt: PARKED });
  const out = await _runSweep(db, WINDOW_MS + 7 * 24 * H);
  assert.equal(out.released, 1);                          // the NEWER orphan lands (its own id)
  assert.ok(await val(db, "stock_movements/rel_rrf_newer"));
  assert.equal(await val(db, "stock_movements/rel_rrf_req_nb_7"), null);   // the old claim is not spent
  assert.ok(out.pending.some((p) => p.lineId === "rrf_req_nb_7" && /later parking/.test(p.why)));
});

test("deleted product record → REFUSED and reported; the unit stays parked, nothing is credited", async () => {
  const archived = { ...heldLine("nb", "7", "hub2"), releasedAt: "2026-09-04T11:51:02.888Z", releasedBy: "owner", releaseMovementId: "rel_rrf_req_nb_7" };
  const db = world({ products: {}, released: { hub2: { "2026-09-04_1400": { rrf_req_nb_7: archived } } } });
  const out = await _runSweep(db, WINDOW_MS + 7 * 24 * H);
  assert.equal(out.released, 0);
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].why, /product record missing/);
  assert.equal((await cell(db, "in_transit", "nb", "7")).qty, 1);
  assert.equal(await val(db, "stock/hub2"), null);
  assert.equal(await val(db, "stock_movements/rel_rrf_req_nb_7"), null);
});

test("orphan cell (parking movement, no line, no archive) → released after an hour, filed under 'unfiled'", async () => {
  const db = world({ products: { nb: { id: "nb" } } });
  const early = await _runSweep(db, Date.parse(PARKED) + ORPHAN_MIN_AGE_MS - 60000);
  assert.equal(early.released, 0); assert.equal(early.pending.length, 1);
  const late = await _runSweep(db, Date.parse(PARKED) + ORPHAN_MIN_AGE_MS + 60000);
  assert.equal(late.released, 1);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  const arch = await val(db, "settings/stockHold/released/hub2/unfiled/rrf_req_nb_7");
  assert.equal(arch.refillId, "req_nb_7");
});

test("a manual transit-lane parking (no holdDest) is not this lane's — skipped by name", async () => {
  const db = makeFakeDb({
    products: { x: { id: "x" } },
    settings: { stockHold: { config: { enabled: false } } },
    stock: { in_transit: { x: { 8: { qty: 2, v: 0, mv: "-Ozu:x:8", lastType: "transfer_out", updatedAt: PARKED } } } },
    stock_movements: { "-Ozu:x:8": { type: "transfer_out", productId: "x", size: "8", qty: 2, from: "central", to: "in_transit", actor: "s", ts: PARKED, appliedAt: PARKED, link: { transferId: "-Ozu" } } },
  });
  const out = await _runSweep(db, Date.parse(PARKED) + 48 * H);
  assert.equal(out.released, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].why, /manual transit lane/);
  assert.equal((await cell(db, "in_transit", "x", "8")).qty, 2);
});

test("the release credits from ZERO on a negative hub cell and records the cleared debt", async () => {
  const db = world({ config: { enabled: false }, products: { nb: { id: "nb" } }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } },
    hub2: { nb: { 7: { qty: -1, v: 4, mv: "sold:x", lastType: "sold" } } } });
  await _runSweep(db, WINDOW_MS + H);
  assert.equal((await cell(db, "hub2", "nb", "7")).qty, 1);
  assert.equal((await cell(db, "hub2", "nb", "7")).v, 5);
  assert.deepEqual((await val(db, "stock_movements/rel_rrf_req_nb_7")).negativeCleared, { hub2: -1 });
});

test("a phantom line (nothing parked) is REFUSED and reported — never credited, still held", async () => {
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } } },
    stock: { in_transit: { nb: { 7: { qty: 0, v: 1, mv: "x", lastType: "transfer_in" } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2") },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 0);
  assert.equal(out.refusals.length, 1);
  assert.match(out.refusals[0].why, /phantom line/);
  assert.equal(await val(db, "stock/hub2"), null);
  assert.ok(await val(db, "settings/stockHold/held/hub2/rrf_req_nb_7"));   // still held
});

test("the writer's negative floor still guards a cell drained between planning and the write", async () => {
  let drained = false;
  const db = makeFakeDb({
    products: { nb: { id: "nb" } },
    settings: { stockHold: { config: { enabled: false }, held: { hub2: { rrf_req_nb_7: heldLine("nb", "7", "hub2") } } } },
    stock: { in_transit: { nb: { 7: { qty: 1, v: 0, mv: "rrf_req_nb_7", lastType: "transfer_out", updatedAt: PARKED } } } },
    stock_movements: { rrf_req_nb_7: parking("nb", "7", "hub2") },
  }, {
    // drain the cell right before its own transaction reads it, after planning
    beforeRead: async (path, state) => {
      if (!drained && path === "stock/in_transit/nb/7") { drained = true; state.root.stock.in_transit.nb[7].qty = 0; }
    },
  });
  const out = await _runSweep(db, WINDOW_MS + H);
  assert.equal(out.released, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].reason, "insufficient_stock");
  assert.ok(await val(db, "settings/stockHold/held/hub2/rrf_req_nb_7"));
});

test("applyMovementAdmin: idempotent on the movement id, bumps v by one, atomic before/after", async () => {
  const db = makeFakeDb({ stock: { in_transit: { p: { 6: { qty: 2, v: 3, mv: "m", lastType: "transfer_out" } } } } });
  const m = { type: "transfer_in", productId: "p", size: "6", qty: 2, from: "in_transit", to: "hub1", movementId: "rel_m", actor: "system:test" };
  const a = await applyMovementAdmin(db, m, { nowIso: "2026-09-11T00:00:00.000Z" });
  assert.equal(a.ok, true);
  const b = await applyMovementAdmin(db, m, { nowIso: "2026-09-11T00:00:01.000Z" });
  assert.equal(b.idempotent, true);
  assert.equal((await cell(db, "hub1", "p", "6")).qty, 2);
  assert.equal((await cell(db, "in_transit", "p", "6")).v, 4);
  assert.deepEqual((await val(db, "stock_movements/rel_m")).before, { in_transit: 2, hub1: 0 });
  assert.equal(await val(db, "stock_movements/rel_m/negativeCleared"), null);
});
