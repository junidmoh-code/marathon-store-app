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
  isOpenDisplayRequest, openRequestIndex, hasOpenDisplayRequest, otherOpenDisplayRequests, duplicateOpenRequests,
  requestStoreFor, rowPath, CLOSE_REASONS, registeredDisplays, rowSegment, storeRowsPath,
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

  // THE REQUESTED INSTANT IS THE ORDER'S, asserted on the PLAN, where the value
  // actually lands. A source-regex test on App.jsx passed green while
  // displayRowStore dropped the argument one file downstream — a pin that reads
  // the caller and not the callee proves nothing about the value.
  // (Independent second-brain review.)
  it("stamps the REQUEST at the order's instant, not the send's", () => {
    const plan = sendPlan({ ...base, size: "10", requestedAt: "2026-09-07T06:00:00.000Z" });
    const fresh = plan.updates[rowPath("trophy", "p1", "new1")];
    expect(Object.values(fresh.events).find((e) => e.what === "requested").at).toBe("2026-09-07T06:00:00.000Z");
    expect(Object.values(fresh.events).find((e) => e.what === "sent").at).toBe(base.at);
  });

  it("falls back to the send instant only when there is genuinely no earlier one", () => {
    const plan = sendPlan({ ...base, size: "10", requestedAt: null });
    const fresh = plan.updates[rowPath("trophy", "p1", "new1")];
    expect(Object.values(fresh.events).find((e) => e.what === "requested").at).toBe(base.at);
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


// ── THE OTHER HALF OF THE WALL WALK ─────────────────────────────────────────
// A display taken off a wall and sent back to the hub is ONE open row: too few
// for the Duplicate tab, and excluded from the wall-walk list precisely because
// it HAS a record. It appeared on no screen at all and its row stayed open
// forever while offShelf kept subtracting the unit. This is the surface that
// reaches it. (Adversarial review of the fix round.)
describe("registeredDisplays — reaching a wall that has exactly one record", () => {
  const catalogue = { p1: { id: "p1", name: "Air Max", brand: "Nike" } };

  it("is SEARCH-ONLY — unfiltered it would be every display in the shop", () => {
    const l = ledger(row());
    expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "" })).toEqual([]);
    expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "   " })).toEqual([]);
  });

  it("finds a single open row at this store, which no other screen shows", () => {
    const l = ledger(row());
    const out = registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "air" });
    expect(out).toHaveLength(1);
    expect(out[0].rows.map((r) => r.rowId)).toEqual(["r1"]);
    // and the Duplicate tab genuinely cannot: one row is not a duplicate.
    expect(duplicateDisplayGroups({ rows: l, productsById: catalogue })).toEqual([]);
    // nor does the wall-walk list, which only holds products with NO record.
    expect(unregisteredDisplayCandidates({
      cells: { p1: { 9: { qty: 1 } } }, rows: l, store: "trophy", hub: "hub1", productsById: catalogue,
    })).toEqual([]);
  });

  it("is scoped to the store being walked", () => {
    const l = ledger(row({ store: "marathon-pe" }));
    expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "air" })).toEqual([]);
    expect(registeredDisplays({ rows: l, store: "marathon-pe", productsById: catalogue, q: "air" })).toHaveLength(1);
  });

  it("ignores closed rows, matches on name / id / brand, and honours the brand filter", () => {
    expect(registeredDisplays({ rows: ledger(row({ status: "closed" })), store: "trophy", productsById: catalogue, q: "air" })).toEqual([]);
    const l = ledger(row());
    for (const q of ["air", "p1", "nike"]) {
      expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q }), q).toHaveLength(1);
    }
    expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "air", brand: "Adidas" })).toEqual([]);
  });

  it("reports every open row when a wall holds more than one", () => {
    const l = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    expect(registeredDisplays({ rows: l, store: "trophy", productsById: catalogue, q: "air" })[0].rows).toHaveLength(2);
  });
});


// ── A PATH SEGMENT IS REFUSED, NEVER MANGLED ────────────────────────────────
// It used to replace each illegal character with "_", which is lossy and
// therefore collides: `p.1` and `p_1` both became `p_1`, so a send for one
// product could close or overwrite the other's rows. Nothing in play is unsafe
// (store ids are a fixed set, product ids are `p{epoch}`), so refusing costs
// nothing real and a collision costs a wall's history. (CodeRabbit.)
describe("path segments refuse rather than collide", () => {
  it("a safe id passes through unchanged", () => {
    for (const id of ["marathon-pe", "trophy", "p1786451460573", "r20260908100000000", "hub1"]) {
      expect(rowSegment(id), id).toBe(id);
    }
  });

  it("every RTDB-illegal character is a refusal, not a substitution", () => {
    for (const bad of ["p.1", "p#1", "p$1", "p/1", "p[1", "p]1", "p 1", "p\t1", ""]) {
      expect(rowSegment(bad), JSON.stringify(bad)).toBeNull();
    }
    // THE COLLISION ITSELF: these two must not resolve to the same thing.
    expect(rowSegment("p.1")).toBeNull();
    expect(rowSegment("p_1")).toBe("p_1");
  });

  it("rowPath and storeRowsPath propagate the refusal", () => {
    expect(rowPath("trophy", "p1", "r1")).toBe("settings/displayRows/trophy/p1/r1");
    expect(rowPath("trophy", "p.1", "r1")).toBeNull();
    expect(rowPath("tro phy", "p1", "r1")).toBeNull();
    expect(rowPath("trophy", "p1", "r 1")).toBeNull();
    expect(storeRowsPath("trophy")).toBe("settings/displayRows/trophy");
    expect(storeRowsPath("mar athon")).toBeNull();
  });

  it("no plan is ever built onto a refused path", () => {
    const at = "2026-09-08T10:00:00.000Z";
    const bad = sendPlan({ rows: {}, store: "trophy", productId: "p.1", size: "9", rowId: "r1", at });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/cannot be stored as a path/);
    expect(openRowPlan({ rows: {}, store: "tro phy", productId: "p1", size: "9", rowId: "r1", at }).ok).toBe(false);
    expect(closeRowPlan({ row: { ...row(), productId: "p.1" }, at, reason: "sold" }).ok).toBe(false);
  });

  // A NULL PATH MUST NEVER REACH A STRING. `${null}` is the literal "null", so
  // an unguarded interpolation reads or writes `settings/displayRows/null/null`
  // — a node belonging to nobody, which is worse than the collision the refusal
  // replaced. Every builder returns null and every caller checks.
  it("the builders return null rather than a path containing 'null'", () => {
    for (const p of [rowPath("tro phy", "p1", "r1"), rowPath("trophy", "p.1", "r1"), storeRowsPath("p.1")]) {
      expect(p).toBeNull();
      expect(String(p)).not.toMatch(/displayRows/);
    }
  });

  it("and an unusable id simply has no rows, rather than reading somebody else's", () => {
    const l = ledger(row({ productId: "p_1" }));
    expect(openRowsFor(l, "trophy", "p_1")).toHaveLength(1);
    expect(openRowsFor(l, "trophy", "p.1")).toEqual([]);
  });
});

// ─── THE AUTO-RAISED TASK IS AN OPEN REQUEST ────────────────────────────────
//
// Marking a Display Partner order READY stamps displayRefillScheduledAt, and
// DISPLAY_REFILL_DELAY_MS surfaces it as a refill task fifteen minutes later
// with no human raising it. The guard did not count those, because it tested
// the CUSTOMER's order status — and a shopper who has collected leaves a wall
// that is still owed the pair the warehouse has not sent.
//
// Measured live 2026-09-08: order #188 (Trophy, p1778857649789), status
// "collected", displayRefillStatus null, task scheduled 317 minutes earlier.
// The predicate answered "not open", so a second request for that wall passed
// both entry points.
describe("a pending auto-raised refill task keeps the wall fenced", () => {
  const task = (o = {}) => ({
    id: "188", requestDisplayPartner: true, productId: "p1778857649789",
    destShop: "trophy", displayRefillScheduledAt: "2026-09-08T12:00:00.000Z",
    displayRefillStatus: null, status: "ready", ...o,
  });

  it("THE LIVE CASE: collected, but the refill task is still pending", () => {
    expect(isOpenDisplayRequest(task({ status: "collected" }))).toBe(true);
  });

  it("and the guard therefore refuses a second request for that wall", () => {
    const orders = [task({ status: "collected" })];
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p1778857649789" })).toBe(true);
    // a different wall, and a different product, are untouched
    expect(hasOpenDisplayRequest(orders, { store: "marathon-pe", productId: "p1778857649789" })).toBe(false);
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p2" })).toBe(false);
  });

  it("still open while the task waits at ready", () => {
    expect(isOpenDisplayRequest(task())).toBe(true);
  });

  it("RESOLVED closes it, on either outcome, whatever the status", () => {
    for (const st of ["refilled", "stockDepleted"]) {
      expect(isOpenDisplayRequest(task({ displayRefillStatus: st })), st).toBe(false);
      expect(isOpenDisplayRequest(task({ displayRefillStatus: st, status: "collected" })), st).toBe(false);
    }
  });

  it("a CANCELLED order is closed even with a task pending — nothing is owed", () => {
    expect(isOpenDisplayRequest(task({ cancelled: true }))).toBe(false);
  });

  it("no task scheduled falls back to the order's own status, as before", () => {
    const noTask = { requestDisplayPartner: true, productId: "p1", destShop: "trophy",
                     displayRefillScheduledAt: null, displayRefillStatus: null };
    expect(isOpenDisplayRequest({ ...noTask, status: "incoming" })).toBe(true);
    expect(isOpenDisplayRequest({ ...noTask, status: "collected" })).toBe(false);
    expect(isOpenDisplayRequest({ ...noTask, status: "out_of_stock" })).toBe(false);
  });

  it("a cancelled refill re-opens the wall — displayRefillScheduledAt cleared", () => {
    // The status patch nulls scheduledAt when a READY order leaves the lane for
    // anything but COLLECTED, so the wall stops being fenced.
    expect(isOpenDisplayRequest(task({ displayRefillScheduledAt: null, status: "out_of_stock" }))).toBe(false);
  });
});

// ─── THE GUARD ON THE PATHS THAT RE-OPEN A REQUEST ──────────────────────────
//
// The one-open-request guard sat on the two places a request is CREATED, and
// not on the two that RE-OPEN one — the READY re-stamp and the refill undo.
// Both are second-openers, and both had reachable routes to two pairs on one
// wall:
//
//   OOS -> Available: order A goes out of stock, scheduledAt is cleared and A
//     reads closed; order B is raised for the same wall and correctly passes;
//     A's "Available" button runs updateStatus(READY) and re-stamps A. Two due
//     tasks.
//   Undo after a newer request: A reads "refilled" so B passes the guard; the
//     operator then undoes A, which nulls displayRefillStatus and leaves
//     scheduledAt. Two.
//
// Both need `exceptId`: the order in hand is the one about to be opened, and
// without the exclusion it would block itself. (Spec-conformance review.)
describe("a re-opener asks whether any OTHER request is open", () => {
  const req = (id, o = {}) => ({
    id, requestDisplayPartner: true, productId: "p1", destShop: "trophy",
    displayRefillScheduledAt: "2026-09-08T12:00:00.000Z", displayRefillStatus: null,
    status: "ready", ...o,
  });

  it("an order does not block itself", () => {
    const orders = [req("100")];
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p1", exceptId: "100" })).toBe(false);
    // ...but it does block a DIFFERENT order re-opening onto the same wall
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p1", exceptId: "101" })).toBe(true);
  });

  it("without exceptId the behaviour is exactly what it was", () => {
    const orders = [req("100")];
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p1" })).toBe(true);
    expect(hasOpenDisplayRequest([], { store: "trophy", productId: "p1" })).toBe(false);
  });

  it("the id comparison survives a numeric id meeting a string one", () => {
    // /orders ids are daily counters and reach this as both shapes.
    expect(hasOpenDisplayRequest([req(100)], { store: "trophy", productId: "p1", exceptId: "100" })).toBe(false);
    expect(hasOpenDisplayRequest([req("100")], { store: "trophy", productId: "p1", exceptId: 100 })).toBe(false);
  });

  it("otherOpenDisplayRequests NAMES the blocker, so a refusal is actionable", () => {
    const orders = [req("100"), req("101"), req("102", { destShop: "marathon-pe" })];
    const blockers = otherOpenDisplayRequests(orders, { store: "trophy", productId: "p1", exceptId: "100" });
    expect(blockers.map((o) => o.id)).toEqual(["101"]);
    expect(otherOpenDisplayRequests(orders, { store: "trophy", productId: "p1", exceptId: "999" }).length).toBe(2);
    expect(otherOpenDisplayRequests(orders, { store: null, productId: "p1" })).toEqual([]);
  });

  it("a RESOLVED other order is not a blocker — the wall is free again", () => {
    const orders = [req("101", { displayRefillStatus: "refilled" })];
    expect(hasOpenDisplayRequest(orders, { store: "trophy", productId: "p1", exceptId: "100" })).toBe(false);
  });
});

// ─── WITHHOLDING MUST NOT MINT A FENCE WITH NO TASK BEHIND IT ───────────────
//
// The first cut of the READY guard nulled scheduledAt but still ran the four
// resets, so an order that had ALREADY been resolved and was then marked READY
// while blocked had its resolution wiped — leaving scheduledAt null,
// displayRefillStatus null and status "ready", which this predicate reads as
// OPEN. A fence invisible in the warehouse list, holding a wall until the daily
// /orders id recycled, long after the real blocker resolved.
//
// This walks CodeRabbit's exact five-step sequence over the predicate.
describe("a blocked READY leaves a resolved order resolved", () => {
  const at = "2026-09-08T12:00:00.000Z";
  const A = { id: "100", requestDisplayPartner: true, productId: "p1", destShop: "trophy" };
  const B = { id: "101", requestDisplayPartner: true, productId: "p1", destShop: "trophy",
              displayRefillScheduledAt: at, displayRefillStatus: null, status: "ready" };

  it("A refilled, B open, A marked READY while blocked, B resolved -> A fences nothing", () => {
    // 1. A is resolved.
    const aResolved = { ...A, displayRefillScheduledAt: at, displayRefillStatus: "refilled", status: "collected" };
    expect(isOpenDisplayRequest(aResolved)).toBe(false);
    // 2. B is open for the same wall, so it is the blocker.
    expect(otherOpenDisplayRequests([aResolved, B], { store: "trophy", productId: "p1", exceptId: "100" })
      .map((o) => o.id)).toEqual(["101"]);
    // 3. A is marked READY while blocked. The guard withholds, which now means
    //    it touches NO display-refill field — only `status` changes.
    const aAfterBlockedReady = { ...aResolved, status: "ready" };
    expect(isOpenDisplayRequest(aAfterBlockedReady)).toBe(false);   // still resolved
    // 4. B resolves.
    const bDone = { ...B, displayRefillStatus: "refilled" };
    // 5. The wall is free — A must not still be fencing it.
    expect(hasOpenDisplayRequest([aAfterBlockedReady, bDone], { store: "trophy", productId: "p1" })).toBe(false);
  });

  it("the shape the bug produced IS open — so the test above is not vacuous", () => {
    // Exactly what the first cut wrote: resolution wiped, no task, status ready.
    const phantom = { ...A, displayRefillScheduledAt: null, displayRefillStatus: null, status: "ready" };
    expect(isOpenDisplayRequest(phantom)).toBe(true);
  });

  it("an UNRESOLVED order blocked at READY still fences, and that is correct", () => {
    // It is a genuine outstanding request for that wall; it simply has no task
    // scheduled yet. Re-marking it READY once the blocker clears schedules one.
    const aFresh = { ...A, displayRefillScheduledAt: null, displayRefillStatus: null, status: "ready" };
    expect(isOpenDisplayRequest(aFresh)).toBe(true);
  });
});
