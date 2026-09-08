// ─── DISPLAY ROWS — the pure core ────────────────────────────────────────────
// Everything the two tabs, the send and the guard decide. The writers are three
// lines of firebase around these answers, so this is where the behaviour is
// pinned.

import { describe, it, expect } from "vitest";
import {
  rowIsOpen, allRows, openRowsFor, openRowIndex,
  duplicateDisplayGroups, duplicateRowCount,
  unregisteredDisplayCandidates, filterCandidates, brandsOf,
  rowTimeline, sendPlan, closeRowPlan, openRowPlan, closeEffectLine,
  isOpenDisplayRequest, openRequestIndex, hasOpenDisplayRequest, duplicateOpenRequests,
  requestStoreFor, rowPath, CLOSE_REASONS,
} from "./displayRowCore";

const row = (o = {}) => ({
  rowId: "r1", store: "trophy", productId: "p1", productName: "Air Max",
  size: "9", sizeKey: "9", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T08:00:00.000Z", openedBy: "u1", openedVia: "send",
  requestOrderId: null, events: {}, ...o,
});

const ledger = (...rows) => {
  const out = {};
  for (const r of rows) {
    out[r.store] = out[r.store] || {};
    out[r.store][r.productId] = out[r.store][r.productId] || {};
    out[r.store][r.productId][r.rowId] = r;
  }
  return out;
};

describe("rowIsOpen — read positively", () => {
  it("is open only when it says so", () => {
    expect(rowIsOpen(row())).toBe(true);
    expect(rowIsOpen(row({ status: "closed" }))).toBe(false);
    expect(rowIsOpen(null)).toBe(false);
  });

  // A field this module has never seen must not accidentally read as open.
  it("a row with no status is not open", () => {
    expect(rowIsOpen({ sizeKey: "9" })).toBe(false);
  });

  it("a one-size sentinel is never an open display", () => {
    expect(rowIsOpen(row({ sizeKey: "_" }))).toBe(false);
    expect(rowIsOpen(row({ sizeKey: "" }))).toBe(false);
  });
});

describe("the ledger reads back", () => {
  it("flattens with store/productId/rowId always present", () => {
    const r = row();
    delete r.store; delete r.productId; delete r.rowId;
    const l = { trophy: { p1: { rX: r } } };
    expect(allRows(l)).toEqual([{ ...r, store: "trophy", productId: "p1", rowId: "rX" }]);
  });

  it("orders open rows oldest first, stably", () => {
    const l = ledger(
      row({ rowId: "b", openedAt: "2026-09-02T00:00:00.000Z" }),
      row({ rowId: "a", openedAt: "2026-09-01T00:00:00.000Z" }),
      row({ rowId: "c", status: "closed" }),
    );
    expect(openRowsFor(l, "trophy", "p1").map((r) => r.rowId)).toEqual(["a", "b"]);
  });

  it("an unknown store or product is an empty list, not a throw", () => {
    expect(openRowsFor({}, "nowhere", "nothing")).toEqual([]);
    expect(openRowIndex(null).size).toBe(0);
  });
});

describe("CLAUSE 4 — duplicate displays", () => {
  it("a product with two open rows at one store is a group", () => {
    const l = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    const g = duplicateDisplayGroups({ rows: l, productsById: new Map() });
    expect(g).toHaveLength(1);
    expect(g[0].rows.map((r) => r.size)).toEqual(["9", "10"]);
    expect(duplicateRowCount(g)).toBe(1);            // the SURPLUS, not the count
  });

  it("one row at each of two stores is NOT a duplicate", () => {
    const l = ledger(row({ store: "trophy" }), row({ store: "marathon-pe" }));
    expect(duplicateDisplayGroups({ rows: l, productsById: new Map() })).toEqual([]);
  });

  it("a closed row does not make a duplicate", () => {
    const l = ledger(row({ rowId: "a" }), row({ rowId: "b", status: "closed" }));
    expect(duplicateDisplayGroups({ rows: l, productsById: new Map() })).toEqual([]);
  });

  // GATED_SNEAKER_HUBS: Pine's displays are booked at hub3 and are out of scope.
  it("hub3 rows are out of scope", () => {
    const l = ledger(row({ rowId: "a", bookedHub: "hub3" }), row({ rowId: "b", bookedHub: "hub3" }));
    expect(duplicateDisplayGroups({ rows: l, productsById: new Map() })).toEqual([]);
  });

  // A row that cannot name its hub is exactly the kind a human should look at.
  it("a row with NO bookedHub is kept, not hidden", () => {
    const l = ledger(row({ rowId: "a", bookedHub: null }), row({ rowId: "b" }));
    expect(duplicateDisplayGroups({ rows: l, productsById: new Map() })).toHaveLength(1);
  });

  it("three open rows are two too many", () => {
    const l = ledger(row({ rowId: "a" }), row({ rowId: "b" }), row({ rowId: "c" }));
    expect(duplicateRowCount(duplicateDisplayGroups({ rows: l, productsById: new Map() }))).toBe(2);
  });

  it("takes the name and the record from the catalogue when it has one", () => {
    const l = ledger(row({ rowId: "a" }), row({ rowId: "b" }));
    const g = duplicateDisplayGroups({ rows: l, productsById: { p1: { id: "p1", name: "Renamed" } } });
    expect(g[0].productName).toBe("Renamed");
  });
});

describe("CLAUSE 5 — the wall walk", () => {
  const cells = {
    p1: { 9: { qty: 2 }, 10: { qty: 1 } },
    p2: { 8: { qty: 3 } },
    p3: { 7: { qty: 0 } },                          // nothing on hand
  };
  const catalogue = {
    p1: { id: "p1", name: "Air Max", brand: "Nike", productType: "sneaker" },
    p2: { id: "p2", name: "Gazelle", brand: "Adidas", productType: "sneaker" },
    p3: { id: "p3", name: "Sold Out", brand: "Nike", productType: "sneaker" },
  };

  it("offers hub stock with no open row for this store", () => {
    const out = unregisteredDisplayCandidates({ cells, rows: {}, store: "trophy", hub: "hub1", productsById: catalogue });
    expect(out.map((c) => c.productId)).toEqual(["p1", "p2"]);   // p3 has no units
    expect(out[0].hubUnits).toBe(3);
  });

  it("drops a product that already has an open row at THIS store", () => {
    const l = ledger(row({ productId: "p1", store: "trophy" }));
    const out = unregisteredDisplayCandidates({ cells, rows: l, store: "trophy", hub: "hub1", productsById: catalogue });
    expect(out.map((c) => c.productId)).toEqual(["p2"]);
  });

  it("a row at ANOTHER store does not excuse this wall", () => {
    const l = ledger(row({ productId: "p1", store: "marathon-pe" }));
    const out = unregisteredDisplayCandidates({ cells, rows: l, store: "trophy", hub: "hub1", productsById: catalogue });
    expect(out.map((c) => c.productId)).toContain("p1");
  });

  it("a CLOSED row does not excuse the wall either", () => {
    const l = ledger(row({ productId: "p1", store: "trophy", status: "closed" }));
    const out = unregisteredDisplayCandidates({ cells, rows: l, store: "trophy", hub: "hub1", productsById: catalogue });
    expect(out.map((c) => c.productId)).toContain("p1");
  });

  it("a wall holds shoes — the footwear predicate is honoured", () => {
    const out = unregisteredDisplayCandidates({
      cells, rows: {}, store: "trophy", hub: "hub1", productsById: catalogue,
      isFootwear: (p) => p?.id === "p2",
    });
    expect(out.map((c) => c.productId)).toEqual(["p2"]);
  });

  it("searches name, brand and id; filters by brand", () => {
    const list = unregisteredDisplayCandidates({ cells, rows: {}, store: "trophy", hub: "hub1", productsById: catalogue });
    expect(filterCandidates(list, { q: "gaz" }).map((c) => c.productId)).toEqual(["p2"]);
    expect(filterCandidates(list, { q: "p1" }).map((c) => c.productId)).toEqual(["p1"]);
    expect(filterCandidates(list, { brand: "Nike" }).map((c) => c.productId)).toEqual(["p1"]);
    expect(filterCandidates(list, { q: "  " }).length).toBe(list.length);
    expect(brandsOf(list)).toEqual(["Adidas", "Nike"]);
  });
});

describe("CLAUSE 2 — the send is ONE atomic write", () => {
  const base = {
    rows: ledger(row({ rowId: "old", size: "8", sizeKey: "8" })),
    store: "trophy", productId: "p1", productName: "Air Max",
    bookedHub: "hub1", rowId: "new1", at: "2026-09-08T10:00:00.000Z", by: "u9", orderId: "042",
  };

  it("closes the old row, opens the new one and clears the request in ONE update", () => {
    const plan = sendPlan({ ...base, size: "10" });
    expect(plan.ok).toBe(true);
    const oldPath = rowPath("trophy", "p1", "old");
    // the close
    expect(plan.updates[`${oldPath}/status`]).toBe("closed");
    expect(plan.updates[`${oldPath}/closedReason`]).toBe("replaced");
    expect(plan.updates[`${oldPath}/closedAt`]).toBe(base.at);
    // the open, at the PICKED size
    const fresh = plan.updates[rowPath("trophy", "p1", "new1")];
    expect(fresh.status).toBe("open");
    expect(fresh.size).toBe("10");
    expect(fresh.sizeKey).toBe("10");
    expect(fresh.requestOrderId).toBe("042");
    expect(plan.closed).toEqual(["old"]);
  });

  it("carries the caller's request-clearing patch into the SAME update", () => {
    const plan = sendPlan({ ...base, size: "10", orderPatch: { "orders/042/displayRefillStatus": "refilled" } });
    expect(plan.updates["orders/042/displayRefillStatus"]).toBe("refilled");
  });

  // THE ABSOLUTE RULE, at the level that can enforce it.
  it("REFUSES without a size — it never invents one", () => {
    expect(sendPlan({ ...base, size: null }).ok).toBe(false);
    expect(sendPlan({ ...base, size: "" }).ok).toBe(false);
    expect(sendPlan({ ...base, size: "   " }).ok).toBe(false);
    expect(sendPlan({ ...base, size: "Free Size" }).ok).toBe(false);   // folds to the "_" sentinel
  });

  it("refuses without an instant, so nothing is stamped at read time", () => {
    expect(sendPlan({ ...base, size: "10", at: null }).ok).toBe(false);
  });

  it("closes EVERY open row, not just the newest — a duplicated wall is fixed by a send", () => {
    const rows = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "11", sizeKey: "11" }));
    const plan = sendPlan({ ...base, rows, size: "10" });
    expect(plan.closed.sort()).toEqual(["a", "b"]);
  });

  it("a send onto an empty wall closes nothing and opens one", () => {
    const plan = sendPlan({ ...base, rows: {}, size: "10" });
    expect(plan.closed).toEqual([]);
    expect(Object.keys(plan.updates)).toEqual([rowPath("trophy", "p1", "new1")]);
  });

  // Derived, not pushed: a retried tap rewrites the same timeline entry.
  it("replaying the same send produces the same update, byte for byte", () => {
    expect(sendPlan({ ...base, size: "10" }).updates)
      .toEqual(sendPlan({ ...base, size: "10" }).updates);
  });
});

describe("closing a row", () => {
  it("writes fields, never the whole row — a concurrent timeline entry survives", () => {
    const plan = closeRowPlan({ row: row(), at: "2026-09-08T11:00:00.000Z", by: "u2", reason: "sold" });
    expect(plan.ok).toBe(true);
    expect(plan.stockMoved).toBe(false);
    const paths = Object.keys(plan.updates);
    expect(paths.every((p) => p.startsWith(rowPath("trophy", "p1", "r1") + "/"))).toBe(true);
    expect(paths).not.toContain(rowPath("trophy", "p1", "r1"));
  });

  it("refuses a reason it does not know", () => {
    expect(closeRowPlan({ row: row(), at: "x", reason: "because" }).ok).toBe(false);
    for (const r of CLOSE_REASONS) {
      expect(closeRowPlan({ row: row(), at: "2026-09-08T11:00:00.000Z", reason: r }).ok).toBe(true);
    }
  });

  it("says, in one place, that no stock moves", () => {
    expect(closeEffectLine(row())).toMatch(/No stock moves/);
  });
});

describe("opening a row without a request", () => {
  it("a wall walk replaces what the record says", () => {
    const rows = ledger(row({ rowId: "old" }));
    const plan = openRowPlan({ rows, store: "trophy", productId: "p1", size: "10",
                               rowId: "n", at: "2026-09-08T10:00:00.000Z" });
    expect(plan.closed).toEqual(["old"]);
  });

  it("keepOpen adds ALONGSIDE — the duplicate tab must not decide for the operator", () => {
    const rows = ledger(row({ rowId: "old" }));
    const plan = openRowPlan({ rows, store: "trophy", productId: "p1", size: "10",
                               rowId: "n", at: "2026-09-08T10:00:00.000Z", keepOpen: true });
    expect(plan.closed).toEqual([]);
  });

  it("a seed records where it came from and claims no send", () => {
    const plan = openRowPlan({ rows: {}, store: "trophy", productId: "p1", size: "9",
                               rowId: "n", at: "2026-09-08T10:00:00.000Z", via: "seed" });
    const fresh = plan.updates[rowPath("trophy", "p1", "n")];
    expect(Object.values(fresh.events).map((e) => e.what)).toEqual(["seeded"]);
  });
});

describe("CLAUSE 6 — the timeline", () => {
  it("reads oldest first and names the reason a row closed", () => {
    const r = row({
      status: "closed", closedReason: "sold",
      events: {
        b: { at: "2026-09-02T00:00:00.000Z", what: "closed", detail: { reason: "sold" } },
        a: { at: "2026-09-01T00:00:00.000Z", what: "sent", detail: { size: "9", orderId: "007" } },
      },
    });
    const t = rowTimeline(r);
    expect(t.map((l) => l.what)).toEqual(["sent", "closed"]);
    expect(t[0].text).toContain("size 9");
    expect(t[0].text).toContain("#007");
    expect(t[1].text).toContain("Sold at the till");
  });

  it("an event with no instant is dropped rather than sorted to the front", () => {
    expect(rowTimeline(row({ events: { a: { what: "sent" } } }))).toEqual([]);
  });

  it("a row with no events reads as empty, not as a throw", () => {
    expect(rowTimeline(row({ events: undefined }))).toEqual([]);
    expect(rowTimeline(null)).toEqual([]);
  });
});

describe("CLAUSE 1 — one open request per product per store", () => {
  const req = (o = {}) => ({ requestDisplayPartner: true, productId: "p1", destShop: "trophy", ...o });

  it("an unresolved display-partner order is open", () => {
    expect(isOpenDisplayRequest(req())).toBe(true);
  });

  it("resolved, collected, out of stock or cancelled is not open", () => {
    expect(isOpenDisplayRequest(req({ displayRefillStatus: "refilled" }))).toBe(false);
    expect(isOpenDisplayRequest(req({ displayRefillStatus: "stockDepleted" }))).toBe(false);
    expect(isOpenDisplayRequest(req({ status: "collected" }))).toBe(false);
    expect(isOpenDisplayRequest(req({ status: "out_of_stock" }))).toBe(false);
    expect(isOpenDisplayRequest(req({ cancelled: true }))).toBe(false);
  });

  it("an ordinary order is never a display request", () => {
    expect(isOpenDisplayRequest({ productId: "p1", destShop: "trophy" })).toBe(false);
  });

  it("the guard fires on the SAME store the send will write", () => {
    // A cross-store pull belongs to displayPairStore, not the ordering shop —
    // the same rule displaySlotStoreFor applies, or the guard would fence a
    // different wall than the send touches.
    const pull = req({ displayPairRequest: true, displayPairStore: "marathon-pe", destShop: "trophy" });
    expect(requestStoreFor(pull)).toBe("marathon-pe");
    expect(hasOpenDisplayRequest([pull], { store: "marathon-pe", productId: "p1" })).toBe(true);
    expect(hasOpenDisplayRequest([pull], { store: "trophy", productId: "p1" })).toBe(false);
  });

  it("works on an array of orders and on the /orders object map alike", () => {
    expect(hasOpenDisplayRequest([req()], { store: "trophy", productId: "p1" })).toBe(true);
    expect(hasOpenDisplayRequest({ "007": req() }, { store: "trophy", productId: "p1" })).toBe(true);
  });

  it("a different product or a different store is not the same request", () => {
    expect(hasOpenDisplayRequest([req()], { store: "trophy", productId: "p2" })).toBe(false);
    expect(hasOpenDisplayRequest([req()], { store: "marathon-pe", productId: "p1" })).toBe(false);
  });

  it("names the products holding more than one", () => {
    expect(duplicateOpenRequests([req(), req()])).toHaveLength(1);
    expect(duplicateOpenRequests([req(), req({ productId: "p2" })])).toEqual([]);
    expect(openRequestIndex([]).size).toBe(0);
  });

  it("a request with no store or no product is not indexed — it cannot be matched", () => {
    expect(hasOpenDisplayRequest([req({ destShop: null })], { store: "trophy", productId: "p1" })).toBe(false);
    expect(hasOpenDisplayRequest([req({ productId: null })], { store: "trophy", productId: "p1" })).toBe(false);
  });
});
