// ─── EVERY TOKEN ON THE LABEL, ONE LIST — the pure half ──────────────────────
// (Owner spec 2026-08-15.) The count flow used to auto-pick ONE code-shaped
// token off a multi-token label and resolve against that token alone; the
// products owned by the label's other numbers were never gathered. These are
// the merge rules that replace it, exercised as data.
//
// Claims:
//   1. THREE tokens → ONE list, carrying candidates from all three.
//   2. Each candidate records WHICH token(s) found it, primary token first.
//   3. Local stamps, index claims (primary + siblings) and the server's
//      alias-only owners all pool into the same list, deduped by product.
//   4. An owner this device cannot show is UNLOADED — never silently dropped.
//   5. A merged-away owner is NEITHER a candidate nor unloaded (its survivor
//      answers for it) — the same rule resolveStyleNumber already enforces.
//   6. ownerCodes distinguishes "one code, several colourways" from "this
//      label's numbers name different products".

import { describe, it, expect } from "vitest";
import { labelTokenSet, mergeTokenCandidates } from "./hubCleanupCore.js";

const P = (id, code, extra = {}) => ({ id, name: id, styleCodeNormalised: code, photoUrl: `https://x/${id}.jpg`, ...extra });

// The live Timberland case from the owner's report: one label, two numbers.
const TIMBER = P("pTimber", "A6CWNEN3");
const OTHER = P("pOther", "A8425");
const THIRD = P("pThird", "TB0A2Q1M");

describe("labelTokenSet", () => {
  it("puts the read code first, normalises, and drops duplicates and blanks", () => {
    expect(labelTokenSet("a6cw-nen3", ["A8425", "a6cwnen3", "", null, "TB0A2Q1M"]))
      .toEqual(["A6CWNEN3", "A8425", "TB0A2Q1M"]);
  });
  it("a single-token label is a one-element set — the flow's untouched road", () => {
    expect(labelTokenSet("CT8527-016", null)).toEqual(["CT8527016"]);
    expect(labelTokenSet("CT8527-016", ["CT8527016"])).toEqual(["CT8527016"]);
  });
});

describe("mergeTokenCandidates — one list from every token", () => {
  it("THREE tokens each owning a different product produce ONE list of three", () => {
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425", "TB0A2Q1M"],
      products: [TIMBER, OTHER, THIRD],
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber", "pOther", "pThird"]);
    // Each row knows which of the label's numbers found it — that string is
    // what the picker renders under the name.
    expect(out.candidates.map((c) => c.codes)).toEqual([["A6CWNEN3"], ["A8425"], ["TB0A2Q1M"]]);
    expect(out.unloadedIds).toEqual([]);
    expect(out.ownerCodes.sort()).toEqual(["A6CWNEN3", "A8425", "TB0A2Q1M"]);
  });

  it("the PRIMARY token's owner leads the list — ordering, never filtering", () => {
    const out = mergeTokenCandidates({
      tokens: ["A8425", "A6CWNEN3"], products: [TIMBER, OTHER],
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pOther", "pTimber"]);
  });

  it("one product found by TWO of the label's numbers keeps both, deduped once", () => {
    const both = P("pBoth", "A6CWNEN3");
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"], products: [both],
      serverOwners: [{ productId: "pBoth", code: "A8425", via: "alias" }],
    });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].codes).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("index claims (primary AND registered siblings) pool with local stamps", () => {
    const sib = P("pSib", null);
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"],
      products: [TIMBER, sib],
      claims: { A8425: { productId: "pSib", claimedAt: 1 } },
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber", "pSib"]);
    expect(out.ownerCodes.sort()).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("an ALIAS-ONLY owner — invisible to any local scan — still reaches the list", () => {
    // The count files code aliases that never stamp a product row. Without the
    // server half this product could not appear, which is exactly how the
    // other token's shoe stayed hidden.
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"], products: [TIMBER, OTHER.id ? { ...OTHER, styleCodeNormalised: null } : OTHER],
      serverOwners: [{ productId: "pOther", code: "A8425", via: "alias" }],
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber", "pOther"]);
  });

  it("an owner this device cannot show is UNLOADED, never dropped", () => {
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"], products: [TIMBER],
      serverOwners: [{ productId: "pGhost", code: "A8425", via: "index" }],
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber"]);
    expect(out.unloadedIds).toEqual(["pGhost"]);
    // The unloaded owner's code still counts towards the framing decision —
    // two different numbers is a duplicate question even when one owner is
    // only a promise from the index.
    expect(out.ownerCodes.sort()).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("an unloaded id the caller DID fetch becomes an ordinary candidate", () => {
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"], products: [TIMBER],
      serverOwners: [{ productId: "pFetched", code: "A8425", via: "index" }],
      resolved: { pFetched: P("pFetched", "A8425") },
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber", "pFetched"]);
    expect(out.unloadedIds).toEqual([]);
  });

  it("a MERGED-AWAY owner is neither a candidate nor unloaded — its survivor answers", () => {
    const dead = P("pDead", "A8425", { mergedInto: "pTimber" });
    const out = mergeTokenCandidates({
      tokens: ["A6CWNEN3", "A8425"], products: [TIMBER, dead],
      claims: { A8425: { productId: "pDead", claimedAt: 1 } },
      serverOwners: [{ productId: "pDead", code: "A8425", via: "index" }],
    });
    expect(out.candidates.map((c) => c.product.id)).toEqual(["pTimber"]);
    expect(out.unloadedIds).toEqual([]);
  });

  it("ONE shared code across every owner is the colourway shape; two codes is the duplicate question", () => {
    const a = P("pA", "A6CWNEN3");
    const b = P("pB", "A6CWNEN3");
    const oneCode = mergeTokenCandidates({ tokens: ["A6CWNEN3", "A8425"], products: [a, b] });
    expect(oneCode.candidates).toHaveLength(2);
    expect(oneCode.ownerCodes).toEqual(["A6CWNEN3"]);

    const twoCodes = mergeTokenCandidates({ tokens: ["A6CWNEN3", "A8425"], products: [a, OTHER] });
    expect(twoCodes.ownerCodes.sort()).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("nothing owns anything → an empty list, so the caller's fallbacks still run", () => {
    const out = mergeTokenCandidates({ tokens: ["ZZZ1", "ZZZ2"], products: [TIMBER] });
    expect(out).toEqual({ candidates: [], unloadedIds: [], ownerCodes: [] });
  });
});
