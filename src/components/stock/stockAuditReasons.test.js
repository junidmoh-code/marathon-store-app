// ─── STOCK AUDIT — the refusal string is a CONTRACT, not a name ──────────────
// The screen turns applyMovement's refusal reasons into sentences staff can
// act on. It shipped keyed on "expect_mismatch", which applyMovement has never
// returned — so the one message written for this feature's headline race (stock
// moved between the list and the tap) never fired, and staff met a raw code.
//
// The unit tests could not catch it: the mock invented the same wrong string on
// both sides, so both halves agreed with each other and neither agreed with the
// real function. THAT is why this test reads applyMovement's own SOURCE rather
// than calling a fake — a mock cannot be the witness for a contract it is
// standing in for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STALE, FAILURE } from "./StockAuditView.jsx";

const SRC = readFileSync(new URL("./applyMovement.js", import.meta.url), "utf8");

describe("the stale-expectation contract", () => {
  it("names the string applyMovement actually returns", () => {
    expect(SRC).toContain(`reason: "${STALE}"`);
  });

  it("every reason applyMovement can return has a sentence", () => {
    // Read the real function's refusal vocabulary and require an answer for
    // each. A reason added there without one here reaches a staff member as a
    // raw code at a shelf, which is a dead end — this is the drift that shipped
    // once already and the reason to check the whole set, not just the one.
    const reasons = [...new Set([...SRC.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]))];
    expect(reasons.length).toBeGreaterThan(5);
    const missing = reasons.filter((r) => !(r in FAILURE));
    expect(missing).toEqual([]);
  });
});
