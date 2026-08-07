// ─── COUNT + REGISTRATION, SIBLING-AWARE — the owner-spec proofs (2026-08-07) ─
// Pinned here:
//   • a code owning MORE THAN ONE product NEVER resolves silently in counting
//   • a code owning exactly one still resolves in ONE step, as before
//   • registered siblings present as a colourway CHOICE (no merge banner);
//     an unexplained collision keeps the merge route
//   • a collision at REGISTRATION asks — it neither blocks nor merges nor
//     saves silently — and an answered question releases the save

import { describe, it, expect } from "vitest";
import { resolveStyleNumber, collisionQuestion, styleStepSatisfied } from "./hubCleanupCore.js";

const P = (id, extra = {}) => ({ id, name: id, ...extra });
const CODE = "HF5509002";

describe("count: one code, several owners — NEVER silent", () => {
  const white = P("pWhite", { styleCodeNormalised: CODE });
  const black = P("pBlack", { styleCodeNormalised: CODE });

  it("PROOF: registered siblings resolve to a CHOICE, not to a product", () => {
    const claim = { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2 } } };
    const out = resolveStyleNumber(CODE, { products: [white, black], claim });
    expect(out.kind).toBe("choose");
    expect(out.products.map((p) => p.id).sort()).toEqual(["pBlack", "pWhite"]);
    expect(out.siblings).toBe(true); // the index vouches for all — colourways, no merge banner
  });

  it("PROOF: a sibling named ONLY by the index (not yet stamped locally) still forces the choice", () => {
    // pBlack has no styleCodeNormalised stamp — only the index knows it owns
    // the code. Silence here would count the wrong colourway.
    const claim = { productId: "pWhite", claimedAt: 1, siblings: { pBlack: { addedAt: 2 } } };
    const out = resolveStyleNumber(CODE, { products: [white, P("pBlack")], claim });
    expect(out.kind).toBe("choose");
    expect(out.products.map((p) => p.id).sort()).toEqual(["pBlack", "pWhite"]);
  });

  it("an index owner missing from this device is surfaced, never dropped", () => {
    const claim = { productId: "pWhite", claimedAt: 1, siblings: { pGhost: { addedAt: 2 } } };
    const out = resolveStyleNumber(CODE, { products: [white], claim });
    expect(out.kind).toBe("choose");
    expect(out.unloadedIds).toEqual(["pGhost"]);
    expect(out.siblings).toBe(false); // cannot vouch for what cannot be shown
  });

  it("PROOF: exactly one owner still resolves in ONE step, exactly as before", () => {
    const claim = { productId: "pWhite", claimedAt: 1 };
    expect(resolveStyleNumber(CODE, { products: [white], claim }))
      .toEqual({ kind: "claim", productId: "pWhite", normalised: CODE });
    // …and with no claim at all, the sole stamped owner answers.
    expect(resolveStyleNumber(CODE, { products: [white], claim: null }).kind).toBe("product");
  });

  it("a claim whose ONLY owner is the stamped product is not a choice — one owner is one owner", () => {
    // The index and the stamp agree on a single product; asking would be noise.
    const claim = { productId: "pWhite", claimedAt: 1, siblings: {} };
    const out = resolveStyleNumber(CODE, { products: [white], claim });
    expect(out.kind).toBe("claim");
  });
});

describe("registration: the collision asks — never blocks, never merges, never silent", () => {
  const owner = P("pWhite", { styleCodeNormalised: CODE });

  it("PROOF: an unanswered collision is an ASK — and it HOLDS the save", () => {
    expect(collisionQuestion({ conflictOwners: [owner], siblingOk: false })).toBe("ask");
    // The save gate: style step satisfied but question unanswered → not ready.
    const payload = { code: "HF5509-002", source: "label", labelPhoto: null };
    expect(styleStepSatisfied(P("pMine"), payload)).toBe(true);
    const styleReady = styleStepSatisfied(P("pMine"), payload)
      && collisionQuestion({ conflictOwners: [owner], siblingOk: false }) !== "ask";
    expect(styleReady).toBe(false);
  });

  it("PROOF: answering 'different colourway' releases the save — both keep the code", () => {
    expect(collisionQuestion({ conflictOwners: [owner], siblingOk: true })).toBe("resolved");
    const payload = { code: "HF5509-002", source: "label", labelPhoto: null };
    const styleReady = styleStepSatisfied(P("pMine"), payload)
      && collisionQuestion({ conflictOwners: [owner], siblingOk: true }) !== "ask";
    expect(styleReady).toBe(true);
  });

  it("no collision means no question", () => {
    expect(collisionQuestion({ conflictOwners: [], siblingOk: false })).toBe("none");
    expect(collisionQuestion({})).toBe("none");
    expect(collisionQuestion()).toBe("none");
  });

  it("there is NO input that resolves a live collision without an answer — silence is not an outcome", () => {
    // Exhaustive over the whole input space of the decision: with a conflict
    // present, the ONLY way out of "ask" is siblingOk (the recorded answer).
    for (const siblingOk of [false, undefined, null, 0, ""]) {
      expect(collisionQuestion({ conflictOwners: [owner], siblingOk })).toBe("ask");
    }
  });
});

describe("merged-away owners (CodeRabbit, PR #331)", () => {
  const CODE2 = "HF5509002";
  it("a claim naming a merged-away sibling plus ONE live owner stays on the one-step path", () => {
    const live = P("pWhite", { styleCodeNormalised: CODE2 });
    const gone = P("pOld", { styleCodeNormalised: CODE2, mergedInto: "pWhite" });
    const claim = { productId: "pWhite", claimedAt: 1, siblings: { pOld: { addedAt: 2 } } };
    const out = resolveStyleNumber(CODE2, { products: [live, gone], claim });
    // The merged-away owner is neither a candidate nor "unloaded" — its
    // survivor answers for it. One live owner = one step, no picker.
    expect(out).toEqual({ kind: "claim", productId: "pWhite", normalised: CODE2 });
  });
});
