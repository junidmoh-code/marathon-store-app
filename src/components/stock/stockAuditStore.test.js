// ─── STOCK AUDIT WRITERS — the three rules, asserted ─────────────────────────
// 1. no direct /stock write, ever — every quantity change is an applyMovement
// 2. the snapshot's quantity is evidence, not a base — the LIVE cell decides
//    the delta and rides along as `expect`
// 3. an outcome is recorded only after the stock write lands

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { cells: {}, updates: [], movements: [], applyResult: null };

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u9" } } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  get: async (r) => ({ val: () => state.cells[r.path] ?? null }),
  update: async (_r, upd) => { state.updates.push(upd); },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-09-07T09:00:00.000Z") }));
vi.mock("./applyMovement", () => ({
  applyMovement: async (m) => {
    state.movements.push(m);
    return state.applyResult ?? { ok: true, movementId: `mv${state.movements.length}` };
  },
}));

const store = await import("./stockAuditStore.js");
const NOW = Date.parse("2026-09-07T09:00:00.000Z");
const RESULTS = "settings/stockAudit/marathon-pe/results/2026-09-07";
const HUB_RESULTS = "settings/stockAudit/hub/hub1/results/2026-09-07";
const ROTATION = "settings/stockAudit/rotation/marathon-pe";

const OOS_ROW = { k: "p1__9__hub1", p: "p1", n: "AF1", s: "9", sk: "9", w: "hub1", q: 7, r: "out_of_stock", c: 2 };
const ROT_ROW = { p: "p1", n: "Tee", sold: false, disp: false, z: [{ s: "S", sk: "S", q: 2 }, { s: "M", sk: "M", q: 3 }] };

beforeEach(() => { state.cells = {}; state.updates = []; state.movements = []; state.applyResult = null; });

describe("adjustCellTo", () => {
  it("computes the delta from the LIVE cell and pins it with expect", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 4 };            // the snapshot said 7
    const res = await store.adjustCellTo({ loc: "hub1", productId: "p1", size: "9", actual: 6, what: "x", store: "marathon-pe", actorRole: "admin" });
    expect(res.ok).toBe(true);
    expect(state.movements).toHaveLength(1);
    const m = state.movements[0];
    expect(m.type).toBe("adjustment");
    expect(m.qty).toBe(2);                                  // 6 − 4, NOT 6 − 7
    expect(m.to).toBe("hub1");
    expect(m.from).toBe(null);
    expect(m.expect).toEqual({ qty: 4 });
    expect(m.reason).toContain("Stock Audit");
    expect(m.reason).toContain("marathon-pe");
  });

  it("a downward correction debits the same cell", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 9 };
    await store.adjustCellTo({ loc: "hub1", productId: "p1", size: "9", actual: 2, what: "x", store: "s" });
    expect(state.movements[0]).toMatchObject({ qty: 7, from: "hub1", to: null, expect: { qty: 9 } });
  });

  it("a missing cell reads as zero, not as a failure", async () => {
    await store.adjustCellTo({ loc: "hub1", productId: "p1", size: "9", actual: 3, what: "x", store: "s" });
    expect(state.movements[0]).toMatchObject({ qty: 3, to: "hub1", expect: { qty: 0 } });
  });

  it("a cell already correct writes no movement at all", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 5 };
    const res = await store.adjustCellTo({ loc: "hub1", productId: "p1", size: "9", actual: 5, what: "x", store: "s" });
    expect(res).toEqual({ ok: true, noop: true, live: 5 });
    expect(state.movements).toHaveLength(0);
  });

  it("refuses a negative or unreadable target before touching anything", async () => {
    // 3.5 is the one that used to get all the way to the database and be
    // rejected as PERMISSION_DENIED, six retries later, as "try again".
    for (const bad of [-1, "abc", null, undefined, "", "  ", 3.5, "2.5"]) {
      expect((await store.adjustCellTo({ loc: "hub1", productId: "p1", size: "9", actual: bad, what: "x", store: "s" })).ok).toBe(false);
    }
    expect(state.movements).toHaveLength(0);
  });
});

describe("Tab A outcomes", () => {
  it("confirmed empty against a cell that AGREES moves no stock", async () => {
    const agreed = { ...OOS_ROW, q: 0 };          // and the LIVE cell is 0 too
    const res = await store.recordOutOfStockOutcome({ hub: "hub1", row: agreed, outcome: "confirmed_empty" });
    expect(res.ok).toBe(true);
    expect(state.movements).toHaveLength(0);
    expect(state.updates[0][`${HUB_RESULTS}/p1__9__hub1`]).toMatchObject({
      outcome: "confirmed_empty", at: NOW, by: "u9", where: "hub1", believed: 0,
    });
  });

  it("confirmed empty against a cell that still reads STOCK corrects it to zero", async () => {
    // The phantom: the system says 7, the human just looked and the shelf is
    // empty. Recording that without a correction would bury the defect the tab
    // exists to find — the row never comes back (it is not negative, and its
    // request ages out of the lookback window).
    state.cells["stock/hub1/p1/9"] = { qty: 7 };
    const res = await store.recordOutOfStockOutcome({ hub: "hub1", row: OOS_ROW, outcome: "confirmed_empty" });
    expect(res.ok).toBe(true);
    expect(state.movements[0]).toMatchObject({ type: "adjustment", qty: 7, from: "hub1", expect: { qty: 7 } });
    expect(state.updates[0][`${HUB_RESULTS}/p1__9__hub1`]).toMatchObject({ outcome: "confirmed_empty", actual: 0, movementId: "mv1" });
  });

  it("confirmed empty against a NEGATIVE cell corrects it up to zero", async () => {
    // A negative cell is wrong by definition. Leaving it would bring the same
    // row back tomorrow, unchanged, every day — the button that describes what
    // the person did has to actually fix it.
    state.cells["stock/hub1/p1/9"] = { qty: -2 };
    const res = await store.recordOutOfStockOutcome({
      hub: "hub1", row: { ...OOS_ROW, q: -2, r: "negative_cell" }, outcome: "confirmed_empty",
    });
    expect(res.ok).toBe(true);
    expect(state.movements[0]).toMatchObject({ type: "adjustment", qty: 2, to: "hub1", from: null, expect: { qty: -2 } });
  });

  it("confirmed empty CORRECTS from the live cell even when the snapshot said zero", async () => {
    // The 07:00 snapshot recorded 0. A mis-scanned transfer credited 4 at
    // 09:00. Staff walk the shelf at 15:00 and it is empty. Gating on the
    // snapshot's number would record the check, drop the row, and leave hub2
    // reading 4 — and the row never returns, because its request has aged out.
    state.cells["stock/hub1/p1/9"] = { qty: 4 };
    const res = await store.recordOutOfStockOutcome({
      hub: "hub1", row: { ...OOS_ROW, q: 0 }, outcome: "confirmed_empty",
    });
    expect(res.ok).toBe(true);
    expect(state.movements[0]).toMatchObject({ type: "adjustment", qty: 4, from: "hub1", expect: { qty: 4 } });
  });

  it("a REFUSED confirmed-empty correction records nothing either", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 7 };
    state.applyResult = { ok: false, reason: "stale_expectation" };
    const res = await store.recordOutOfStockOutcome({ hub: "hub1", row: OOS_ROW, outcome: "confirmed_empty" });
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("adjust writes the movement first and records the result after", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 7 };
    const res = await store.recordOutOfStockOutcome({ hub: "hub1", row: OOS_ROW, outcome: "adjusted", actual: 0 });
    expect(res.ok).toBe(true);
    expect(state.movements[0]).toMatchObject({ qty: 7, from: "hub1" });
    expect(state.updates[0][`${HUB_RESULTS}/p1__9__hub1`]).toMatchObject({ outcome: "adjusted", actual: 0, movementId: "mv1" });
  });

  it("a REFUSED adjustment records nothing — the row must stay on the list", async () => {
    state.cells["stock/hub1/p1/9"] = { qty: 7 };
    state.applyResult = { ok: false, reason: "stale_expectation" };
    const res = await store.recordOutOfStockOutcome({ hub: "hub1", row: OOS_ROW, outcome: "adjusted", actual: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("stale_expectation");
    expect(state.updates).toHaveLength(0);
  });

  it("an unknown outcome is refused rather than stored", async () => {
    expect((await store.recordOutOfStockOutcome({ hub: "hub1", row: OOS_ROW, outcome: "whatever" })).ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});

describe("Tab B outcomes", () => {
  it("every outcome stamps the rotation, so every one goes to the back", async () => {
    for (const o of ["present", "not_on_display", "slow"]) {
      state.updates = [];
      const res = await store.recordRotationOutcome({ store: "marathon-pe", row: ROT_ROW, outcome: o });
      expect(res.ok).toBe(true);
      expect(state.updates[0][`${ROTATION}/p1`]).toEqual({ at: NOW, o, by: "u9" });
    }
  });

  it("present, not-on-display and slow move no stock", async () => {
    for (const o of ["present", "not_on_display", "slow"]) {
      await store.recordRotationOutcome({ store: "marathon-pe", row: ROT_ROW, outcome: o });
    }
    expect(state.movements).toHaveLength(0);
  });

  it("not there zeroes every held size of the product from the product view", async () => {
    state.cells["stock/marathon-pe/p1/S"] = { qty: 2 };
    state.cells["stock/marathon-pe/p1/M"] = { qty: 3 };
    const res = await store.recordRotationOutcome({ store: "marathon-pe", row: ROT_ROW, outcome: "not_there" });
    expect(res.ok).toBe(true);
    expect(state.movements.map((m) => [m.size, m.qty, m.from])).toEqual([["S", 2, "marathon-pe"], ["M", 3, "marathon-pe"]]);
    expect(state.updates[0][`${RESULTS}/p1`].movementIds).toEqual(["mv1", "mv2"]);
  });

  it("not there from the size view touches only that size", async () => {
    state.cells["stock/marathon-pe/p1/M"] = { qty: 3 };
    await store.recordRotationOutcome({ store: "marathon-pe", row: ROT_ROW, outcome: "not_there", sizes: [{ sk: "M" }] });
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]).toMatchObject({ size: "M", qty: 3 });
    // the stamp is still the PRODUCT's — one rotation record whichever view acted
    expect(state.updates[0][`${ROTATION}/p1`].o).toBe("not_there");
  });

  it("a partial failure is reported with what landed, and stamps nothing", async () => {
    // The second size refuses. applyMovement is atomic per movement and not
    // across several, so the honest outcome is: say which sizes moved, leave
    // the row on the list, and write no stamp.
    state.cells["stock/marathon-pe/p1/S"] = { qty: 2 };
    state.cells["stock/marathon-pe/p1/M"] = { qty: 3 };
    let n = 0;
    const realPush = state.movements.push.bind(state.movements);
    state.movements.push = (m) => {
      const r = realPush(m);
      if (++n === 2) state.applyResult = { ok: false, reason: "insufficient_stock" };
      return r;
    };
    const res = await store.recordRotationOutcome({ store: "marathon-pe", row: ROT_ROW, outcome: "not_there" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("insufficient_stock");
    expect(res.partial).toEqual(["mv1"]);
    expect(state.updates).toHaveLength(0);
  });

  it("a row with no sizes is refused rather than silently doing nothing", async () => {
    const res = await store.recordRotationOutcome({ store: "marathon-pe", row: { p: "p1", z: [] }, outcome: "not_there" });
    expect(res).toMatchObject({ ok: false, reason: "no_sizes" });
    expect(state.updates).toHaveLength(0);
  });
});
