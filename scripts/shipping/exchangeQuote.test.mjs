// quoteExchange — the exchange desk's live two-way quote (Junid, 25 Nov 2026). Fakes only, never the network.
import { describe, it, expect } from "vitest";
import { quoteExchange, quoteRecord, parseItems } from "./exchangeQuote.mjs";
import { bookReturn } from "./bookReturn.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";

const ORDER_KEY = "18985060335765";
const ORIGINAL = (over = {}) => ({
  orderNumber: 1952, shopifyName: "#1952", status: "packed",
  customer: { name: "Pumeza Vitshima", email: "p@example.com", phone: "0732296677" },
  lines: [{ pid: "p1", size: "6", sizeKey: "6", qty: 1, title: "DIESEL BLUE", category: "Footwear", isFootwear: true, unitPriceCents: 119900 }],
  shipping: { address: { address1: "519 ilitha township Qonce", city: "Qonce", province: "Eastern Cape", zip: "5600", name: "Pumeza Vitshima", phone: "0732296677" } },
  ...over,
});
const SHOP_CONTACT = { name: "Shop", mobile_number: "0310000000", email: "shop@example.com" };
const RETURN_CONTACT = { name: "Yusuf", mobile_number: "+27600000001", email: "" };
const db = ({ original = ORIGINAL(), cfg = {} } = {}) => fakeDb({
  config: { shipping: { live: false, collectionContact: SHOP_CONTACT, returnContact: RETURN_CONTACT, deliveryMode: "door", dropBox: { enabled: false }, ...cfg } },
  online_orders: { [ORDER_KEY]: original },
  products: {
    p1: { name: "DIESEL BLUE", category: "Footwear", isFootwear: true },
    p2: { name: "T shirt white", category: "Clothing", isFootwear: false },
  },
});
const POINTS = { pickup_points: [{ pickup_point_id: "RVM01017", pickup_point_provider: "tcg-locker", name: "Engen Amatola", type: "locker", lat: -32.8874, lng: 27.3919, status: "online", available_compartment_sizes: ["V4-L", "V4-M"], address: { street_address: "128 Buffalo Rd, Qonce, 5601", city: "Qonce" } }] };
const r = (rate, code) => ({ rate, service_level: { code } });
function fakeClient() {
  const calls = [];
  return {
    calls,
    getPickupPoints: async (q) => { calls.push(["getPickupPoints", q]); return POINTS; },
    // a locker return → L2D; to the shop's door (return from their door) → ECO 140.37; to the customer (outbound) → ECO 95.5
    getRates: async (body) => {
      calls.push(["getRates", body]);
      if (body.collection_pickup_point_id) return { rates: [r(120.1, "L2DM - ECO")] };
      if (String(body.delivery_address?.code) === "5600") return { rates: [r(95.5, "ECO")] };
      return { rates: [r(140.37, "ECO"), r(60, "L2DM - ECO")] };
    },
    createShipment: async (body) => { calls.push(["createShipment", body]); throw new Error("a quote must never create"); },
  };
}
const geocoder = async () => ({ lat: -32.8802, lng: 27.3937 });
const deps = (d, client) => ({ db: d, client, geocoder });
const ONE = [{ pid: "p1", size: "6" }];

describe("quoteExchange", () => {
  it("locker: the nearest-locker return + the outbound, ceil'd into cents, nothing created or written", async () => {
    const d = db();
    const client = fakeClient();
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: JSON.stringify(ONE), replacement: [{ pid: "p1", size: "7" }], mode: "locker" }, deps(d, client));
    expect(out).toEqual({
      ok: true,
      returnLeg: { rand: 120.1, service: "L2DM - ECO", mode: "locker_dropoff", locker: { name: "Engen Amatola", address: "128 Buffalo Rd, Qonce, 5601", km: expect.any(Number) } },
      outboundLeg: { rand: 95.5, service: "ECO" },
      totalCents: 21560,
      blockers: [],
    });
    expect(client.calls.filter((c) => c[0] === "createShipment")).toHaveLength(0);
    expect(d.writes).toHaveLength(0);
  });

  it("door: no locker is looked for, a door rate from their address; no outbound → outboundLeg null", async () => {
    const client = fakeClient();
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: [], mode: "door" }, deps(db(), client));
    expect(out).toMatchObject({ ok: true, returnLeg: { rand: 140.37, service: "ECO", mode: "door_collection", locker: null }, outboundLeg: null, totalCents: 14037 });
    expect(client.calls.filter((c) => c[0] === "getPickupPoints")).toHaveLength(0);
  });

  it("the ceiling is reported, never a refusal", async () => {
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: ONE, mode: "door" }, deps(db({ cfg: { maxChargeRand: 100 } }), fakeClient()));
    expect(out.ok).toBe(true);
    expect(out.blockers).toEqual(["return leg: quote R140.37 is over the R100 ceiling"]);
  });

  it("refuses a missing address, a missing order, nothing coming back, a bad mode", async () => {
    const noAddr = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, mode: "locker" }, deps(db({ original: ORIGINAL({ shipping: {} }) }), fakeClient()));
    expect(noAddr).toMatchObject({ ok: false });
    expect(noAddr.reason).toMatch(/^return leg: missing: customer street_address/);
    expect(await quoteExchange({ orderKey: "123", returning: ONE }, deps(db(), fakeClient()))).toEqual({ ok: false, reason: "no order at /online_orders/123" });
    expect(await quoteExchange({ orderKey: ORDER_KEY, returning: [] }, deps(db(), fakeClient()))).toMatchObject({ ok: false, reason: /nothing is coming back/ });
    expect(await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, mode: "post" }, deps(db(), fakeClient()))).toMatchObject({ ok: false, reason: /mode must be/ });
    expect(await quoteExchange({ orderKey: ORDER_KEY, returning: [{ pid: "nope" }] }, deps(db(), fakeClient()))).toEqual({ ok: false, reason: "no product nope" });
  });
});

describe("quoteRecord / parseItems", () => {
  it("builds reserve.js's exchange shape: one qty-1 line per unit, the original's address, the contact phone", () => {
    const rec = quoteRecord({ original: ORIGINAL(), orderKey: ORDER_KEY, items: [{ pid: "p2", size: "XL", qty: 2 }], products: { p2: { name: "T shirt white", category: "Clothing" } }, phone: "+27732296677" });
    expect(rec).toMatchObject({ key: "exchange-1952-0", orderNumber: "1952-EX", shopifyName: "#1952-EX", exchange: { contactPhone: "+27732296677", relatedOrders: [ORDER_KEY] }, shipping: { address: { zip: "5600" } } });
    expect(rec.lines).toHaveLength(2);
    expect(rec.lines[0]).toMatchObject({ pid: "p2", size: "XL", sizeKey: "XL", qty: 1, isFootwear: false });
  });
  it("refuses an item with no pid or an unsafe one", () => {
    expect(() => parseItems('[{"size":"7"}]', "returning")).toThrow(/no pid/);
    expect(() => parseItems([{ pid: "a/b" }], "returning")).toThrow();
    expect(() => parseItems("{", "returning")).toThrow(/not JSON/);
  });
});

describe("bookReturn collection: door (the customer's choice)", () => {
  const KEY = "exchange-1952-1794647899318";
  const EX = { ...quoteRecord({ original: ORIGINAL(), orderKey: ORDER_KEY, items: ONE, products: { p1: { name: "DIESEL BLUE", category: "Footwear", isFootwear: true } }, phone: "27732296677" }), key: undefined };
  EX.exchange = { ...EX.exchange, paidAt: 1794647899318 };
  delete EX.key;
  const live = (over = {}) => fakeDb({ config: { shipping: { live: true, collectionContact: SHOP_CONTACT, returnContact: RETURN_CONTACT, ...over } }, online_orders: { [KEY]: EX }, products: { p1: { name: "DIESEL BLUE", category: "Footwear" } } });
  const shipClient = () => {
    const c = fakeClient();
    c.createShipment = async (body) => { c.calls.push(["createShipment", body]); return { id: 77, short_tracking_reference: "DOOR77", custom_tracking_reference: "DOOR77", service_level_code: "ECO", rate: 140.37 }; };
    return c;
  };

  it("books a door collection without looking for a locker, even with the no-locker door fallback off", async () => {
    const d = live();
    const client = shipClient();
    const out = await bookReturn(KEY, { db: d, client, log: () => {}, now: () => 1000, geocoder, collection: "door" });
    expect(client.calls.filter((c) => c[0] === "getPickupPoints")).toHaveLength(0);
    const sent = client.calls.find((c) => c[0] === "createShipment")[1];
    expect(sent).not.toHaveProperty("collection_pickup_point_id");
    expect(out).toMatchObject({ booked: true, mode: "door_collection", waybill: "DOOR77", dropOffRef: null, locker: null, doorFallback: { reason: "customer chose door collection", kind: "customer_choice", at: 1000 } });
    expect(d.root.online_orders[KEY].returnShipping).toMatchObject({ mode: "door_collection", courierBooking: { state: "booked" } });
  });

  it("keeps the guards: over the ceiling it is refused with nothing created; the default stays a locker", async () => {
    const client = shipClient();
    expect(await bookReturn(KEY, { db: live({ maxChargeRand: 100 }), client, log: () => {}, now: () => 1000, geocoder, collection: "door" })).toMatchObject({ skipped: true, refused: true, reason: "quote R140.37 is over the R100 ceiling" });
    expect(client.calls.filter((c) => c[0] === "createShipment")).toHaveLength(0);
    const locker = await bookReturn(KEY, { db: live(), client: shipClient(), log: () => {}, now: () => 1000, geocoder });
    expect(locker).toMatchObject({ booked: true, mode: "locker_dropoff" });
    await expect(bookReturn(KEY, { db: live(), client: shipClient(), log: () => {}, now: () => 1000, geocoder, collection: "post" })).rejects.toThrow(/locker or door/);
  });
});
