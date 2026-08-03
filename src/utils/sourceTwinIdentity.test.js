// End-to-end identity assertions for the Source refill queue, wired through the
// SAME functions App.jsx calls: group key → response cell path → movement id
// seed → fulfil gate. Written against the live incident of 2026-08-03, where a
// refill card for one "Nike SB Dunk Low Green White" deducted stock from a
// different product of the identical name.
import { describe, it, expect } from "vitest";
import { restockCountsFromLog, computeRestockCounts, sourceResponsePath, sourceNameKey } from "./insights";
import { buildProductIdIndex, resolveProductIdByName, buildPhotoIndex, photoForProduct, canFulfilCard } from "./productIdentity";
import { sourceMovementIdSeed } from "../components/stock/sourceMovementDedupe";

const NAME = "Nike SB Dunk Low Green White";
const TWIN_A = "p1781649332106";   // barcodes 00009098-103 — the wrongly deducted record
const TWIN_B = "p1781649925620";   // barcodes 00009138-143
const DATE = "2026-06-16";
const SIZE = "9";

const CATALOG = [
  { id: TWIN_A, name: NAME, photoUrl: "https://x/a.jpg" },
  { id: TWIN_B, name: NAME, photoUrl: "https://x/b.jpg" },
];

const ready = (orderNumber, hh, productId) => ({
  action: "ready", orderNumber, productId, productName: NAME, size: SIZE,
  placedAtHub: "hub1", timestamp: `2026-06-16T${hh}:00:00.000Z`,
});
const sale = (productId) => ({ productId, productName: NAME, size: SIZE, hub: "hub1" });

describe("twin products in the Source queue (past-day History feed)", () => {
  it("two same-day same-hub twin requests → two separate cards with two separate response cells", () => {
    const groups = restockCountsFromLog({
      log: [ready("130", "08", TWIN_A), ready("180", "09", TWIN_B)],
      dateStr: DATE, hub: "hub1",
    });

    // Two cards, each carrying its OWN product id — not one merged card whose
    // id came from whichever request happened to be first.
    const keys = Object.keys(groups).sort();
    expect(keys).toEqual([TWIN_A, TWIN_B].sort());
    expect(groups[TWIN_A].productId).toBe(TWIN_A);
    expect(groups[TWIN_B].productId).toBe(TWIN_B);
    expect(groups[TWIN_A].sizes).toEqual({ [SIZE]: 1 });
    expect(groups[TWIN_B].sizes).toEqual({ [SIZE]: 1 });

    // Separate restock_requests cells: responding to one twin cannot mark the
    // other's card complete (the shared-cell half of the bug).
    const cellA = `${sourceResponsePath(DATE, TWIN_A)}/${SIZE}`;
    const cellB = `${sourceResponsePath(DATE, TWIN_B)}/${SIZE}`;
    expect(cellA).not.toBe(cellB);

    // Separate movement ids: twin B's transfer can no longer be swallowed as a
    // duplicate of twin A's (the silent-no-op half of the bug).
    const seedA = sourceMovementIdSeed(DATE, TWIN_A, SIZE);
    const seedB = sourceMovementIdSeed(DATE, TWIN_B, SIZE);
    expect(seedA).not.toBe(seedB);

    // And this is what the OLD name key did to all three of the above.
    const legacyKey = sourceNameKey(NAME);
    expect(groups[TWIN_A].nameKey).toBe(legacyKey);
    expect(groups[TWIN_B].nameKey).toBe(legacyKey);
    expect(sourceMovementIdSeed(DATE, legacyKey, SIZE)).toBe(sourceMovementIdSeed(DATE, legacyKey, SIZE));
  });

  it("today's sales feed splits the same twins the same way (both builders in lock-step)", () => {
    const groups = computeRestockCounts([sale(TWIN_A), sale(TWIN_B)]);
    expect(Object.keys(groups).sort()).toEqual([TWIN_A, TWIN_B].sort());
    // Today and History must agree on the key for the same product, or a
    // response written by one tab would not be seen by the other.
    const fromLog = restockCountsFromLog({ log: [ready("130", "08", TWIN_A)], dateStr: DATE, hub: "hub1" });
    expect(Object.keys(fromLog)).toEqual([TWIN_A]);
    expect(Object.keys(groups)).toContain(TWIN_A);
  });

  it("all three twin cards show three different photos", () => {
    const catalog3 = [...CATALOG, { id: "p1781648943606", name: NAME, photoUrl: "https://x/c.jpg" }];
    const idx = buildPhotoIndex(catalog3);
    const urls = catalog3.map(p => photoForProduct(idx, { productId: p.id, productName: NAME }).photoUrl);
    expect(new Set(urls).size).toBe(3);
  });
});

describe("ambiguous-name refusal reaches the caller", () => {
  // resolveId as fulfilCtx builds it (App.jsx): id if the record has one, else
  // the identity index — which refuses duplicated names.
  const idx = buildProductIdIndex(CATALOG);
  const resolveId = (product) => {
    if (!product) return null;
    if (product.productId) return product.productId;
    return resolveProductIdByName(idx, product.productName);
  };

  it("a pid-less card for a duplicated name resolves to null and CANNOT fulfil", () => {
    const legacyCard = { productName: NAME, productId: null };
    expect(resolveId(legacyCard)).toBeNull();
    // The caller's gate: no id → plain Available button, no stock movement.
    expect(canFulfilCard({ enabled: true, productId: resolveId(legacyCard) })).toBe(false);
  });

  it("a card that carries its own pid still fulfils normally", () => {
    expect(resolveId({ productName: NAME, productId: TWIN_B })).toBe(TWIN_B);
    expect(canFulfilCard({ enabled: true, productId: TWIN_B })).toBe(true);
  });

  it("a pid-less card for a UNIQUE name still resolves and fulfils", () => {
    const idx2 = buildProductIdIndex([...CATALOG, { id: "pU", name: "Adidas Samba OG Black" }]);
    const pid = resolveProductIdByName(idx2, "Adidas Samba OG Black");
    expect(pid).toBe("pU");
    expect(canFulfilCard({ enabled: true, productId: pid })).toBe(true);
  });

  it("no transfer permission → cannot fulfil regardless of a good id", () => {
    expect(canFulfilCard({ enabled: false, productId: TWIN_A })).toBe(false);
  });
});
