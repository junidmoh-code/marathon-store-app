// ─── deactivation.js — the flag's whole contract, pinned ─────────────────────
// Run: npx vitest run src/utils/deactivation.test.js
//
// Mutation-proofed by scripts/mutation-proof-deactivate.mjs: each block names
// the mutation that must turn it red.

import { describe, it, expect } from "vitest";
import {
  isDeactivated, deactivateUpdates, reactivateUpdates, orderSizeOut, deactivationLine,
} from "./deactivation.js";

describe("isDeactivated", () => {
  it("is a single truthy check on the deactivated node", () => {
    expect(isDeactivated({ deactivated: { at: 1, by: "u1" } })).toBe(true);
    expect(isDeactivated({})).toBe(false);
    expect(isDeactivated(null)).toBe(false);
    // A reactivated product (node deleted, stamp left) is ACTIVE.
    expect(isDeactivated({ reactivated: { at: 2, by: "u1", reason: "manual" } })).toBe(false);
  });
});

describe("payload shapes — one node on, the other deleted, atomically", () => {
  it("deactivate sets deactivated and DELETES reactivated in one update", () => {
    const u = deactivateUpdates("p1", { uid: "u1", byName: "junid", nowMs: 123 });
    expect(u).toEqual({
      "products/p1/deactivated": { at: 123, by: "u1", byName: "junid" },
      "products/p1/reactivated": null,
    });
  });
  it("reactivate DELETES deactivated and stamps who/when/why", () => {
    const u = reactivateUpdates("p1", { uid: "u1", byName: "junid", nowMs: 456, reason: "stock_received" });
    expect(u).toEqual({
      "products/p1/deactivated": null,
      "products/p1/reactivated": { at: 456, by: "u1", byName: "junid", reason: "stock_received" },
    });
  });
  it("never writes undefined — a missing byName is OMITTED (the #327 lesson)", () => {
    const d = deactivateUpdates("p1", { uid: "u1", byName: null, nowMs: 1 });
    expect("byName" in d["products/p1/deactivated"]).toBe(false);
    const r = reactivateUpdates("p1", { uid: "u1", byName: undefined, nowMs: 1 });
    expect("byName" in r["products/p1/reactivated"]).toBe(false);
    expect(r["products/p1/reactivated"].reason).toBe("manual");
  });
  it("touches ONLY the two flag paths — record, stock, barcodes, history untouched", () => {
    for (const u of [
      deactivateUpdates("p1", { uid: "u1", byName: "j", nowMs: 1 }),
      reactivateUpdates("p1", { uid: "u1", byName: "j", nowMs: 1, reason: "manual" }),
    ]) {
      expect(Object.keys(u).sort()).toEqual(["products/p1/deactivated", "products/p1/reactivated"]);
    }
  });
});

describe("orderSizeOut — the ordering predicate all three chip surfaces share", () => {
  const active = { id: "p1", productType: "clothing" };
  it("a deactivated product's sizes are out for ANY product type, stock or not", () => {
    const dead = { id: "p1", deactivated: { at: 1, by: "u1" } };
    expect(orderSizeOut(dead, { clothingOrder: false, hubQty: 99 })).toBe(true);
    expect(orderSizeOut({ ...dead, productType: "clothing" }, { clothingOrder: true, hubQty: 5 })).toBe(true);
  });
  it("an ACTIVE product keeps today's exact behaviour: clothing gates on hub qty, sneakers never grey", () => {
    expect(orderSizeOut(active, { clothingOrder: true, hubQty: 0 })).toBe(true);
    expect(orderSizeOut(active, { clothingOrder: true, hubQty: 1 })).toBe(false);
    expect(orderSizeOut({ id: "s1" }, { clothingOrder: false, hubQty: 0 })).toBe(false);
  });
});

describe("deactivationLine", () => {
  it("says who and when, and is empty for an active product", () => {
    const line = deactivationLine({ deactivated: { at: Date.parse("2026-08-25T08:00:00Z"), by: "u1", byName: "junid" } });
    expect(line).toMatch(/^Deactivated /);
    expect(line).toContain("by junid");
    expect(deactivationLine({})).toBe("");
  });
});
