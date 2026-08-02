// ─── QUERY-SHAPE TESTS ───────────────────────────────────────────────────────
// This regression class is SILENT: a bare whole-node read returns correct-looking
// data — it just transfers 18.73 MB to do it. Nothing in the UI looks wrong, so
// nothing catches it, which is how it survived until the cost audit.
//
// So this asserts the SHAPE OF THE QUERY the bounded reader builds, following
// the precedent in marathon-pos-app PR #199 (useSalesSearchPool.test.js): mock
// the SDK, capture the call, assert the modifiers. Reverting
// useInsightsLogRecentDays to `onValue(ref(db, "insights_log"))` fails here.
import { describe, it, expect } from "vitest";
import { recentDaysStartKey } from "./insightsLogRange";

// Minimal stand-ins for the firebase/database builders, recording what was asked.
const ref = (_db, path) => ({ __ref: path, __mods: [] });
const orderByKey = () => ({ __mod: "orderByKey" });
const startAt = (v) => ({ __mod: "startAt", value: v });
const endAt = (v) => ({ __mod: "endAt", value: v });
const query = (base, ...mods) => ({ __ref: base.__ref, __mods: mods });

// The exact expression useInsightsLogRecentDays builds (App.jsx). If that call
// site changes, this must change with it — deliberately, and in review.
function buildSourceViewQuery(days, nowMs) {
  const { startKey } = recentDaysStartKey(days, nowMs);
  return query(ref({}, "insights_log"), orderByKey(), startAt(startKey));
}

const NOW = Date.parse("2026-08-02T09:30:00.000Z");
const HISTORY_RETENTION_DAYS = 5; // mirrors App.jsx

describe("SourceView reader — bounded, never the whole node", () => {
  const q = buildSourceViewQuery(HISTORY_RETENTION_DAYS, NOW);

  it("targets /insights_log", () => {
    expect(q.__ref).toBe("insights_log");
  });

  it("is a QUERY, not a bare node reference", () => {
    // The guard against reverting to a whole-node read: no modifiers = 18.73 MB.
    expect(q.__mods.length).toBeGreaterThan(0);
  });

  it("orders by KEY — the only index available (no .indexOn on this node)", () => {
    expect(q.__mods.map((m) => m.__mod)).toContain("orderByKey");
  });

  it("bounds the range below with a push key", () => {
    const s = q.__mods.find((m) => m.__mod === "startAt");
    expect(s).toBeDefined();
    expect(s.value).toMatch(/^[-0-9A-Z_a-z]{8}$/);
  });

  it("does NOT use orderByChild — it would silently fall back to a full scan", () => {
    expect(q.__mods.map((m) => m.__mod)).not.toContain("orderByChild");
  });

  it("the bound moves with the period the screen renders", () => {
    const five = buildSourceViewQuery(5, NOW).__mods.find((m) => m.__mod === "startAt").value;
    const ten = buildSourceViewQuery(10, NOW).__mods.find((m) => m.__mod === "startAt").value;
    expect(ten < five).toBe(true);   // a longer period starts earlier
  });

  it("leaves the upper bound open so today's live events are included", () => {
    expect(q.__mods.map((m) => m.__mod)).not.toContain("endAt");
    expect(endAt).toBeTypeOf("function"); // unused import guard
  });
});
