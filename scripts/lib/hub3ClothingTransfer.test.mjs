// Hub 3 clothing → Concrete (Junid, 12 Nov 2026): plan and apply against the
// fake RTDB (real delete semantics) and the real server-side movement writer.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { planHub3ClothingTransfer, applyHub3ClothingTransfer, finishAndVerify, assertPlanScope, owningShop, sizeOfKey, REASON, CLEANUP_REASON } from "./hub3ClothingTransfer.mjs";
const require = createRequire(import.meta.url);
const { makeFakeDb } = require("../../functions/test/helpers/fake-rtdb.cjs");
const { applyMovementAdmin } = require("../../functions/lib/admin-movement.cjs");

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const cell = (qty, o = {}) => ({ qty, v: 3, mv: "m0", lastType: "count", ...o });
const PRODUCTS = {
  tee: { name: "Tee", category: "Clothing", categoryKey: "t-shirts", sizes: ["S", "M", "L"] },
  shoe: { name: "Shoe", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "8.5"] },
  legacy: { name: "Boot", category: "Footwear", subcategory: "Boots", sizes: ["9"] },
  perf: { name: "Scent", category: "Perfume", categoryKey: "perfumes", sizes: [] },
  cap: { name: "Cap", category: "Accessories", categoryKey: "caps-beanies", sizes: [] },
  odd: { name: "Thing", sizes: [] },
  pants: { name: "Pants", category: "Clothing", categoryKey: "pants", sizes: ["28/30"] },
};
const world = () => ({
  products: PRODUCTS,
  stock: {
    hub3: {
      tee: { S: cell(3), M: cell(0), L: cell(-1) },
      shoe: { 8: cell(2), "8_5": cell(0) },
      legacy: { 9: cell(1) },
      perf: { _: cell(4) },
      cap: { _: cell(0) },
      odd: { _: cell(2) },
      gone: { _: cell(0) },
      pants: { "28_30": cell(1) },
    },
    concrete: { tee: { S: cell(1) }, cap: { _: cell(-2) } },
  },
  refill_engine: {
    seats: { hub3: { tee: { via: "stock", at: "x", owner: "concrete" }, shoe: { via: "stock", at: "x" }, cap: { via: "cell", at: "x" } }, "marathon-pine": { tee: { via: "stock", at: "x" } } },
    seatReleases: { concrete: { odd: { at: "2026-11-01T00:00:00.000Z" } } },
    open: { hub3: { tee: { S: { refillId: "rq1", qty: 2, source: "central" } } }, concrete: { cap: { _: { refillId: "rq2", qty: 5, source: "hub3" } } } },
  },
  refill_requests: {
    rq1: { status: "open", productId: "tee", size: "S", qty: 2, requestingLocation: "hub3", createdAt: "2026-11-11T08:00:00.000Z" },
    rq2: { status: "open", productId: "cap", size: "", qty: 5, requestingLocation: "concrete", createdAt: "2026-11-11T08:00:00.000Z", createdFrom: { source: "hub3" } },
    rq3: { status: "open", productId: "shoe", size: "8", qty: 1, requestingLocation: "hub3", createdAt: "2026-11-11T08:00:00.000Z" },
    rq4: { status: "open", productId: "tee", size: "M", qty: 1, requestingLocation: "marathon-pine", createdAt: "2026-11-11T08:00:00.000Z", createdFrom: { source: "hub3" }, sentQty: 1 },
    rq5: { status: "open", productId: "tee", size: "M", qty: 2, requestingLocation: "concrete", createdAt: "2026-11-11T08:00:00.000Z", createdFrom: { source: "central" } },
  },
});
const planOf = (t) => planHub3ClothingTransfer({ hub3Stock: t.stock.hub3, products: PRODUCTS, seats: t.refill_engine.seats, requests: t.refill_requests, locks: t.refill_engine.open, runId: "20261112" });

describe("the plan", () => {
  it("everything not footwear: positives move in full, negatives clean up, zeros wait for removal; footwear (legacy too) stays", () => {
    const p = planOf(world());
    expect(p.transfers.map((t) => `${t.pid}/${t.sizeKey}:${t.qty}`).sort()).toEqual(["odd/_:2", "pants/28_30:1", "perf/_:4", "tee/S:3"]);
    expect(p.cleanups.map((t) => `${t.pid}/${t.sizeKey}:${t.qty}`)).toEqual(["tee/L:-1"]);
    expect(p.zeros.map((t) => `${t.pid}/${t.sizeKey}`).sort()).toEqual(["cap/_", "gone/_", "tee/M"]);
    expect(p.footwearKept.sort()).toEqual(["legacy", "shoe"]);
    expect(p.transfers.find((t) => t.pid === "tee").movementId).toBe("h3cl_20261112_tee_S");
    expect(p.cleanups[0].movementId).toBe("h3cc_20261112_tee_L");
    expect(p.summary).toMatchObject({ transferCells: 4, transferProducts: 4, transferUnits: 10, cleanupCells: 1, cleanupUnits: -1, zeroCells: 3, perfumeProducts: 1, perfumeUnits: 4 });
  });
  it("seats: Concrete for what moved, never the perfume; every Hub 3 non-footwear seat off, never a shoe's", () => {
    const p = planOf(world());
    expect(p.seatOn).toEqual(["odd", "pants", "tee"]);
    expect(p.perfumes).toEqual(["perf"]);
    expect(p.seatsOff).toEqual(["cap", "tee"]);
    expect(p.noRecord).toEqual(["gone"]);
  });
  it("requests: open Hub 3 non-footwear and shop-from-Hub 3 non-footwear only; never a shoe's, never a Central line", () => {
    const ids = planOf(world()).withdraw.map((w) => w.id).sort();
    expect(ids).toEqual(["rq1", "rq2", "rq4"]);
  });
  it("owner by today's seats; sizes from the product's own list", () => {
    expect(owningShop({ concrete: { a: {} }, "marathon-pine": { a: {} } }, "a")).toBe("both");
    expect(owningShop({ "marathon-pine": { a: {} } }, "a")).toBe("marathon-pine");
    expect(owningShop({}, "a")).toBe("neither");
    expect(sizeOfKey("28_30", PRODUCTS.pants)).toBe("28/30");
    expect(sizeOfKey("8_5", PRODUCTS.shoe)).toBe("8.5");
    expect(sizeOfKey("_", PRODUCTS.cap)).toBe("_");
    expect(planOf(world()).summary.byOwner).toEqual({ "marathon-pine": { products: 1, units: 3 }, neither: { products: 3, units: 7 } });
  });
  it("refuses a plan that names footwear or a path outside stock/hub3", () => {
    const p = planOf(world());
    expect(() => assertPlanScope({ ...p, transfers: [...p.transfers, { pid: "shoe", path: "stock/hub3/shoe/8" }] }, PRODUCTS)).toThrow(/footwear/);
    expect(() => assertPlanScope({ ...p, transfers: [{ pid: "tee", path: "stock/concrete/tee/S" }] }, PRODUCTS)).toThrow(/outside/);
    expect(() => assertPlanScope({ ...p, seatOn: ["perf"] }, PRODUCTS)).toThrow(/Concrete/);
  });
});

describe("apply + verify", () => {
  const run = async (t) => {
    const db = makeFakeDb(t);
    const plan = planOf(t);
    const res = await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    const fin = await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW, runId: "20261112" });
    return { db, plan, res, fin, root: db.state.root };
  };
  it("moves every positive unit to Concrete, cleans the negative, removes every non-footwear row, keeps footwear exactly", async () => {
    const { root, fin } = await run(world());
    expect(fin.clean).toBe(true);
    expect(Object.keys(root.stock.hub3).sort()).toEqual(["legacy", "shoe"]);
    expect(root.stock.hub3.shoe).toEqual(world().stock.hub3.shoe);
    expect(root.stock.hub3.legacy).toEqual(world().stock.hub3.legacy);
    expect(root.stock.concrete.tee.S.qty).toBe(4);
    expect(root.stock.concrete.perf._.qty).toBe(4);
    expect(root.stock.concrete.odd._.qty).toBe(2);
    expect(root.stock.concrete.pants["28_30"].qty).toBe(1);
    expect(root.stock.concrete.cap._.qty).toBe(-2);
    const mv = root.stock_movements;
    expect(mv.h3cl_20261112_tee_S).toMatchObject({ type: "transfer_in", from: "hub3", to: "concrete", qty: 3, reason: REASON, size: "S" });
    expect(mv.h3cl_20261112_pants_28_30.size).toBe("28/30");
    expect(mv.h3cc_20261112_tee_L).toMatchObject({ type: "adjustment", to: "hub3", qty: 1, reason: CLEANUP_REASON });
    expect(Object.keys(mv).filter((k) => k.startsWith("h3c")).length).toBe(5);
  });
  it("seats Concrete (no perfume), clears its tombstone, switches Hub 3 non-footwear seats off", async () => {
    const { root } = await run(world());
    expect(Object.keys(root.refill_engine.seats.concrete).sort()).toEqual(["odd", "pants", "tee"]);
    expect(root.refill_engine.seats.concrete.tee.via).toBe("hub3_transfer");
    expect(Object.keys(root.refill_engine.seats.hub3)).toEqual(["shoe"]);
    expect(root.refill_engine.seatReleases?.concrete?.odd).toBeUndefined();
    expect(root.refill_engine.seats["marathon-pine"].tee).toBeTruthy();
  });
  it("withdraws untouched requests with their locks; a picked one stands; a shoe's and a Central line are left", async () => {
    const { root, res } = await run(world());
    expect(root.refill_requests.rq1).toMatchObject({ status: "cancelled", cancelReason: REASON });
    expect(root.refill_requests.rq2).toMatchObject({ status: "cancelled", cancelReason: REASON });
    expect(root.refill_requests.rq3.status).toBe("open");
    expect(root.refill_requests.rq4.status).toBe("open");
    expect(root.refill_requests.rq5.status).toBe("open");
    expect(root.refill_engine.open?.hub3).toBeUndefined();
    expect(root.refill_engine.open?.concrete).toBeUndefined();
    expect(res.withdrawn.find((w) => w.id === "rq4").outcome).toBe("touched");
  });
  it("re-running is a no-op (deterministic ids)", async () => {
    const t = world();
    const db = makeFakeDb(t);
    const plan = planOf(t);
    await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    const again = await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    expect(again.moved.every((m) => m.idempotent || m.note === "now_zero")).toBe(true);
    expect(db.state.root.stock.concrete.tee.S.qty).toBe(4);
  });
  it("a sale at Hub 3 between the read and the move: the cell's new quantity moves, nothing goes negative", async () => {
    const t = world();
    const db = makeFakeDb(t);
    const plan = planOf(t);
    await db.ref("stock/hub3/tee/S").update({ qty: 1 });
    const res = await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    expect(res.moved.find((m) => m.pid === "tee").qty).toBe(1);
    expect(db.state.root.stock.concrete.tee.S.qty).toBe(2);
  });
  it("an arrival at Hub 3 after the move: verify moves the new units with a second id and still ends footwear-only", async () => {
    const t = world();
    const db = makeFakeDb(t);
    const plan = planOf(t);
    await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    await db.ref("stock/hub3/cap/_").update({ qty: 2 });
    const fin = await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW, runId: "20261112" });
    expect(fin.clean).toBe(true);
    expect(Object.entries(db.state.root.stock_movements).find(([k]) => k.startsWith("h3cl_20261112_cap___v"))[1].qty).toBe(2);
    expect(db.state.root.stock.concrete.cap._.qty).toBe(2);
  });
});

import { planRowAlign, applyRowAlign, planEarlyRelease, applyEarlyRelease } from "./hub3ClothingTransfer.mjs";
describe("explicit rows at the retired from-Hub 3 keep", () => {
  const targets = {
    concrete: { tee: { S: { target: 1, minQty: 1, reorderPoint: 0, source: "policy_target" }, M: { target: 0, minQty: 0 }, L: { target: 3, minQty: 2 } }, cap: { _: { target: 5, minQty: 4, reorderPoint: 0 } }, perf: { _: { target: 1, minQty: 1, reorderPoint: 0 } }, shoe: { 8: { target: 1, minQty: 1, reorderPoint: 0 } } },
    "marathon-pine": { odd: { _: { target: 5, minQty: 4, reorderPoint: 0 } } },
    hub1: { tee: { S: { target: 1, minQty: 1, reorderPoint: 0 } } },
  };
  it("aligns exactly the 1/ask-0 and 5/ask-0 rows at Pine/Concrete to 2 and 5; never footwear, perfume at Concrete, or Marathon", () => {
    const { align, left } = planRowAlign({ targets, products: PRODUCTS });
    expect(align.map((a) => `${a.loc}/${a.pid}/${a.sizeKey}->${a.to.target}`).sort()).toEqual(["concrete/cap/_->5", "concrete/tee/S->2", "marathon-pine/odd/_->5"]);
    expect(left.map((a) => `${a.loc}/${a.pid}/${a.sizeKey}`)).toEqual(["concrete/tee/L"]);
  });
  it("edits in place (never deletes), keeps the old numbers on the row, and refuses a row changed since the read", async () => {
    const db = makeFakeDb({ stock_targets: JSON.parse(JSON.stringify(targets)) });
    const { align } = planRowAlign({ targets, products: PRODUCTS });
    await db.ref("stock_targets/marathon-pine/odd/_").update({ target: 7 });
    const res = await applyRowAlign({ db, align, nowIso: "2026-11-12T10:00:00.000Z" });
    const row = db.state.root.stock_targets.concrete.tee.S;
    expect(row).toMatchObject({ target: 2, minQty: 1, source: "policy_target", prevRetiredHub3Keep: { target: 1, minQty: 1, reorderPoint: 0 } });
    expect(row.reorderPoint).toBeUndefined();
    expect(res.find((r) => r.pid === "odd").outcome).toBe("changed_since_read");
    expect(db.state.root.stock_targets.concrete.tee.M).toEqual({ target: 0, minQty: 0 });
    expect(db.state.root.stock_targets.hub1.tee.S.target).toBe(1);
  });
});

describe("the one-off release", () => {
  const requests = {
    a: { status: "open", requestingLocation: "concrete", productId: "tee", size: "S", qty: 2, createdAt: "2026-11-12T11:00:05.000Z" },
    b: { status: "open", requestingLocation: "hub2", productId: "shoe", size: "8", qty: 1, createdAt: "2026-11-12T11:00:05.000Z" },
    c: { status: "open", requestingLocation: "marathon-pine", productId: "cap", size: "", qty: 5, createdAt: "2026-11-12T10:00:00.000Z" },
    d: { status: "open", requestingLocation: "hub3", productId: "shoe", size: "8", qty: 1, createdAt: "2026-11-12T11:00:05.000Z", earlyRelease: { at: "x" } },
    e: { status: "fulfilled", requestingLocation: "concrete", productId: "tee", size: "M", qty: 1, createdAt: "2026-11-12T11:00:05.000Z" },
  };
  it("releases only open, unreleased division lines raised since the run started — never a Marathon line", async () => {
    const lines = planEarlyRelease({ requests, sinceIso: "2026-11-12T11:00:00.000Z" });
    expect(lines.map((l) => l.id)).toEqual(["a"]);
    const db = makeFakeDb({ refill_requests: JSON.parse(JSON.stringify(requests)) });
    const res = await applyEarlyRelease({ db, lines: planEarlyRelease({ requests, sinceIso: "2026-11-12T00:00:00.000Z" }), nowIso: "2026-11-12T11:05:00.000Z", by: "script", reason: "one-off" });
    expect(res.map((r) => `${r.id}:${r.outcome}`).sort()).toEqual(["a:released", "c:released"]);
    expect(db.state.root.refill_requests.a.earlyRelease).toEqual({ at: "2026-11-12T11:05:00.000Z", by: "script", reason: "one-off" });
    expect(db.state.root.refill_requests.b.earlyRelease).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("a positive cell with no product record is refused unless the operator allows it", async () => {
    const t = world();
    t.stock.hub3.ghost = { 8: cell(2) };
    const plan = planOf(t);
    expect(() => assertPlanScope(plan, PRODUCTS)).toThrow(/no product record/);
    expect(() => assertPlanScope(plan, PRODUCTS, { allowNoRecord: true })).not.toThrow();
    const db = makeFakeDb(t);
    await expect(applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW })).rejects.toThrow(/no product record/);
    expect(db.state.root.stock.hub3.ghost[8].qty).toBe(2);
  });
  it("verify reports every cell it removed, with what it held", async () => {
    const t = world();
    const db = makeFakeDb(t);
    await applyHub3ClothingTransfer({ db, plan: planOf(t), products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    const fin = await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW, runId: "20261112" });
    expect(fin.removedCells.map((r) => r.path).sort()).toEqual(["stock/hub3/cap/_", "stock/hub3/gone/_", "stock/hub3/odd/_", "stock/hub3/pants/28_30", "stock/hub3/perf/_", "stock/hub3/tee/L", "stock/hub3/tee/M", "stock/hub3/tee/S"]);
    expect(fin.removedCells.every((r) => r.before && r.before.qty === 0)).toBe(true);
  });
});

describe("review round 2", () => {
  it("a re-run after a later arrival: the spent id is reported, and verify moves the new units under a fresh id", async () => {
    const t = world();
    const db = makeFakeDb(t);
    const plan = planOf(t);
    await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW, runId: "20261112" });
    await db.ref("stock/hub3/tee/S").set({ qty: 2, v: 9, mv: "x", lastType: "transfer_in" });
    const again = await applyHub3ClothingTransfer({ db, plan, products: PRODUCTS, applyMovementAdmin, nowMs: NOW + 1000 });
    expect(again.moved.find((m) => m.pid === "tee").refused).toBe("id_spent_cell_refilled");
    const fin = await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW + 2000, runId: "20261112" });
    expect(fin.clean).toBe(true);
    expect(db.state.root.stock.concrete.tee.S.qty).toBe(6);
  });
  it("verify leaves a record-less cell above zero unless allowed", async () => {
    const t = world();
    const db = makeFakeDb(t);
    await applyHub3ClothingTransfer({ db, plan: planOf(t), products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    await db.ref("stock/hub3/ghost/8").set({ qty: 1, v: 0, mv: "x", lastType: "transfer_in" });
    const fin = await finishAndVerify({ db, products: PRODUCTS, applyMovementAdmin, nowMs: NOW, runId: "20261112" });
    expect(fin.clean).toBe(false);
    expect(fin.skippedNoRecord).toContain("stock/hub3/ghost/8");
    expect(db.state.root.stock.hub3.ghost[8].qty).toBe(1);
  });
  it("a record-less Hub 3 seat is not switched off; a product size of '' falls back to the key", () => {
    const t = world();
    t.refill_engine.seats.hub3.ghost = { via: "stock", at: "x" };
    const p = planOf(t);
    expect(p.seatsOff).not.toContain("ghost");
    expect(p.seatsUnknown).toContain("ghost");
    expect(sizeOfKey("_", { sizes: [""] })).toBe("_");
  });
  it("a request whose pick already moved stock (no sentQty yet) is not withdrawn", async () => {
    const t = world();
    t.stock_movements = { mvp: { ts: "2026-11-11T09:00:00.000Z", type: "transfer_out", link: { refillId: "rq1" } } };
    const db = makeFakeDb(t);
    const res = await applyHub3ClothingTransfer({ db, plan: planOf(t), products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    expect(res.withdrawn.find((w) => w.id === "rq1").outcome).toBe("touched");
    expect(db.state.root.refill_requests.rq1.status).toBe("open");
  });
  it("an orphan lock (its request gone) is removed", async () => {
    const t = world();
    delete t.refill_requests.rq2;
    const db = makeFakeDb(t);
    const res = await applyHub3ClothingTransfer({ db, plan: planOf(t), products: PRODUCTS, applyMovementAdmin, nowMs: NOW });
    expect(res.withdrawn.find((w) => w.id === "rq2").outcome).toBe("absent");
    expect(db.state.root.refill_engine.open?.concrete).toBeUndefined();
  });
});
