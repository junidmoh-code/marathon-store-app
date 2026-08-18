// ─── NEGATIVE-CELL CORRECTION — THE DECISION LOGIC, EXTRACTED ────────────────
// Run the tests: npx vitest run scripts/lib/negativeCellPlanCore.test.mjs
//
// scripts/fix-negative-pe-bag-cells.mjs writes to production. The three questions
// it has to answer correctly are all pure, so they live here where they can be
// proven against cases the live database will not politely reproduce on demand:
//
//   1. classifyLeg  — is this cell PENDING, already APPLIED, or DRIFTED?
//   2. guardDrift   — did anything move between the match table and the write?
//   3. verifyLeg    — did the correction land?
//
// WHY THIS IS NOT AN ABSTRACTION FOR ITS OWN SAKE. Both defects CodeRabbit found
// on PR #379 were in exactly these three answers, and neither was reachable from a
// dry run against healthy data — the script printed a correct-looking table in both
// the broken and the fixed version. A defect that only appears on the second run,
// or only when a till moved a unit, is one that has to be constructed in a test or
// discovered in production.
//
// THE GOVERNING RULE: A CORRECTION ASSERTS, IT DOES NOT ADAPT.
// Every quantity is declared up front from the audit that justified the correction.
// Nothing here computes `after` from `live`. If the world has moved, the audit that
// concluded "PE holds −1" no longer describes it, and the only safe answer is to
// decline — not to apply the same delta to a baseline nobody reviewed.

/** Movement id present, or not — the only witness of a write that survives a crash. */
export const APPLIED = "APPLIED";
export const PENDING = "PENDING";
export const DRIFTED = "DRIFTED";
export const NO_CELL = "NO CELL";

/**
 * Where does one leg of a correction stand?
 *
 * ORDER IS LOAD-BEARING. `movementExists` is consulted BEFORE the quantity,
 * because the two expectations can collide: a heal from −1 to 0 on a cell that
 * legitimately reached 0 by other means would read as PENDING against
 * expectedBefore and as APPLIED against expectedAfter. The ledger record is what
 * distinguishes "we did this" from "it happens to look like we did".
 *
 * A cell that is absent entirely is NO_CELL, never DRIFTED: the difference matters
 * to whoever reads the report, because a missing cell is a different investigation
 * from a moved one.
 */
export function classifyLeg({ live, expectedBefore, expectedAfter, movementExists }) {
  if (typeof live !== "number") return NO_CELL;
  if (movementExists) return live === expectedAfter ? APPLIED : DRIFTED;
  return live === expectedBefore ? PENDING : DRIFTED;
}

/**
 * What should the runner do with a whole correction, given its legs' states?
 *
 * ALL-OR-NOTHING, deliberately. A paired transfer whose source drifted but whose
 * destination did not must not have its destination half applied: that would
 * invent a unit. The legs are one atomic update precisely because they are one
 * fact about one unit.
 */
export function correctionState(states) {
  if (states.length === 0) return "blocked";
  if (states.every((s) => s === APPLIED)) return "skip";
  if (states.every((s) => s === PENDING)) return "apply";
  return "blocked";
}

/**
 * The late guard, run immediately before the write. Returns null when it is still
 * safe to proceed, or a human-readable reason when it is not.
 *
 * `v` IS THE DISCRIMINATOR, NOT THE QUANTITY. A concurrent sale followed by a
 * concurrent return leaves the quantity where it started and the correction would
 * sail through a quantity-only check — while its `before`/`after` ledger record
 * silently misdescribes what happened. Every legitimate cell write bumps `v`, so
 * comparing it catches the round trip that the quantity hides.
 *
 * This NARROWS the race; it does not close it. RTDB has no conditional multi-path
 * update, so there is no primitive that is both atomic across cell+ledger and
 * conditional on current state. See the header of fix-negative-pe-bag-cells.mjs
 * for why the atomic-and-guarded option beats per-cell transactions.
 */
export function guardDrift({ staged, fresh, expectedBefore, loc = "cell" }) {
  const nowQty = typeof fresh?.qty === "number" ? fresh.qty : null;
  if (nowQty !== expectedBefore) return `${loc} qty ${nowQty} ≠ expected ${expectedBefore}`;
  const stagedV = staged?.v ?? null;
  const freshV = fresh?.v ?? null;
  if (freshV !== stagedV) return `${loc} v moved ${stagedV} → ${freshV}`;
  return null;
}

/**
 * Did the correction land? ABSOLUTE against the declared expectation — never
 * `snapshotQty + delta`.
 *
 * This is the second CodeRabbit defect in one line. The old check derived its
 * expectation from the PRE-RUN snapshot and added the delta, so a re-run that
 * correctly SKIPPED an already-applied movement then compared the already-corrected
 * quantity against corrected-plus-delta and reported a mismatch. The script's own
 * idempotency claim failed its own verification. Comparing to a declared literal is
 * the same assertion on run 1 and run 5, which is what idempotent has to mean.
 */
export function verifyLeg({ nowQty, expectedAfter }) {
  return nowQty === expectedAfter;
}

/** The `v` a cell should carry after a write — new cells start at 0. */
export function nextVersion(cell) {
  return typeof cell?.v === "number" ? cell.v + 1 : 0;
}
