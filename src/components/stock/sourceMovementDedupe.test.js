import { describe, it, expect } from "vitest";
import { checkSourceMovementDuplicate } from "./sourceMovementDedupe";

// A fake /stock_movements node. Keys are movement ids, values are the stored
// movement records (only productId matters to the dedupe decision).
const ledger = (records) => {
  const reads = [];
  return {
    reads,
    getMovement: async (id) => { reads.push(id); return records[id] || null; },
  };
};

// Ids as the Source panel builds them. NEW = pid-derived, LEGACY = the old
// name-derived form that twins collided on.
const NEW_A    = "srcful_2026-08-03_pTwinA_9_0";
const NEW_B    = "srcful_2026-08-03_pTwinB_9_0";
const LEGACY   = "srcful_2026-08-03_Nike_SB_Dunk_Low_Green_White_9_0";

describe("checkSourceMovementDuplicate — Source fulfil dual-id check", () => {
  it("same pid, same size, same day, second attempt → suppressed as duplicate", () => {
    // The ordinary double-tap / retry case. Must stay suppressed, or the fix
    // would trade a wrong-product bug for a double-deduction bug.
    const { getMovement } = ledger({ [NEW_A]: { productId: "pTwinA", size: "9" } });
    return checkSourceMovementDuplicate({ getMovement, newId: NEW_A, legacyId: LEGACY, productId: "pTwinA" })
      .then(r => expect(r).toEqual({ duplicate: true, viaLegacy: false }));
  });

  it("TWIN pid, identical name, same size, same day → NOT a duplicate, the transfer lands", async () => {
    // THE BUG. Twin A already fulfilled — under the legacy name id, which twin B
    // would also derive. B's own pid id is absent, and the legacy record belongs
    // to A (different productId), so B must be allowed through.
    // A check weakened to "legacy id exists → duplicate" fails exactly here.
    const { getMovement } = ledger({ [LEGACY]: { productId: "pTwinA", size: "9" } });
    const r = await checkSourceMovementDuplicate({ getMovement, newId: NEW_B, legacyId: LEGACY, productId: "pTwinB" });
    expect(r).toEqual({ duplicate: false, viaLegacy: false });
  });

  it("a movement written under the LEGACY name id → recognised, not re-applied, flagged viaLegacy", async () => {
    // Cutover safety: this transfer really did happen pre-deploy. Re-applying it
    // under the new pid id would double-move stock.
    const { getMovement } = ledger({ [LEGACY]: { productId: "pTwinA", size: "9" } });
    const r = await checkSourceMovementDuplicate({ getMovement, newId: NEW_A, legacyId: LEGACY, productId: "pTwinA" });
    expect(r).toEqual({ duplicate: true, viaLegacy: true });
  });

  it("nothing recorded under either id → not a duplicate", async () => {
    const { getMovement } = ledger({});
    const r = await checkSourceMovementDuplicate({ getMovement, newId: NEW_A, legacyId: LEGACY, productId: "pTwinA" });
    expect(r).toEqual({ duplicate: false, viaLegacy: false });
  });

  it("the NEW id wins without ever reading the legacy id", async () => {
    // Once a cell is post-cutover the legacy read is pure waste; it must be skipped.
    const l = ledger({ [NEW_A]: { productId: "pTwinA" }, [LEGACY]: { productId: "pTwinA" } });
    const r = await checkSourceMovementDuplicate({ getMovement: l.getMovement, newId: NEW_A, legacyId: LEGACY, productId: "pTwinA" });
    expect(r).toEqual({ duplicate: true, viaLegacy: false });
    expect(l.reads).toEqual([NEW_A]);
  });

  it("no legacy id supplied (pid-less group, or key unchanged) → only the new id is read", async () => {
    const l = ledger({});
    await checkSourceMovementDuplicate({ getMovement: l.getMovement, newId: NEW_A, legacyId: null, productId: "pTwinA" });
    expect(l.reads).toEqual([NEW_A]);
    // A legacy id identical to the new one (pid-less group: both are the name
    // key) must not be read twice either.
    const l2 = ledger({});
    await checkSourceMovementDuplicate({ getMovement: l2.getMovement, newId: LEGACY, legacyId: LEGACY, productId: "pLegacy" });
    expect(l2.reads).toEqual([LEGACY]);
  });

  it("a legacy record with no productId at all does not block the transfer", async () => {
    // Defensive: an ancient/hand-written movement lacking productId can't be
    // proven to be ours, so it must not suppress a real transfer.
    const { getMovement } = ledger({ [LEGACY]: { size: "9" } });
    const r = await checkSourceMovementDuplicate({ getMovement, newId: NEW_A, legacyId: LEGACY, productId: "pTwinA" });
    expect(r).toEqual({ duplicate: false, viaLegacy: false });
  });

  it("partial-fulfil ids stay independent — the _{alreadySent} suffix is part of the id", async () => {
    // Sending unit 2 of 3 must not be suppressed by unit 1's movement.
    const { getMovement } = ledger({ "srcful_2026-08-03_pTwinA_9_0": { productId: "pTwinA" } });
    const r = await checkSourceMovementDuplicate({
      getMovement, newId: "srcful_2026-08-03_pTwinA_9_1",
      legacyId: "srcful_2026-08-03_Nike_SB_Dunk_Low_Green_White_9_1", productId: "pTwinA",
    });
    expect(r).toEqual({ duplicate: false, viaLegacy: false });
  });
});
