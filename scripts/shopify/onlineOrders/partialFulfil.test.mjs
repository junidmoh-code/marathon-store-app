// Partial pack → partial fulfilment on Shopify (docs/ONLINE-ORDERS.md § Partial pack).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { partialFulfilmentPlan } from "./shopifyOrders.mjs";
import { packedLineItems, partShipBlockers, settledOffParcel } from "./partialFulfil.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import doorRates from "../../shipping/fixtures/rates-door-capetown.json";
import lockerRates from "../../shipping/fixtures/rates-locker-capetown.json";

// NO TEST HERE REACHES THE NETWORK.
let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-21T10:00:00Z"); // Wed 12:00 SAST
const NEXT_DAY_11 = Date.parse("2026-10-22T09:00:00Z"); // Thu 11:00 SAST
const LI = (n) => `gid://shopify/LineItem/${n}`;

function fakeCourier() {
  return {
    getRates: async (body) => (body.collection_pickup_point_id ? lockerRates : doorRates),
    createShipment: async () => { throw new Error("createShipment must not be reached"); },
    cancelShipment: async () => { throw new Error("cancelShipment must not be reached"); },
  };
}

const tee = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: LI(2), pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee",
  isFootwear: false, unitPriceCents: 25000, category: "Clothing", photoUrl: "https://x/tee.jpg",
  source: { locationId: "marathon-pe", status: "not_found", entryKey: "displayChecks_active/marathon-pe/online__9001__0" },
  ...over,
});
const snk = (over = {}) => ({
  lineId: "l1", shopifyLineItemId: LI(1), pid: "SNK", size: "8", sizeKey: "8", qty: 1, title: "Air Runner",
  isFootwear: true, unitPriceCents: 50000, category: "Footwear",
  source: { locationId: "hub1", status: "handed", entryKey: "online_picks/9001_1" },
  ...over,
});

function world({ lines = [tee(), snk()], order = {}, enabled = true, over = {} } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 3600e3 },
    config: { onlineOrders: { enabled } },
    products: { TEE: { name: "Club Tee", sizes: ["M"] }, SNK: { name: "Air Runner", sizes: ["8"] } },
    stock: { "marathon-pe": { TEE: { M: { qty: 1 } } }, hub2: { TEE: { M: { qty: 1 } } }, hub1: { SNK: { 8: { qty: 1 } } } },
    online_orders: {
      9001: {
        ref: "WEB-1801", orderNumber: 1801, shopifyGid: "gid://shopify/Order/9001", shopifyName: "#1801",
        status: "needs_attention", customer: { name: "Thandi M", email: "buyer@example.com" },
        attention: { kind: "not_found", reason: "Not found at Marathon PE", at: NOW - 60e3 }, attentionOpen: true,
        lines, ...order,
      },
    },
    ...over,
  };
}

function deps(f, at = NOW, over = {}) {
  const mails = [];
  const logs = [];
  return {
    mails, logs,
    deps: {
      db: f.db, graphql: null, nowMs: async () => at,
      send: async (m) => { mails.push(m); },
      increment, saDate: () => "2026-10-21",
      log: (l) => logs.push(l), courier: fakeCourier(), courierLog: () => {},
      ...over,
    },
  };
}
const tick = (f, at = NOW, over = {}) => runOrdersPoll(deps(f, at, over).deps);
const line = (f, i, id = "9001") => f.read(`online_orders/${id}/lines/${i}`);
const writesUnder = (f, from, prefix) => f.writes.slice(from).filter(([, p]) => p.startsWith(prefix));

describe("partial fulfilment", () => {
  it("packedLineItems: whole order → null; partial → only the packed Shopify line items; a follow-up → its own", () => {
    expect(packedLineItems({ lines: [tee(), snk()] })).toBeNull();
    expect(packedLineItems({ lines: [tee(), snk()], packedLines: { 0: true, 1: true } })).toBeNull();
    expect(packedLineItems({ lines: [tee(), snk()], packedLines: { 1: true } })).toEqual({ [LI(1)]: 1 });
    expect(packedLineItems({ followUpOf: "9001", lines: [tee()] })).toEqual({ [LI(2)]: 1 });
    // A Shopify line split over two app lines counts only the packed piece.
    expect(packedLineItems({ lines: [tee(), tee({ lineId: "l1" })], packedLines: { 0: true } })).toEqual({ [LI(2)]: 1 });
  });

  it("partialFulfilmentPlan takes only what is owed, per fulfilment order", () => {
    const fos = [
      { id: "FO1", status: "OPEN", lineItems: { nodes: [{ id: "FOL1", remainingQuantity: 2, lineItem: { id: LI(2) } }, { id: "FOL2", remainingQuantity: 1, lineItem: { id: LI(1) } }] } },
      { id: "FO2", status: "CLOSED", lineItems: { nodes: [{ id: "FOL3", remainingQuantity: 1, lineItem: { id: LI(1) } }] } },
    ];
    expect(partialFulfilmentPlan(fos, { [LI(2)]: 1 })).toEqual([{ fulfillmentOrderId: "FO1", fulfillmentOrderLineItems: [{ id: "FOL1", quantity: 1 }] }]);
    expect(partialFulfilmentPlan(fos, {})).toEqual([]);
  });

  it("the pack's tick fulfils only the shipped line; an ambiguous 5xx that applied is never fulfilled twice", async () => {
    // Shopify, faked with state: TEE (LI 2) qty 2 split across two app lines,
    // one shipped and one off the parcel; the sneaker LI 1 unshipped. Both left-out lines
    // are SETTLED (store credit: Jamie's 24 h rule), the only way a pack may leave a line (Junid, 20 Nov 2026).
    const shop = { [LI(2)]: { qty: 2, fulfilled: 0 }, [LI(1)]: { qty: 1, fulfilled: 0 } };
    const sent = [];
    let failAfterApply = true;
    const graphql = async (query, vars) => {
      if (query.includes("orders(")) return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
      if (query.includes("unfulfilledQuantity")) {
        return { order: {
          id: vars.id, cancelledAt: null,
          lineItems: { nodes: Object.entries(shop).map(([id, s]) => ({ id, currentQuantity: s.qty, unfulfilledQuantity: s.qty - s.fulfilled })) },
          fulfillmentOrders: { nodes: [{ id: "FO1", status: "OPEN", lineItems: { nodes: Object.entries(shop).map(([id, s], k) => ({ id: `FOL${k}`, remainingQuantity: s.qty - s.fulfilled, lineItem: { id } })) } }] },
        } };
      }
      if (query.includes("fulfillmentCreate")) {
        const items = vars.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems;
        sent.push(items);
        for (const it of items) { const lid = Object.keys(shop)[Number(it.id.slice(3))]; shop[lid].fulfilled += it.quantity; }
        if (failAfterApply) { failAfterApply = false; throw new Error("GraphQL HTTP 502 on a MUTATION — not retrying"); }
        return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1" }, userErrors: [] } };
      }
      throw new Error(`unexpected ${query.slice(0, 50)}`);
    };
    const lines = [
      tee({ source: { status: "handed", locationId: "marathon-pe" } }),
      tee({ lineId: "l0b", source: { status: "resolved" }, resolution: { outcome: { kind: "store_credit", amountCents: 25000, at: NOW - 60e3, via: "ship_without" } } }),
      snk({ source: { status: "resolved" }, resolution: { outcome: { kind: "store_credit", amountCents: 90000, at: NOW - 60e3, via: "ship_without" } } }),
    ];
    const f = fakeDb(world({ lines, order: { status: "packed", packedLines: { 0: true }, fulfilState: "pending", fulfil: { state: "pending", attempts: 0 }, attention: null, attentionOpen: null, pack: { saleId: "S1" } } }));
    await runOrdersPoll(deps(f, NOW, { graphql }).deps);
    expect(f.read("online_orders/9001/fulfil/baseline")).toEqual({ 2: 0, 1: 0 });
    expect(f.read("online_orders/9001/fulfilState")).toBe("failed");
    expect(sent).toEqual([[{ id: "FOL0", quantity: 1 }]]);
    // Retry (Settings sets it back to pending): owes nothing now.
    await f.db.ref("online_orders/9001").update({ fulfilState: "pending", "fulfil/state": "pending" });
    await runOrdersPoll(deps(f, NOW + 60e3, { graphql }).deps);
    expect(sent).toHaveLength(1);
    expect(shop[LI(2)].fulfilled).toBe(1);
    expect(shop[LI(1)].fulfilled).toBe(0);
    expect(f.read("online_orders/9001/fulfilState")).toBe("done");
  });
});

describe("no part-shipping: one order ships as one parcel (Junid, 20 Nov 2026)", () => {
  const packed = (lines, packedLines, extra = {}) => ({ status: "packed", lines, packedLines, ...extra });
  it("a left-out line counts as settled only on a recorded decision", () => {
    expect(settledOffParcel(tee({ source: { status: "resolved" }, resolution: { outcome: { kind: "store_credit" } } }))).toBe(true);
    expect(settledOffParcel(tee({ source: { status: "resolved" }, resolution: { outcome: { kind: "refund", amountCents: 25000 } } }))).toBe(true);
    expect(settledOffParcel(tee({ source: { status: "resolved" }, resolution: { outcome: { kind: "refund_requested" } } }))).toBe(true);
    expect(settledOffParcel(tee({ source: { status: "resolved" }, resolution: { money: { kind: "credit", amountCents: 25000, state: "done" } } }))).toBe(true);
    expect(settledOffParcel(tee({ source: { status: "cancelled" } }))).toBe(true);
    for (const status of ["resolving", "unavailable", "no_stock", "not_found", "needs_attention", "moved", "pick", "handed", "resolved"]) expect(settledOffParcel(tee({ source: { status } }))).toBe(false);
    // a swap is not a reason to leave the line behind: the replacement ships with the rest
    expect(settledOffParcel(tee({ source: { status: "resolved" }, resolution: { outcome: { kind: "swap" } } }))).toBe(false);
  });

  it("the whole order, a settled leave-out, a second parcel, a follow-up and an exchange are never blocked", () => {
    expect(partShipBlockers("9001", packed([tee(), snk()], { 0: true, 1: true }))).toEqual([]);
    expect(partShipBlockers("9001", { status: "packed", lines: [tee(), snk()] })).toEqual([]); // packed before partial packs existed
    expect(partShipBlockers("9001", packed([tee(), snk({ source: { status: "resolved" }, resolution: { outcome: { kind: "store_credit" } } })], { 0: true }))).toEqual([]);
    expect(partShipBlockers("9001r1", packed([tee(), snk()], { 0: true }, { reship: { of: "9001" } }))).toEqual([]);
    expect(partShipBlockers("9001f1", packed([snk()], { 0: true }, { followUpOf: "9001" }))).toEqual([]);
    expect(partShipBlockers("exchange-1801-5", packed([tee(), snk()], { 0: true }))).toEqual([]);
  });

  it("#2204: the trainer packed, the T-shirt left behind unsettled: NO courier is booked, nothing is fulfilled, the reason is on the order; Retry ships once it is settled", async () => {
    const sent = [];
    const graphql = async (query, vars) => {
      if (query.includes("orders(")) return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
      if (query.includes("fulfillmentCreate")) { sent.push(vars); return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1" }, userErrors: [] } }; }
      return { order: { id: vars.id, cancelledAt: null, lineItems: { nodes: [{ id: LI(2), currentQuantity: 1, unfulfilledQuantity: 1 }, { id: LI(1), currentQuantity: 1, unfulfilledQuantity: 1 }] }, fulfillmentOrders: { nodes: [{ id: "FO1", status: "OPEN", lineItems: { nodes: [{ id: "FOL0", remainingQuantity: 1, lineItem: { id: LI(2) } }, { id: "FOL1", remainingQuantity: 1, lineItem: { id: LI(1) } }] } }] } } };
    };
    const lines = [tee({ source: { status: "unavailable" } }), snk({ source: { status: "handed", locationId: "hub1" } })];
    const f = fakeDb(world({ lines, order: { status: "packed", packedLines: { 1: true }, leftOut: { 0: { at: NOW, by: "u1" } }, fulfilState: "pending", fulfil: { state: "pending", attempts: 0 }, attention: null, attentionOpen: null, pack: { saleId: "S1" } } }));
    const courier = fakeCourier();
    await runOrdersPoll(deps(f, NOW, { graphql, courier }).deps);
    expect(f.read("online_orders/9001/fulfilState")).toBe("courier_failed");
    expect(f.read("online_orders/9001/courierError")).toMatch(/part-shipping is blocked: Club Tee M \(unavailable\) is not in the parcel/);
    expect(f.read("online_orders/9001/attention/reason")).toMatch(/^Packed, but not shipped: part-shipping is blocked/);
    expect(f.read("online_orders/9001/shipping/waybill") ?? null).toBeNull();
    expect(sent).toEqual([]);
    // Jamie's 24 h rule settles the T-shirt (store credit); Retry on the packing screen then ships the parcel.
    await f.db.ref("online_orders/9001/lines/0").update({ source: { status: "resolved" }, resolution: { outcome: { kind: "store_credit", amountCents: 25000, at: NOW + 30e3, via: "ship_without" } } });
    await f.db.ref("online_orders/9001").update({ fulfilState: "pending", "fulfil/state": "pending" });
    await runOrdersPoll(deps(f, NOW + 60e3, { graphql, courier }).deps);
    expect(f.read("online_orders/9001/fulfilState")).toBe("done");
    expect(sent).toHaveLength(1);
  });
});

describe("owed but not coverable", () => {
  it("a packed line whose fulfilment order is ON_HOLD is a failure, never 'done'", async () => {
    const { fulfilLinesOnShopify } = await import("./shopifyOrders.mjs");
    const LI2 = "gid://shopify/LineItem/2";
    const graphql = async () => ({ order: { id: "o", lineItems: { nodes: [{ id: LI2, currentQuantity: 1, unfulfilledQuantity: 1 }] }, fulfillmentOrders: { nodes: [{ id: "FO1", status: "ON_HOLD", lineItems: { nodes: [{ id: "FOL1", remainingQuantity: 1, lineItem: { id: LI2 } }] } }] } } });
    const out = await fulfilLinesOnShopify(graphql, { orderGid: "o", packed: { [LI2]: 1 }, baseline: { [LI2]: 0 } });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no open fulfilment for 1 unit/);
  });
});

describe("a swapped item ships without Shopify's own email", () => {
  it("notifyCustomer is false for a follow-up carrying a swapped line", async () => {
    const { fulfilParcel } = await import("./partialFulfil.mjs");
    const LI2 = "gid://shopify/LineItem/2";
    const sent = [];
    const graphql = async (q, v) => {
      if (q.includes("fulfillmentCreate")) { sent.push(v.fulfillment); return { fulfillmentCreate: { fulfillment: { id: "f" }, userErrors: [] } }; }
      return { order: { id: "o", lineItems: { nodes: [{ id: LI2, currentQuantity: 1, unfulfilledQuantity: 1 }] }, fulfillmentOrders: { nodes: [{ id: "FO1", status: "OPEN", lineItems: { nodes: [{ id: "FOL1", remainingQuantity: 1, lineItem: { id: LI2 } }] } }] } } };
    };
    const db = { ref: () => ({ set: async () => {} }) };
    const out = await fulfilParcel({ graphql, db }, "9001f0", { followUpOf: "9001", shopifyGid: "o", lines: [{ shopifyLineItemId: LI2, qty: 1, swappedFrom: { title: "x" } }] });
    expect(out.ok).toBe(true);
    expect(sent[0].notifyCustomer).toBe(false);
  });
});
