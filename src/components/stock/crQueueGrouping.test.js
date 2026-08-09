// ─── CR ORDERS product-grouping — presentation-only guarantees, pinned ───────
// Run: npx vitest run src/components/stock/crQueueGrouping.test.js
// Every fixture batch and item is DEEP-FROZEN: if grouping ever tries to write,
// merge, or rewrite a request record, these tests throw before they assert.
import { describe, it, expect } from "vitest";
import { crMovementId, crLineCreatedAt, mergeActiveCRBatches, pendingUnits } from "./crQueueGrouping.js";

const deepFreeze = (x) => {
  if (x && typeof x === "object") { Object.values(x).forEach(deepFreeze); Object.freeze(x); }
  return x;
};

// A per-request batch exactly as the warehouse memo builds it (one createdAt
// per request; every item carries its own createdAt = the request's).
const req = ({ pid = "p1", name = "England Jersey", shop = "marathon-pe", createdAt, items, auto = false, shadow = false }) =>
  deepFreeze({
    batchKey: `${pid}__${shop}__${createdAt}`,
    productId: pid, productName: name, destShop: shop, createdAt,
    productPhoto: null, productPhotoUrl: null,
    ...(auto ? { autoRefill: true } : {}), ...(shadow ? { shadow: true } : {}),
    items: items.map((it) => ({ status: null, qty: 1, gen: 0, createdAt, ...it })),
  });

describe("one card per product — sizes from separate requests combine", () => {
  it("two sizes of one product, requested at different times, render on ONE card", () => {
    const S = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const M = req({ createdAt: "2026-08-09T10:30:00.000Z", items: [{ orderId: "R004", size: "M" }] });
    const out = mergeActiveCRBatches([S, M]);
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => i.size)).toEqual(["S", "M"]);
    // Item records pass through BY REFERENCE — nothing rewritten.
    expect(out[0].items[0]).toBe(S.items[0]);
    expect(out[0].items[1]).toBe(M.items[0]);
  });

  it("a third size arriving later JOINS the card (same key) instead of starting a new row", () => {
    const S = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const M = req({ createdAt: "2026-08-09T10:30:00.000Z", items: [{ orderId: "R004", size: "M" }] });
    const before = mergeActiveCRBatches([S, M]);
    const L = req({ createdAt: "2026-08-09T12:15:00.000Z", items: [{ orderId: "R009", size: "L" }] });
    const after = mergeActiveCRBatches([S, M, L]);
    expect(after).toHaveLength(1);
    // The card identity is stable across arrivals — the accordion stays put.
    expect(after[0].batchKey).toBe(before[0].batchKey);
    expect(after[0].items.map((i) => i.size)).toEqual(["S", "M", "L"]);
    // A card's age is its OLDEST ask.
    expect(after[0].createdAt).toBe("2026-08-09T08:00:00.000Z");
  });

  it("a single-size product still renders as one ordinary card", () => {
    const solo = req({ createdAt: "2026-08-09T09:00:00.000Z", items: [{ orderId: "R002", size: "XL", qty: 2 }] });
    const out = mergeActiveCRBatches([solo]);
    expect(out).toHaveLength(1);
    expect(out[0].items).toHaveLength(1);
    expect(out[0].items[0]).toBe(solo.items[0]);
    expect(pendingUnits(out[0].items)).toBe(2);
  });

  it("PE and Trophy never share a card; different products never share a card", () => {
    const pe = req({ shop: "marathon-pe", createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const tr = req({ shop: "trophy", createdAt: "2026-08-09T08:05:00.000Z", items: [{ orderId: "R003", size: "S" }] });
    const other = req({ pid: "p2", name: "Track Pants", createdAt: "2026-08-09T08:10:00.000Z", items: [{ orderId: "R005", size: "M" }] });
    expect(mergeActiveCRBatches([pe, tr, other])).toHaveLength(3);
  });
});

describe("size order inside a card — run order, never lexical", () => {
  it("letter sizes sort S, M, L, XL, XXL whatever order the requests arrived in", () => {
    const out = mergeActiveCRBatches([
      req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "a", size: "XXL" }, { orderId: "b", size: "M" }] }),
      req({ createdAt: "2026-08-09T09:00:00.000Z", items: [{ orderId: "c", size: "S" }, { orderId: "d", size: "XL" }, { orderId: "e", size: "L" }] }),
    ]);
    expect(out[0].items.map((i) => i.size)).toEqual(["S", "M", "L", "XL", "XXL"]);
  });

  it("footwear sorts numerically — 5, 5.5, 6, 9, 12, 13 — where lexical order would give 12, 13, 5 …", () => {
    const out = mergeActiveCRBatches([
      req({ createdAt: "2026-08-09T08:00:00.000Z", items: [
        { orderId: "a", size: "13" }, { orderId: "b", size: "5.5" }, { orderId: "c", size: "9" },
      ] }),
      req({ createdAt: "2026-08-09T09:00:00.000Z", items: [
        { orderId: "d", size: "12" }, { orderId: "e", size: "6" }, { orderId: "f", size: "5" },
      ] }),
    ]);
    const sizes = out[0].items.map((i) => i.size);
    expect(sizes).toEqual(["5", "5.5", "6", "9", "12", "13"]);
    expect(sizes).not.toEqual([...sizes].sort()); // lexical would be wrong
  });
});

describe("fulfilling one size must not touch another — id + record independence", () => {
  it("each line's movement id is built from ITS OWN request date, byte-identical to the ungrouped queue's", () => {
    const S = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const M = req({ createdAt: "2026-08-09T10:30:00.000Z", items: [{ orderId: "R004", size: "M" }] });
    const [card] = mergeActiveCRBatches([S, M]);
    for (const [reqBatch, item] of [[S, S.items[0]], [M, M.items[0]]]) {
      const ungrouped = crMovementId("cr", item.orderId, reqBatch.createdAt, item.gen);   // what the old per-request card sent
      const grouped = crMovementId("cr", item.orderId, crLineCreatedAt(item, card), item.gen);
      expect(grouped).toBe(ungrouped);
    }
    // And the two lines' ids never collide with each other.
    expect(crMovementId("cr", "R001", crLineCreatedAt(S.items[0], card), 0))
      .not.toBe(crMovementId("cr", "R004", crLineCreatedAt(M.items[0], card), 0));
  });

  it("legacy items without their own createdAt fall back to the batch date (per-request cards: same value)", () => {
    const batch = { createdAt: "2026-08-09T08:00:00.000Z" };
    expect(crLineCreatedAt({ orderId: "R001" }, batch)).toBe("2026-08-09T08:00:00.000Z");
  });

  it("resolved and pending lines coexist on one card, each keeping its own status and stamps", () => {
    const done = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [
      { orderId: "R001", size: "S", status: "available", refilledAt: "2026-08-09T09:00:00.000Z", refilledQty: 1 },
      { orderId: "R002", size: "M" },
    ] });
    const late = req({ createdAt: "2026-08-09T10:00:00.000Z", items: [{ orderId: "R007", size: "L", status: "rejected", outOfStockAt: "2026-08-09T11:00:00.000Z" }] });
    const [card] = mergeActiveCRBatches([done, late]);
    expect(card.items.map((i) => [i.size, i.status])).toEqual([["S", "available"], ["M", null], ["L", "rejected"]]);
    // Only the pending line counts toward the header total.
    expect(pendingUnits(card.items)).toBe(1);
  });

  it("an explicit qty of 0 contributes ZERO units — the 1-fallback is only for absent/invalid qty", () => {
    expect(pendingUnits([
      { orderId: "a", size: "S", status: null, qty: 0 },          // resized to nothing → 0, not a phantom 1
      { orderId: "b", size: "M", status: null },                  // absent → 1
      { orderId: "c", size: "L", status: null, qty: "junk" },     // invalid → 1
      { orderId: "d", size: "XL", status: null, qty: 3 },
    ])).toBe(5);
  });

  it("grouping writes nothing: frozen inputs survive, and input batch objects are untouched", () => {
    const S = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const M = req({ createdAt: "2026-08-09T10:30:00.000Z", items: [{ orderId: "R004", size: "M" }] });
    const snapshot = JSON.stringify([S, M]);
    mergeActiveCRBatches([S, M]);          // would throw on any mutation (frozen)
    expect(JSON.stringify([S, M])).toBe(snapshot);
  });
});

describe("state clarity on mixed cards", () => {
  it("shadow previews are never merged into an actionable card", () => {
    const live = req({ createdAt: "2026-08-09T08:00:00.000Z", items: [{ orderId: "R001", size: "S" }] });
    const shadow = req({ createdAt: "2026-08-09T09:00:00.000Z", shadow: true, items: [{ orderId: "R002", size: "M" }] });
    const out = mergeActiveCRBatches([live, shadow]);
    expect(out).toHaveLength(2);
    expect(out.find((b) => b.shadow)).toBe(shadow);           // passed through untouched
    expect(out.find((b) => !b.shadow).items.map((i) => i.size)).toEqual(["S"]);
  });

  it("the AUTO chip survives only when EVERY merged request is engine-raised", () => {
    const auto1 = req({ createdAt: "2026-08-09T08:00:00.000Z", auto: true, items: [{ orderId: "R001", size: "S" }] });
    const auto2 = req({ createdAt: "2026-08-09T09:00:00.000Z", auto: true, items: [{ orderId: "R002", size: "M" }] });
    const human = req({ createdAt: "2026-08-09T10:00:00.000Z", items: [{ orderId: "R003", size: "L" }] });
    expect(mergeActiveCRBatches([auto1, auto2])[0].autoRefill).toBe(true);
    expect(mergeActiveCRBatches([auto1, human])[0].autoRefill).toBe(false);
  });
});
