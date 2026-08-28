// ─── PER-PRODUCT TARGETS — THE RULES OF THE ONE WRITE PATH ───────────────────
// Each of these pins a property that, removed, either arms a shop nobody chose
// or switches one off nobody chose. Mutation-proved in
// scripts/mutation-proof-target-override.mjs.

import { describe, it, expect } from "vitest";
import {
  overrideDraft, overridePlan, switchOffDraft, clearDraft, applyToAll,
  validateOverrideDraft, inheritedAt, previewRows, targetPayload, expectationFor,
  derivedMinQty, numOrNull, isOurs, OVERRIDE_SOURCE,
} from "./targetOverride";
import { resolveTarget } from "./seatingCore";

// A clothing product in a category the map governs at trophy, size by size.
const P = {
  p1: { id: "p1", name: "Jersey", productType: "clothing", categoryKey: "soccer-jerseys",
        sizes: ["S", "M", "L", "XL", "XXL"] },
  perfume: { id: "perfume", name: "Scent", categoryKey: "perfumes", sizes: [] },
};
const CATEGORY_5 = {
  mode: { trophy: "live" },
  categoryPolicy: { "soccer-jerseys": { perSize: true, trophy: { sizes: {
    S: { target: 1, minQty: 1 }, M: { target: 2, minQty: 1 }, L: { target: 2, minQty: 1 },
    XL: { target: 1, minQty: 1 }, XXL: { target: 1, minQty: 1 },
  } } } },
};
// Units somewhere in the network on every size, so the dead-size rule does not
// resolve them all to 0 — that rule is the engine's and is tested there.
const STOCK = { trophy: { p1: { S: { qty: 1 }, M: { qty: 1 }, L: { qty: 1 }, XL: { qty: 1 }, XXL: { qty: 1 } } } };
const ctx = (targets = {}, config = CATEGORY_5, stock = STOCK, products = P) =>
  ({ products, stock, targets, config });
const draftOf = (c, sizes, reorderPoint = "") => {
  const d = overrideDraft(c, "trophy", "p1");
  for (const [k, v] of Object.entries(sizes)) d.sizes[k] = { ...d.sizes[k], target: v };
  return { ...d, reorderPoint };
};

// ── BLANK IS INHERIT. IT IS NOT ZERO. ────────────────────────────────────────
describe("a blank field means inherit", () => {
  it("writes no row at all, so the category policy still answers", () => {
    const plan = overridePlan(ctx(), "trophy", "p1", draftOf(ctx(), { M: "" }));
    expect(plan.rows).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
    expect(plan.dirty).toBe(false);
  });

  it("REMOVES an existing row, which is what inheriting means", () => {
    const c = ctx({ trophy: { p1: { M: { target: 7, minQty: 4, source: OVERRIDE_SOURCE, prevAbsent: true } } } });
    const plan = overridePlan(c, "trophy", "p1", draftOf(c, { M: "" }));
    expect(plan.remove.map((r) => r.sizeKey)).toEqual(["M"]);
    // and the size goes back to the category's number, not to nothing
    expect(inheritedAt(c, "trophy", "p1", "M").target).toBe(2);
    expect(inheritedAt(c, "trophy", "p1", "M").source).toBe("category_policy");
  });

  it("never becomes 0 anywhere in the path", () => {
    expect(numOrNull("")).toBe(null);
    expect(numOrNull("   ")).toBe(null);
    expect(numOrNull(undefined)).toBe(null);
    expect(numOrNull("0")).toBe(0);
  });
});

// ── AN EXPLICIT NUMBER BEATS THE CATEGORY ────────────────────────────────────
describe("an entered number is an explicit row", () => {
  it("a NON-ZERO row beats the category policy", () => {
    const plan = overridePlan(ctx(), "trophy", "p1", draftOf(ctx(), { M: "9" }));
    expect(plan.rows).toEqual([{ sizeKey: "M", target: 9, minQty: 5 }]);
    const after = ctx({ trophy: { p1: { M: { target: 9, minQty: 5 } } } });
    expect(resolveTarget(after, "trophy", "p1", "M")).toMatchObject({ target: 9, source: "explicit" });
  });

  it("0 is legal and is the off switch — it beats the category policy too", () => {
    const plan = overridePlan(ctx(), "trophy", "p1", draftOf(ctx(), { M: "0" }));
    expect(plan.rows).toEqual([{ sizeKey: "M", target: 0, minQty: 0 }]);
    const after = ctx({ trophy: { p1: { M: { target: 0, minQty: 0 } } } });
    expect(resolveTarget(after, "trophy", "p1", "M")).toMatchObject({ target: 0, source: "explicit" });
  });

  it("a 0 retracts an open request — the preview says so", () => {
    const rows = previewRows(ctx(), "trophy", "p1", draftOf(ctx(), { M: "0" }));
    const m = rows.find((r) => r.sizeKey === "M");
    expect(m.before).toBe(2);
    expect(m.after).toBe(0);
    expect(m.retracts).toBe(true);
    // and every other size is untouched
    expect(rows.filter((r) => r.changed).map((r) => r.sizeKey)).toEqual(["M"]);
  });

  it("minQty is derived, never typed", () => {
    expect(derivedMinQty(9)).toBe(5);
    expect(derivedMinQty(1)).toBe(1);
    expect(derivedMinQty(0)).toBe(0);
  });
});

// ── CLEAR PUTS THE CATEGORY BACK ─────────────────────────────────────────────
describe("clearing an override restores the category policy", () => {
  it("removes the rows this card created", () => {
    const rows = {};
    for (const k of ["S", "M", "L", "XL", "XXL"]) rows[k] = { target: 0, minQty: 0, source: OVERRIDE_SOURCE, prevAbsent: true };
    const c = ctx({ trophy: { p1: rows } });
    const plan = overridePlan(c, "trophy", "p1", clearDraft(c, "trophy", "p1"));
    expect(plan.remove.map((r) => r.sizeKey).sort()).toEqual(["L", "M", "S", "XL", "XXL"]);
    expect(plan.restore).toHaveLength(0);
    // afterwards every size resolves from the map again
    const after = ctx({});
    for (const k of ["S", "M", "L"]) {
      expect(resolveTarget(after, "trophy", "p1", k).source).toBe("category_policy");
    }
  });

  it("restores the row it replaced rather than deleting it", () => {
    const hand = { target: 6, minQty: 3, source: "hand" };
    const c = ctx({ trophy: { p1: { M: { target: 0, minQty: 0, source: OVERRIDE_SOURCE, prevRow: hand } } } });
    const plan = overridePlan(c, "trophy", "p1", clearDraft(c, "trophy", "p1"));
    expect(plan.restore).toEqual([{ sizeKey: "M", prev: c.targets.trophy.p1.M, to: hand }]);
    expect(plan.remove).toHaveLength(0);
  });

  it("names a foreign row rather than removing it quietly", () => {
    const c = ctx({ trophy: { p1: { M: { target: 6, minQty: 3, source: "hand" } } } });
    const plan = overridePlan(c, "trophy", "p1", clearDraft(c, "trophy", "p1"));
    expect(plan.foreign.map((f) => f.sizeKey)).toEqual(["M"]);
    // and the payload does not claim permission it was not given
    const { payload } = targetPayload(c, "trophy", "p1", clearDraft(c, "trophy", "p1"));
    expect(payload.allowRemoveForeign).toBeUndefined();
    expect(targetPayload(c, "trophy", "p1", clearDraft(c, "trophy", "p1"), { allowRemoveForeign: true })
      .payload.allowRemoveForeign).toBe(true);
  });

  it("isOurs recognises both stamps and nothing else", () => {
    expect(isOurs({ source: OVERRIDE_SOURCE })).toBe(true);
    expect(isOurs({ source: "seating_off" })).toBe(true);
    expect(isOurs({ source: "excluded" })).toBe(false);
    expect(isOurs({ source: "manual" })).toBe(false);
    expect(isOurs({})).toBe(false);
    expect(isOurs(null)).toBe(false);
  });
});

// ── THE SIZE GRID IS THE PRODUCT'S OWN ───────────────────────────────────────
describe("the editor offers the product's own sizes", () => {
  it("a clothing product gets one field per declared size", () => {
    expect(Object.keys(overrideDraft(ctx(), "trophy", "p1").sizes).sort())
      .toEqual(["L", "M", "S", "XL", "XXL"]);
  });

  it("arming it writes FIVE distinct per-size rows", () => {
    const plan = overridePlan(ctx(), "trophy", "p1",
      draftOf(ctx(), { S: "1", M: "3", L: "3", XL: "2", XXL: "1" }));
    expect(plan.rows).toEqual([
      { sizeKey: "S", target: 1, minQty: 1 },
      { sizeKey: "M", target: 3, minQty: 2 },
      { sizeKey: "L", target: 3, minQty: 2 },
      { sizeKey: "XL", target: 2, minQty: 1 },
      { sizeKey: "XXL", target: 1, minQty: 1 },
    ]);
  });

  it("a ONE-SIZE product gets exactly one field and no size grid", () => {
    const c = { products: P, stock: { trophy: { perfume: { _: { qty: 3 } } } }, targets: {},
      config: { mode: { trophy: "live" }, categoryPolicy: { perfumes: { trophy: { target: 8, minQty: 4 } } } } };
    const d = overrideDraft(c, "trophy", "perfume");
    expect(Object.keys(d.sizes)).toEqual(["_"]);
    expect(d.sizes._.label).toBe("One size");
    const plan = overridePlan(c, "trophy", "perfume", { ...d, sizes: { _: { ...d.sizes._, target: "4" } } });
    expect(plan.rows).toEqual([{ sizeKey: "_", target: 4, minQty: 2 }]);
  });

  it("a size the CATEGORY names but the product does not is not offered", () => {
    // The map speaks for XXXL; this product does not come in it.
    const config = { ...CATEGORY_5, categoryPolicy: { "soccer-jerseys": { perSize: true, trophy: { sizes: {
      ...CATEGORY_5.categoryPolicy["soccer-jerseys"].trophy.sizes, XXXL: { target: 4, minQty: 2 },
    } } } } };
    const c = ctx({}, config);
    expect(Object.keys(overrideDraft(c, "trophy", "p1").sizes)).not.toContain("XXXL");
    // and the engine agrees: it resolves nothing for a size the product lacks
    expect(resolveTarget(c, "trophy", "p1", "XXXL")).toBe(null);
  });

  it("a size the PRODUCT declares but the category run omits is offered, and inherits nothing", () => {
    const config = { ...CATEGORY_5, categoryPolicy: { "soccer-jerseys": { perSize: true, trophy: { sizes: {
      S: { target: 1, minQty: 1 },
    } } } } };
    const c = ctx({}, config);
    expect(Object.keys(overrideDraft(c, "trophy", "p1").sizes)).toContain("XXL");
    expect(inheritedAt(c, "trophy", "p1", "XXL")).toBe(null);
    // which is exactly why it can be given a row of its own
    const plan = overridePlan(c, "trophy", "p1", draftOf(c, { XXL: "2" }));
    expect(plan.rows).toEqual([{ sizeKey: "XXL", target: 2, minQty: 1 }]);
  });

  it("a row on a size the editor never rendered is LEFT ALONE", () => {
    // A legacy row on "4XL", a size this product does not declare.
    const c = ctx({ trophy: { p1: { "4XL": { target: 3, minQty: 2, source: "hand" } } } });
    const d = overrideDraft(c, "trophy", "p1");
    // seatingSizes includes rowed keys, so it IS rendered — and therefore is a
    // decision the owner can see. The guard is for a draft that does not name
    // it at all, which is what a stale editor sends.
    delete d.sizes["4XL"];
    const plan = overridePlan(c, "trophy", "p1", d);
    expect(plan.remove).toHaveLength(0);
    expect(plan.rows).toHaveLength(0);
  });
});

// ── APPLY TO ALL ─────────────────────────────────────────────────────────────
describe("apply to all", () => {
  it("fills every size field and nothing else", () => {
    const d = draftOf(ctx(), { S: "1" }, "1");
    const filled = applyToAll(d, 4);
    expect(Object.values(filled.sizes).map((r) => r.target)).toEqual(["4", "4", "4", "4", "4"]);
    // it does not touch the location's Ask at, and it does not touch on-hand
    expect(filled.reorderPoint).toBe("1");
    expect(filled.sizes.S.onHand).toBe(d.sizes.S.onHand);
    expect(filled.loc).toBe(d.loc);
    expect(filled.pid).toBe(d.pid);
  });

  it("writes each size as its own row — nothing stores 'they are all 4'", () => {
    const plan = overridePlan(ctx(), "trophy", "p1", applyToAll(overrideDraft(ctx(), "trophy", "p1"), 4));
    expect(plan.rows).toHaveLength(5);
    expect(new Set(plan.rows.map((r) => r.target))).toEqual(new Set([4]));
  });

  it("a blank apply-to-all clears every field back to inherit", () => {
    const filled = applyToAll(draftOf(ctx(), { S: "1", M: "2" }), "");
    expect(Object.values(filled.sizes).every((r) => r.target === "")).toBe(true);
  });
});

// ── SWITCH OFF IS AN OVERRIDE OF 0 ───────────────────────────────────────────
describe("switch off is the same mechanism", () => {
  it("sets every size the engine arms to 0", () => {
    const d = switchOffDraft(ctx(), "trophy", "p1");
    expect(Object.values(d.sizes).map((r) => r.target)).toEqual(["0", "0", "0", "0", "0"]);
    const plan = overridePlan(ctx(), "trophy", "p1", d);
    expect(plan.rows.every((r) => r.target === 0 && r.minQty === 0)).toBe(true);
  });
});

// ── VALIDATION ───────────────────────────────────────────────────────────────
describe("validation", () => {
  it("accepts 0 and blank, refuses anything that is not a whole number", () => {
    const d = draftOf(ctx(), { S: "0", M: "", L: "2.5", XL: "-1", XXL: "abc" });
    const errs = validateOverrideDraft(d);
    expect(errs.S).toBeUndefined();
    expect(errs.M).toBeUndefined();
    expect(errs.L).toBeTruthy();
    expect(errs.XL).toBeTruthy();
    expect(errs.XXL).toBeTruthy();
  });

  it("refuses an Ask at that is at or above the smallest Keep", () => {
    expect(validateOverrideDraft(draftOf(ctx(), { S: "2", M: "5" }, "2")).reorderPoint).toBeTruthy();
    expect(validateOverrideDraft(draftOf(ctx(), { S: "2", M: "5" }, "1")).reorderPoint).toBeUndefined();
  });

  it("refuses a target above the cap", () => {
    expect(validateOverrideDraft(draftOf(ctx(), { S: "501" })).S).toBeTruthy();
    expect(validateOverrideDraft(draftOf(ctx(), { S: "500" })).S).toBeUndefined();
  });
});

// ── DRIFT ────────────────────────────────────────────────────────────────────
describe("the expectation covers every size the plan touches", () => {
  it("null for a size with no row — a real value, not an omission", () => {
    const c = ctx({ trophy: { p1: { M: { target: 7, minQty: 4, reorderPoint: 2, source: "hand" } } } });
    const draft = draftOf(c, { M: "3", S: "1" });
    const plan = overridePlan(c, "trophy", "p1", draft);
    const exp = expectationFor(c, "trophy", "p1", plan);
    expect(exp.M).toEqual({ target: 7, minQty: 4, reorderPoint: 2 });
    expect(exp.S).toBe(null);
    expect(Object.keys(exp).sort()).toEqual(["M", "S"]);
  });
});
