// The dropped-return repair plan: where each unit goes, what is set aside,
// and that a second run restocks nothing.
import { describe, it, expect } from "vitest";
import { planDroppedRepair, buildRestockUpdate, logKeyFor, repairMovementId, unitsByLocation, REPAIR_REASON, LOG_ROOT } from "./dropped-return-repair-core.mjs";

const shoe = (over = {}) => ({ recordId: "RET-0001", originalSaleId: "SALE-0001", kind: "layby cancel", storeId: "trophy", productId: "p-shoe", size: "8", qty: 1, category: "Footwear", soldFrom: "hub2", name: "A shoe", at: 1, ...over });
const shirt = (over = {}) => ({ recordId: "RET-0002", originalSaleId: "SALE-0002", kind: "refund", storeId: "pe", productId: "p-shirt", size: "M", qty: 1, category: "Clothing", soldFrom: "marathon-pe", name: "A shirt", at: 2, ...over });
const exists = { "p-shoe": true, "p-shirt": true };
const plan = (dropped, extra = {}) => planDroppedRepair({ dropped, products: exists, ...extra });

describe("where each dropped unit goes", () => {
  it("a sneaker goes back to the hub the original sale deducted from", () => {
    expect(plan([shoe()]).restocks[0]).toMatchObject({ to: "hub2", qty: 1, productId: "p-shoe", sizeKey: "8" });
    expect(plan([shoe({ soldFrom: "hub1", storeId: "pe" })]).restocks[0].to).toBe("hub1");
  });

  it("clothing goes back to the shop that took the return, whatever the sale deducted", () => {
    expect(plan([shirt()]).restocks[0].to).toBe("marathon-pe");
    expect(plan([shirt({ storeId: "trophy", soldFrom: "marathon-pe" })]).restocks[0].to).toBe("trophy");
    expect(plan([shirt({ soldFrom: null })]).restocks[0].to).toBe("marathon-pe");
    for (const category of ["Accessories", "Perfume", null]) expect(plan([shirt({ category })]).restocks[0].to).toBe("marathon-pe");
  });

  it("a half size is booked under its encoded key", () => {
    expect(plan([shoe({ size: "5.5" })]).restocks[0].sizeKey).toBe("5_5");
    expect(plan([shirt({ size: null })]).restocks[0].sizeKey).toBe("_");
  });

  it("a merged-away product's unit is booked under its survivor, and says so", () => {
    const p = planDroppedRepair({ dropped: [shoe({ productId: "p-old" })], products: { "p-old": { survivor: "p-new" } } });
    expect(p.restocks[0]).toMatchObject({ productId: "p-new", bookedUnder: "p-old", to: "hub2" });
  });

  it("totals per location", () => {
    const p = plan([shoe(), shoe({ recordId: "RET-0003", storeId: "pe" }), shirt(), shirt({ recordId: "RET-0004", storeId: "trophy", qty: 2 })]);
    expect(unitsByLocation(p.restocks)).toEqual({ hub2: 2, "marathon-pe": 1, trophy: 2 });
  });
});

describe("what is set aside, never forced", () => {
  it("footwear whose original hub was not found — no fallback hub is invented", () => {
    const p = plan([shoe({ soldFrom: null })]);
    expect(p.restocks).toEqual([]);
    expect(p.setAside[0].why).toMatch(/hub the original sale deducted from was not found/);
  });

  it("footwear whose sale deducted a shop, Central, or a hub across the wall", () => {
    for (const soldFrom of ["marathon-pe", "trophy", "central", "hub3"]) {
      const p = plan([shoe({ soldFrom })]);
      expect(p.restocks, soldFrom).toEqual([]);
      expect(p.setAside[0].why).toMatch(/not a hub in the returning shop's section/);
    }
  });

  it("NEVER restocks a Marathon PE / Trophy return into Section 1, or a Section 1 return into Section 2", () => {
    const s1 = ["hub3", "marathon-pine", "concrete"];
    const s2 = ["hub1", "hub2", "marathon-pe", "trophy"];
    for (const storeId of ["pe", "trophy"]) for (const soldFrom of [...s1, ...s2, "central", null]) for (const d of [shoe({ storeId, soldFrom }), shirt({ storeId, soldFrom })]) {
      for (const r of plan([d]).restocks) expect(s1.includes(r.to), `${storeId} ← ${soldFrom}`).toBe(false);
    }
    for (const storeId of ["pine", "concrete"]) for (const soldFrom of [...s1, ...s2]) for (const d of [shoe({ storeId, soldFrom }), shirt({ storeId, soldFrom })]) {
      for (const r of plan([d]).restocks) expect(s2.includes(r.to), `${storeId} ← ${soldFrom}`).toBe(false);
    }
  });

  it("a product that no longer exists and has no survivor", () => {
    expect(planDroppedRepair({ dropped: [shoe()], products: {} }).setAside[0].why).toMatch(/no merge survivor/);
    expect(planDroppedRepair({ dropped: [shoe()], products: { "p-shoe": {} } }).setAside[0].why).toMatch(/no merge survivor/);
  });

  it("a sale that sold short is never guessed at — set aside, whatever the quantities", () => {
    for (const d of [shirt({ qty: 3, soldShortfall: 1 }), shirt({ qty: 1, soldShortfall: 2 }), shirt({ qty: 1, soldShortfall: 1 })]) {
      const p = plan([d]);
      expect(p.restocks).toEqual([]);
      expect(p.setAside[0].why).toMatch(/needs a person to decide/);
    }
  });

  it("a store the registry does not know, and a line with no quantity", () => {
    expect(plan([shirt({ storeId: "mobile" })]).setAside[0].why).toMatch(/does not know/);
    expect(plan([shirt({ qty: 0 })]).setAside[0].why).toMatch(/no quantity/);
  });
});

describe("idempotency", () => {
  it("a line already in the repair log is never planned again", () => {
    const first = plan([shoe(), shirt()]);
    const log = {};
    for (const r of first.restocks) {
      const u = buildRestockUpdate(r, { cell: { qty: 0, v: 1 }, nowIso: "T", actor: "repair" });
      log[r.logKey] = u[`${LOG_ROOT}/${r.logKey}`];
    }
    const second = plan([shoe(), shirt()], { log });
    expect(second.restocks).toEqual([]);
    expect(second.alreadyRepaired).toHaveLength(2);
  });

  it("the movement id and the log key are functions of the record, product and size alone", () => {
    expect(logKeyFor(shoe())).toBe("RET-0001:p-shoe:8");
    expect(repairMovementId(shoe({ size: "5.5" }))).toBe("repair:dropped-return:RET-0001:p-shoe:5_5");
    // two lines of ONE record get two keys
    expect(logKeyFor(shoe())).not.toBe(logKeyFor(shoe({ productId: "p-other" })));
  });
});

describe("the write", () => {
  const r = plan([shoe()]).restocks[0];

  it("is one update: the cell, a NEW tagged movement linked to the original record, and the log entry", () => {
    const u = buildRestockUpdate(r, { cell: { qty: 2, v: 7, state: "live" }, nowIso: "T", actor: "repair" });
    expect(Object.keys(u).sort()).toEqual([`${LOG_ROOT}/${r.logKey}`, "stock/hub2/p-shoe/8", `stock_movements/${r.movementId}`].sort());
    expect(u["stock/hub2/p-shoe/8"]).toMatchObject({ qty: 3, v: 8, state: "live", mv: r.movementId });
    expect(u[`stock_movements/${r.movementId}`]).toMatchObject({
      type: "return", to: "hub2", qty: 1, reason: REPAIR_REASON, link: { saleId: "RET-0001", originalSaleId: "SALE-0001" },
      before: { hub2: 2 }, after: { hub2: 3 },
    });
  });

  it("adds exactly the unit, creates the cell when there is none, and never pays off a legacy negative", () => {
    expect(buildRestockUpdate(r, { cell: null, nowIso: "T", actor: "a" })["stock/hub2/p-shoe/8"].qty).toBe(1);
    expect(buildRestockUpdate(r, { cell: { qty: -3 }, nowIso: "T", actor: "a" })["stock/hub2/p-shoe/8"].qty).toBe(1);
  });

  it("never touches the original POS record or any existing movement", () => {
    const u = buildRestockUpdate(r, { cell: null, nowIso: "T", actor: "a" });
    expect(Object.keys(u).some((k) => k.startsWith("pos/") || k.startsWith("stock_movements/return:") || k.startsWith("stock_movements/sold:"))).toBe(false);
  });
});
