// quoteExchange — the exchange desk's live two-way quote (Junid, 25 Nov 2026). Fakes only, never the network.
import { describe, it, expect } from "vitest";
import { quoteExchange, quoteRecord, parseItems, ratesOnlyClient, runQuoteCli, flag } from "./exchangeQuote.mjs";
import { bookReturn, planReturn } from "./bookReturn.mjs";
import { planShipment } from "./bookShipment.mjs";
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
      if (body.delivery_pickup_point_id) return { rates: [r(80.25, "D2LM - ECO")] };
      if (String(body.delivery_address?.code) === "5600") return { rates: [r(95.5, "ECO")] };
      return { rates: [r(140.37, "ECO"), r(60, "L2DM - ECO")] };
    },
    createShipment: async (body) => { calls.push(["createShipment", body]); throw new Error("a quote must never create"); },
  };
}
const geocoder = async () => ({ lat: -32.8802, lng: 27.3937, from: "address", by: "street" });
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
    const held = quoteRecord({ original: ORIGINAL({ shipping: { ...ORIGINAL().shipping, addressHold: { state: "confirmed" } } }), orderKey: ORDER_KEY, items: ONE });
    expect(held.shipping).not.toHaveProperty("addressHold"); // reserve.js never copies it: the quote refuses when the booking would
    expect(held.customer).toEqual({ name: "Pumeza Vitshima" });
  });
  it("refuses an item with no pid or an unsafe one", () => {
    expect(() => parseItems('[{"size":"7"}]', "returning")).toThrow(/no pid/);
    expect(() => parseItems([{ pid: "a/b" }], "returning")).toThrow();
    expect(() => parseItems("{", "returning")).toThrow(/not JSON/);
    expect(() => parseItems([{ pid: "p1", qty: 11 }], "returning")).toThrow(/1 to 10/);
    expect(() => parseItems([{ pid: "p1", qty: 1.5 }], "returning")).toThrow(/whole number/);
    expect(parseItems([{ pid: "p1", qty: 10 }], "returning")[0].qty).toBe(10);
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

describe("architect review of #997", () => {
  it("parity: both legs are planned on the reserve-shaped record (lines = the replacement) and give the same code and rate as planReturn/planShipment", async () => {
    const d = db();
    const replacement = [{ pid: "p2", size: "XL", qty: 2 }];
    const products = { p1: d.root.products.p1, p2: d.root.products.p2 };
    // What reserve.js exchangeOrder writes once the exchange is on: the replacement lines, nothing else of the original.
    const real = { ...quoteRecord({ original: ORIGINAL(), orderKey: ORDER_KEY, items: replacement, products }), key: "exchange-1952-1794647899318" };
    const [ret, out] = [await planReturn(real, { db: d, client: fakeClient(), products, key: real.key, geocoder }), await planShipment(real, { db: d, client: fakeClient(), products, geocoder })];
    const q = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement, mode: "locker" }, deps(d, fakeClient()));
    expect(q.returnLeg).toMatchObject({ service: ret.rate.code, rand: ret.rate.rate });
    expect(q.outboundLeg).toEqual({ service: out.chosen.rate.code, rand: out.chosen.rate.rate });
    // the parcel priced for the return is the replacement's (two folded tees), not the returning sneaker's shoebox
    const client = fakeClient();
    await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement, mode: "locker" }, deps(db(), client));
    const lockerBody = client.calls.find((c) => c[0] === "getRates" && c[1].collection_pickup_point_id)[1];
    expect(JSON.stringify(lockerBody.parcels)).toEqual(JSON.stringify(ret.payload.parcels));
  });

  it("a geocode failure is transient (tried again), not a refusal", async () => {
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: ONE, mode: "locker" }, { db: db(), client: fakeClient(), geocoder: async () => null });
    expect(out).toMatchObject({ ok: false, transient: true });
    expect(out.reason).toMatch(/^return leg: the customer's address could not be placed/);
  });

  it("the outbound follows the shop's own delivery mode: door-to-locker when deliveryMode is not door", async () => {
    const d = db({ cfg: { deliveryMode: "locker" } });
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: ONE, mode: "locker" }, deps(d, fakeClient()));
    expect(out).toMatchObject({ ok: true, outboundLeg: { service: "D2LM - ECO", rand: 80.25 } });
  });

  it("every outbound live blocker is reported (not only the ceiling)", async () => {
    const out = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: ONE, mode: "door" }, deps(db({ cfg: { collectionContact: {} } }), fakeClient()));
    expect(out.ok).toBe(true);
    expect(out.blockers).toContain("outbound leg: collection_contact");
  });

  it("door refusals: no SA mobile (an email alone is not enough for a driver), and a parcel no box fits", async () => {
    const noPhone = ORIGINAL({ customer: { name: "P" }, shipping: { address: { ...ORIGINAL().shipping.address, phone: "" } } });
    const a = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: [], mode: "door" }, { ...deps(db({ original: noPhone }), fakeClient()), email: "p@example.com" });
    expect(a).toMatchObject({ ok: false });
    expect(a.reason).toMatch(/mobile number is missing/);
    const tiny = { boxes: [{ id: "box-tiny", code: "TINY", label: "Tiny", lengthCm: 10, widthCm: 10, heightCm: 2, tareKg: 0.1, measured: true }] };
    const b = await quoteExchange({ orderKey: ORDER_KEY, returning: ONE, replacement: [{ pid: "p2", size: "XL", qty: 10 }], mode: "door" }, deps(db({ cfg: tiny }), fakeClient()));
    expect(b).toMatchObject({ ok: false });
    expect(b.reason).toMatch(/no standard box fits/);
  });

  it("the CLI's client can only price: no createShipment", () => {
    const c = ratesOnlyClient(fakeClient());
    expect(Object.keys(c).sort()).toEqual(["getPickupPoints", "getRates"]);
    expect(c.createShipment).toBeUndefined();
  });

  it("a flag given without a valid value is an error, never a silent default; absent = default", () => {
    expect(flag(["--key", "x"], "mode", { allowed: ["locker", "door"] })).toEqual({ present: false, value: null });
    expect(() => flag(["--mode"], "mode", { allowed: ["locker", "door"] })).toThrow(/needs a value/);
    expect(() => flag(["--mode", "--phone", "1"], "mode", { allowed: ["locker", "door"] })).toThrow(/needs a value/);
    expect(() => flag(["--collection", "post"], "collection", { allowed: ["locker", "door"] })).toThrow(/must be locker or door/);
    expect(flag(["--collection", "door"], "collection", { allowed: ["locker", "door"] }).value).toBe("door");
  });

  describe("the CLI writes exactly one JSON line", () => {
    const run = async (argv, makeDeps) => {
      const lines = [];
      const code = await runQuoteCli(argv, { makeDeps, write: (s) => lines.push(s) });
      const text = lines.join("");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.trimEnd().split("\n")).toHaveLength(1);
      return { code, out: JSON.parse(text) };
    };
    const ok = async () => ({ db: db(), client: fakeClient(), geocoder });
    it("on success", async () => {
      const { code, out } = await run(["--order-key", ORDER_KEY, "--returning", JSON.stringify(ONE), "--replacement", JSON.stringify(ONE), "--mode", "door"], ok);
      expect(code).toBe(0);
      expect(out).toMatchObject({ ok: true, returnLeg: { mode: "door_collection" } });
    });
    it("on ok:false", async () => {
      const { code, out } = await run(["--order-key", "123", "--returning", JSON.stringify(ONE)], ok);
      expect(code).toBe(0);
      expect(out).toEqual({ ok: false, reason: "no order at /online_orders/123" });
    });
    it("on a crash, with transient when known; and a bad --mode", async () => {
      const { code, out } = await run(["--order-key", ORDER_KEY], async () => { const e = new Error("db down"); e.transient = true; throw e; });
      expect(code).toBe(1);
      expect(out).toEqual({ ok: false, error: "db down", transient: true });
      const bad = await run(["--order-key", ORDER_KEY, "--mode"], ok);
      expect(bad.code).toBe(1);
      expect(bad.out.error).toMatch(/--mode needs a value/);
    });
  });
});
