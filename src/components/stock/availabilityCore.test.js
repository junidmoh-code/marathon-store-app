// Tests for the shared availability resolver (availabilityCore.js) and the
// Tomorrow gate's pure outcome rule. Pure — no firebase, no I/O.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { availableUnits, readyPromisedByCell, cellAvailability, cellBlockInfo, promisedKey, promiseFresh, READY_PROMISE_MAX_AGE_MS } from "./availabilityCore";
import { tomorrowTapOutcome } from "./tomorrowGate";
import { decodeSizeKey } from "../../utils/sizeKey";

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
    // placedAtHub:"hub3" with NO hub field: the app's orderInHub lists this
    // under Hub 1 too ((o.hub || "hub1") === "hub1") — legacy pre-14B shape.
    // The resolver mirrors the app exactly, so it IS counted at hub1.
    { status: "ready", productId: "p1", size: "7", placedAtHub: "hub3" },
    { status: "ready", productId: "p1", size: "9", placedAtHub: "hub3", hub: "hub3" }, // real hub3 order — excluded
    { status: "ready", productId: "c1", size: "M", hub: "hub1" },                   // clothing deducts at dispatch
    { status: "ready", productId: "p1", hub: "hub1" },                              // sizeless — unattributable
    { status: "ready", size: "7", hub: "hub1" },                                    // no productId
    null,
  ];
  it("counts footwear ready orders per cell in encoded-key space", () => {
    const m = readyPromisedByCell(orders, "hub1", PRODUCTS);
    expect(m["p1::7"]).toBe(3);   // 2 plain + the legacy hub-less placedAtHub:"hub3" row
    expect(m["p1::8"]).toBe(1);
    expect(m["p1::5_5"]).toBe(1);
    expect(m["p1::9"]).toBeUndefined();   // a real hub3 order (hub:"hub3") never books hub1
    expect(Object.keys(m).sort()).toEqual(["p1::5_5", "p1::7", "p1::8"]);
  });
  it("defaults a hub-less order to hub1 (the app's orderInHub convention)", () => {
    const m = readyPromisedByCell([{ status: "ready", productId: "p1", size: "6" }], "hub1", PRODUCTS);
    expect(m["p1::6"]).toBe(1);
  });
  it("matches the app's orderInHub EXACTLY: hub1 reads `hub`, hub3/hubC read placedAtHub only", () => {
    // {placedAtHub:"hub1", hub:"hub2"} lists under Hub 2 in the app — booking
    // it at hub1 here was a false ✕ (adversarial review, PR #446).
    const rows = [
      { status: "ready", productId: "p1", size: "6", placedAtHub: "hub1", hub: "hub2" },
      { status: "ready", productId: "p1", size: "7", placedAtHub: "hubC", hub: "hub1" },
    ];
    const h1 = readyPromisedByCell(rows, "hub1", PRODUCTS);
    expect(h1["p1::6"]).toBeUndefined();   // the app calls this a Hub 2 order
    expect(h1["p1::7"]).toBe(1);           // hub reads "hub1" — the app lists it under Hub 1
    expect(readyPromisedByCell(rows, "hubC", PRODUCTS)["p1::7"]).toBe(1);   // and hubC ALSO sees it — both surfaces net it
  });
  it("books NOTHING at central — orders are hub-placed, so central needs no promise netting", () => {
    expect(readyPromisedByCell(orders, "central", PRODUCTS)).toEqual({});
  });
  it("a missing products map nets nothing (partial inputs are safe, never a false X)", () => {
    expect(readyPromisedByCell(orders, "hub1", null)).toEqual({});
  });
});

describe("cellAvailability — the two joined", () => {
  // The fixture is built the way production builds it: STORED keys decoded by
  // decodeSizeKey, exactly what useStockCells hands the caller. A hand-typed
  // raw-size fixture let the classic encoded-vs-decoded indexing bug pass all
  // fourteen tests (adversarial review, PR #446), because raw sizes happen to
  // equal their own decoded keys for plain numerics.
  const decodeByProduct = (byProduct) => {
    const out = {};
    for (const pid of Object.keys(byProduct)) {
      const dec = {};
      for (const k of Object.keys(byProduct[pid])) dec[decodeSizeKey(k)] = byProduct[pid][k];
      out[pid] = dec;
    }
    return out;
  };
  const cells = decodeByProduct({
    p1: { 7: { qty: 3 }, "5_5": { qty: 1 }, 6: { qty: -2 } },
    fs: { _: { qty: 12 } },          // one-size product — "Free Size" in the grid
    sp: { _8: { qty: 4 } },          // space-padded declared size " 8"
  });
  const promised = { [promisedKey("p1", "7")]: 2, [promisedKey("p1", "5.5")]: 1 };
  it("nets the promise out of the clamped cell", () => {
    expect(cellAvailability({ cells, promised, productId: "p1", size: "7" })).toBe(1);
    expect(cellAvailability({ cells, promised, productId: "p1", size: "5.5" })).toBe(0);
  });
  it("half sizes resolve through the stored 5_5 → decoded 5.5 key", () => {
    expect(cellAvailability({ cells, promised: {}, productId: "p1", size: "5.5" })).toBe(1);
  });
  it('a one-size product asked by its "Free Size" grid label finds the "_" cell', () => {
    expect(cellAvailability({ cells, promised: {}, productId: "fs", size: "Free Size" })).toBe(12);
  });
  it('a space-padded declared size (" 8") finds its "_8" cell', () => {
    expect(cellAvailability({ cells, promised: {}, productId: "sp", size: " 8" })).toBe(4);
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

// ─── THE GHOST-PROMISE BOUND (2026-09-01) ────────────────────────────────────
// /orders is keyed by the DAILY order number, so a stale record survives until
// its number is reused — measured live: 56 "ready" records older than 30 days,
// each permanently ✕-ing a size that had real stock (3 blocked cells traced to
// promises from exactly one month before). A promise now expires after
// READY_PROMISE_MAX_AGE_MS; an order with no parseable timestamp still counts.
describe("readyPromisedByCell — the ghost-promise bound", () => {
  const NOW = Date.parse("2026-09-01T12:00:00.000Z");
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
  it("a month-old ready record no longer books the cell", () => {
    const ghosts = [
      { status: "ready", productId: "p1", size: "7", hub: "hub1", readyAt: iso(31 * 86400000) },
      { status: "ready", productId: "p1", size: "8", hub: "hub1", createdAt: iso(31 * 86400000) },   // readyAt missing — createdAt ages it
    ];
    expect(readyPromisedByCell(ghosts, "hub1", PRODUCTS, NOW)).toEqual({});
  });
  it("a fresh ready order books exactly as before", () => {
    const m = readyPromisedByCell(
      [{ status: "ready", productId: "p1", size: "7", hub: "hub1", readyAt: iso(3600000) }],
      "hub1", PRODUCTS, NOW);
    expect(m["p1::7"]).toBe(1);
  });
  it("the boundary: inside the window counts, past it does not", () => {
    const at = (msAgo) => readyPromisedByCell(
      [{ status: "ready", productId: "p1", size: "7", hub: "hub1", readyAt: iso(msAgo) }],
      "hub1", PRODUCTS, NOW)["p1::7"];
    expect(at(READY_PROMISE_MAX_AGE_MS)).toBe(1);
    expect(at(READY_PROMISE_MAX_AGE_MS + 1)).toBeUndefined();
  });
  it("a fresh readyAt outranks a stale createdAt — the promise clock starts at ready", () => {
    // Ordered 20 days ago, only marked ready an hour ago: the collection
    // window opened at READY, so the promise is fresh.
    const m = readyPromisedByCell(
      [{ status: "ready", productId: "p1", size: "7", hub: "hub1", createdAt: iso(20 * 86400000), readyAt: iso(3600000) }],
      "hub1", PRODUCTS, NOW);
    expect(m["p1::7"]).toBe(1);
  });
  it('an unparseable readyAt ("" default in the wild) falls THROUGH to createdAt, not to "keep forever"', () => {
    const m = readyPromisedByCell(
      [{ status: "ready", productId: "p1", size: "7", hub: "hub1", readyAt: "", createdAt: iso(31 * 86400000) }],
      "hub1", PRODUCTS, NOW);
    expect(m).toEqual({});
  });
  it("an un-ageable order (no timestamps) keeps its promise — legacy shapes stay ✕-ward", () => {
    const m = readyPromisedByCell(
      [{ status: "ready", productId: "p1", size: "7", hub: "hub1" }],
      "hub1", PRODUCTS, NOW);
    expect(m["p1::7"]).toBe(1);
    expect(promiseFresh({}, NOW)).toBe(true);
  });
});

// ─── REGRESSION: the Lacoste Powercourt size 8 report (owner, 2026-09-01) ───
// Hub 1 physically held (and had counted) one size-8 pair; the picker showed
// ✕. Two truths, pinned apart:
//   • a FRESH ready order genuinely reserves the last pair → ✕ stands, and
//     cellBlockInfo carries the split so the UI can say "reserved", not
//     silently look like "this size doesn't exist";
//   • the same record gone stale (its daily key never reused) must NOT keep
//     blocking the size — that was the bug class this pins against.
describe("regression — counted stock vs picker ✕ (Lacoste Powercourt shape)", () => {
  const NOW = Date.parse("2026-09-01T12:00:00.000Z");
  const LACOSTE = { id: "p1779610355274", category: "Footwear", productType: "sneaker" };
  const BY_ID = { [LACOSTE.id]: LACOSTE };
  // The live cell shape: numeric size keys 6..11, size 8 holding the counted 1.
  const cells = { [LACOSTE.id]: { 6: { qty: 3 }, 7: { qty: 2 }, 8: { qty: 1 }, 9: { qty: 1 }, 10: { qty: 2 }, 11: { qty: 2 } } };
  const order113 = { status: "ready", productId: LACOSTE.id, size: "8", hub: "hub1", placedAtHub: "hub1", readyAt: "2026-09-01T10:19:11.147Z" };
  it("fresh ready order: the last pair reads ✕ BY DESIGN, and the why-split says reserved", () => {
    const promised = readyPromisedByCell([order113], "hub1", BY_ID, NOW);
    expect(cellAvailability({ cells, promised, productId: LACOSTE.id, size: "8" })).toBe(0);
    expect(cellBlockInfo({ cells, promised, productId: LACOSTE.id, size: "8" }))
      .toEqual({ booked: 1, promised: 1, available: 0 });
  });
  it("the same record a month stale: size 8 is available again (the bug class)", () => {
    const promised = readyPromisedByCell([{ ...order113, readyAt: "2026-08-01T10:19:11.147Z" }], "hub1", BY_ID, NOW);
    expect(cellAvailability({ cells, promised, productId: LACOSTE.id, size: "8" })).toBe(1);
  });
  it("every other counted size stays available throughout", () => {
    const promised = readyPromisedByCell([order113], "hub1", BY_ID, NOW);
    for (const [sz, want] of [["6", 3], ["7", 2], ["9", 1], ["10", 2], ["11", 2]])
      expect(cellAvailability({ cells, promised, productId: LACOSTE.id, size: sz })).toBe(want);
  });
});

describe("module purity", () => {
  it("availabilityCore imports no firebase — callers feed it data they already hold", () => {
    const src = readFileSync(new URL("./availabilityCore.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ["']firebase/);
    expect(src).not.toMatch(/\.\.\/\.\.\/firebase/);
  });
});
