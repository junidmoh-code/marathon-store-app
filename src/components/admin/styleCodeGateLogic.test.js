// ─── STYLE CODE GATE LOGIC — THE THREE "DO NOT GUESS" RULES ──────────────────
// Each block below pins one failure that CodeRabbit found on PR #312, and each
// has a mutation check: the test is written so that reintroducing the original
// bug makes it fail. A test that passes both with and without the fix proves
// nothing, which is exactly how the reaper bug shipped.

import { describe, it, expect } from "vitest";
import {
  resolveAddStockTarget,
  classifyLookupOutcome,
  labelPhotoEvidence,
  TARGET_READY, TARGET_CHOOSE, TARGET_BLOCKED,
  BLOCK_NO_TARGET, BLOCK_CLAIM_UNAVAILABLE, BLOCK_PRODUCT_UNAVAILABLE,
  STEP_ORPHAN, STEP_EXISTING, STEP_FOUND, STEP_UNAVAILABLE, STEP_UNKNOWN,
} from "./styleCodeGateLogic";

const P = (id, over = {}) => ({ id, name: `Product ${id}`, ...over });

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHERE DOES THE STOCK GO?
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveAddStockTarget — never guess, never first-match", () => {
  // ── THE MAJOR ─────────────────────────────────────────────────────────────
  // Stock on the wrong twin is SILENT count corruption — worse than the
  // duplicate product this feature prevents, because a duplicate is visible and
  // a wrong count looks like a normal receipt.
  it("TWO PRODUCTS ON ONE CODE: refuses to pick a target, and demands a choice", () => {
    const out = resolveAddStockTarget({
      claim: null,
      existingProducts: [P("p1"), P("p2")],
      products: [P("p1"), P("p2")],
    });
    expect(out.kind).toBe(TARGET_CHOOSE);
    expect(out.options).toEqual(["p1", "p2"]);
    // The mutation check: the old code did `existing[0].id`. Nothing here may
    // hand back a productId, so that behaviour cannot pass this test.
    expect(out.productId).toBeUndefined();
  });

  it("three products is still a choice, not a guess", () => {
    const out = resolveAddStockTarget({
      claim: null,
      existingProducts: [P("p1"), P("p2"), P("p3")],
      products: [P("p1"), P("p2"), P("p3")],
    });
    expect(out.kind).toBe(TARGET_CHOOSE);
    expect(out.options).toHaveLength(3);
  });

  it("an explicit, valid operator choice unblocks it", () => {
    const out = resolveAddStockTarget({
      claim: null,
      existingProducts: [P("p1"), P("p2")],
      products: [P("p1"), P("p2")],
      selectedId: "p2",
    });
    expect(out).toEqual({ kind: TARGET_READY, productId: "p2", basis: "operator-selected" });
  });

  it("a selection that is not one of the options is refused, not honoured", () => {
    for (const selectedId of ["p9", "", null, "P1"]) {
      const out = resolveAddStockTarget({
        claim: null,
        existingProducts: [P("p1"), P("p2")],
        products: [P("p1"), P("p2")],
        selectedId,
      });
      expect(out.kind).toBe(TARGET_CHOOSE);
    }
  });

  it("a selected product that is not loaded is refused", () => {
    const out = resolveAddStockTarget({
      claim: null,
      existingProducts: [P("p1"), P("p2")],
      products: [P("p1")], // p2 not loaded on this device
      selectedId: "p2",
    });
    expect(out.kind).toBe(TARGET_CHOOSE);
  });

  // ── The claim is the authority ────────────────────────────────────────────
  it("a loaded claim settles the target outright", () => {
    const out = resolveAddStockTarget({
      claim: { productId: "p1" },
      existingProducts: [P("p1")],
      products: [P("p1")],
    });
    expect(out).toEqual({ kind: TARGET_READY, productId: "p1", basis: "claim" });
  });

  it("THE CLAIM WINS over the legacy scan, even when the scan found other rows", () => {
    // The old code ignored the claim whenever the scan returned anything.
    // Stamped records are not ownership; /style_code_index is.
    const out = resolveAddStockTarget({
      claim: { productId: "p2" },
      existingProducts: [P("p1"), P("p2"), P("p3")],
      products: [P("p1"), P("p2"), P("p3")],
    });
    expect(out.kind).toBe(TARGET_READY);
    expect(out.productId).toBe("p2");
    expect(out.basis).toBe("claim");
  });

  it("a claim naming a product we cannot see is BLOCKED, never downgraded to a scan row", () => {
    const out = resolveAddStockTarget({
      claim: { productId: "pGONE" },
      existingProducts: [P("p1")],
      products: [P("p1")],
    });
    expect(out.kind).toBe(TARGET_BLOCKED);
    expect(out.reason).toBe(BLOCK_CLAIM_UNAVAILABLE);
    expect(out.productId).toBe("pGONE"); // named so the operator can escalate
  });

  // ── The certain single case still works ───────────────────────────────────
  it("one loaded match with no claim is ready", () => {
    const out = resolveAddStockTarget({
      claim: null, existingProducts: [P("p1")], products: [P("p1")],
    });
    expect(out).toEqual({ kind: TARGET_READY, productId: "p1", basis: "sole-match" });
  });

  it("one match we cannot see is blocked", () => {
    const out = resolveAddStockTarget({ claim: null, existingProducts: [P("p1")], products: [] });
    expect(out.kind).toBe(TARGET_BLOCKED);
    expect(out.reason).toBe(BLOCK_PRODUCT_UNAVAILABLE);
  });

  it("nothing at all is blocked", () => {
    expect(resolveAddStockTarget({ claim: null, existingProducts: [], products: [] }).reason).toBe(BLOCK_NO_TARGET);
    expect(resolveAddStockTarget({}).reason).toBe(BLOCK_NO_TARGET);
  });

  it("junk input is blocked rather than throwing", () => {
    for (const args of [{}, { existingProducts: null, products: null }, { claim: {} }, { claim: { productId: "" } }]) {
      expect(resolveAddStockTarget(args).kind).toBe(TARGET_BLOCKED);
    }
    expect(resolveAddStockTarget({ existingProducts: [null, { id: "" }], products: [] }).reason).toBe(BLOCK_NO_TARGET);
  });

  it("NO input shape ever yields a target the caller did not establish", () => {
    // Sweep: the only way to get a productId back is claim / sole match /
    // explicit valid selection. Everything else must refuse.
    const cases = [
      { claim: null, existingProducts: [P("a"), P("b")], products: [P("a"), P("b")] },
      { claim: null, existingProducts: [P("a"), P("b")], products: [P("a")] },
      { claim: { productId: "z" }, existingProducts: [P("a"), P("b")], products: [P("a"), P("b")] },
      { claim: null, existingProducts: [P("a")], products: [] },
      { claim: null, existingProducts: [], products: [P("a")] },
    ];
    for (const c of cases) {
      const out = resolveAddStockTarget(c);
      expect(out.kind).not.toBe(TARGET_READY);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FAILED vs EMPTY
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyLookupOutcome — an error is not an absence", () => {
  it("a thrown lookup is UNAVAILABLE, never 'not in the catalogue'", () => {
    expect(classifyLookupOutcome({ threw: true })).toBe(STEP_UNAVAILABLE);
    expect(classifyLookupOutcome({ threw: true, data: { found: false, existingProducts: [] } }))
      .toBe(STEP_UNAVAILABLE);
  });

  it("a lookup that ANSWERED empty is UNKNOWN — the one case we may say that", () => {
    expect(classifyLookupOutcome({ data: { found: false, existingProducts: [], errors: [] } }))
      .toBe(STEP_UNKNOWN);
  });

  it("a degraded tier with no result is UNAVAILABLE, not UNKNOWN", () => {
    // The mutation check: ignoring `errors` here collapses this into UNKNOWN,
    // which is what put the create-new path in front of the operator after a
    // failure — producing the duplicate this feature exists to prevent.
    const out = classifyLookupOutcome({
      data: { found: false, existingProducts: [], errors: [{ provider: "kicksdb", message: "HTTP 503" }] },
    });
    expect(out).toBe(STEP_UNAVAILABLE);
    expect(out).not.toBe(STEP_UNKNOWN);
  });

  it("UNAVAILABLE and UNKNOWN are distinct values, so callers cannot conflate them", () => {
    expect(STEP_UNAVAILABLE).not.toBe(STEP_UNKNOWN);
  });

  it("a local answer outranks a degraded remote one", () => {
    const errors = [{ provider: "kicksdb", message: "HTTP 503" }];
    expect(classifyLookupOutcome({ data: { existingProducts: [P("p1")], errors } })).toBe(STEP_EXISTING);
    expect(classifyLookupOutcome({ data: { claim: { productId: "p1" }, existingProducts: [], errors } })).toBe(STEP_EXISTING);
    expect(classifyLookupOutcome({ data: { found: true, existingProducts: [], errors } })).toBe(STEP_FOUND);
  });

  it("an orphaned claim outranks everything", () => {
    expect(classifyLookupOutcome({ data: { claimOrphaned: true, claim: { productId: "x" }, found: true } }))
      .toBe(STEP_ORPHAN);
  });

  it("a found result is FOUND", () => {
    expect(classifyLookupOutcome({ data: { found: true, existingProducts: [] } })).toBe(STEP_FOUND);
  });

  it("junk input degrades to UNKNOWN rather than throwing", () => {
    expect(classifyLookupOutcome()).toBe(STEP_UNKNOWN);
    expect(classifyLookupOutcome({ data: null })).toBe(STEP_UNKNOWN);
    expect(classifyLookupOutcome({ data: { errors: "boom" } })).toBe(STEP_UNKNOWN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. IS THIS PHOTO EVIDENCE FOR THIS CODE?
// ─────────────────────────────────────────────────────────────────────────────
describe("labelPhotoEvidence — a photo is evidence for exactly one code", () => {
  const photo = { dataUrl: "data:...", blob: {} };

  it("holds when the code still matches the one the photo produced", () => {
    expect(labelPhotoEvidence({ labelPhoto: photo, photoForCode: "CT8527016", normalised: "CT8527016" }))
      .toBe(photo);
  });

  it("drops the moment the code moves on", () => {
    expect(labelPhotoEvidence({ labelPhoto: photo, photoForCode: "CT8527016", normalised: "CT8527700" }))
      .toBeNull();
  });

  it("THE RETAKE GAP: a new photo with no binding is NOT evidence for the old code", () => {
    // The first version of this guard set photoForCode only on success, so a
    // FAILED retake left a brand-new photo paired with the PREVIOUS code. The
    // component now clears the binding before the read; this asserts the
    // cleared state is treated as "no evidence".
    expect(labelPhotoEvidence({ labelPhoto: photo, photoForCode: null, normalised: "CT8527016" })).toBeNull();
    expect(labelPhotoEvidence({ labelPhoto: photo, photoForCode: "", normalised: "CT8527016" })).toBeNull();
  });

  it("no photo is never evidence, whatever the binding says", () => {
    expect(labelPhotoEvidence({ labelPhoto: null, photoForCode: "CT8527016", normalised: "CT8527016" })).toBeNull();
  });

  it("an empty code is never evidence", () => {
    expect(labelPhotoEvidence({ labelPhoto: photo, photoForCode: "CT8527016", normalised: "" })).toBeNull();
  });

  it("junk input returns null rather than throwing", () => {
    expect(labelPhotoEvidence()).toBeNull();
    expect(labelPhotoEvidence({})).toBeNull();
  });
});
