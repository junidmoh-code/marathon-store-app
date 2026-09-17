// ─── The first-batch repair — plan and apply, driven for real over the fake RTDB ─
// decideRepair / buildPlan / applyPlan are the functions the script runs; the
// fake is functions/test/helpers/fake-rtdb.cjs (the same one the trigger's
// tests use). Claims: Hub 2 presence by ANY means withdraws the shop's Central
// request and seeds Hub 2; no presence keeps it and still seeds; nothing
// touched twice on a second run; no stock quantity ever changes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { decideRepair, buildPlan, applyPlan, REPAIR_REASON } from "./first-batch-repair.mjs";

const req = createRequire(import.meta.url);
const { makeFakeDb } = req("../../functions/test/helpers/fake-rtdb.cjs");
const T = "2026-09-17T21:00:00.000Z";
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const fbRow = (pid, size, store, over = {}) => ({
  productId: pid, size, qty: 2, requestingLocation: store, status: "open", createdAt: "2026-09-17T18:30:00.000Z",
  createdFrom: { firstBatch: true, solveId: `fb_${pid}_1`, source: "central", store, hub: "hub2" }, ...over,
});
const readAll = async (db) => db.state.root.refill_requests || {};
const qtys = (db) => JSON.stringify(Object.fromEntries(Object.entries(db.state.root.stock || {}).map(([l, byPid]) => [l, Object.fromEntries(Object.entries(byPid).map(([pid, row]) => [pid, Array.isArray(row) ? row.map((c) => c && c.qty) : Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c && c.qty]))]))])));

function world() {
  return makeFakeDb({
    products: { p1: { id: "p1" }, p2: { id: "p2" }, p3: { id: "p3" }, p4: { id: "p4" }, p5: { id: "p5" }, p6: { id: "p6" } },
    stock: {
      central: { p1: { M: cell(5) }, p2: { M: cell(5) }, p3: { _: cell(3) }, p4: { M: cell(2) }, p5: { M: cell(2) }, p6: { "8": cell(2) } },
      hub2: { p1: { M: cell(3) }, p6: [null, null, null, null, null, null, null, null, { qty: 0 }] },   // p1 stocked; p6 array-coerced row, cell at 8 (a hole elsewhere)
      trophy: { p1: { M: cell(0) }, p2: { M: cell(0) }, p3: { _: cell(0) }, p4: { M: cell(0) }, p5: { M: cell(0) }, p6: { "8": cell(0) } },
    },
    stock_targets: { hub2: { p4: { M: { target: 3 } } } },                       // p4: explicit row = presence
    refill_engine: { open: { hub2: { p5: { M: { qty: 2, source: "central", runId: "scan-9", refillId: "eng5" } } } } },   // p5: engine lock = presence
    refill_requests: {
      a: fbRow("p1", "M", "trophy"),                       // stock node → withdraw
      b: fbRow("p2", "M", "marathon-pe"),                  // nothing at Hub 2 → keep, seed
      c: fbRow("p3", "_", "trophy"),                       // one-size, nothing → keep, seed "_"
      d: fbRow("p4", "M", "trophy"),                       // explicit row only → a plan, not presence → keep, seed
      e: fbRow("p5", "M", "trophy"),                       // engine lock + open hub2 request → withdraw
      eng5: { productId: "p5", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: T, createdFrom: { engine: true, source: "central" } },
      f: fbRow("p1", "M", "marathon-pe", { sentQty: 1, qty: 1 }),   // touched → never withdrawn (stock in motion)
      g: fbRow("p6", "8", "trophy"),                       // array-coerced Hub 2 row with a cell at 8 → presence → withdraw; no seed needed
      h: fbRow("p2", "M", "trophy", { status: "fulfilled" }),        // resolved → seed only (once)
      hub: fbRow("p1", "M", "hub2"),                       // Hub 2's own leg: not a shop row
      eng: { productId: "p1", size: "L", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T, createdFrom: { engine: true, source: "hub2" } },   // engine row: untouched
    },
  });
}

describe("decideRepair — presence by ANY means", () => {
  const row = fbRow("p", "M", "trophy");
  it("no presence → keep the Central request, seed Hub 2", () => {
    expect(decideRepair({ row, hub2Node: null, hub2Locks: null, hub2OpenRequests: [], hub2TargetRow: null })).toMatchObject({ withdraw: false, seedNeeded: true, presence: [], openUntouched: true });
  });
  it("a qty-0 cell is presence; so is a lock, an open Hub 2 request; an explicit row is a PLAN (reported, never presence)", () => {
    expect(decideRepair({ row, hub2Node: { M: cell(0) }, hub2Locks: null, hub2OpenRequests: [], hub2TargetRow: null })).toMatchObject({ withdraw: true, seedNeeded: false, presence: ["stock_cell"] });
    // a Solve's own seed (updatedBy a uid) IS prior presence; the trigger's / this repair's qty-0 seed is NOT
    expect(decideRepair({ row, hub2Node: { M: { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedBy: "u1" } } })).toMatchObject({ withdraw: true, presence: ["stock_cell"] });
    expect(decideRepair({ row, hub2Node: { M: { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedBy: "first_batch" } } })).toMatchObject({ withdraw: false, presence: [], seedNeeded: false });
    expect(decideRepair({ row, hub2Node: { M: { qty: 2, mv: "seed", updatedBy: "first_batch" } } })).toMatchObject({ withdraw: true, presence: ["stock_cell"] });
    expect(decideRepair({ row, hub2Node: null, hub2Locks: { M: {} }, hub2OpenRequests: [], hub2TargetRow: null })).toMatchObject({ withdraw: true, presence: ["engine_lock"] });
    expect(decideRepair({ row, hub2Node: null, hub2Locks: null, hub2OpenRequests: ["x"], hub2TargetRow: null })).toMatchObject({ withdraw: true, presence: ["open_hub2_request"] });
    expect(decideRepair({ row, hub2Node: null, hub2Locks: null, hub2OpenRequests: [], hub2TargetRow: { M: { target: 0 } } })).toMatchObject({ withdraw: false, presence: [], explicitRow: true });
  });
  it("a touched or resolved row is never withdrawn, whatever the presence", () => {
    expect(decideRepair({ row: { ...row, sentQty: 1 }, hub2Node: { M: cell(1) } }).withdraw).toBe(false);
    expect(decideRepair({ row: { ...row, status: "cancelled" }, hub2Node: { M: cell(1) } }).withdraw).toBe(false);
  });
  it("one-size keys as '_' and an array hole is an absent cell", () => {
    expect(decideRepair({ row: fbRow("p", "_", "trophy"), hub2Node: null }).sizeKey).toBe("_");
    expect(decideRepair({ row: fbRow("p", "8", "trophy"), hub2Node: [null, null, null, null, null, null, null, null, { qty: 0 }] })).toMatchObject({ seedNeeded: false, withdraw: true });
    expect(decideRepair({ row: fbRow("p", "7", "trophy"), hub2Node: [null, null, null, null, null, null, null, null, { qty: 0 }] })).toMatchObject({ seedNeeded: true, withdraw: true });
  });
});

describe("buildPlan + applyPlan over the fake", () => {
  it("plans exactly the shop rows: withdraws a/e/g, keeps b/c/d, seeds p2 M (b+h once) / p3 _ / p4 M / p5 M", async () => {
    const db = world();
    const { plan, shopRows } = await buildPlan(db, { readAll });
    expect(shopRows).toBe(8);
    const by = Object.fromEntries(plan.map((p) => [p.id, p]));
    expect(Object.keys(by).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(plan.filter((p) => p.withdraw).map((p) => p.id).sort()).toEqual(["a", "e", "g"]);
    expect(plan.filter((p) => p.openUntouched && !p.withdraw).map((p) => p.id).sort()).toEqual(["b", "c", "d"]);
    expect(by.d.explicitRow).toBe(true);
    expect(by.f.withdraw).toBe(false);
    expect(by.c.sizeKey).toBe("_");
    expect(by.g.seedNeeded).toBe(false);
  });

  it("apply: withdrawals carry the reason + marker, seeds land (qty 0), no quantity changes, the engine row and Hub 2's leg are untouched", async () => {
    const db = world();
    const before = qtys(db);
    const { plan } = await buildPlan(db, { readAll });
    const r = await applyPlan(db, plan, T);
    expect(r).toEqual({ seeded: 4, withdrawn: 3, refused: 0 });   // p2 M (b+h share ONE seed), p3 _, p4 M, p5 M; p1 M and p6 8 exist
    const rr = db.state.root.refill_requests;
    for (const id of ["a", "e", "g"]) {
      expect(rr[id].status).toBe("cancelled");
      expect(rr[id].cancelReason).toBe(REPAIR_REASON);
      expect(rr[id].firstBatch.hub2Leg).toEqual({ none: "repair_hub2_present", at: T });
    }
    for (const id of ["b", "c", "d", "f", "eng", "hub"]) expect(rr[id].status).toBe("open");
    expect(rr.h.status).toBe("fulfilled");
    const h2 = db.state.root.stock.hub2;
    expect(h2.p2.M).toEqual({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: T, updatedBy: "first_batch" });
    expect(h2.p3._).toMatchObject({ qty: 0 });
    expect(h2.p1.M.qty).toBe(3);                 // never overwritten
    // every pre-existing quantity is byte-identical; new cells are qty 0 only
    const after = JSON.parse(qtys(db)), b = JSON.parse(before);
    for (const [l, byPid] of Object.entries(after)) for (const [pid, row] of Object.entries(byPid)) for (const [k, q] of Object.entries(row)) {
      if (b[l]?.[pid]?.[k] != null) expect(q, `${l}/${pid}/${k}`).toBe(b[l][pid][k]); else expect(q === 0 || q == null, `${l}/${pid}/${k}`).toBe(true);
    }
    expect(db.state.root.refill_engine.open.hub2.p5.M.refillId).toBe("eng5");   // the engine's lock is not ours to touch
  });

  it("idempotent: a second plan is all no-ops and a second apply writes nothing", async () => {
    const db = world();
    await applyPlan(db, (await buildPlan(db, { readAll })).plan, T);
    const snap = JSON.stringify(db.state.root);
    const { plan } = await buildPlan(db, { readAll });
    expect(plan.filter((p) => p.withdraw)).toHaveLength(0);
    expect(plan.filter((p) => p.seedNeeded)).toHaveLength(0);
    const r = await applyPlan(db, plan, "2026-09-17T22:00:00.000Z");
    expect(r).toEqual({ seeded: 0, withdrawn: 0, refused: 0 });
    expect(JSON.stringify(db.state.root)).toBe(snap);
  });

  it("the CAS refuses a row Central fulfilled between plan and apply", async () => {
    const db = world();
    const { plan } = await buildPlan(db, { readAll });
    db.state.root.refill_requests.a = { ...db.state.root.refill_requests.a, status: "fulfilled", sentQty: 2 };
    const r = await applyPlan(db, plan.filter((p) => p.id === "a"), T);
    expect(r).toEqual({ seeded: 0, withdrawn: 0, refused: 1 });
    expect(db.state.root.refill_requests.a.status).toBe("fulfilled");
  });
});
