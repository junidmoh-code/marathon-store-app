// ─── ARMING A LOCATION SEATS NOTHING — the client half ────────────────────────
// Run: npx vitest run src/components/stock/seatingArmGate.test.js
//
// The rule: an engine policy sets HOW MANY to keep, never WHERE to keep. A leg
// being armed for the first time reaches only products the location already
// holds a stock cell for.
//
// The SERVER is the gate — functions/lib/category-policy-write.cjs
// gateNewLegsToSeated, pinned in functions/test/policy-seating-gate.test.cjs —
// and it holds whatever any client sends. These tests pin the client side of
// the same rule: the seed the arming button produces, and that it survives the
// whole draft → policy path intact. A screen that showed "All products" and
// then saved a scoped leg would be lying about what it just did, which is how
// the 2026-09-08 arming went unnoticed for a day.

import { describe, it, expect } from "vitest";
import { seedArmedLocation, seedLocation, seedPerSizeLocation, policyFromDraft, draftFromEntry, editorRows } from "./enginePolicyCore";

describe("seedArmedLocation", () => {
  it("stamps carriedOnly on a one-size leg", () => {
    const row = seedArmedLocation({ target: 4 });
    expect(row.carriedOnly).toBe(true);
    // …and changes nothing else about the seed it has always produced.
    const { carriedOnly, ...rest } = row;
    expect(rest).toEqual(seedLocation(4));
  });

  it("stamps carriedOnly on a per-size leg, leaving the size run alone", () => {
    const run = ["6", "7", "8"];
    const row = seedArmedLocation({ sizeRun: run });
    expect(row.carriedOnly).toBe(true);
    expect(row.sizes).toEqual(seedPerSizeLocation(run).sizes);
  });

  it("has no way to produce an unscoped leg", () => {
    // No argument, in any shape, turns it off. There is deliberately no
    // parameter for it: the choice this function exists to remove is the choice
    // of arming without deciding.
    for (const args of [{}, { target: 0 }, { target: null }, { sizeRun: [] },
                        { sizeRun: ["6"], target: 9 }, { carriedOnly: false }]) {
      expect(seedArmedLocation(args).carriedOnly).toBe(true);
    }
  });
});

describe("the scope survives the save path", () => {
  it("a seeded one-size leg reaches the callable as carriedOnly", () => {
    const draft = { hub2: { ...seedArmedLocation({ target: 3 }), target: "3", minQty: "2" } };
    expect(policyFromDraft(draft)).toEqual({ hub2: { target: 3, minQty: 2, carriedOnly: true } });
  });

  it("a seeded per-size leg reaches the callable as carriedOnly", () => {
    const seeded = seedArmedLocation({ sizeRun: ["6", "7"] });
    const draft = { hub1: { ...seeded, sizes: { 6: { target: "3", minQty: "2", reorderPoint: "" },
                                                7: { target: "3", minQty: "2", reorderPoint: "" } } } };
    const out = policyFromDraft(draft, { perSize: true });
    expect(out.hub1.carriedOnly).toBe(true);
    expect(out.hub1.sizes).toEqual({ 6: { target: 3, minQty: 2 }, 7: { target: 3, minQty: 2 } });
    expect(out.perSize).toBe(true);
  });
});

describe("an ALREADY-ARMED leg is not narrowed by any of this", () => {
  // The live case: hub1's sneakers are armed unscoped. Loading that entry into
  // the editor and saving it back must produce the same unscoped leg — the seed
  // above is for NEW legs and must never reach an existing one.
  const entry = { perSize: true, hub1: { sizes: { 7: { target: 5, minQty: 3 } } } };
  const carriage = { hub1: { carries: true, products: 40, units: 90 }, hub2: { carries: true, products: 5, units: 9 } };

  it("round-trips unscoped", () => {
    const draft = draftFromEntry({ entry, carriage, destinations: ["hub1", "hub2"] });
    expect(draft.hub1.carriedOnly).toBeUndefined();
    expect(policyFromDraft(draft, { perSize: true }).hub1.carriedOnly).toBeUndefined();
  });

  it("and the editor row still reports it as unscoped, so the chip is honest", () => {
    const rows = editorRows({ entry, carriage, destinations: ["hub1", "hub2"] });
    const hub1 = rows.find((r) => r.loc === "hub1");
    expect(hub1.armed).toBe(true);
    expect(hub1.carriedOnly).toBe(false);
    // hub2 is a destination with no leg — the row exists so it can be armed,
    // and it is NOT armed, which is what makes its chip fixed on screen.
    expect(rows.find((r) => r.loc === "hub2").armed).toBe(false);
  });
});
