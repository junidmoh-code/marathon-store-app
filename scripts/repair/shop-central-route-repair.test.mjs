// ─── The shop ← Central repair — plan and apply, driven over the fake RTDB ────
// decideRow / buildPlan / applyPlan are the functions the script runs; the fake
// is functions/test/helpers/fake-rtdb.cjs (the trigger's own). Claims: a shop ←
// Central row whose hub shows presence is withdrawn and its lock released; a
// legitimate first batch (hub never held it) is kept; a sent or mid-pick row is
// never touched and is listed; a second run changes nothing; no stock moves.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { decideRow, buildPlan, applyPlan, REPAIR_REASON } from "./shop-central-route-repair.mjs";

const req = createRequire(import.meta.url);
const { makeFakeDb } = req("../../functions/test/helpers/fake-rtdb.cjs");
const NOW = "2026-10-03T12:00:00.000Z";
const C0 = "2026-09-25T14:25:29.087Z";
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received", updatedAt: "2026-09-01T08:00:00.000Z" });
const LOCATIONS = {
  central: { kind: "warehouse" }, hub1: { kind: "warehouse" }, hub2: { kind: "warehouse" }, hub3: { kind: "warehouse" },
  "marathon-pe": { kind: "store" }, trophy: { kind: "store" }, "marathon-pine": { kind: "store" },
};
const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const fb = (pid, size, store, over = {}) => ({
  productId: pid, size, qty: 2, requestingLocation: store, status: "open", createdAt: C0,
  createdFrom: { firstBatch: true, solveId: `fb_${pid}_1`, source: "central", store, hub: "hub2" }, ...over,
});
const lock = (id) => ({ qty: 2, source: "central", createdAt: C0, runId: "first_batch:x", refillId: id });

function world() {
  return makeFakeDb({
    config: { refillEngine: { routes: ROUTES } },
    locations: LOCATIONS,
    stock: {
      central: { p1: { M: cell(5) }, p2: { M: cell(5) }, p3: { M: cell(5) }, p4: { M: cell(5) } },
      hub2: { p1: { L: cell(0) }, p3: { M: cell(2) }, p4: { M: cell(1) } },   // p1: a qty-0 cell from long ago = held before
      trophy: { p1: { M: cell(0) }, p2: { M: cell(0) }, p3: { M: cell(0) }, p4: { M: cell(0) } },
    },
    refill_engine: { open: { trophy: { p1: { M: lock("a") } }, "marathon-pe": { p2: { M: lock("b") } } } },
    refill_requests: {
      a: fb("p1", "M", "trophy"),                                   // hub held it (old cell) → withdraw
      b: fb("p2", "M", "marathon-pe"),                              // hub never held it → keep (legit first batch)
      c: fb("p3", "M", "trophy", { sentQty: 1, qty: 1 }),           // hub holds it but a tranche is sent → never touched, listed
      d: fb("p4", "M", "marathon-pe", { sentQty: "1" }),            // non-number sentQty = touched → never touched
      e: { productId: "p1", size: "M", qty: 1, requestingLocation: "trophy", status: "fulfilled", createdAt: C0, createdFrom: { firstBatch: true, source: "central" } },
      f: { productId: "p9", size: "S", qty: 1, requestingLocation: "trophy", status: "open", createdAt: C0, createdFrom: { engine: true, source: "hub2" } },   // normal route — not a target
    },
  });
}
const readOpen = async (db) => Object.fromEntries(Object.entries(db.state.root.refill_requests).filter(([, r]) => !r.resolvedAt));
const readSince = async (db) => db.state.root.refill_requests;
const stockJson = (db) => JSON.stringify(db.state.root.stock);

describe("shop ← Central repair", () => {
  it("plans exactly the rule: withdraw a/held, keep b/never held, never touch c/d (sent)", async () => {
    const db = world();
    const { plan, picked } = await buildPlan(db, { readOpen, readSince });
    const by = Object.fromEntries(plan.map((p) => [p.id, p]));
    expect(Object.keys(by).sort()).toEqual(["a", "b", "c", "d"]);
    expect(by.a.withdraw).toBe(true);
    expect(by.a.presence).toContain("stock_cell");
    expect(by.b.withdraw).toBe(false);
    expect(by.b.presence).toEqual([]);
    expect(by.c.withdraw).toBe(false);
    expect(by.c.inFlight).toBe(true);
    expect(by.d.withdraw).toBe(false);
    expect(picked.map((r) => r.id).sort()).toEqual(["c", "d", "e"]);   // what physically left Central
  });

  it("applies by CAS, releases only its own lock, is idempotent, and moves no stock", async () => {
    const db = world();
    const before = stockJson(db);
    const { plan } = await buildPlan(db, { readOpen, readSince });
    const r1 = await applyPlan(db, plan, NOW);
    expect(r1).toEqual({ withdrawn: 1, refused: 0, locksReleased: 1 });
    const a = db.state.root.refill_requests.a;
    expect(a.status).toBe("cancelled");
    expect(a.cancelReason).toBe(REPAIR_REASON);
    expect(a.firstBatch.hub2Leg).toEqual({ none: "hub2_present", at: NOW });
    expect(db.state.root.refill_engine.open.trophy).toBeUndefined();          // released (and the fake drops the empty parent, like RTDB)
    expect(db.state.root.refill_engine.open["marathon-pe"].p2.M.refillId).toBe("b");   // the kept first batch keeps its lock
    expect(db.state.root.refill_requests.c.status).toBe("open");
    expect(stockJson(db)).toBe(before);
    const again = await buildPlan(db, { readOpen, readSince });
    expect(again.plan.filter((p) => p.withdraw)).toEqual([]);
    expect(await applyPlan(db, again.plan, NOW)).toEqual({ withdrawn: 0, refused: 0, locksReleased: 0 });
  });

  it("a pick that lands between plan and apply wins: the CAS refuses and the lock stays", async () => {
    const db = world();
    const { plan } = await buildPlan(db, { readOpen, readSince });
    db.state.root.refill_requests.a.sentQty = 1;
    expect(await applyPlan(db, plan, NOW)).toEqual({ withdrawn: 0, refused: 1, locksReleased: 0 });
    expect(db.state.root.refill_requests.a.status).toBe("open");
    expect(db.state.root.refill_engine.open.trophy.p1.M.refillId).toBe("a");
  });

  it("Section 1 has the same rule: Pine ← Central is withdrawn when Hub 3 held the product (once Pine is routed via Hub 3)", () => {
    const routes = { ...ROUTES, hub3: "central", "marathon-pine": "hub3" };
    const row = fb("p1", "M", "marathon-pine", { createdFrom: { firstBatch: true, source: "central" } });
    const held = decideRow({ row, routes, locations: LOCATIONS, hubNode: { M: cell(1) }, hubLocks: null, heldLines: null, openRows: [] });
    expect(held.hub).toBe("hub3");
    expect(held.withdraw).toBe(true);
    const never = decideRow({ row, routes, locations: LOCATIONS, hubNode: null, hubLocks: null, heldLines: null, openRows: [] });
    expect(never.withdraw).toBe(false);
  });
});
