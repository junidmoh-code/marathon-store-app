// RETURN-ONLY exchange records (Junid, 26 Nov 2026): store credit or a refund instead of a replacement. Jamie's
// exchange page (marathon-dm-agent src/jimmy/exchangeDesk/desk.js returnRecordFor) writes
// online_orders/exchange-<n>-<ms> with exchange.returnOnly and the returning line flagged returnOnly. Nothing is
// routed, raised, held, estimated or shipped for it; it waits "new" until the item is back in good condition.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll, RETURN_ONLY_COURIER_TEXT } from "./poll.mjs";
import { holdRowsFor } from "./orderModel.mjs";
import { createFastShipper } from "./fastShip.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { deriveOrderStatus, isReturnOnlyOrder, isReturnOnlyLine, returnOnlyReceivedGood } from "../../../src/utils/onlineOrders.js";
import { bookShipment, RETURN_ONLY_REASON } from "../../shipping/bookShipment.mjs";
import { judgeOrder } from "../../online/orderAgent/judge.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-26T10:00:00Z");
const EX = "exchange-2301-1764150000000";

function fakeCourier() {
  const calls = [];
  return {
    calls,
    getRates: async (body) => { calls.push(["getRates", body]); throw new Error("getRates must not be reached"); },
    createShipment: async (body) => { calls.push(["createShipment", body]); throw new Error("createShipment must not be reached"); },
    cancelShipment: async (ref) => { calls.push(["cancelShipment", ref]); throw new Error("cancelShipment must not be reached"); },
  };
}
function shopify() {
  const calls = [];
  const graphql = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes("orders(")) return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  return { graphql, calls };
}
const deps = (f, over = {}) => ({
  db: f.db, graphql: shopify().graphql, nowMs: async () => NOW, send: async () => {}, increment, saDate: () => "2026-11-26",
  log: () => {}, courier: fakeCourier(), courierLog: () => {}, refRand: () => 0.5, ...over,
});

// Exactly what desk.js returnRecordFor writes (reserve.js exchangeOrder around one returnOnly line).
const returnLine = (over = {}) => ({ pid: "SNK", size: "8", sizeKey: "8", qty: 1, title: "Air Runner", category: "Footwear", isFootwear: true, unitPriceCents: 0, returnOnly: true, exchangeFor: "Air Runner", ...over });
const returnRecord = (over = {}, exOver = {}) => ({
  orderNumber: "2301-EX", shopifyName: "#2301-EX", createdAt: NOW - 3600e3, ingestedAt: NOW - 3600e3, updatedAt: NOW - 3600e3,
  customer: { name: "Thandi M" },
  shipping: { address: { name: "Thandi M", address1: "5 Esplanade Road", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa" } },
  totals: { subtotalCents: 0, totalCents: 0, currency: "ZAR" },
  lines: [returnLine()],
  status: "new",
  exchange: {
    kind: "exchange", by: "exchange page", at: NOW - 3600e3, returnOnly: true, note: "Return #2301 … comes back for store credit. Nothing ships.",
    paidCents: 0, ref: "desk-7", paidVia: "exchange page", contactPhone: "27821234567", relatedOrders: ["9001"],
    desk: { id: 7, reason: "change_of_mind", outcome: "credit", ourFault: false }, awaitingPayment: false, shipBeforeReturn: false, returnCollection: "locker", paidAt: NOW - 1800e3,
    ...exOver,
  },
  ...over,
});
const world = (rec = returnRecord(), extra = {}) => ({
  online_orders_meta: { goLiveAtMs: NOW - 86400e3 },
  config: { onlineOrders: { enabled: true }, shipping: { live: true, deliveryMode: "door", collectionContact: { name: "The Marathon", mobile_number: "0310000000" } } },
  products: { SNK: { name: "Air Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["8"] } },
  shopify_sync: { SNK: { variants: { 8: { shopifyVariantId: "gid://shopify/ProductVariant/1108" } } } },
  stock: { hub1: { SNK: { 8: { qty: 3 } } }, hub2: { SNK: { 8: { qty: 3 } } } },
  online_orders: { [EX]: rec },
  ...extra,
});
const rec = (f) => f.read(`online_orders/${EX}`);
const outbound = (f) => f.writes.filter(([, p]) => /^orders\/|^displayChecks_active\/|^online_reservations\//.test(p));

describe("the shared rule (src/utils/onlineOrders.js)", () => {
  it("knows a return-only record by the record flag, or by every line being flagged", () => {
    expect(isReturnOnlyOrder(returnRecord())).toBe(true);
    expect(isReturnOnlyOrder(returnRecord({}, { returnOnly: undefined }))).toBe(true); // lines all flagged
    expect(isReturnOnlyOrder(returnRecord({ lines: [returnLine({ returnOnly: undefined })] }, { returnOnly: undefined }))).toBe(false);
    expect(isReturnOnlyOrder(returnRecord({ lines: [] }))).toBe(true); // the record flag alone
    expect(isReturnOnlyOrder(null)).toBe(false);
    expect(isReturnOnlyLine(returnLine())).toBe(true);
    expect(isReturnOnlyLine({ pid: "SNK" })).toBe(false);
  });

  it("deriveOrderStatus: new while the return is on its way — never needs_attention or picking, even with feeds on and no lines", () => {
    expect(deriveOrderStatus(returnRecord(), { enabled: true })).toBe("new");
    expect(deriveOrderStatus(returnRecord({ status: "needs_attention" }), { enabled: true })).toBe("new");
    expect(deriveOrderStatus(returnRecord({ lines: [] }), { enabled: true })).toBe("new");
    expect(deriveOrderStatus(returnRecord({ status: "cancelled" }))).toBe("cancelled");
  });

  it("closes only once the item is back AND checked good with no hold; a disputed or unchecked return stays open", () => {
    const done = { state: "done", at: NOW };
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: done, check: { result: "good" } } }))).toBe("closed");
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: { returnSaleId: "S1" }, check: { result: "good" } } }))).toBe("closed");
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: done } }))).toBe("new");
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: done, check: { result: "not_original" } } }))).toBe("new");
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: done, check: { result: "good" }, conditionHold: { at: 1 } } }))).toBe("new");
    expect(deriveOrderStatus(returnRecord({ incoming: { arrival: { state: "returning" }, check: { result: "good" } } }))).toBe("new");
    expect(returnOnlyReceivedGood(returnRecord())).toBe(false);
  });

  it("a returning line on a mixed record is not waited for", () => {
    const mixed = { status: "new", lines: [returnLine(), { pid: "TEE", size: "M", sizeKey: "M", qty: 1, source: { locationId: "hub2", status: "handed" } }], exchange: { kind: "exchange" } };
    expect(isReturnOnlyOrder(mixed)).toBe(false);
    expect(deriveOrderStatus(mixed, { enabled: true })).toBe("ready");
  });

  it("holdRowsFor: a return-only record holds nothing; on a mixed record only the outgoing line holds", () => {
    expect(holdRowsFor(returnRecord())).toEqual({});
    const mixed = { status: "new", shopifyName: "#2301-EX", lines: [returnLine(), { pid: "TEE", size: "M", sizeKey: "M", qty: 1, source: { locationId: "hub2", status: "pick" } }] };
    expect(Object.keys(holdRowsFor(mixed))).toEqual(["TEE/M"]);
  });
});

describe("the poller's keep pass", () => {
  it("routes nothing, raises no hub order or strip entry, holds nothing and estimates no parcel (feeds on)", async () => {
    const f = fakeDb(world());
    const out = await runOrdersPoll(deps(f));
    expect(out.errors).toEqual([]);
    expect(out.entries).toBe(0);
    expect(outbound(f)).toEqual([]);
    const r = rec(f);
    expect(r.status).toBe("new");
    expect(r.lines).toEqual([returnLine()]); // untouched: no source, no routeGen
    expect(r.attention).toBeUndefined();
    expect(r.shipping.estimate).toBeUndefined();
    expect(f.read("orders")).toBeFalsy();
    expect(f.read("displayChecks_active")).toBeFalsy();
  });

  it("a returning line someone sent to reroute is still never routed", async () => {
    const f = fakeDb(world(returnRecord({ lines: [returnLine({ source: { status: "reroute" } })] })));
    await runOrdersPoll(deps(f));
    expect(outbound(f)).toEqual([]);
    expect(rec(f).lines[0].source).toEqual({ status: "reroute" });
  });

  it("takes back a stray hold row an older run left for it", async () => {
    const f = fakeDb(world(returnRecord(), { online_reservations: { SNK: { 8: { [EX]: { qty: 1, ref: "#2301-EX", locs: { hub2: 1 } } } } } }));
    await runOrdersPoll(deps(f));
    expect(f.read(`online_reservations/SNK/8/${EX}`)).toBeFalsy();
  });

  it("a record an older tick put in needs_attention goes back to new, its attention cleared", async () => {
    const f = fakeDb(world(returnRecord({ status: "needs_attention", attention: { kind: "unresolved", reason: "x", at: 1 }, attentionOpen: true })));
    await runOrdersPoll(deps(f));
    const r = rec(f);
    expect(r.status).toBe("new");
    expect(r.attention).toBeUndefined();
    expect(r.attentionOpen).toBeUndefined();
  });

  it("closes once the item is back and checked good (it then leaves the open queries)", async () => {
    const f = fakeDb(world(returnRecord({ incoming: { arrival: { state: "done", at: NOW - 60e3 }, check: { result: "good" } } })));
    await runOrdersPoll(deps(f));
    expect(rec(f).status).toBe("closed");
    expect(outbound(f)).toEqual([]);
  });

  it("an ordinary exchange record beside it is still routed and held (the rule is per record)", async () => {
    const other = "exchange-2302-1764150000001";
    const f = fakeDb(world(returnRecord(), {}));
    await f.db.ref(`online_orders/${other}`).set({ ...returnRecord({ orderNumber: "2302-EX", shopifyName: "#2302-EX" }, { returnOnly: undefined, desk: undefined }), lines: [{ pid: "SNK", size: "8", sizeKey: "8", qty: 1, title: "Air Runner", isFootwear: true, unitPriceCents: 0, source: { locationId: "hub2", status: "pick" } }] });
    await runOrdersPoll(deps(f));
    expect(f.read(`online_reservations/SNK/8/${other}`)).toMatchObject({ qty: 1 });
    expect(f.read(`online_reservations/SNK/8/${EX}`)).toBeFalsy();
  });
});

describe("never an outbound shipment", () => {
  it("packed anyway: the tick books no courier, flags it with the reason", async () => {
    const courier = fakeCourier();
    const f = fakeDb(world(returnRecord({ status: "packed", fulfilState: "pending", fulfil: { state: "pending", attempts: 0 } })));
    await runOrdersPoll(deps(f, { courier }));
    expect(courier.calls).toEqual([]);
    expect(rec(f)).toMatchObject({ fulfilState: "courier_failed", courierError: RETURN_ONLY_COURIER_TEXT, attentionOpen: true, attention: { kind: "courier_failed" } });
    expect(rec(f).shipping.courierBooking).toBeUndefined();
  });

  it("fast-ship never takes it up", async () => {
    const shipOne = vi.fn(async () => "shipped");
    const f = fakeDb(world());
    const shipper = createFastShipper({ db: f.db, shipOne, log: () => {} });
    expect(shipper.consider(EX, returnRecord({ status: "packed", fulfilState: "pending" }))).toBeNull();
    expect(shipOne).not.toHaveBeenCalled();
  });

  it("bookShipment refuses it before planning anything", async () => {
    const client = fakeCourier();
    const f = fakeDb(world());
    const res = await bookShipment({ ...returnRecord({ status: "packed" }), key: EX }, { db: f.db, client, log: () => {}, now: () => NOW });
    expect(res).toEqual({ skipped: true, returnOnly: true, reason: RETURN_ONLY_REASON });
    expect(client.calls).toEqual([]);
    expect(f.writes).toEqual([]);
  });
});

describe("the order agent", () => {
  it("waiting for the return: the incoming group, no action of any kind", () => {
    const v = judgeOrder(returnRecord(), { lines: {} }, NOW);
    expect(v).toMatchObject({ group: "incoming", actions: [], lines: [] });
  });
  it("back: green, nothing to chase", () => {
    const v = judgeOrder(returnRecord({ incoming: { arrival: { state: "done" } } }), { lines: {} }, NOW + 30 * 86400e3);
    expect(v).toMatchObject({ group: "green", actions: [], lines: [] });
  });
  it("a returning line on a mixed record is never judged", () => {
    const mixed = { status: "new", lines: [returnLine(), { pid: "TEE", size: "M", sizeKey: "M", qty: 1, source: { locationId: "marathon-pe", status: "handed" } }] };
    const v = judgeOrder(mixed, { lines: {} }, NOW);
    expect(v.total).toBe(1);
    expect(v.lines.every((j) => j.i !== 0)).toBe(true);
  });
});
