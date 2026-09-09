import { describe, it, expect, vi } from "vitest";
import {
  resolveDuplicateChoice, exactRowsOf, createAnywayPrompt, splitPrefillSizes, totalsKnowable,
  gatherExactTotals, prefillIsFresh, PREFILL_MAX_AGE_MS, TOTALS_TIMEOUT_MS,
  DUP_NONE, DUP_RESOLVED, DUP_CHOOSE,
} from "./duplicateGate.js";
import { TIER_EXACT_CODE, TIER_PARTIAL_CODE, TIER_FUZZY_NAME } from "../../utils/productDupMatch.js";

const row = (id, name, tier = TIER_EXACT_CODE) => ({ product: { id, name }, tier, score: 1, reason: "r" });

describe("resolveDuplicateChoice — one code must not mean two products", () => {
  it("a SOLE exact match resolves, and is never offered as a choice", () => {
    const r = resolveDuplicateChoice([row("p1", "Tracksuit")]);
    expect(r.kind).toBe(DUP_RESOLVED);
    expect(r.row.product.id).toBe("p1");
  });

  it("weaker tiers alongside it do not turn it into a choice", () => {
    const r = resolveDuplicateChoice([
      row("p1", "Tracksuit"),
      row("p2", "Sibling", TIER_PARTIAL_CODE),
      row("p3", "Lookalike", TIER_FUZZY_NAME),
    ]);
    expect(r.kind).toBe(DUP_RESOLVED);
    expect(r.row.product.id).toBe("p1");
  });

  it("a GENUINE TIE — two products already answering to one code — must be picked", () => {
    const r = resolveDuplicateChoice([row("p1", "A"), row("p2", "B")]);
    expect(r.kind).toBe(DUP_CHOOSE);
    expect(r.rows.map((x) => x.product.id)).toEqual(["p1", "p2"]);
  });

  it("no exact match resolves nothing — the panel stays a panel", () => {
    expect(resolveDuplicateChoice([row("p1", "A", TIER_FUZZY_NAME)]).kind).toBe(DUP_NONE);
    expect(resolveDuplicateChoice([]).kind).toBe(DUP_NONE);
  });

  it("survives junk", () => {
    for (const v of [null, undefined, "rows", 3]) expect(resolveDuplicateChoice(v).kind).toBe(DUP_NONE);
    expect(resolveDuplicateChoice([null, undefined, {}]).kind).toBe(DUP_NONE);
  });
});

describe("exactRowsOf", () => {
  it("keeps only the exact tier", () => {
    expect(exactRowsOf([row("a"), row("b", "B", TIER_PARTIAL_CODE)]).map((r) => r.product.id)).toEqual(["a"]);
  });
  it("survives junk", () => {
    for (const v of [null, undefined, 7]) expect(exactRowsOf(v)).toEqual([]);
  });
});

describe("totalsKnowable — no locations means UNKNOWN, never zero", () => {
  it("is false before the location registry answers", () => {
    expect(totalsKnowable([])).toBe(false);
    for (const v of [null, undefined, "hub1", 0, {}]) expect(totalsKnowable(v)).toBe(false);
  });
  it("is true once there is something to sum over", () => {
    expect(totalsKnowable(["hub1"])).toBe(true);
  });
  it("summing over NO locations would otherwise print the most dangerous sentence", () => {
    // This is what the guard prevents: sumProduct of an empty map returns a
    // confident { total: 0 }, and "with 0 units" reads as "dead record, safe to
    // replace" — pushing the operator toward the duplicate the dialog exists to
    // stop. With no locations, nothing is read and the count stays unknown.
    const p = createAnywayPrompt("44712", [row("p1", "X")], totalsKnowable([]) ? { p1: { total: 0 } } : {});
    expect(p).toContain("an unknown number of units");
    expect(p).not.toContain("0 units");
  });
});

describe("gatherExactTotals — the caller's guards, where a test can see them", () => {
  const rows = [row("p1", "A"), row("p2", "B")];

  it("reads a total for every exact candidate", async () => {
    const read = vi.fn(async (pid) => ({ total: pid === "p1" ? 4 : 7 }));
    expect(await gatherExactTotals(rows, ["hub1"], read)).toEqual({ p1: { total: 4 }, p2: { total: 7 } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("READS NOTHING when there are no locations — unread is unknown, not zero", async () => {
    const read = vi.fn(async () => ({ total: 0 }));
    expect(await gatherExactTotals(rows, [], read)).toEqual({});
    expect(read).not.toHaveBeenCalled();
    // …and the sentence built from it says so.
    expect(createAnywayPrompt("44712", rows, await gatherExactTotals(rows, [], read)))
      .toContain("an unknown number of units");
  });

  it("a failed read is null, and does not block the others or the save", async () => {
    const read = vi.fn(async (pid) => { if (pid === "p1") throw new Error("denied"); return { total: 3 }; });
    expect(await gatherExactTotals(rows, ["hub1"], read)).toEqual({ p1: null, p2: { total: 3 } });
  });

  it("ignores weaker tiers — only exact matches are ever counted", async () => {
    const read = vi.fn(async () => ({ total: 1 }));
    await gatherExactTotals([row("f", "F", TIER_FUZZY_NAME)], ["hub1"], read);
    expect(read).not.toHaveBeenCalled();
  });

  it("survives a missing reader rather than throwing inside the save handler", async () => {
    expect(await gatherExactTotals(rows, ["hub1"], undefined)).toEqual({});
  });

  it("A HUNG READ DOES NOT WEDGE THE SAVE — it times out into UNKNOWN", async () => {
    // RTDB's get() has no timeout of its own. Unbounded here, the Save button
    // looks live, does nothing, swallows every further tap (the re-entrancy
    // guard already holds its lock) and shows no error — recoverable only by a
    // reload. Losing a number is not worth losing the save.
    vi.useFakeTimers();
    try {
      const never = () => new Promise(() => {});
      const p = gatherExactTotals(rows, ["hub1"], never, 50);
      await vi.advanceTimersByTimeAsync(51);
      const totals = await p;
      expect(totals).toEqual({});
      expect(createAnywayPrompt("44712", rows, totals)).toContain("an unknown number of units");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a healthy read is not delayed by the bound", async () => {
    const read = vi.fn(async () => ({ total: 5 }));
    expect(await gatherExactTotals(rows, ["hub1"], read, TOTALS_TIMEOUT_MS)).toEqual({ p1: { total: 5 }, p2: { total: 5 } });
  });

  it("a SLOW read still contributes whatever landed before the bound", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn((pid) => (pid === "p1" ? Promise.resolve({ total: 2 }) : new Promise(() => {})));
      const p = gatherExactTotals(rows, ["hub1"], read, 50);
      await vi.advanceTimersByTimeAsync(51);
      expect(await p).toEqual({ p1: { total: 2 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("prefillIsFresh — a handoff is not a standing instruction", () => {
  it("is fresh when it was just made", () => {
    expect(prefillIsFresh({ at: 1000 }, 1000)).toBe(true);
    expect(prefillIsFresh({ at: 1000 }, 1000 + PREFILL_MAX_AGE_MS)).toBe(true);
  });

  it("GOES STALE — an abandoned handoff must not spring a filled receive form later", () => {
    expect(prefillIsFresh({ at: 1000 }, 1000 + PREFILL_MAX_AGE_MS + 1)).toBe(false);
  });

  it("a clock that moved backwards keeps the operator's work rather than discarding it", () => {
    // The skew must EXCEED the window, or an abs() of the age would look
    // identical and this would prove nothing.
    expect(prefillIsFresh({ at: 1000 + PREFILL_MAX_AGE_MS * 2 }, 1000)).toBe(true);
  });

  it("refuses anything without a real timestamp", () => {
    for (const v of [null, undefined, {}, { at: "1000" }, { at: NaN }]) expect(prefillIsFresh(v, 1000)).toBe(false);
    expect(prefillIsFresh({ at: 1000 }, NaN)).toBe(false);
  });
});

describe("createAnywayPrompt — a twin is a deliberate act", () => {
  it("names the product and its unit count", () => {
    const p = createAnywayPrompt("44712", [row("p1", "Mens Fleece Tracksuit")], { p1: { total: 14 } });
    expect(p).toContain("44712 already exists as Mens Fleece Tracksuit with 14 units");
    expect(p).toContain("Create a second product anyway?");
  });

  it("says one unit, not one units", () => {
    expect(createAnywayPrompt("44712", [row("p1", "X")], { p1: { total: 1 } })).toContain("with 1 unit.");
  });

  it("says zero when zero is what was read", () => {
    expect(createAnywayPrompt("44712", [row("p1", "X")], { p1: { total: 0 } })).toContain("with 0 units");
  });

  it("AN UNREADABLE COUNT IS UNKNOWN, NEVER ZERO", () => {
    const p = createAnywayPrompt("44712", [row("p1", "X")], { p1: null });
    expect(p).toContain("an unknown number of units");
    expect(p).not.toContain("0 units");
  });

  it("…and so is a missing entry", () => {
    expect(createAnywayPrompt("44712", [row("p1", "X")], {})).toContain("an unknown number of units");
  });

  it("names every product in a tie", () => {
    const p = createAnywayPrompt("44712", [row("p1", "A"), row("p2", "B")], { p1: { total: 2 }, p2: { total: 3 } });
    expect(p).toContain("A with 2 units, and as B with 3 units");
  });

  it("a fuzzy-only match gets NO confirm — a dialog over a guess trains people to dismiss dialogs", () => {
    expect(createAnywayPrompt("Nike Air", [row("p1", "Nike Air", TIER_FUZZY_NAME)], {})).toBeNull();
    expect(createAnywayPrompt("44712", [], {})).toBeNull();
    expect(createAnywayPrompt("44712", null, {})).toBeNull();
  });

  it("an unnamed product is still named as something", () => {
    expect(createAnywayPrompt("44712", [{ product: { id: "p1" }, tier: TIER_EXACT_CODE }], {}))
      .toContain("an unnamed product");
  });
});

describe("splitPrefillSizes — the handoff loses nothing silently", () => {
  it("carries the sizes the product has", () => {
    expect(splitPrefillSizes({ S: "2", M: "3" }, ["S", "M", "L"]))
      .toEqual({ carried: { S: "2", M: "3" }, dropped: [] });
  });

  it("reports the sizes it cannot carry rather than dropping them quietly", () => {
    expect(splitPrefillSizes({ S: "2", XXXL: "4" }, ["S", "M"]))
      .toEqual({ carried: { S: "2" }, dropped: ["XXXL"] });
  });

  it("a blank or zero quantity carries nothing and is NOT a loss", () => {
    expect(splitPrefillSizes({ S: "", M: "0", XXXL: "", L: "abc" }, ["S", "M"]))
      .toEqual({ carried: {}, dropped: [] });
  });

  it("normalises the quantity to a whole number string", () => {
    expect(splitPrefillSizes({ S: 5, M: "07" }, ["S", "M"]).carried).toEqual({ S: "5", M: "7" });
  });

  it("compares sizes as strings, so a numeric shoe size still matches", () => {
    expect(splitPrefillSizes({ 9: "2" }, [9, 10]).carried).toEqual({ 9: "2" });
  });

  it("dropped sizes come back in a stable order", () => {
    expect(splitPrefillSizes({ XL: "1", L: "1" }, []).dropped).toEqual(["L", "XL"]);
  });

  it("survives junk", () => {
    expect(splitPrefillSizes(null, null)).toEqual({ carried: {}, dropped: [] });
    expect(splitPrefillSizes({ S: "1" }, null)).toEqual({ carried: {}, dropped: ["S"] });
  });
});
