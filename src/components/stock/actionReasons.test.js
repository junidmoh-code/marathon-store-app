// ─── EVERY DISABLED ACTION CARRIES A REASON ──────────────────────────────────
// Owner directive 2026-08-10: "never grey something without saying why". The
// contract these tests defend is deliberately absolute — null means AVAILABLE,
// any string means DISABLED and is the text the operator reads — because that is
// what lets a component write `disabled={!!reason}` and be structurally unable to
// produce a silently dead button.
//
// The exhaustive sweep at the bottom is the real guard: it walks every blocking
// input of every action and asserts a non-empty sentence comes back. A future
// disable condition added without a reason fails here rather than shipping as a
// dead button someone has to guess at.
import { describe, it, expect } from "vitest";
import {
  solveReason, solveConfirmReason, moveReason,
  footwearSolveReason, footwearRequestReason, footwearConfirmReason, footwearRequestSubmitReason,
} from "./actionReasons";

// Everything fine — the one input shape that must return null.
const OK = {
  canAct: true, configLoaded: true, configError: false, targetsLoaded: true,
  hasSourceStock: true, policyAtAnyStore: true, ruleOnAnywhere: true, oneSize: false,
};

describe("solveReason — the clothing Solve", () => {
  it("null when the engine really would refill what Solve seeds", () => {
    expect(solveReason(OK)).toBe(null);
  });

  it("a one-size product WITH a policy and source stock is available", () => {
    expect(solveReason({ ...OK, oneSize: true })).toBe(null);
  });

  it("a one-size product with NO policy stays disabled and says what it needs", () => {
    const r = solveReason({ ...OK, oneSize: true, policyAtAnyStore: false });
    expect(r).toMatch(/one-size/i);
    expect(r).toMatch(/target/i);
  });

  it("no stock anywhere stays unactionable and says exactly that", () => {
    expect(solveReason({ ...OK, hasSourceStock: false })).toBe("No stock at any source — there's nothing to send.");
  });

  it("names the SWITCH when refills are off, and the POLICY when they're on", () => {
    // These send an operator to two different places, so they must not collapse
    // into one message (they did before: everything read "no standard sizes").
    expect(solveReason({ ...OK, policyAtAnyStore: false, ruleOnAnywhere: false })).toMatch(/switched off/i);
    expect(solveReason({ ...OK, policyAtAnyStore: false, ruleOnAnywhere: true })).toMatch(/No refill policy/i);
  });

  it("distinguishes a config still loading from one that failed to load", () => {
    expect(solveReason({ ...OK, configLoaded: false })).toMatch(/one moment/i);
    expect(solveReason({ ...OK, configError: true })).toMatch(/Can't read/i);
    // Targets are the other half of the answer — pending is not the same as none.
    expect(solveReason({ ...OK, targetsLoaded: false })).toMatch(/one moment/i);
  });

  it("permission outranks everything — never send someone to check a policy they can't act on", () => {
    const r = solveReason({ ...OK, canAct: false, policyAtAnyStore: false, configLoaded: false });
    expect(r).toMatch(/stock role/i);
  });

  it("called with nothing at all still returns a sentence, never undefined", () => {
    expect(typeof solveReason()).toBe("string");
  });
});

describe("solveConfirmReason / moveReason", () => {
  it("null only when the nominated store actually has qualifying sizes", () => {
    expect(solveConfirmReason({ canAct: true, busy: false, sizesInPlan: 1 })).toBe(null);
    const r = solveConfirmReason({ canAct: true, busy: false, sizesInPlan: 0, storeLabel: "Trophy" });
    expect(r).toMatch(/Trophy/);
    expect(r).toMatch(/other shop|manually/i);
  });
  it("move is available only with a role and a quantity above zero", () => {
    expect(moveReason({ canAct: true, busy: false, units: 3 })).toBe(null);
    expect(moveReason({ canAct: true, busy: false, units: 0 })).toBe("Set a quantity above zero to move.");
    expect(moveReason({ canAct: false, units: 3 })).toMatch(/stock role/i);
    expect(moveReason({ canAct: true, busy: true, units: 3 })).toMatch(/Working/i);
  });
});

describe("the sneaker list carries reasons on the same contract", () => {
  it("available only with a role, a loaded run and something to raise", () => {
    expect(footwearSolveReason({ canAct: true, runLoaded: true, linesAtAnyHub: 1 })).toBe(null);
    expect(footwearSolveReason({ canAct: true, runLoaded: false, linesAtAnyHub: 1 })).toMatch(/aren't set up/i);
    expect(footwearSolveReason({ canAct: true, runLoaded: true, linesAtAnyHub: 0 })).toMatch(/already queued/i);
    expect(footwearSolveReason({ canAct: false })).toMatch(/stock role/i);
  });
  it("request, confirm and submit each answer for themselves", () => {
    expect(footwearRequestReason({ canAct: true })).toBe(null);
    expect(footwearRequestReason({ canAct: false })).toMatch(/stock role/i);
    expect(footwearConfirmReason({ canAct: true, busy: false, lines: 2 })).toBe(null);
    expect(footwearConfirmReason({ canAct: true, busy: false, lines: 0, hubLabel: "Hub 2" })).toMatch(/Hub 2/);
    expect(footwearRequestSubmitReason({ canAct: true, busy: false, units: 1 })).toBe(null);
    expect(footwearRequestSubmitReason({ canAct: true, busy: false, units: 0 })).toMatch(/above zero/i);
  });
});

describe("EXHAUSTIVE — no blocking input may return a silent disable", () => {
  // Every (action, blocking input) pair. If a reason function ever returns a
  // falsy value for a state a component treats as disabled, the button goes grey
  // with nothing on the row — the precise failure this module exists to prevent.
  const cases = [
    // ruleOnAnywhere is deliberately NOT in this list. It is not an independent
    // blocker: it only chooses WHICH no-policy sentence to show. An explicit
    // /stock_targets row outlives the kill switch in the engine (resolveTarget
    // returns it before the switch is read), so "switch off, policy present"
    // must stay AVAILABLE — pinned separately below.
    ["solve", solveReason, OK, ["canAct", "configLoaded", "targetsLoaded", "hasSourceStock", "policyAtAnyStore"]],
    ["solveConfirm", solveConfirmReason, { canAct: true, busy: false, sizesInPlan: 2 }, ["canAct", "sizesInPlan"]],
    ["move", moveReason, { canAct: true, busy: false, units: 2 }, ["canAct", "units"]],
    ["footwearSolve", footwearSolveReason, { canAct: true, runLoaded: true, linesAtAnyHub: 2 }, ["canAct", "runLoaded", "linesAtAnyHub"]],
    ["footwearRequest", footwearRequestReason, { canAct: true }, ["canAct"]],
    ["footwearConfirm", footwearConfirmReason, { canAct: true, busy: false, lines: 2 }, ["canAct", "lines"]],
    ["footwearSubmit", footwearRequestSubmitReason, { canAct: true, busy: false, units: 2 }, ["canAct", "units"]],
  ];
  for (const [name, fn, ok, blockers] of cases) {
    it(`${name}: available when nothing blocks, and every blocker yields a sentence`, () => {
      expect(fn(ok)).toBe(null);
      for (const key of blockers) {
        const r = fn({ ...ok, [key]: key === "canAct" || typeof ok[key] === "boolean" ? false : 0 });
        expect(typeof r, `${name} blocked by ${key} returned ${JSON.stringify(r)}`).toBe("string");
        expect(r.length, `${name} blocked by ${key} returned an empty string`).toBeGreaterThan(10);
      }
      // The busy state is a disable too, and it must speak as well.
      if ("busy" in ok) expect(typeof fn({ ...ok, busy: true })).toBe("string");
    });
  }
  it("configError is a blocker on solve and speaks", () => {
    expect(typeof solveReason({ ...OK, configError: true })).toBe("string");
  });
  it("rule-based refills OFF but a policy still resolving stays AVAILABLE", () => {
    // The explicit-row-survives-the-kill-switch rule, at the reason layer.
    expect(solveReason({ ...OK, ruleOnAnywhere: false, policyAtAnyStore: true })).toBe(null);
  });
  it("reasons are plain sentences — no jargon, no config keys", () => {
    const all = [
      solveReason({ ...OK, policyAtAnyStore: false }),
      solveReason({ ...OK, policyAtAnyStore: false, ruleOnAnywhere: false }),
      solveReason({ ...OK, hasSourceStock: false }),
      moveReason({ canAct: true, units: 0 }),
      footwearSolveReason({ canAct: true, runLoaded: true, linesAtAnyHub: 0 }),
    ];
    for (const r of all) {
      expect(r).not.toMatch(/ruleBasedTargets|defaultRunByStore|stock_targets|resolveTarget|qualifyingSizes|seedLocations/);
      expect(r).toMatch(/[.!]$/);   // a finished sentence, not a fragment
    }
  });
});
