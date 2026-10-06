// The repair plan: what moves, what is set aside, and that a second run moves nothing.
import { describe, it, expect } from "vitest";
import { planRepair, buildMoveUpdate, logKeyFor, repairMovementId, cellKey, soldKey, originalSaleIdsFor, REPAIR_REASON, LOG_ROOT } from "./return-repair-core.mjs";

const ret = (over = {}) => ({ mvId: "return:RET1:marathon-pine:p1:9", recordId: "RET1", productId: "p1", size: "9", qty: 1, to: "marathon-pine", ts: "2026-09-01T10:00:00.000Z", ...over });
const rec = (storeId, originalSaleId = "SALE1", over = {}) => ({ storeId, lineItems: { a: { productId: "p1", size: "9", sourceType: "return", originalSaleId, ...over } } });
const base = (over = {}) => ({
  returns: [ret()],
  records: { RET1: rec("pe") },
  soldCells: { [soldKey("SALE1", "p1", "9")]: "hub2" },
  cells: { [cellKey("marathon-pine", "p1", "9")]: 1 },
  log: {},
  ...over,
});

describe("what gets moved", () => {
  it("a PE return booked to Pine goes to the hub the original sale deducted", () => {
    const p = planRepair(base());
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]).toMatchObject({ from: "marathon-pine", toHub: "hub2", qty: 1, takenAt: "marathon-pe", returnRecordId: "RET1", movementId: repairMovementId("return:RET1:marathon-pine:p1:9") });
    expect(p.shortAtSource).toEqual([]);
    expect(p.undetermined).toEqual([]);
  });

  it("covers Trophy, and Hub 3 / Concrete / the stockroom as the wrong destination", () => {
    for (const to of ["hub3", "concrete", "concrete-stockroom"]) {
      const p = planRepair(base({ returns: [ret({ to, mvId: `return:RET1:${to}:p1:9` })], records: { RET1: rec("trophy") }, soldCells: { [soldKey("SALE1", "p1", "9")]: "hub1" }, cells: { [cellKey(to, "p1", "9")]: 3 } }));
      expect(p.moves[0]).toMatchObject({ from: to, toHub: "hub1", takenAt: "trophy" });
    }
  });

  it("a refund keyed by the original record uses that record as the original sale", () => {
    const p = planRepair(base({ records: { RET1: { storeId: "pe", lineItems: { a: { productId: "p1", size: "9" } } } }, soldCells: { [soldKey("RET1", "p1", "9")]: "hub1" } }));
    expect(p.moves[0].toHub).toBe("hub1");
  });

  it("follows a layby completion id back to the layby that deducted", () => {
    expect(originalSaleIdsFor(ret(), rec("pe", "LAY9~C"))).toEqual(["LAY9~C", "LAY9"]);
    const p = planRepair(base({ records: { RET1: rec("pe", "LAY9~C") }, soldCells: { [soldKey("LAY9", "p1", "9")]: "hub2" } }));
    expect(p.moves[0].toHub).toBe("hub2");
  });

  it("matches a half size through its encoded key", () => {
    const p = planRepair({
      returns: [ret({ size: "5_5", mvId: "return:RET1:hub3:p1:5_5", to: "hub3" })],
      records: { RET1: rec("pe", "SALE1", { size: "5.5" }) },
      soldCells: { [soldKey("SALE1", "p1", "5.5")]: "hub1" },
      cells: { [cellKey("hub3", "p1", "5.5")]: 1 },
    });
    expect(p.moves).toHaveLength(1);
  });
});

describe("what is set aside, never forced", () => {
  it("(a) the Section 1 cell no longer holds the unit", () => {
    const p = planRepair(base({ cells: { [cellKey("marathon-pine", "p1", "9")]: 0 } }));
    expect(p.moves).toEqual([]);
    expect(p.shortAtSource[0]).toMatchObject({ onHand: 0, toHub: "hub2", qty: 1 });
  });

  it("(a) two returns into one cell that now holds one: the first moves, the second is listed", () => {
    const p = planRepair(base({
      returns: [ret(), ret({ mvId: "return:RET2:marathon-pine:p1:9", recordId: "RET2", ts: "2026-09-02T10:00:00.000Z" })],
      records: { RET1: rec("pe"), RET2: rec("trophy", "SALE2") },
      soldCells: { [soldKey("SALE1", "p1", "9")]: "hub2", [soldKey("SALE2", "p1", "9")]: "hub1" },
    }));
    expect(p.moves.map((m) => m.returnRecordId)).toEqual(["RET1"]);
    expect(p.shortAtSource.map((m) => m.returnRecordId)).toEqual(["RET2"]);
    expect(p.shortAtSource[0].alreadyClaimedByEarlierMoves).toBe(1);
  });

  it("(b) no sold movement for the original sale — and NO fallback hub is invented", () => {
    const p = planRepair(base({ soldCells: {} }));
    expect(p.moves).toEqual([]);
    expect(p.undetermined[0]).toMatchObject({ why: "no sold movement was found for the original sale", originalSaleIds: ["SALE1"] });
    expect(p.undetermined[0].toHub).toBeUndefined();
  });

  it("(b) the original sale deducted a shop, Central or a Section 1 hub", () => {
    for (const loc of ["marathon-pe", "central", "hub3", "marathon-pine"]) {
      const p = planRepair(base({ soldCells: { [soldKey("SALE1", "p1", "9")]: loc } }));
      expect(p.moves, loc).toEqual([]);
      expect(p.undetermined[0].why).toMatch(/not a Section 2 hub/);
    }
  });

  it("(b) the return record is missing or names no store", () => {
    expect(planRepair(base({ records: {} })).undetermined[0].why).toBe("the return record was not found");
    expect(planRepair(base({ records: { RET1: rec(null) } })).undetermined[0].why).toMatch(/no known store/);
  });
});

describe("what is not a repair at all", () => {
  it("a return taken at Pine or Concrete and booked in Section 1 is left alone", () => {
    for (const store of ["pine", "concrete"]) {
      const p = planRepair(base({ records: { RET1: rec(store) } }));
      expect(p.moves).toEqual([]);
      expect(p.undetermined).toEqual([]);
      expect(p.notSection2).toHaveLength(1);
    }
  });

  it("a return booked inside Section 2 or at Central is not touched", () => {
    for (const to of ["hub1", "hub2", "marathon-pe", "trophy", "central"]) {
      const p = planRepair(base({ returns: [ret({ to })] }));
      expect(p.moves).toEqual([]);
      expect(p.notSection1Destination).toHaveLength(1);
    }
  });
});

describe("idempotency", () => {
  it("a return already in the repair log is never planned again", () => {
    const first = planRepair(base());
    const update = buildMoveUpdate(first.moves[0], { fromCell: { qty: 1, v: 4 }, toCell: { qty: 2, v: 7 }, nowIso: "2026-10-02T09:00:00.000Z", actor: "repair" });
    const logEntry = update[`${LOG_ROOT}/${first.moves[0].logKey}`];
    // after the first run the unit has left Pine and the log has the entry
    const second = planRepair(base({ cells: { [cellKey("marathon-pine", "p1", "9")]: 0 }, log: { [logKeyFor(ret().mvId)]: logEntry } }));
    expect(second.moves).toEqual([]);
    expect(second.shortAtSource).toEqual([]);
    expect(second.alreadyRepaired).toHaveLength(1);
  });

  it("the corrective movement id is a function of the return movement alone", () => {
    expect(repairMovementId("return:RET1:marathon-pine:p1:9")).toBe("repair:sections-return:return:RET1:marathon-pine:p1:9");
    expect(planRepair(base()).moves[0].movementId).toBe(planRepair(base()).moves[0].movementId);
  });
});

describe("the write", () => {
  const move = planRepair(base()).moves[0];

  it("is one update: both cells, a NEW movement tagged with the reason, and the log entry", () => {
    const u = buildMoveUpdate(move, { fromCell: { qty: 3, v: 4, state: "live" }, toCell: { qty: 2, v: 7 }, nowIso: "T", actor: "repair" });
    expect(Object.keys(u).sort()).toEqual([
      `${LOG_ROOT}/${move.logKey}`, "stock/hub2/p1/9", "stock/marathon-pine/p1/9", `stock_movements/${move.movementId}`,
    ].sort());
    expect(u["stock/marathon-pine/p1/9"]).toMatchObject({ qty: 2, v: 5, state: "live", mv: move.movementId });
    expect(u["stock/hub2/p1/9"]).toMatchObject({ qty: 3, v: 8 });
    expect(u[`stock_movements/${move.movementId}`]).toMatchObject({
      type: "transfer_out", from: "marathon-pine", to: "hub2", qty: 1, reason: REPAIR_REASON,
      link: { returnMovementId: "return:RET1:marathon-pine:p1:9", returnRecordId: "RET1" },
    });
  });

  it("moves only: the two cells' total is unchanged and neither goes negative", () => {
    const u = buildMoveUpdate(move, { fromCell: { qty: 1 }, toCell: null, nowIso: "T", actor: "repair" });
    expect(u["stock/marathon-pine/p1/9"].qty + u["stock/hub2/p1/9"].qty).toBe(1);
    expect(u["stock/marathon-pine/p1/9"].qty).toBe(0);
  });

  it("refuses when the live source cell cannot cover it, rather than going negative", () => {
    expect(buildMoveUpdate(move, { fromCell: { qty: 0 }, toCell: { qty: 5 }, nowIso: "T", actor: "repair" })).toBe(null);
    expect(buildMoveUpdate(move, { fromCell: null, toCell: { qty: 5 }, nowIso: "T", actor: "repair" })).toBe(null);
  });

  it("never touches the original return movement or the return record", () => {
    const u = buildMoveUpdate(move, { fromCell: { qty: 1 }, toCell: null, nowIso: "T", actor: "repair" });
    expect(Object.keys(u).some((k) => k === "stock_movements/return:RET1:marathon-pine:p1:9" || k.startsWith("pos/"))).toBe(false);
  });
});
