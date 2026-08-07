// ─── APPLY PATH for satisfied-by-stock withdrawals ────────────────────────────
// refill-satisfied.test.cjs pins the PLAN. This pins what the scan actually does
// with it, against a fake db — the half where the live re-check lives.
//
// The bug this file exists for (CodeRabbit, PR #332): the plan allocates a cell
// oldest-first across siblings, but the apply loop re-reads the LIVE cell
// independently for each closure. A naive `live >= s.qty` test re-opens the very
// hole the plan closes — two siblings each asking 2 against a cell the plan saw
// holding 4, with the live cell since dropped to 2, would BOTH pass, and the
// second would be cancelled against units the first already claimed.
const { test } = require("node:test");
const assert = require("node:assert");
const { _applySatisfied: applySatisfied } = require("../refill-scan.cjs");

const START = "2026-08-07T13:00:00.000Z";

// A fake db with exactly the two surfaces the apply path touches: a stock qty
// read and a request transaction. Records every write so the test can assert on
// what LANDED, not on what was intended.
function fakeDb({ stock = {}, requests = {}, failReadAt = null }) {
  const writes = {};
  return {
    writes,
    ref(path) {
      return {
        once: async () => {
          if (failReadAt && path.includes(failReadAt)) throw new Error("network");
          const v = path in stock ? stock[path] : null;
          return { val: () => v };
        },
        transaction: async (fn) => {
          const id = path.split("/")[1];
          // FIRST PASS AGAINST THE COLD CACHE returns null, exactly as RTDB does
          // — the #199 behaviour the callback has to survive.
          let out = fn(null);
          if (out === undefined) return { committed: false, snapshot: { val: () => requests[id] ?? null } };
          const cur = requests[id] ?? null;
          out = fn(cur);
          if (out === undefined) return { committed: false, snapshot: { val: () => cur } };
          if (out !== null) { requests[id] = out; writes[path] = out; }
          return { committed: true, snapshot: { val: () => (out === null ? null : requests[id]) } };
        },
      };
    },
  };
}

const closure = (over = {}) => ({
  refillId: "r1", dest: "hub1", pid: "boot", sizeKey: "7", size: "7",
  qty: 2, have: 3, rrStatus: "cancelled", cancelReason: "already_in_stock", ...over,
});
const openReq = () => ({ productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open" });

test("a withdrawal lands when the live cell still covers it", async () => {
  const db = fakeDb({ stock: { "stock/hub1/boot/7/qty": 3 }, requests: { r1: openReq() } });
  const r = await applySatisfied({ db, closures: [closure()], startedAt: START });
  assert.strictEqual(r.satisfied, 1);
  assert.strictEqual(r.stale, 0);
  const w = db.writes["refill_requests/r1"];
  assert.strictEqual(w.status, "cancelled");
  assert.strictEqual(w.cancelReason, "already_in_stock");
  assert.strictEqual(w.resolvedAt, START);
  assert.deepStrictEqual(w.satisfiedBy, { location: "hub1", onHand: 3, requested: 2 });
});

test("ONE UNIT SATISFIES ONE REQUEST — siblings do not both consume the same stock", async () => {
  // The plan saw 4 and allocated 2+2. The live cell has since dropped to 2.
  // Only the first may withdraw; the second must survive as real work.
  const db = fakeDb({
    stock: { "stock/hub1/boot/7/qty": 2 },
    requests: { r1: openReq(), r2: openReq() },
  });
  const r = await applySatisfied({
    db, startedAt: START,
    closures: [closure({ refillId: "r1", qty: 2, have: 4 }), closure({ refillId: "r2", qty: 2, have: 4 })],
  });
  assert.strictEqual(r.satisfied, 1, "exactly one withdrawal may land against 2 units");
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(db.writes["refill_requests/r1"].status, "cancelled");
  assert.strictEqual(db.writes["refill_requests/r2"], undefined, "the second request must be untouched");
});

test("both siblings withdraw when the live cell genuinely covers both", async () => {
  const db = fakeDb({
    stock: { "stock/hub1/boot/7/qty": 4 },
    requests: { r1: openReq(), r2: openReq() },
  });
  const r = await applySatisfied({
    db, startedAt: START,
    closures: [closure({ refillId: "r1", qty: 2 }), closure({ refillId: "r2", qty: 2 })],
  });
  assert.strictEqual(r.satisfied, 2);
  assert.strictEqual(r.stale, 0);
});

test("siblings on DIFFERENT cells never compete", async () => {
  const db = fakeDb({
    stock: { "stock/hub1/boot/7/qty": 2, "stock/hub1/boot/8/qty": 2 },
    requests: { r1: openReq(), r2: openReq() },
  });
  const r = await applySatisfied({
    db, startedAt: START,
    closures: [closure({ refillId: "r1", sizeKey: "7" }), closure({ refillId: "r2", sizeKey: "8" })],
  });
  assert.strictEqual(r.satisfied, 2, "separate cells have separate allocations");
});

test("a stale closure consumes NOTHING — a later sibling still gets real stock", async () => {
  // The first closure asks 5 against a cell holding 2, so it is stale. That must
  // not deprive the second, which asks 2 and is genuinely covered.
  const db = fakeDb({
    stock: { "stock/hub1/boot/7/qty": 2 },
    requests: { r1: openReq(), r2: openReq() },
  });
  const r = await applySatisfied({
    db, startedAt: START,
    closures: [closure({ refillId: "r1", qty: 5 }), closure({ refillId: "r2", qty: 2 })],
  });
  assert.strictEqual(r.satisfied, 1);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(db.writes["refill_requests/r2"].status, "cancelled");
});

test("the units left in the snapshot gap → no withdrawal", async () => {
  // The plan saw 3; a sale took it to 0 before the scan applied. Cancelling here
  // would be unrecoverable for a Missing Sneakers ask.
  const db = fakeDb({ stock: { "stock/hub1/boot/7/qty": 0 }, requests: { r1: openReq() } });
  const r = await applySatisfied({ db, closures: [closure()], startedAt: START });
  assert.strictEqual(r.satisfied, 0);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(db.writes["refill_requests/r1"], undefined);
});

test("a NEGATIVE live cell is zero available, never a withdrawal", async () => {
  const db = fakeDb({ stock: { "stock/hub1/boot/7/qty": -3 }, requests: { r1: openReq() } });
  const r = await applySatisfied({ db, closures: [closure({ qty: 1 })], startedAt: START });
  assert.strictEqual(r.satisfied, 0);
  assert.strictEqual(r.stale, 1);
});

test("a FAILED stock read stands down rather than guessing", async () => {
  const db = fakeDb({ stock: {}, requests: { r1: openReq() }, failReadAt: "stock/hub1" });
  const r = await applySatisfied({ db, closures: [closure()], startedAt: START });
  assert.strictEqual(r.satisfied, 0);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(db.writes["refill_requests/r1"], undefined);
});

test("a request resolved in the gap is left exactly as it is", async () => {
  // The picker fulfilled it between plan and apply. The transaction must abort
  // and the fulfilment must survive untouched.
  const db = fakeDb({
    stock: { "stock/hub1/boot/7/qty": 3 },
    requests: { r1: { ...openReq(), status: "fulfilled" } },
  });
  const r = await applySatisfied({ db, closures: [closure()], startedAt: START });
  assert.strictEqual(r.satisfied, 0);
  assert.strictEqual(db.writes["refill_requests/r1"], undefined);
});

test("the apply path writes ONLY the request node — never a lock", async () => {
  const db = fakeDb({ stock: { "stock/hub1/boot/7/qty": 3 }, requests: { r1: openReq() } });
  await applySatisfied({ db, closures: [closure()], startedAt: START });
  const paths = Object.keys(db.writes);
  assert.deepStrictEqual(paths, ["refill_requests/r1"]);
  assert.ok(!paths.some((p) => p.startsWith("refill_engine/open")),
    "another live lock may share this cell — nulling it would strand a request the engine is waiting on");
});

test("a missing request node no-ops instead of creating one", async () => {
  const db = fakeDb({ stock: { "stock/hub1/boot/7/qty": 3 }, requests: {} });
  const r = await applySatisfied({ db, closures: [closure()], startedAt: START });
  assert.strictEqual(r.satisfied, 0);
  assert.strictEqual(db.writes["refill_requests/r1"], undefined);
});
