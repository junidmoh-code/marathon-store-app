// The setup screen's two pure decisions: how far along the download is, and
// what to say when it stops.
import { describe, test, expect } from "vitest";
import { progressFor, explainFailure } from "../MirrorSetupScreen";
import { MIRROR_LEGS } from "../nodes";

describe("the bar is weighted by BYTES, not by legs done", () => {
  test("eighteen of twenty legs is a small fraction of the download", () => {
    // /insights_log and /stock_movements are 68 MB of the 104. A bar that
    // counted legs would show 90% here and then sit still for four minutes,
    // which teaches people that progress bars lie.
    const allButTheBigTwo = MIRROR_LEGS
      .map((l) => l.name).filter((n) => n !== "insights" && n !== "movements");
    expect(allButTheBigTwo).toHaveLength(MIRROR_LEGS.length - 2);
    const { pct } = progressFor(allButTheBigTwo);
    expect(pct).toBeLessThan(40);
    expect(pct).toBeGreaterThan(25);
  });

  test("nothing done is 0%, everything done is 100%", () => {
    expect(progressFor([]).pct).toBe(0);
    expect(progressFor(MIRROR_LEGS.map((l) => l.name)).pct).toBe(100);
  });

  test("every leg in the registry has a measured size", () => {
    // A leg with no entry contributes nothing, so the bar would stop short of
    // 100% for ever and a person would sit watching it.
    const all = progressFor(MIRROR_LEGS.map((l) => l.name));
    const each = MIRROR_LEGS.map((l) => progressFor([l.name]).bytes);
    expect(each.every((b) => b > 0)).toBe(true);
    expect(each.reduce((a, b) => a + b, 0)).toBe(all.bytes);
  });

  test("the total is the measured 103.7 MB, within rounding", () => {
    // docs/store-offline-mirror.md §5.1. If this moves, that table moved too —
    // the number a person is told to expect and the number the bar divides by
    // have to be the same number.
    const { total } = progressFor([]);
    expect(total).toBeGreaterThan(103_000_000);
    expect(total).toBeLessThan(104_500_000);
  });
});

describe("what it says when the download stops", () => {
  test("permission denied names the rule that has not been pasted", () => {
    expect(explainFailure(new Error("PERMISSION_DENIED: Permission denied")))
      .toMatch(/rule for the change log/);
  });

  test("a timeout says the connection, and that nothing is lost", () => {
    expect(explainFailure(new Error("/insights_log did not answer within 30000 ms")))
      .toMatch(/nothing downloaded so far has been lost/);
  });

  test("anything else is shown verbatim rather than guessed at", () => {
    expect(explainFailure(new Error("the \"products\" swap wrote 4945 rows but the store holds 4900")))
      .toContain("4945");
  });

  test("an error with no message still says something", () => {
    expect(explainFailure(null)).toBeTruthy();
  });
});
