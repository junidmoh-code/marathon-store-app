// ─── HUB 2 SNEAKERS THROUGH THE ONE RESOLVER (2026-09-05) ────────────────────
//
// Hub 1 sneakers (built 2026-08-25) and Hub 2 clothing (older, live) each had a
// grey-out; Hub 2 SNEAKERS had neither that nor the Tomorrow gate. This file
// pins the first half of closing that gap: availabilityCore.js — the one shared
// resolver — answers for a Hub 2 cell with EXACTLY the arithmetic it uses at
// Hub 1. No second definition of "available" was added for Hub 2; the module is
// hub-agnostic by construction (`loc` is a parameter), and these tests are the
// proof that it really is, not a claim.
//
// THE DEFINITION, restated for this lane (owner decisions, unchanged):
//   available = max(0, cellQty) − ready-order promises, floored at 0
//   • displays count as available stock and are NEVER subtracted
//   • no missed-demand logging — a blocked size is just an ✕
//
// Live census 2026-09-05 (scripts/census-hub2-negative-sneaker-cells.mjs):
// Hub 2 holds 2,476 sneaker cells, 22 of them negative, −23 units in total
// (one at −2, twenty-one at −1). Every one of those reads unavailable here
// through the clamp; none were zeroed by this branch.
import { describe, it, expect } from "vitest";
import {
  availableUnits, readyPromisedByCell, cellAvailability, cellBlockInfo, promisedKey,
} from "./availabilityCore";
import { decodeSizeKey, stockSizeKey } from "../../utils/sizeKey";
import { orderSizeOut } from "../../utils/deactivation";

const SNEAKER = { id: "s1", category: "Footwear", productType: "sneaker" };
const BOOT    = { id: "s2", category: "Footwear", productType: "sneaker" };   // "Boots" — same seven-category group
const CLOTHING = { id: "c1", category: "Clothing", productType: "clothing" };
const PRODUCTS = { s1: SNEAKER, s2: BOOT, c1: CLOTHING };

// Built the way production builds it: STORED keys decoded by decodeSizeKey,
// exactly what useStockCells/useStockCellsState hand the caller. A hand-typed
// raw-size fixture hides the encoded-vs-decoded indexing bug for plain
// numerics (adversarial review, PR #446) — so never hand-type one.
const decodeByProduct = (byProduct) => {
  const out = {};
  for (const pid of Object.keys(byProduct)) {
    const dec = {};
    for (const k of Object.keys(byProduct[pid])) dec[decodeSizeKey(k)] = byProduct[pid][k];
    out[pid] = dec;
  }
  return out;
};

describe("the resolver answers for Hub 2 exactly as it does for Hub 1", () => {
  it("readyPromisedByCell books a hub2 order at hub2 and nowhere else", () => {
    const orders = [
      { status: "ready", productId: "s1", size: "8", hub: "hub2", readyAt: "2026-09-05T10:00:00.000Z" },
      { status: "ready", productId: "s1", size: "9", hub: "hub1", readyAt: "2026-09-05T10:00:00.000Z" },
    ];
    const NOW = Date.parse("2026-09-05T10:05:00.000Z");
    const h2 = readyPromisedByCell(orders, "hub2", PRODUCTS, NOW);
    const h1 = readyPromisedByCell(orders, "hub1", PRODUCTS, NOW);
    expect(h2).toEqual({ "s1::8": 1 });
    expect(h1).toEqual({ "s1::9": 1 });
  });
  it("a hub-less order defaults to hub1, never to hub2 (the app's orderInHub convention)", () => {
    const rows = [{ status: "ready", productId: "s1", size: "8" }];
    expect(readyPromisedByCell(rows, "hub2", PRODUCTS)).toEqual({});
    expect(readyPromisedByCell(rows, "hub1", PRODUCTS)["s1::8"]).toBe(1);
  });
  it("hub2 and hub1 are the SAME code path — same inputs, same numbers, per hub", () => {
    const cells = decodeByProduct({ s1: { 7: { qty: 4 } } });
    const mk = (h) => [{ status: "ready", productId: "s1", size: "7", hub: h, readyAt: "2026-09-05T10:00:00.000Z" }];
    const NOW = Date.parse("2026-09-05T10:05:00.000Z");
    for (const h of ["hub1", "hub2"]) {
      const promised = readyPromisedByCell(mk(h), h, PRODUCTS, NOW);
      expect(cellAvailability({ cells, promised, productId: "s1", size: "7" })).toBe(3);
    }
  });
});

describe("Hub 2 sneaker cells — negative, over-promised, and plain", () => {
  // The live shapes: the −2 cell (Air Jordan 1 low size 5) and a −1 cell, plus
  // an over-promised cell and a healthy one.
  const cells = decodeByProduct({
    s1: { 5: { qty: -2 }, 6: { qty: -1 }, 7: { qty: 1 }, 8: { qty: 3 }, 9: { qty: 0 } },
    s2: { 10: { qty: 2 } },
  });
  const NOW = Date.parse("2026-09-05T10:05:00.000Z");
  const READY = "2026-09-05T10:00:00.000Z";
  const promised = readyPromisedByCell([
    { status: "ready", productId: "s1", size: "7", hub: "hub2", readyAt: READY },   // takes the only pair
    { status: "ready", productId: "s2", size: "10", qty: 5, hub: "hub2", readyAt: READY },  // over-promised: 5 booked out of 2
  ], "hub2", PRODUCTS, NOW);

  it("a negative cell is unavailable and never reports a negative number", () => {
    expect(cellAvailability({ cells, promised, productId: "s1", size: "5" })).toBe(0);
    expect(cellAvailability({ cells, promised, productId: "s1", size: "6" })).toBe(0);
    expect(availableUnits(-2)).toBe(0);
  });
  it("an OVER-promised cell floors at zero, never goes negative", () => {
    expect(promised["s2::10"]).toBe(5);
    expect(cellAvailability({ cells, promised, productId: "s2", size: "10" })).toBe(0);
    expect(cellBlockInfo({ cells, promised, productId: "s2", size: "10" }))
      .toEqual({ booked: 2, promised: 5, available: 0 });
  });
  it("the last pair reserved for an uncollected order reads ✕, with the why-split intact", () => {
    expect(cellAvailability({ cells, promised, productId: "s1", size: "7" })).toBe(0);
    expect(cellBlockInfo({ cells, promised, productId: "s1", size: "7" }))
      .toEqual({ booked: 1, promised: 1, available: 0 });
  });
  it("the why-split never reports a NEGATIVE booked — the note renders that number", () => {
    // "All -2 of size 5 at Hub 2 are reserved…" is what an unclamped split
    // would put in front of staff. 22 Hub 2 sneaker cells are negative today.
    expect(cellBlockInfo({ cells, promised, productId: "s1", size: "5" }))
      .toEqual({ booked: 0, promised: 0, available: 0 });
    expect(cellBlockInfo({ cells, promised, productId: "s1", size: "6" }))
      .toEqual({ booked: 0, promised: 0, available: 0 });
  });
  it("an empty cell and a missing cell are both unavailable", () => {
    expect(cellAvailability({ cells, promised, productId: "s1", size: "9" })).toBe(0);
    expect(cellAvailability({ cells, promised, productId: "s1", size: "13" })).toBe(0);
  });
  it("a healthy cell reports its units", () => {
    expect(cellAvailability({ cells, promised, productId: "s1", size: "8" })).toBe(3);
  });
});

describe("sizes 3 – 13, whole and half, resolve through sizeKey.js", () => {
  // The full South African sneaker run as the grid renders it, each size given
  // a distinct quantity so a key that resolves to the WRONG cell cannot pass.
  const RUN = ["3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8",
               "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12", "12.5", "13"];
  const stored = {};
  RUN.forEach((sz, i) => { stored[stockSizeKey(sz)] = { qty: i + 1 }; });
  const cells = decodeByProduct({ s1: stored });

  it("half sizes are stored under the underscore key — 5.5 lives at 5_5", () => {
    expect(stockSizeKey("5.5")).toBe("5_5");
    expect(Object.keys(stored)).toContain("5_5");
    expect(Object.keys(stored)).not.toContain("5.5");
  });
  it("every size in the run resolves to its OWN cell, value for value", () => {
    RUN.forEach((sz, i) => {
      expect(cellAvailability({ cells, promised: {}, productId: "s1", size: sz })).toBe(i + 1);
    });
  });
  it("a promise on 5.5 blocks 5.5 and leaves 5 and 6 alone", () => {
    const NOW = Date.parse("2026-09-05T10:05:00.000Z");
    const promised = readyPromisedByCell(
      [{ status: "ready", productId: "s1", size: "5.5", qty: 6, hub: "hub2", readyAt: "2026-09-05T10:00:00.000Z" }],
      "hub2", PRODUCTS, NOW);
    expect(promised).toEqual({ "s1::5_5": 6 });
    expect(promisedKey("s1", "5.5")).toBe("s1::5_5");
    expect(cellAvailability({ cells, promised, productId: "s1", size: "5.5" })).toBe(0);   // 6 booked, 6 promised
    expect(cellAvailability({ cells, promised, productId: "s1", size: "5" })).toBe(5);
    expect(cellAvailability({ cells, promised, productId: "s1", size: "6" })).toBe(7);
  });
});

// ─── HUB 2 CLOTHING IS UNCHANGED, VALUE FOR VALUE ────────────────────────────
// The convergence: the clothing grey-out's zero-test now runs through the same
// availableUnits() the sneaker lane uses, instead of its own `Number(q)||0`.
// That is a definition merge, NOT a behaviour change — and the claim is only
// worth as much as its proof, so this exhausts the input space that matters.
//
// What deliberately did NOT converge: clothing looks its cell up by the RAW
// declared size, the sneaker lane by decodedCellKey. Merging THAT would change
// which cell a "Free Size" / space-padded clothing size reads, i.e. it would
// change live Hub 2 clothing behaviour — forbidden. It stays as it is, stated
// here so the next reader does not "fix" it by accident.
describe("Hub 2 clothing — the converged arithmetic is byte-identical", () => {
  const legacyHubQty = (q) => Number(q) || 0;              // what App.jsx did before
  const convergedHubQty = (q) => availableUnits(q);        // what it does now
  const INPUTS = [
    -100, -23, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 12, 999,
    undefined, null, NaN, "", "0", "3", "-1", "x", true, false,
  ];
  it("the two agree on OUT vs IN for every input a cell can hold", () => {
    for (const q of INPUTS) {
      expect(orderSizeOut(CLOTHING, { clothingOrder: true, hubQty: convergedHubQty(q) }))
        .toBe(orderSizeOut(CLOTHING, { clothingOrder: true, hubQty: legacyHubQty(q) }));
    }
  });
  it("the two agree on the ADD clamp — Math.max(0, qty − inCart) for every input", () => {
    for (const q of INPUTS) {
      for (const inCart of [0, 1, 5]) {
        expect(Math.max(0, convergedHubQty(q) - inCart)).toBe(Math.max(0, legacyHubQty(q) - inCart));
      }
    }
  });
  it("the two agree on the note's `have <= 0` test and its `rem > left` self-hide", () => {
    for (const q of INPUTS) {
      for (const inCart of [0, 1, 5]) {
        const a = convergedHubQty(q), b = legacyHubQty(q);
        expect(a <= 0).toBe(b <= 0);
        // left is minted as Math.max(0, remaining) at the time the note is set,
        // then re-tested as `rem > left` on every later render.
        const la = Math.max(0, a - inCart), lb = Math.max(0, b - inCart);
        expect((a - inCart) > la).toBe((b - inCart) > lb);
      }
    }
  });
  it("only NEGATIVE inputs differ in VALUE, and every consumer floors them", () => {
    // The one observable difference, named: −23 becomes 0. Both are ≤ 0, both
    // floor to 0 in the clamp, both render the same note. Nothing else changes.
    expect(convergedHubQty(-23)).toBe(0);
    expect(legacyHubQty(-23)).toBe(-23);
    for (const q of INPUTS) {
      if (legacyHubQty(q) >= 0) expect(convergedHubQty(q)).toBe(legacyHubQty(q));
    }
  });
  it("clothing nets NO promises — readyPromisedByCell is footwear-only, at hub2 as at hub1", () => {
    const rows = [{ status: "ready", productId: "c1", size: "M", hub: "hub2", readyAt: "2026-09-05T10:00:00.000Z" }];
    expect(readyPromisedByCell(rows, "hub2", PRODUCTS, Date.parse("2026-09-05T10:05:00.000Z"))).toEqual({});
  });
});
