// ─── NO READ THIS APP MAKES ON /insights_log IS QUERY-LESS ───────────────────
//
// The /insights_log read rule (RULES-INSIGHTS-LOG-QUERY.md) refuses a read that
// carries no query. That rule is only safe to paste because every read path in
// this app carries one — so this asserts it on the REAL modules, with the
// firebase builders mocked, rather than on a hand-copied expression.
//
// If someone puts `onValue(ref(db, "insights_log"))` back, the app starts
// failing against the live rule with PERMISSION_DENIED and no screen explains
// why. This test is what turns that into a red build instead.
import { describe, it, expect, vi } from "vitest";

const calls = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ __ref: path }),
  query: (base, ...mods) => { const q = { __ref: base.__ref, __mods: mods }; calls.push(q); return q; },
  orderByKey: () => ({ __mod: "orderByKey" }),
  startAt: (v) => ({ __mod: "startAt", value: v }),
  startAfter: (v) => ({ __mod: "startAfter", value: v }),
  endAt: (v) => ({ __mod: "endAt", value: v }),
  limitToFirst: (n) => ({ __mod: "limitToFirst", value: n }),
  limitToLast: (n) => ({ __mod: "limitToLast", value: n }),
  get: vi.fn(async () => ({ forEach: () => false })),
  onChildAdded: vi.fn(() => () => {}),
  onValue: vi.fn(() => () => {}),
}));
vi.mock("../firebase", () => ({ database: { __db: true } }));

const { insightsLogQueries } = await import("./InsightsLogProvider");
const { readByKeyPages } = await import("../push/pagedRead");
const { get, onValue } = await import("firebase/database");

const mods = (q) => q.__mods.map((m) => m.__mod);

describe("the all-time /insights_log reader", () => {
  it("never calls onValue on the node — that is the read the rule refuses", async () => {
    // The provider module has been imported; nothing at module scope may have
    // opened a bare subscription, and openInsightsLog must not use onValue.
    expect(onValue).not.toHaveBeenCalled();
  });

  it("pages the history with orderByKey + limitToFirst, and a cursor after that", async () => {
    calls.length = 0;
    let n = 0;
    get.mockImplementation(async () => {
      // First page full (forces a second request), second page short.
      const keys = n++ === 0 ? ["-A", "-B"] : ["-C"];
      return { forEach: (cb) => { for (const k of keys) cb({ key: k, val: () => ({ k }) }); return false; } };
    });
    await readByKeyPages({ __ref: "insights_log" }, { pageSize: 2, maxPages: 5 });

    expect(calls.length).toBe(2);
    expect(calls[0].__ref).toBe("insights_log");
    expect(mods(calls[0])).toEqual(["orderByKey", "limitToFirst"]);
    expect(mods(calls[1])).toEqual(["orderByKey", "startAfter", "limitToFirst"]);
    expect(calls[1].__mods.find((m) => m.__mod === "startAfter").value).toBe("-B");
  });

  it("tails with startAt — the bound the rule can actually name", () => {
    const q = insightsLogQueries.tail({ after: "-OxbQq0123" });
    expect(q.__ref).toBe("insights_log");
    // startAfter is NOT used: there is no rule variable guaranteed to name it,
    // and a tail the rule cannot see is a tail that gets refused.
    expect(mods(q)).toEqual(["orderByKey", "startAt"]);
  });

  it("tails an EMPTY node from a lower bound, still a query", () => {
    const q = insightsLogQueries.tail({ after: "-" });
    expect(mods(q)).toEqual(["orderByKey", "startAt"]);
  });

  it("uses no orderByChild anywhere — /insights_log has no .indexOn", () => {
    expect(mods(insightsLogQueries.tail({ after: "-A" }))).not.toContain("orderByChild");
  });
});
