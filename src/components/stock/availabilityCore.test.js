// Tests for the shared availability resolver (availabilityCore.js) and the
// Tomorrow gate's pure outcome rule. Pure — no firebase, no I/O.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { availableUnits, readyPromisedByCell, cellAvailability, promisedKey } from "./availabilityCore";
import { tomorrowTapOutcome } from "./tomorrowGate";

const SNEAKER = { id: "p1", category: "Footwear", productType: "sneaker" };
const CLOTHING = { id: "c1", category: "Clothing", productType: "clothing" };
const PRODUCTS = { p1: SNEAKER, c1: CLOTHING };

describe("availableUnits — the definition", () => {
  it("clamps a negative cell to zero: a zeroed or oversold cell reads as unavailable", () => {
    expect(availableUnits(-3)).toBe(0);
    expect(availableUnits(0)).toBe(0);
    expect(availableUnits(2)).toBe(2);
  });
  it("subtracts promised units and floors at 0", () => {
    expect(availableUnits(3, 1)).toBe(2);
    expect(availableUnits(2, 2)).toBe(0);
    expect(availableUnits(1, 5)).toBe(0);
    expect(availableUnits(-2, 1)).toBe(0);
  });
  it("garbage inputs read as zero, never NaN", () => {
    expect(availableUnits(undefined)).toBe(0);
    expect(availableUnits("3", "x")).toBe(3);
    expect(availableUnits(NaN, -1)).toBe(0);
  });
});

describe("readyPromisedByCell — ready-but-uncollected promises", () => {
  const orders = [
    { status: "ready", productId: "p1", size: "7", qty: 1, hub: "hub1" },
    { status: "ready", productId: "p1", size: "7", qty: 1, hub: "hub1" },           // stacks
    { status: "ready", productId: "p1", sentSize: "8", size: "7", hub: "hub1" },    // sentSize wins
    { status: "ready", productId: "p1", size: "5.5", hub: "hub1" },                 // half size → 5_5
    { status: "incoming", productId: "p1", size: "9", hub: "hub1" },                // not ready
    { status: "ready", productId: "p1", size: "7", placedAtHub: "hub3" },           // other hub
    { status: "ready", productId: "c1", size: "M", hub: "hub1" },                   // clothing deducts at dispatch
    { status: "ready", productId: "p1", hub: "hub1" },                              // sizeless — unattributable
    { status: "ready", size: "7", hub: "hub1" },                                    // no productId
    null,
  ];
  it("counts footwear ready orders per cell in encoded-key space", () => {
    const m = readyPromisedByCell(orders, "hub1", PRODUCTS);
    expect(m["p1::7"]).toBe(2);
    expect(m["p1::8"]).toBe(1);
    expect(m["p1::5_5"]).toBe(1);
    expect(Object.keys(m).sort()).toEqual(["p1::5_5", "p1::7", "p1::8"]);
  });
  it("defaults a hub-less order to hub1 (the app's orderInHub convention)", () => {
    const m = readyPromisedByCell([{ status: "ready", productId: "p1", size: "6" }], "hub1", PRODUCTS);
    expect(m["p1::6"]).toBe(1);
  });
  it("books NOTHING at central — orders are hub-placed, so central needs no promise netting", () => {
    expect(readyPromisedByCell(orders, "central", PRODUCTS)).toEqual({});
  });
  it("a missing products map nets nothing (partial inputs are safe, never a false X)", () => {
    expect(readyPromisedByCell(orders, "hub1", null)).toEqual({});
  });
});

describe("cellAvailability — the two joined", () => {
  const cells = { p1: { 7: { qty: 3 }, "5.5": { qty: 1 }, 6: { qty: -2 } } };
  const promised = { [promisedKey("p1", "7")]: 2, [promisedKey("p1", "5.5")]: 1 };
  it("nets the promise out of the clamped cell", () => {
    expect(cellAvailability({ cells, promised, productId: "p1", size: "7" })).toBe(1);
    expect(cellAvailability({ cells, promised, productId: "p1", size: "5.5" })).toBe(0);
  });
  it("a negative cell is unavailable", () => {
    expect(cellAvailability({ cells, promised, productId: "p1", size: "6" })).toBe(0);
  });
  it("a missing cell is unavailable", () => {
    expect(cellAvailability({ cells, promised, productId: "p1", size: "9" })).toBe(0);
    expect(cellAvailability({ cells: {}, promised, productId: "p1", size: "7" })).toBe(0);
  });
});

describe("tomorrowTapOutcome — the moment-of-tap rule", () => {
  it("no availability → the promise converts silently to out-of-stock", () => {
    expect(tomorrowTapOutcome(0)).toBe("out_of_stock");
  });
  it("availability → the Tomorrow promise stands", () => {
    expect(tomorrowTapOutcome(1)).toBe("tomorrow");
    expect(tomorrowTapOutcome(7)).toBe("tomorrow");
  });
  it("UNKNOWN (null) fails open to Tomorrow — a false OOS messages a customer wrongly", () => {
    expect(tomorrowTapOutcome(null)).toBe("tomorrow");
  });
});

describe("module purity", () => {
  it("availabilityCore imports no firebase — callers feed it data they already hold", () => {
    const src = readFileSync(new URL("./availabilityCore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ["']firebase/);
    expect(src).not.toMatch(/\.\.\/\.\.\/firebase/);
  });
});
