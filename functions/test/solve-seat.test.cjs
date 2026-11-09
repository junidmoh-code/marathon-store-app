// Hub 1 and Hub 2 never share a sneaker, across separate Solves too
// (Junid, 9 Nov 2026). Drives the real enforce function over a small in-memory
// RTDB: transaction undefined aborts, and an empty node ceases to exist.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { enforceMarathonSolveSeat } = require("../lib/solve-seat.cjs");
const rs = require("../lib/request-source.cjs");
const { marathonHubSeated, otherMarathonHub, marathonSolveRefusal } = require("../lib/concrete-division.cjs");

function makeDb(seed = {}) {
  const root = JSON.parse(JSON.stringify(seed));
  const reads = [];
  const parts = (p) => String(p).split("/").filter(Boolean);
  const get = (p) => parts(p).reduce((n, k) => (n == null ? undefined : n[k]), root) ?? null;
  const set = (p, v) => {
    const keys = parts(p); const leaf = keys.pop(); let n = root;
    for (const k of keys) n = n[k] ?? (n[k] = {});
    if (v === null) delete n[leaf]; else n[leaf] = JSON.parse(JSON.stringify(v));
  };
  return {
    root, reads,
    ref: (p) => ({
      once: async () => { reads.push(p); return { val: () => get(p) }; },
      set: async (v) => set(p, v),
      transaction: async (fn) => {
        const r = fn(get(p));
        if (r === undefined) return { committed: false, snapshot: { val: () => get(p) } };
        set(p, r);
        return { committed: true, snapshot: { val: () => get(p) } };
      },
    }),
  };
}
const row = (over = {}) => ({ productId: "p", size: "8", qty: 1, requestingLocation: "hub1", status: "open", requestSource: "solve", createdFrom: { via: "missing_sneakers", manual: true }, ...over });
const run = (db, id, rr) => enforceMarathonSolveSeat({ db, id, rr, nowIso: "2026-11-09T10:00:00.000Z" });

test("a Hub 1 Solve is cancelled while Hub 2 holds a cell, sold out included; logged for Junid", async () => {
  const db = makeDb({ stock: { hub2: { p: { 8: { qty: 0 } } } }, refill_requests: { r1: row() } });
  const res = await run(db, "r1", row());
  assert.deepEqual([res.refused, res.cancelled], [true, true]);
  assert.equal(db.root.refill_requests.r1.status, "cancelled");
  assert.equal(db.root.refill_requests.r1.cancelReason, rs.SEAT_REJECT_REASON);
  assert.equal(db.root.refill_engine.rejectedRequests.r1.reason, rs.SEAT_REJECT_REASON);
});

test("the reverse: a Hub 2 Solve while Hub 1 holds it", async () => {
  const rr = row({ requestingLocation: "hub2" });
  const db = makeDb({ stock: { hub1: { p: { 8: { qty: 3 } } } }, refill_requests: { r1: rr } });
  assert.equal((await run(db, "r1", rr)).refused, true);
});

test("a switched-off cell (target 0 row) is not a seat; a positive target row with no cell is", async () => {
  let db = makeDb({ stock: { hub2: { p: { 8: { qty: 0 } } } }, stock_targets: { hub2: { p: { 8: { target: 0 } } } }, refill_requests: { r1: row() } });
  assert.equal((await run(db, "r1", row())).refused, false);
  db = makeDb({ stock_targets: { hub2: { p: { 8: { target: 2 } } } }, refill_requests: { r1: row() } });
  assert.equal((await run(db, "r1", row())).refused, true);
});

test("across separate Solves: a Solve still open at Hub 2 refuses the Hub 1 Solve that follows", async () => {
  const h2 = row({ requestingLocation: "hub2" });
  const db = makeDb({ refill_requests: { a: h2, b: row() } });
  assert.equal((await run(db, "a", h2)).refused, false);
  assert.equal(db.root.refill_engine.solveSeats.p.hub, "hub2");
  assert.equal((await run(db, "b", row())).refused, true);
  assert.equal(db.root.refill_requests.b.status, "cancelled");
  assert.equal(db.root.refill_requests.a.status, "open");
});

test("the same hub's second size joins the claim; a claim whose requests are gone is taken over", async () => {
  const h2 = row({ requestingLocation: "hub2" });
  const db = makeDb({ refill_requests: { a: h2, c: h2, b: row() } });
  await run(db, "a", h2);
  assert.equal((await run(db, "c", h2)).refused, false);
  assert.deepEqual(Object.keys(db.root.refill_engine.solveSeats.p.requests).sort(), ["a", "c"]);
  // Both Hub 2 lines are cancelled in the queue: the claim no longer speaks.
  db.root.refill_requests.a.status = "cancelled";
  db.root.refill_requests.c.status = "cancelled";
  assert.equal((await run(db, "b", row())).refused, false);
  assert.equal(db.root.refill_engine.solveSeats.p.hub, "hub1");
});

test("a claim line that is still open keeps the claim, and an id the run never read keeps it too", () => {
  const cur = { hub: "hub2", requests: { a: true, c: true } };
  assert.equal(rs.claimSolveSeat(cur, { hub: "hub1", id: "b", nowIso: "t", staleIds: ["a"] }), undefined);
  assert.ok(rs.claimSolveSeat(cur, { hub: "hub1", id: "b", nowIso: "t", staleIds: ["a", "c"] }));
});

test("a person's send always wins: a line already moving is left alone, only logged", async () => {
  const rr = row({ sentQty: 1 });
  const db = makeDb({ stock: { hub2: { p: { 8: { qty: 1 } } } }, refill_requests: { r1: rr } });
  const res = await run(db, "r1", rr);
  assert.deepEqual([res.refused, res.cancelled], [true, false]);
  assert.equal(db.root.refill_requests.r1.status, "open");
});

test("only a sneaker Solve at Hub 1 or Hub 2 is read at all", async () => {
  const db = makeDb({ refill_requests: {} });
  for (const rr of [
    row({ requestingLocation: "hub3" }),
    row({ createdFrom: { via: "missing_products_solve" } }),
    row({ requestSource: "scan", createdFrom: { engine: true } }),
    row({ productId: "" }),
  ]) assert.equal((await run(db, "x", rr)).checked, false);
  assert.equal(db.reads.length, 0);
});

test("the reads are keyed to one product, never a whole node", async () => {
  const db = makeDb({ refill_requests: { r1: row() } });
  await run(db, "r1", row());
  assert.deepEqual(db.reads.sort(), ["refill_engine/solveSeats/p", "stock/hub2/p", "stock_targets/hub2/p"]);
});

test("the seat test itself", () => {
  assert.equal(marathonHubSeated({}), false);
  assert.equal(marathonHubSeated({ cells: {} }), false);
  assert.equal(marathonHubSeated({ cells: { 8: { qty: 0 } } }), true);
  assert.equal(marathonHubSeated({ cells: { 8: { qty: 0 }, 9: { qty: 0 } }, rows: { 8: { target: 0 } } }), true);   // size 9 still seated
  assert.equal(marathonHubSeated({ cells: { 8: null } }), false);
  assert.equal(marathonHubSeated({ openRequest: true }), true);
  assert.deepEqual([otherMarathonHub("hub1"), otherMarathonHub("hub2"), otherMarathonHub("hub3")], ["hub2", "hub1", null]);
  assert.match(marathonSolveRefusal("hub1"), /seated at Hub 2.*solved to Hub 1/);
  assert.match(marathonSolveRefusal("hub2"), /seated at Hub 1.*solved to Hub 2/);
});
