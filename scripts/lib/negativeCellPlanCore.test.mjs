// ─── NEGATIVE-CELL CORRECTION — BEHAVIOURAL TESTS ────────────────────────────
// Run: npx vitest run scripts/lib/negativeCellPlanCore.test.mjs
//
// Two of these tests exist because CodeRabbit found the defects on PR #379 and the
// dry run could not have. Each names the defect it pins, so a future edit that
// reintroduces one fails a test that explains itself rather than a bare assertion.

import { describe, it, expect } from "vitest";
import {
  classifyLeg, correctionState, guardDrift, verifyLeg, nextVersion,
  APPLIED, PENDING, DRIFTED, NO_CELL,
} from "./negativeCellPlanCore.mjs";

// The three real corrections, as the audit recorded them.
const TROPHY_LEG = { expectedBefore: 2, expectedAfter: 1 };
const PE_LEG = { expectedBefore: -1, expectedAfter: 0 };

describe("classifyLeg — the audited state, not a delta", () => {
  it("is PENDING when the cell still holds what the audit recorded", () => {
    expect(classifyLeg({ ...PE_LEG, live: -1, movementExists: false })).toBe(PENDING);
    expect(classifyLeg({ ...TROPHY_LEG, live: 2, movementExists: false })).toBe(PENDING);
  });

  it("is APPLIED when the movement landed and the cell holds the corrected value", () => {
    expect(classifyLeg({ ...PE_LEG, live: 0, movementExists: true })).toBe(APPLIED);
  });

  it("REFUSES a cell that drifted since the audit, rather than correcting onto it", () => {
    // The whole point. The audit concluded "PE holds −1". At −3 that conclusion
    // does not transfer, and the old delta-based version would have moved it to −2:
    // a number nobody reviewed, sitting on a cell nobody re-examined.
    expect(classifyLeg({ ...PE_LEG, live: -3, movementExists: false })).toBe(DRIFTED);
    expect(classifyLeg({ ...TROPHY_LEG, live: 5, movementExists: false })).toBe(DRIFTED);
  });

  it("distinguishes a missing cell from a moved one", () => {
    expect(classifyLeg({ ...PE_LEG, live: null, movementExists: false })).toBe(NO_CELL);
    expect(classifyLeg({ ...PE_LEG, live: undefined, movementExists: false })).toBe(NO_CELL);
  });

  it("consults the ledger BEFORE the quantity, so a coincidence is not read as success", () => {
    // A heal from −1 → 0 on a cell that reached 0 by other means: PENDING by
    // expectedBefore is false, APPLIED by expectedAfter is true. Only the movement
    // record separates "we did this" from "it looks like we did".
    expect(classifyLeg({ ...PE_LEG, live: 0, movementExists: false })).toBe(DRIFTED);
    // And a movement that exists over a quantity that is NOT the corrected one is
    // drift too — something moved the cell after the correction landed.
    expect(classifyLeg({ ...PE_LEG, live: 4, movementExists: true })).toBe(DRIFTED);
  });
});

describe("correctionState — a paired transfer is all-or-nothing", () => {
  it("applies only when every leg is pending", () => {
    expect(correctionState([PENDING, PENDING])).toBe("apply");
    expect(correctionState([PENDING])).toBe("apply");
  });

  it("skips only when every leg is already applied", () => {
    expect(correctionState([APPLIED, APPLIED])).toBe("skip");
  });

  it("BLOCKS a half-drifted pair — applying one leg would invent a unit", () => {
    // Trophy drifted, PE did not. Healing PE alone raises −1 to 0 with no
    // corresponding decrement anywhere: one bag out of thin air.
    expect(correctionState([DRIFTED, PENDING])).toBe("blocked");
    expect(correctionState([PENDING, DRIFTED])).toBe("blocked");
    // Half-applied is equally refused — that is a partial write to investigate,
    // not a state to write over.
    expect(correctionState([APPLIED, PENDING])).toBe("blocked");
    expect(correctionState([NO_CELL, PENDING])).toBe("blocked");
  });

  it("blocks an empty plan rather than treating it as done", () => {
    expect(correctionState([])).toBe("blocked");
  });
});

describe("guardDrift — the late read before the write", () => {
  it("passes when nothing moved between the match table and the write", () => {
    expect(guardDrift({ staged: { qty: -1, v: 6 }, fresh: { qty: -1, v: 6 }, expectedBefore: -1 })).toBe(null);
  });

  it("refuses when the quantity moved", () => {
    const r = guardDrift({ staged: { qty: -1, v: 6 }, fresh: { qty: -2, v: 7 }, expectedBefore: -1, loc: "marathon-pe" });
    expect(r).toContain("marathon-pe");
    expect(r).toContain("qty -2");
  });

  it("refuses a sale-then-return that lands back on the SAME quantity", () => {
    // The case a quantity-only check cannot see. The cell reads −1 before and −1
    // after, but two movements happened in between, so the correction's before/after
    // ledger record would misdescribe the history it claims to document.
    const r = guardDrift({ staged: { qty: -1, v: 6 }, fresh: { qty: -1, v: 8 }, expectedBefore: -1, loc: "marathon-pe" });
    expect(r).toContain("v moved 6 → 8");
  });

  it("refuses a cell that vanished between the two reads", () => {
    expect(guardDrift({ staged: { qty: -1, v: 6 }, fresh: null, expectedBefore: -1 })).toContain("qty null");
  });
});

describe("verifyLeg — absolute, so a re-run is not a false alarm", () => {
  it("passes on the corrected value", () => {
    expect(verifyLeg({ nowQty: 0, expectedAfter: 0 })).toBe(true);
    expect(verifyLeg({ nowQty: 1, expectedAfter: 1 })).toBe(true);
  });

  it("SECOND RUN over an already-applied correction still verifies", () => {
    // The regression this pins. The old check computed `want = snapshotQty ± qty`
    // from the pre-run snapshot. On a re-run the snapshot already held the
    // corrected 0, so `want` became 0 + 1 = 1 and a perfectly successful,
    // correctly-skipped correction reported ⛔ MISMATCH.
    const snapshotQtyOnSecondRun = 0;      // already corrected
    const expectedAfter = 0;
    expect(verifyLeg({ nowQty: snapshotQtyOnSecondRun, expectedAfter })).toBe(true);
    // The old expression, for contrast — it fails on identical, correct data:
    const oldWant = snapshotQtyOnSecondRun + 1;
    expect(snapshotQtyOnSecondRun === oldWant).toBe(false);
  });

  it("fails when the cell does not hold the corrected value", () => {
    expect(verifyLeg({ nowQty: -1, expectedAfter: 0 })).toBe(false);
    expect(verifyLeg({ nowQty: null, expectedAfter: 0 })).toBe(false);
  });
});

describe("nextVersion", () => {
  it("increments an existing version", () => {
    expect(nextVersion({ qty: -1, v: 6 })).toBe(7);
    expect(nextVersion({ qty: 2, v: 0 })).toBe(1);
  });

  it("starts a new or version-less cell at 0", () => {
    expect(nextVersion(null)).toBe(0);
    expect(nextVersion({ qty: 3 })).toBe(0);
  });
});

describe("the three live corrections, end to end through the pure logic", () => {
  const PLAN = [
    { pid: "p1782635759411", legs: [{ loc: "trophy", ...TROPHY_LEG }, { loc: "marathon-pe", ...PE_LEG }] },
    { pid: "p1782640227755", legs: [{ loc: "marathon-pe", ...PE_LEG }] },
    { pid: "p1782641125804", legs: [{ loc: "marathon-pe", ...PE_LEG }] },
  ];
  // Live quantities read from production on 2026-08-18, before anything was applied.
  const LIVE = { trophy: { p1782635759411: 2 }, "marathon-pe": { p1782635759411: -1, p1782640227755: -1, p1782641125804: -1 } };

  it("all three are apply-able on a first run", () => {
    for (const p of PLAN) {
      const states = p.legs.map((l) => classifyLeg({ ...l, live: LIVE[l.loc]?.[p.pid], movementExists: false }));
      expect(correctionState(states)).toBe("apply");
    }
  });

  it("all three are skip-able, not re-writable, on a second run", () => {
    for (const p of PLAN) {
      const states = p.legs.map((l) => classifyLeg({ ...l, live: l.expectedAfter, movementExists: true }));
      expect(correctionState(states)).toBe("skip");
      // …and verification still passes, which is the bug that was fixed.
      for (const l of p.legs) expect(verifyLeg({ nowQty: l.expectedAfter, expectedAfter: l.expectedAfter })).toBe(true);
    }
  });

  it("the network total is unchanged by the paired transfer and unchanged by the heals", () => {
    const paired = PLAN[0];
    const delta = paired.legs.reduce((n, l) => n + (l.expectedAfter - l.expectedBefore), 0);
    expect(delta).toBe(0);            // one unit moves; none is created
    // A heal DOES raise the recorded total by one — that is the point of clearing a
    // debt — but it creates nothing SELLABLE, because avail() clamped −1 to 0 already.
    for (const p of PLAN.slice(1)) {
      const d = p.legs.reduce((n, l) => n + (l.expectedAfter - l.expectedBefore), 0);
      expect(d).toBe(1);
      const sellableBefore = p.legs.reduce((n, l) => n + Math.max(0, l.expectedBefore), 0);
      const sellableAfter = p.legs.reduce((n, l) => n + Math.max(0, l.expectedAfter), 0);
      expect(sellableAfter).toBe(sellableBefore);
    }
  });
});
