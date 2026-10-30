// bookReturn — an online exchange's return leg, locker-to-door from the locker nearest the customer. Recorded fixtures
// and fakes only, never the network.
import { describe, it, expect } from "vitest";
import { bookReturn, planReturn, nearestLocker, geocode } from "./bookReturn.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";
import lockerCpt from "./fixtures/rates-locker-capetown.json";
import shipmentLocker from "./fixtures/shipment-locker.json";

const KEY = "exchange-1793-1793333411004";
const SHOP_CONTACT = { name: "Junid Atugar", mobile_number: "0310000000", email: "shop@example.com" };
const POINTS = {
  pickup_points: [
    { pickup_point_id: "CG999", pickup_point_provider: "tcg-locker", name: "Far Mall", type: "locker", lat: -32.95, lng: 27.5, status: "online", available_compartment_sizes: ["V4-L"], address: { street_address: "1 Far Rd", city: "Qonce" } },
    { pickup_point_id: "RVM01017", pickup_point_provider: "tcg-locker", name: "Engen Amatola Convenience Centre", type: "locker", lat: -32.8874, lng: 27.3919, status: "online", description: "Left of Forecourt", trading_hours: "Mon – Sun: All day", available_compartment_sizes: ["V4-L", "V4-S", "V4-M"], address: { street_address: "128 Buffalo Rd, Qonce, 5601", city: "Qonce" } },
    { pickup_point_id: "CG001", pickup_point_provider: "tcg-locker", name: "Hidden", type: "locker", lat: -32.88, lng: 27.39, is_hidden: true, address: {} },
    { pickup_point_id: "CG002", pickup_point_provider: "tcg-locker", name: "Offline", type: "locker", lat: -32.8803, lng: 27.3938, status: "offline", address: {} },
  ],
};
const EXCHANGE = (over = {}) => ({
  orderNumber: "1793-EX", shopifyName: "#1793-EX", status: "ready",
  customer: { name: "Thanduxolo Tyebi" },
  exchange: { paidAt: 1793333411004, contactPhone: "27600000000" },
  lines: [{ pid: "p1", category: "Footwear", isFootwear: true, title: "Diesel", size: "7", qty: 1 }],
  shipping: { address: { address1: "519 ilitha township Qonce", city: "Qonce", province: "Eastern Cape", zip: "5600", name: "Thanduxolo Tyebi", phone: "0600000000" } },
  ...over,
});
const db = ({ live = true, exchange = EXCHANGE(), extra = {} } = {}) => fakeDb({
  config: { shipping: { live, collectionContact: SHOP_CONTACT } },
  online_orders: { [KEY]: exchange, ...extra },
});
const geocoder = async () => ({ lat: -32.8802, lng: 27.3937 });
function fakeClient({ createResult = shipmentLocker, createError = null, rates = lockerCpt, points = POINTS } = {}) {
  const calls = [];
  return {
    calls,
    creates: () => calls.filter((c) => c[0] === "createShipment"),
    getPickupPoints: async (q) => { calls.push(["getPickupPoints", q]); return points; },
    getRates: async (body) => { calls.push(["getRates", body]); return rates; },
    createShipment: async (body) => { calls.push(["createShipment", body]); if (createError) throw createError; return createResult; },
  };
}
const deps = (d, client, over = {}) => ({ db: d, client, log: () => {}, now: () => 1000, geocoder, email: "t@example.com", ...over });

describe("nearestLocker", () => {
  it("takes the closest online, listed locker the parcel fits", async () => {
    const l = await nearestLocker(fakeClient(), { lat: -32.8802, lng: 27.3937 }, "M");
    expect(l).toMatchObject({ id: "RVM01017", name: "Engen Amatola Convenience Centre", address: "128 Buffalo Rd, Qonce, 5601" });
    expect(l.km).toBeLessThan(2);
  });
  it("skips a locker without a compartment big enough", async () => {
    const points = { pickup_points: [{ ...POINTS.pickup_points[1], available_compartment_sizes: ["V4-S"] }, POINTS.pickup_points[0]] };
    expect((await nearestLocker(fakeClient({ points }), { lat: -32.88, lng: 27.39 }, "L")).id).toBe("CG999");
  });
});

describe("geocode", () => {
  it("tries the full address, then wider, and returns the first hit", async () => {
    const asked = [];
    const fetchImpl = async (url) => { asked.push(decodeURIComponent(url.split("q=")[1])); return { ok: true, json: async () => (asked.length < 2 ? [] : [{ lat: "-32.1", lon: "27.2" }]) }; };
    const at = await geocode({ street_address: "519 ilitha", local_area: "", city: "Qonce", code: "5600" }, { fetchImpl });
    expect(at).toMatchObject({ lat: -32.1, lng: 27.2 });
    expect(asked[0]).toBe("519 ilitha, Qonce, 5600");
  }, 10000);
});

describe("planReturn", () => {
  it("is the reverse of a website shipment: customer at the nearest locker → the shop door", async () => {
    const d = db();
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: d, client: fakeClient(), geocoder, email: "t@example.com", key: KEY, products: {} });
    expect(plan.ok).toBe(true);
    expect(plan.payload).toMatchObject({
      collection_pickup_point_id: "RVM01017",
      collection_pickup_point_provider: "tcg-locker",
      collection_contact: { name: "Thanduxolo Tyebi", mobile_number: "27600000000", email: "t@example.com" },
      collection_address: { city: "Qonce", code: "5600" },
      delivery_contact: SHOP_CONTACT,
      service_level_code: "L2DM - ECO",
      customer_reference: "1793-EX return",
    });
    expect(plan.payload.delivery_address.company).toBeTruthy(); // the shop
  });
  it("never falls back to a door collection", async () => {
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient({ rates: { rates: null } }), geocoder, key: KEY, products: {} });
    expect(plan).toMatchObject({ ok: false });
    expect(plan.reason).toMatch(/no locker rate/);
  });
  it("refuses an address it cannot place", async () => {
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient(), geocoder: async () => null, key: KEY, products: {} });
    expect(plan.reason).toMatch(/could not be placed/);
    expect(plan.transient).toBe(true);
  });
});

describe("strictly locker to door, and near", () => {
  it("a door service in the quote is never chosen", async () => {
    const rates = { rates: [{ rate: 50, service_level: { code: "ECO" } }, { rate: 130, service_level: { code: "L2DM - ECO" } }] };
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient({ rates }), geocoder, key: KEY, products: {} });
    expect(plan.payload.service_level_code).toBe("L2DM - ECO");
    const only = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient({ rates: { rates: [{ rate: 50, service_level: { code: "ECO" } }] } }), geocoder, key: KEY, products: {} });
    expect(only.ok).toBe(false);
  });
  it("a nearest locker too far away is refused", async () => {
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient(), geocoder: async () => ({ lat: -30, lng: 25, from: "x" }), key: KEY, products: {} });
    expect(plan.reason).toMatch(/km from the customer's address/);
  });
});

describe("bookReturn", () => {
  it("books once and records the waybill, the drop-off reference and the locker", async () => {
    const d = db();
    const client = fakeClient();
    const out = await bookReturn(KEY, deps(d, client));
    expect(out).toMatchObject({ booked: true, waybill: "TEST01", dropOffRef: "LD-TEST01", locker: { id: "RVM01017" } });
    expect(d.root.online_orders[KEY].returnShipping).toMatchObject({ waybill: "TEST01", courierBooking: { state: "booked" } });
    const again = await bookReturn(KEY, deps(d, client));
    expect(again).toMatchObject({ skipped: true, reason: "return already booked" });
    expect(client.creates()).toHaveLength(1);
  });
  for (const live of [false, "true", 1, null]) {
    it(`live=${JSON.stringify(live)} is a dry run: no create`, async () => {
      const client = fakeClient();
      const out = await bookReturn(KEY, deps(db({ live }), client));
      expect(out.skipped).toBe(true);
      expect(client.creates()).toHaveLength(0);
    });
  }
  it("leaves a return booked by hand, an item already back, or a cancelled exchange alone", async () => {
    for (const exchange of [EXCHANGE({ incoming: { waybill: "CQMT67" } }), EXCHANGE({ incoming: { arrival: { state: "done" } } }), EXCHANGE({ status: "cancelled" })]) {
      const client = fakeClient();
      expect((await bookReturn(KEY, deps(db({ exchange }), client))).skipped).toBe(true);
      expect(client.creates()).toHaveLength(0);
    }
  });
  it("refuses a key that is not an exchange, and an unpaid record", async () => {
    await expect(bookReturn("18965302608021", deps(db(), fakeClient()))).rejects.toThrow(/not an exchange key/);
    const unpaid = EXCHANGE({ exchange: { contactPhone: "27600000000" } });
    expect((await bookReturn(KEY, deps(db({ exchange: unpaid }), fakeClient()))).reason).toMatch(/no paid exchange/);
  });
  it("refuses a quote over the ceiling", async () => {
    const rates = { rates: [{ rate: 400, service_level: { code: "L2DL - ECO" } }] };
    const client = fakeClient({ rates });
    const out = await bookReturn(KEY, deps(db(), client));
    expect(out).toMatchObject({ skipped: true, refused: true });
    expect(client.creates()).toHaveLength(0);
  });
  it("a lost create response holds the claim as unknown (never booked twice)", async () => {
    const d = db();
    const err = Object.assign(new Error("timeout"), { status: 504 });
    await expect(bookReturn(KEY, deps(d, fakeClient({ createError: err })))).rejects.toMatchObject({ ambiguous: true });
    expect(d.root.online_orders[KEY].returnShipping.courierBooking.state).toBe("unknown");
    const client = fakeClient();
    expect((await bookReturn(KEY, deps(d, client))).reason).toMatch(/already unknown/);
    expect(client.creates()).toHaveLength(0);
  });
  it("a refused create (4xx) releases the claim as failed, with the error", async () => {
    const d = db();
    await expect(bookReturn(KEY, deps(d, fakeClient({ createError: Object.assign(new Error("insufficient funds"), { status: 400 }) })))).rejects.toMatchObject({ ambiguous: false });
    expect(d.root.online_orders[KEY].returnShipping.courierBooking).toMatchObject({ state: "failed" });
  });
});
