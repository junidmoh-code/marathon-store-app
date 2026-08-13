import { describe, it, expect } from "vitest";
import { seedCellUntouched, undoCellTxn, pathLoc, pathSizeKey, seededSizesByLoc, solveUndoBlockers } from "./solveUndo";

// The exact cell a Solve writes — copied from the live incident this module
// was born from (LV bag → Marathon PE, 2026-08-13 17:20:40Z).
const SEED = { lastType: "count", mv: "seed", qty: 0, state: "live", updatedAt: "2026-08-13T17:20:40.110Z", updatedBy: "someUid", v: 0 };

describe("seedCellUntouched — the only state an undo may delete", () => {
  it("accepts the exact untouched seed", () => {
    expect(seedCellUntouched(SEED)).toBe(true);
  });
  it("refuses the moment anything real lands on the cell", () => {
    expect(seedCellUntouched({ ...SEED, qty: 1 })).toBe(false);            // stock arrived
    expect(seedCellUntouched({ ...SEED, v: 1 })).toBe(false);              // any versioned write
    expect(seedCellUntouched({ ...SEED, mv: "sold:xyz" })).toBe(false);    // movement replaced the marker
    expect(seedCellUntouched({ ...SEED, lastType: "transfer_in" })).toBe(false);
    expect(seedCellUntouched(null)).toBe(false);
    expect(seedCellUntouched(undefined)).toBe(false);
  });
});

describe("undoCellTxn — the transaction decision, where the TOCTOU dies", () => {
  it("deletes an untouched seed (returns null = commit delete)", () => {
    expect(undoCellTxn(SEED)).toBe(null);
  });
  it("ABORTS on a touched cell (returns undefined) — a racing sale/count is never erased", () => {
    expect(undoCellTxn({ ...SEED, qty: 2, v: 1, mv: "recv" })).toBe(undefined);
  });
  it("commits a no-op on null instead of aborting — the RTDB local-cache-first retry pattern", () => {
    // Aborting on null would bail on the cache before the server value ever
    // arrives; committing null-onto-null forces the round trip and a re-run
    // against the real cell.
    expect(undoCellTxn(null)).toBe(null);
    expect(undoCellTxn(undefined)).toBe(null);
  });
});

describe("path helpers over the recorded seed paths", () => {
  const paths = ["stock/marathon-pe/p1/_", "stock/hub2/p1/M", "stock/hub2/p1/_"];
  it("parse loc and sizeKey", () => {
    expect(pathLoc(paths[0])).toBe("marathon-pe");
    expect(pathSizeKey(paths[0])).toBe("_");
    expect(pathSizeKey(paths[1])).toBe("M");
  });
  it("group seeded sizes by location", () => {
    const byLoc = seededSizesByLoc(paths);
    expect([...byLoc["marathon-pe"]]).toEqual(["_"]);
    expect([...byLoc.hub2].sort()).toEqual(["M", "_"]);
  });
});

describe("solveUndoBlockers — snapshot identity, never clocks", () => {
  const paths = ["stock/marathon-pe/p1/_", "stock/hub2/p1/_"];
  const PRIOR_LOCK = { createdAt: "2026-08-13T16:45:04.829Z", qty: 3, refillId: "-Ozw-rvcjRIKCaEi1Z5Q" };

  it("no locks anywhere → no blockers", () => {
    expect(solveUndoBlockers({ paths, openByLoc: { "marathon-pe": null, hub2: null }, priorOpenByLoc: { hub2: null } })).toEqual([]);
  });
  it("a lock that was ALREADY THERE at solve time does not block — it existed without the cell", () => {
    // The live LV bag: a 16:45 target-row intent under a 17:20 mistaken
    // solve. Same refillId at solve time and undo time → same lock → allow.
    expect(solveUndoBlockers({
      paths,
      openByLoc: { hub2: { _: PRIOR_LOCK } },
      priorOpenByLoc: { hub2: { _: PRIOR_LOCK } },
    })).toEqual([]);
  });
  it("a lock NOT in the solve-time snapshot blocks and names the order — even if its createdAt PREDATES the solve", () => {
    // The reviewers' second HIGH: a lock's createdAt is its scan's START
    // time, so a scan spanning the solve carries an 'earlier' timestamp
    // while being causally after. Identity comparison catches it; a clock
    // comparison would have waved it through.
    const b = solveUndoBlockers({
      paths,
      openByLoc: { hub2: { _: { createdAt: "2026-08-13T17:15:04.000Z", qty: 3, refillId: "-OzwNEWLOCK", orderId: "R036-99" } } },
      priorOpenByLoc: { hub2: null },
    });
    expect(b.length).toBe(1);
    expect(b[0]).toMatch(/reject it in the queue first/);
    expect(b[0]).toMatch(/R036-99/);
  });
  it("a REPLACED lock at the same size blocks — different refillId means fresh engine work", () => {
    const b = solveUndoBlockers({
      paths,
      openByLoc: { hub2: { _: { ...PRIOR_LOCK, refillId: "-OzwDIFFERENT" } } },
      priorOpenByLoc: { hub2: { _: PRIOR_LOCK } },
    });
    expect(b.length).toBe(1);
  });
  it("a lock on a size the solve did NOT seed never blocks — undo does not touch its cell", () => {
    expect(solveUndoBlockers({
      paths: ["stock/hub2/p1/_"],
      openByLoc: { hub2: { M: { createdAt: "2026-08-13T18:00:00.000Z", refillId: "-OzwUnrelated" } } },
      priorOpenByLoc: { hub2: null },
    })).toEqual([]);
  });
});
