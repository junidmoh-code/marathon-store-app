// DOOR-TO-LOCKER (Junid, 20 Nov 2026) — fakes only, never the network.
// Every booking: our door → the Courier Guy locker nearest the customer, one
// shoe-sized parcel per shipment. /config/shipping/deliveryMode "door" is the
// old booking, unchanged. No locker for the parcel → that door-to-door booking
// instead (Junid, 24 Nov 2026).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bookShipment, cancelShipment, planShipment, doorRetryDue, doorHandBackDue, handBackBooked } from "./bookShipment.mjs";
import { retryNoLocker } from "./retry-no-locker.mjs";
import { lockerParcelCount, declaredParcel, oneShoe, placeAddress, NO_CODE_NOTE, lockerSizeFor, chooseLockerRate, serviceSize } from "./lockerDelivery.mjs";
import { rebookLocker, UNCOLLECTED } from "./rebook-locker.mjs";
import { reconcileOrder, runReconcile, shipmentsOf } from "./reconcile.mjs";
import { adjustmentLines } from "./courier-recon.mjs";
import { DEFAULT_SHIPPING_CONFIG } from "../../src/shipping/shippingConfig.js";
import { fakeDb } from "./fakeDb.testutil.mjs";
import doorCpt from "./fixtures/rates-door-capetown.json";

const CONTACT = { name: "The Marathon", mobile_number: "0310000000", email: "" };
const NOW = 1_700_000_000_000;
const AT = { lat: -26.3165, lng: 26.8227 };
const point = (id, name, lat, lng, over = {}) => ({
  pickup_point_id: id, pickup_point_provider: "tcg-locker", name, type: "locker", lat, lng,
  address: { street_address: "1 Van Riebeeck St", city: "Ventersdorp" }, description: "Opposite KFC", trading_hours: "Mon – Sun: All day",
  available_compartment_sizes: ["V4-L", "V4-S", "V4-M"], is_hidden: false, status: "online", ...over,
});
const NEAR = point("RVM01240", "Astron Energy Ventersdorp", -26.3209, 26.8156); // ~0.9 km
const SECOND = point("CG648", "MBT N14 Ventersdorp", -26.3259, 26.7888); // ~3.5 km
const FAR = point("CG900", "Potchefstroom Mall", -26.715, 27.097); // ~52 km
const d2l = (m = 130.31, l = 192.72) => ({ rates: [
  { rate: l, service_level: { code: "D2LL - ECO", name: "Door to locker large" }, charged_weight: 3 },
  { rate: m, service_level: { code: "D2LM - ECO", name: "Door to locker medium" }, charged_weight: 3, base_rate: { charge: m } },
] });

function fakeClient({ points = [NEAR, SECOND, FAR], lockerRates = d2l(), createErrors = {}, statuses = {} } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c[1]),
    shipmentCalls: () => calls.filter((c) => c[0] === "createShipment" || c[0] === "cancelShipment"),
    getRates: async (body) => { calls.push(["getRates", body]); return body.delivery_pickup_point_id ? (typeof lockerRates === "function" ? lockerRates(body) : lockerRates) : doorCpt; },
    getPickupPoints: async (q) => { calls.push(["getPickupPoints", q]); return { pickup_points: points }; },
    getShipments: async (q) => { calls.push(["getShipments", q]); return { shipments: [{ short_tracking_reference: q.tracking_reference, status: statuses[q.tracking_reference] ?? "collection-assigned" }] }; },
    createShipment: async (body) => {
      calls.push(["createShipment", body]);
      n++;
      if (createErrors[n]) throw createErrors[n];
      return { id: 1000 + n, short_tracking_reference: `WB${n}`, service_level_code: body.service_level_code, rate: 130.31 };
    },
    cancelShipment: async (ref) => { calls.push(["cancelShipment", ref]); return { ok: true }; },
  };
}

const ORDER = (over = {}) => ({
  key: "1001", orderNumber: 2257, shopifyGid: "gid://shopify/Order/1001",
  lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "9", qty: 1 }],
  shipping: { address: { street: "12 Carmichael Street", suburb: "None", city: "Ventersdorp", province: "North West", zip: "2710" } },
  customer: { name: "A Customer", phone: "0820000000", email: "a@example.com" },
  ...over,
});
const PAIRS = (qty) => ORDER({ lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "9", qty }] });
// A split is only ever a person's: shipping/lockerParcels on the order (rebook-locker.mjs --parcels).
const SPLIT = (n) => { const o = ORDER(); return { ...o, shipping: { ...o.shipping, lockerParcels: n } }; };
// NO deliveryMode in the node: the code's default is door-to-locker.
const db = (live, cfg = {}, extra = {}) => fakeDb({
  config: { shipping: { ...(live === undefined ? {} : { live }), collectionContact: CONTACT, ...cfg } },
  online_orders: { 1001: ORDER() },
  ...extra,
});
const geo = (at = AT, from = "12 Carmichael Street, None, Ventersdorp, 2710") => { const g = vi.fn(async () => (at ? { ...at, from } : null)); return g; };
const deps = (d, client, { geocoder = geo(), logs = [] } = {}) => ({ db: d, client, geocoder, log: (l) => logs.push(l), now: () => NOW });

let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchSpy.mockRestore());

describe("the default is door-to-locker", () => {
  it("the code's default mode is locker, the parcel one shoe: 34 × 23 × 13 cm, 1.5 kg", () => {
    expect(DEFAULT_SHIPPING_CONFIG.deliveryMode).toBe("locker");
    expect(oneShoe(DEFAULT_SHIPPING_CONFIG)).toEqual({ kind: "oneShoe", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 1.5 });
    expect(DEFAULT_SHIPPING_CONFIG.maxChargeRand).toBe(500);
  });

  it("dry run: the normal payload plus the delivery pickup point, the one-shoe parcel, the cheapest locker service; nothing created", async () => {
    const client = fakeClient();
    const res = await bookShipment(ORDER(), deps(db(false), client));
    expect(client.shipmentCalls()).toEqual([]);
    expect(res.dryRun).toEqual({
      collection_address: expect.objectContaining({ code: "4001" }),
      collection_contact: CONTACT,
      // the customer's own address stays on the shipment
      delivery_address: expect.objectContaining({ street_address: "12 Carmichael Street", city: "Ventersdorp", code: "2710" }),
      delivery_pickup_point_id: "RVM01240",
      delivery_pickup_point_provider: "tcg-locker",
      delivery_contact: { name: "A Customer", mobile_number: "0820000000", email: "a@example.com" },
      parcels: [{ parcel_description: "Retail", submitted_length_cm: 34, submitted_width_cm: 23, submitted_height_cm: 13, submitted_weight_kg: 1.5 }],
      service_level_code: "D2LM - ECO",
      customer_reference: "#2257",
      customer_reference_name: "Order no.",
      mute_notifications: false,
    });
    expect(res.dryRun).not.toHaveProperty("collection_pickup_point_id");
    expect(res.quote).toEqual({ mode: "door_to_locker", code: "D2LM - ECO", rate: 130.31 });
    expect(res.deliveryLocker).toMatchObject({ id: "RVM01240", name: "Astron Energy Ventersdorp" });
    expect(res.doorQuote).toEqual({ code: "ECO", rate: 100 });
    // the /rates call that priced it carried the pickup point and the one-shoe parcel
    const priced = client.of("getRates").find((b) => b.delivery_pickup_point_id);
    expect(priced).toMatchObject({ delivery_pickup_point_id: "RVM01240", delivery_pickup_point_provider: "tcg-locker", parcels: [expect.objectContaining({ submitted_length_cm: 34, submitted_weight_kg: 1.5 })] });
  });

  it("the box comes from the lines (Junid, 21 Nov 2026): thirty bags weigh 15 kg, past the M box's 10 kg, so the L box", async () => {
    const client = fakeClient();
    const order = ORDER({ lines: [{ category: "Accessories", subcategory: "Bags", qty: 30 }] });
    const d = db(true);
    const res = await bookShipment(order, deps(d, client));
    expect(res.waybill).toBe("WB1");
    expect(client.of("createShipment")).toHaveLength(1);
    expect(client.of("createShipment")[0]).toMatchObject({ service_level_code: "D2LL - ECO", parcels: [{ parcel_description: "Retail", submitted_length_cm: 34, submitted_width_cm: 23, submitted_height_cm: 26, submitted_weight_kg: 15 }] });
    expect(d.root.online_orders["1001"].shipping.parcel).toMatchObject({ lockerSize: "L", declaredAs: "whole_order" });
  });

  it("thirty-one bags (15.5 kg) fit no locker box (nor a standard box, so door-to-door refuses them too): nothing created", async () => {
    const client = fakeClient();
    const res = await bookShipment(ORDER({ lines: [{ category: "Accessories", subcategory: "Bags", qty: 31 }] }), deps(db(true), client));
    expect(client.of("createShipment")).toEqual([]);
    expect(JSON.stringify(res)).toMatch(/largest Courier Guy locker box/);
  });

  it("live: books D2L once and records the locker, the waybills, the door quote and the no-code fact on the order", async () => {
    const d = db(true);
    const client = fakeClient();
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(client.of("createShipment")).toHaveLength(1);
    expect(client.of("createShipment")[0]).toMatchObject({ delivery_pickup_point_id: "RVM01240", delivery_pickup_point_provider: "tcg-locker", service_level_code: "D2LM - ECO" });
    const s = d.root.online_orders["1001"].shipping;
    expect(s).toMatchObject({
      provider: "courier_guy", shipmentId: 1001, waybill: "WB1", trackingReference: "WB1", service: "D2LM - ECO", cost: 130.31,
      deliveryMode: "locker", waybills: ["WB1"], doorQuote: { code: "ECO", rate: 100 },
      priced: { quoted: 130.31, mode: "door_to_locker" },
      courierBooking: { state: "booked" }, bookedAt: NOW,
    });
    expect(s.deliveryLocker).toEqual({
      id: "RVM01240", provider: "tcg-locker", name: "Astron Energy Ventersdorp", address: "1 Van Riebeeck St, Ventersdorp",
      hours: "Mon – Sun: All day", description: "Opposite KFC", km: expect.any(Number),
      placedBy: "street", smsTo: "0820000000", hasCollectionCode: false, collectionCodeNote: NO_CODE_NOTE,
      // The locker's own point and address (the delivery address when Courier Guy cannot place the street, #2181).
      lat: -26.3209, lng: 26.8156,
      tcgAddress: { street_address: "1 Van Riebeeck St", local_area: "", city: "Ventersdorp", zone: "", code: "" },
    });
    expect(s.deliveryLocker.km).toBeLessThan(2);
    // a fixed declaration, not an estimate: no rule version, so reconcile never learns the parcel table from it
    expect(s.parcel).toMatchObject({ declaredAs: "one_shoe", parcelCount: 1, parcels: [{ lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 1.5 }] });
    expect(s.parcel.ruleVersion).toBeUndefined();
    expect(s.quotes.map((q) => q.code)).toEqual(["ECO", "D2LM - ECO", "D2LL - ECO"]);
    expect(res.waybill).toBe("WB1");
  });

  it("the cheapest service the API returns is booked (nothing excluded unless config says so)", async () => {
    const client = fakeClient({ lockerRates: d2l(210, 150) });
    expect((await bookShipment(ORDER(), deps(db(false), client))).dryRun.service_level_code).toBe("D2LL - ECO");
    const client2 = fakeClient({ lockerRates: d2l(210, 150) });
    expect((await bookShipment(ORDER(), deps(db(false, { excludeServiceCodes: ["D2LL - ECO"] }), client2))).dryRun.service_level_code).toBe("D2LM - ECO");
  });

  it("the nearest locker that PRICES wins: one Courier Guy quotes nothing for is passed over", async () => {
    const client = fakeClient({ lockerRates: (b) => (b.delivery_pickup_point_id === "RVM01240" ? { rates: null } : d2l()) });
    const res = await bookShipment(ORDER(), deps(db(false), client));
    expect(res.deliveryLocker.id).toBe("CG648");
    expect(res.dryRun.delivery_pickup_point_id).toBe("CG648");
  });

  it("a hidden, offline or too-small locker is never chosen", async () => {
    const client = fakeClient({ points: [point("H1", "Hidden", -26.3166, 26.8228, { is_hidden: true }), point("O1", "Offline", -26.3166, 26.8228, { status: "offline" }), point("S1", "Small only", -26.3166, 26.8228, { available_compartment_sizes: ["V4-S", "V4-XS"] }), SECOND] });
    expect((await bookShipment(ORDER(), deps(db(false), client))).deliveryLocker.id).toBe("CG648");
  });

  it("exchanges and second parcels go door-to-locker too", async () => {
    const ex = { key: "exchange-1789-1793333411004", shopifyName: "#1789-EX", exchange: { paidAt: 1793333411004, contactPhone: "27600000000" }, lines: ORDER().lines, shipping: ORDER().shipping, customer: { name: "A Customer" } };
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT } }, online_orders: { [ex.key]: ex, "1001r1": { reship: { of: "1001" } } } });
    const client = fakeClient();
    const res = await bookShipment(ex, deps(d, client));
    expect(res).toMatchObject({ waybill: "WB1", deliveryMode: "locker", deliveryLocker: { id: "RVM01240", smsTo: "27600000000" } });
    expect(client.of("createShipment")[0]).toMatchObject({ customer_reference: "#1789-EX", delivery_pickup_point_id: "RVM01240" });
    const re = await bookShipment({ ...ORDER(), key: "1001r1", reship: { of: "1001" } }, deps(d, client));
    expect(re).toMatchObject({ waybill: "WB2", deliveryMode: "locker" });
  });
});

describe("deliveryMode \"door\" restores door-to-door exactly", () => {
  it("no map lookup, no locker list, no pickup point, the estimated parcel, the door service", async () => {
    const client = fakeClient();
    const geocoder = geo();
    const d = db(true, { deliveryMode: "door" });
    const res = await bookShipment(ORDER(), deps(d, client, { geocoder }));
    expect(geocoder).not.toHaveBeenCalled();
    expect(client.of("getPickupPoints")).toEqual([]);
    expect(client.calls.map((c) => c[0])).toEqual(["getRates", "createShipment"]);
    const sent = client.of("createShipment")[0];
    expect(sent).not.toHaveProperty("delivery_pickup_point_id");
    expect(sent.service_level_code).toBe("ECO");
    expect(sent.parcels).toEqual([{ parcel_description: "Retail", submitted_length_cm: 34, submitted_width_cm: 23, submitted_height_cm: 13, submitted_weight_kg: 1.2 }]);
    expect(Object.keys(res).sort()).toEqual(["bookedAt", "cost", "parcel", "priced", "provider", "quotes", "service", "shipmentId", "trackingReference", "waybill"]);
    expect(res.priced.mode).toBe("door");
    expect(res.parcel.ruleVersion).toBe(4);
    expect(d.root.online_orders["1001"].shipping).not.toHaveProperty("deliveryLocker");
  });

  it("door mode still refuses a parcel no box fits; locker mode does not", async () => {
    const bags = ORDER({ lines: [{ category: "Accessories", subcategory: "Bags", qty: 30 }] });
    expect((await bookShipment(bags, deps(db(true, { deliveryMode: "door" }), fakeClient()))).reason).toMatch(/no standard box fits/);
  });
});

// NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026, STANDING RULE: "if no Courier Guy locker is near the customer (like #2411
// Alistair, Jansenville: 'no locker within 30 km'), book DOOR-TO-DOOR delivery to their address automatically instead of
// failing. Never leave an order unbooked because there's no locker."). This block used to pin the 20 Nov rule ("refused
// with the reason, NEVER a silent door-to-door"); only a no-locker reason falls back, every other failure still refuses.
describe("no locker → booked DOOR-TO-DOOR with the reason on the order; every other failure still refuses", () => {
  const expectNothingBooked = (client, d) => {
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.root.online_orders["1001"].shipping?.waybill).toBeUndefined();
    expect(d.root.online_orders["1001"].shipping?.courierBooking).toBeUndefined();
  };
  // The door-to-door booking, exactly as /config/shipping/deliveryMode "door" makes it: the estimated parcel, the
  // customer's own address, no pickup point, the cheapest door service (ECO R100 in the fixture).
  const expectDoorBooking = (client, d, res) => {
    const creates = client.of("createShipment");
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty("delivery_pickup_point_id");
    expect(creates[0]).toMatchObject({
      service_level_code: "ECO", customer_reference: "#2257",
      delivery_address: { street_address: "12 Carmichael Street", city: "Ventersdorp", code: "2710" },
      parcels: [{ submitted_length_cm: 34, submitted_width_cm: 23, submitted_height_cm: 13, submitted_weight_kg: 1.2 }],
    });
    expect(res).toMatchObject({ waybill: "WB1", service: "ECO", deliveryMode: "door", priced: { mode: "door" } });
    const s = d.root.online_orders["1001"].shipping;
    expect(s).toMatchObject({ waybill: "WB1", deliveryMode: "door", doorFallback: { reason: res.doorFallback.reason, at: NOW }, courierBooking: { state: "booked" } });
    // No locker on a door booking: nothing for Jamie to send the customer to, no PIN, no waybills[] list.
    expect(s).not.toHaveProperty("deliveryLocker");
    expect(s).not.toHaveProperty("waybills");
    // A real estimate again (not the fixed one-shoe declaration): it carries the rule version.
    expect(s.parcel.ruleVersion).toBe(4);
    // The line is returned for the poller to queue; it is never part of the shipping node.
    expect(s).not.toHaveProperty("junidLine");
  };

  it("the nearest locker is too far (#2411): booked door-to-door, shipping.deliveryMode \"door\" + doorFallback, Junid's line says so", async () => {
    const client = fakeClient({ points: [FAR] });
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res.skipped).toBeUndefined();
    expect(res.doorFallback).toMatchObject({ kind: "none_near", at: NOW });
    expect(res.doorFallback.reason).toMatch(/^no Courier Guy locker within 30 km of Ventersdorp \(the nearest, Potchefstroom Mall, is 5\d(\.\d)? km away\)$/);
    expect(res.junidLine).toMatch(/^#2257: booked door-to-door: no Courier Guy locker within 30 km of Ventersdorp \(the nearest, Potchefstroom Mall, is 5\d(\.\d)? km away\)\. ECO R130\.31, waybill WB1\.$/);
    expect(res.junidLine).not.toMatch(/Not booked/);
    expectDoorBooking(client, d, res);
  });

  it("the distance is config: /config/shipping/locker/maxKm 60 books the 52 km locker", async () => {
    const client = fakeClient({ points: [FAR] });
    const res = await bookShipment(ORDER(), deps(db(true, { locker: { maxKm: 60 } }), client));
    expect(res).toMatchObject({ waybill: "WB1", deliveryLocker: { id: "CG900" }, deliveryMode: "locker" });
    expect(res.doorFallback).toBeUndefined();
  });

  it("only the town could be placed: the tighter town limit (20 km) applies, the reason says so, and it goes door-to-door", async () => {
    const mid = point("CG777", "Twenty-five away", -26.541, 26.8227); // ~25 km
    const client = fakeClient({ points: [mid] });
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client, { geocoder: geo(AT, "Ventersdorp, 2710") }));
    expect(res.doorFallback.reason).toMatch(/no Courier Guy locker within 20 km of Ventersdorp .*; only the town could be placed on the map/);
    expectDoorBooking(client, d, res);
    // by its street the same locker is inside the 30 km limit: door-to-locker, as before
    expect((await bookShipment(ORDER(), deps(db(true), fakeClient({ points: [mid] })))).deliveryLocker.id).toBe("CG777");
  });

  it("only the town placed because the postal-code lookup FAILED (429, timeout): tried again later, never door-to-door (architect review, #984)", async () => {
    const mid = point("CG777", "Twenty-five away", -26.541, 26.8227); // ~25 km: inside 30, outside the town's 20
    const client = fakeClient({ points: [mid] });
    const d = db(true);
    const failedLookup = vi.fn(async () => ({ ...AT, from: "Ventersdorp, 2710", by: "town", postcodeFailed: "HTTP 429" }));
    const res = await bookShipment(ORDER(), deps(d, client, { geocoder: failedLookup }));
    expect(res).toMatchObject({ skipped: true, reason: expect.stringMatching(/postal code lookup failed \(HTTP 429\): tried again later/) });
    expect(res.noLocker).toBeUndefined();
    expect(res.doorFallback).toBeUndefined();
    expect(client.shipmentCalls()).toEqual([]);
    // a genuine no-match (the town point, nothing failed) still goes door-to-door
    const noMatch = fakeClient({ points: [mid] });
    const d2 = db(true);
    const res2 = await bookShipment(ORDER(), deps(d2, noMatch, { geocoder: vi.fn(async () => ({ ...AT, from: "Ventersdorp, 2710", by: "town" })) }));
    expect(res2.doorFallback.reason).toMatch(/within 20 km/);
    expectDoorBooking(noMatch, d2, res2);
  });

  it("the drop box switched on: the no-locker fallback is still collected at our door, never a drop-box rate (architect review, #984)", async () => {
    const L2D = { rates: [{ rate: 40, service_level: { code: "L2DM - ECO" } }] };
    const withDropBox = () => { const c = fakeClient({ points: [FAR] }); const base = c.getRates; c.getRates = async (b) => (b.collection_pickup_point_id ? (c.calls.push(["getRates", b]), L2D) : base(b)); return c; };
    const client = withDropBox();
    const d = db(true, { dropBox: { enabled: true } });
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res).toMatchObject({ waybill: "WB1", deliveryMode: "door", service: "ECO" });
    expect(client.of("getRates").some((b) => b.collection_pickup_point_id)).toBe(false);
    expect(client.of("createShipment")[0]).not.toHaveProperty("collection_pickup_point_id");
    // an explicit deliveryMode "door" keeps the drop box exactly as before
    const explicit = withDropBox();
    await bookShipment(ORDER(), deps(db(false, { dropBox: { enabled: true }, deliveryMode: "door" }), explicit));
    expect(explicit.of("getRates").some((b) => b.collection_pickup_point_id)).toBe(true);
  });

  it("no locker at all near the address: door-to-door", async () => {
    const client = fakeClient({ points: [] });
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res.doorFallback.reason).toBe("no Courier Guy locker within 30 km of Ventersdorp");
    expectDoorBooking(client, d, res);
  });

  it("the same ceiling: a door rate UNDER it books, OVER it is refused live with both reasons in Junid's line, and never handed back again", async () => {
    // ECO is R100 in the door fixture.
    const under = fakeClient({ points: [FAR] });
    expect((await bookShipment(ORDER(), deps(db(true, { maxChargeRand: 100 }), under))).waybill).toBe("WB1");
    const client = fakeClient({ points: [FAR] });
    const d = db(true, { maxChargeRand: 99 });
    const res = await bookShipment(ORDER(), deps(d, client));
    // The reason is the ceiling's own, unchanged (what the POS card translates); the locker's reason sits beside it.
    expect(res).toMatchObject({ skipped: true, reason: "quote R100.00 is over the R99 ceiling", noLocker: true, doorTried: true, doorFallback: { kind: "none_near" }, overCeiling: { ceiling: 99, chosen: { mode: "door", code: "ECO", rate: 100 } } });
    expect(res.junidLine).toMatch(/^#2257: no Courier Guy locker within 30 km of Ventersdorp .*, so door-to-door was priced\. Courier Guy quotes R100\.00 \(ECO, .*\), over the R99 ceiling, not booked\./);
    expectNothingBooked(client, d);
    // named in a dry run, like any ceiling
    const dry = await bookShipment(ORDER(), deps(db(false, { maxChargeRand: 99 }), fakeClient({ points: [FAR] })));
    expect(dry).toMatchObject({ skipped: true, deliveryMode: "door", doorFallback: { kind: "none_near" }, liveBlockers: ["quote R100.00 is over the R99 ceiling"] });
  });

  it("no locker AND no door price: refused with the door plan's reason, the locker's beside it, one line for Junid", async () => {
    const client = fakeClient({ points: [FAR] });
    client.getRates = async (body) => { client.calls.push(["getRates", body]); return { rates: null }; };
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res).toMatchObject({ skipped: true, reason: "no usable rate (door: none; locker: none)", noLocker: true, doorTried: true, doorFallback: { kind: "none_near" } });
    expect(res.junidLine).toMatch(/^#2257: no Courier Guy locker within 30 km of Ventersdorp .*, and door-to-door could not be booked either \(no usable rate/);
    expectNothingBooked(client, d);
  });

  it("a parcel no locker box takes (31 bags, 15.5 kg) is a no-locker outcome too: door-to-door, where the box list decides", async () => {
    const bags = (qty) => ORDER({ lines: [{ category: "Accessories", subcategory: "Bags", qty }] });
    // 31 bags fit no standard box either: refused as any door booking is, Junid told both.
    const client = fakeClient();
    const d = db(true);
    const res = await bookShipment(bags(31), deps(d, client));
    expect(res).toMatchObject({ skipped: true, reason: "no standard box fits", noLocker: true, doorTried: true, doorFallback: { kind: "too_big" } });
    expect(res.junidLine).toMatch(/largest Courier Guy locker box .*, and door-to-door was not booked either \(no standard box fits\)/);
    expectNothingBooked(client, d);
    expect(client.of("getPickupPoints")).toEqual([]); // the locker list was never asked: no box, no locker
  });

  it("Courier Guy quotes no service to any near locker: door-to-door (an answer, not a failed lookup)", async () => {
    const client = fakeClient({ lockerRates: { rates: null } });
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res.doorFallback).toMatchObject({ kind: "none_priced" });
    expect(res.doorFallback.reason).toMatch(/Courier Guy quoted no door-to-locker service to the lockers near Ventersdorp/);
    expectDoorBooking(client, d, res);
  });

  it("/config/shipping/locker/doorFallback false is the 20 Nov rule again: refused, one line for Junid, nothing priced door-to-door", async () => {
    const client = fakeClient({ points: [FAR] });
    const d = db(true, { locker: { doorFallback: false, doorQuote: false } });
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res).toMatchObject({ skipped: true, noLocker: true });
    expect(res.reason).toMatch(/^no Courier Guy locker within 30 km of Ventersdorp/);
    expect(res.junidLine).toMatch(/Not booked \(door-to-locker only\)/);
    expect(res.doorTried).toBeUndefined();
    expect(client.of("getRates")).toEqual([]);
    expectNothingBooked(client, d);
  });

  // ── STILL REFUSED, exactly as before ──────────────────────────────────────
  it("the address cannot be placed on the map: refused, no locker asked for, no line to Junid (the map service being down looks the same)", async () => {
    const client = fakeClient();
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client, { geocoder: geo(null) }));
    expect(res).toMatchObject({ skipped: true, noLocker: true });
    expect(res.reason).toMatch(/no Courier Guy locker could be chosen for Ventersdorp: the address could not be placed on the map/);
    expect(res.junidLine).toBeUndefined();
    expect(res.doorFallback).toBeUndefined();
    expect(client.of("getRates").filter((b) => !b.delivery_pickup_point_id).length).toBeLessThanOrEqual(1); // only the doorQuote comparison, never a booking plan
    expect(client.of("getPickupPoints")).toEqual([]);
    expectNothingBooked(client, d);
  });

  it("a rates lookup that FAILS on the town retry is a failed lookup (retry later), not \"no service\"", async () => {
    let n = 0;
    const client = fakeClient({ points: [NEAR], lockerRates: () => { if (++n === 1) return { rates: null }; throw Object.assign(new Error("HTTP 503"), { status: 503 }); } });
    const res = await bookShipment(ORDER(), deps(db(true), client));
    expect(res.reason).toMatch(/no door-to-locker rate \(HTTP 503\)/);
    expect(res.noLocker).toBeUndefined();
    expect(res.doorFallback).toBeUndefined();
    expect(res.junidLine).toBeUndefined();
    expect(client.shipmentCalls()).toEqual([]);
  });

  it("no customer mobile number: not booked live (the locker PIN is sent by SMS), named in a dry run", async () => {
    const emailOnly = ORDER({ customer: { name: "A Customer", email: "a@example.com" } });
    const client = fakeClient();
    const d = db(true);
    expect((await bookShipment(emailOnly, deps(d, client))).reason).toBe("no customer mobile number (the locker PIN is sent by SMS)");
    expectNothingBooked(client, d);
    expect((await bookShipment(emailOnly, deps(db(false), fakeClient()))).liveBlockers).toEqual(["no customer mobile number (the locker PIN is sent by SMS)"]);
    // door-to-door never needed one
    expect((await bookShipment(emailOnly, deps(db(true, { deliveryMode: "door" }), fakeClient()))).waybill).toBe("WB1");
  });

  it("a locker a PERSON named, ruled out or split is never swapped for door-to-door", async () => {
    const steer = (shipping) => { const o = ORDER(); return { ...o, shipping: { ...o.shipping, ...shipping } }; };
    for (const [shipping, why] of [
      [{ lockerChoice: { id: "CG404", by: "hand" } }, /locker CG404 is not among the online Courier Guy lockers/],
      [{ lockerAvoid: ["RVM01240", "CG648"] }, /no Courier Guy locker within 30 km/],
      [{ lockerParcels: 2 }, /no Courier Guy locker within 30 km/],
    ]) {
      const client = fakeClient(shipping.lockerParcels ? { points: [FAR] } : {});
      const d = db(true);
      const res = await bookShipment(steer(shipping), deps(d, client));
      expect(res).toMatchObject({ skipped: true, noLocker: true });
      expect(res.reason).toMatch(why);
      expect(res.doorFallback).toBeUndefined();
      expect(res.junidLine).toMatch(/Not booked \(door-to-locker only\)/);
      expectNothingBooked(client, d);
    }
  });

  it("a HALF-BOOKED split is never finished as door: the lockers gone, nothing is booked and the checkpoint is kept", async () => {
    const d = db(true);
    const client = fakeClient({ createErrors: { 2: Object.assign(new Error("HTTP 400 invalid"), { status: 400 }) } });
    await expect(bookShipment(SPLIT(3), deps(d, client))).rejects.toThrow(/400/);
    expect(d.root.online_orders["1001"].shipping.partial).toMatchObject({ shipments: [{ waybill: "WB1" }], locker: { id: "RVM01240" } });
    // The retry: no locker near any more (the very case that now goes door-to-door for a fresh order).
    const client2 = fakeClient({ points: [FAR] });
    // Even with the person's split count gone from the copy the retry holds, the checkpoint alone stops it.
    const retry = { ...ORDER(), shipping: { ...ORDER().shipping, partial: d.root.online_orders["1001"].shipping.partial, courierBooking: d.root.online_orders["1001"].shipping.courierBooking } };
    const res = await bookShipment(retry, deps(d, client2));
    expect(res.skipped).toBe(true);
    expect(res.doorFallback).toBeUndefined();
    expect(res.reason).toMatch(/locker RVM01240 is not among the online Courier Guy lockers/);
    expect(client2.shipmentCalls()).toEqual([]);
    const s = d.root.online_orders["1001"].shipping;
    expect(s.partial).toMatchObject({ shipments: [{ waybill: "WB1" }] });
    expect(s.waybill).toBeUndefined();
    expect(s.deliveryMode).toBeUndefined();
  });

  it("an order already booked is skipped before anything is priced, whatever the lockers say", async () => {
    const client = fakeClient({ points: [FAR] });
    const o = ORDER();
    const res = await bookShipment({ ...o, shipping: { ...o.shipping, shipmentId: 55, waybill: "OLD1" } }, deps(db(true), client));
    expect(res).toMatchObject({ skipped: true, reason: "already booked" });
    expect(client.calls).toEqual([]);
  });

  it("a second booking of the same order after the door-to-door one books nothing (the claim, then the shipmentId)", async () => {
    const d = db(true);
    const first = fakeClient({ points: [FAR] });
    await bookShipment(ORDER(), deps(d, first));
    // a stale copy of the order (no shipmentId on it): the claim on the database stops it
    const stale = fakeClient({ points: [FAR] });
    expect(await bookShipment(ORDER(), deps(d, stale))).toMatchObject({ skipped: true, reason: "booking already booked" });
    expect(stale.shipmentCalls()).toEqual([]);
    // the fresh copy: its shipmentId
    const fresh = fakeClient({ points: [FAR] });
    expect(await bookShipment({ ...ORDER(), shipping: d.root.online_orders["1001"].shipping }, deps(d, fresh))).toMatchObject({ skipped: true, reason: "already booked" });
    expect(fresh.calls).toEqual([]);
  });

  it("no customer mobile number: not booked live to a locker (the PIN is sent by SMS), named in a dry run; door-to-door never needed one", async () => {
    const emailOnly = ORDER({ customer: { name: "A Customer", email: "a@example.com" } });
    const client = fakeClient();
    const d = db(true);
    expect((await bookShipment(emailOnly, deps(d, client))).reason).toBe("no customer mobile number (the locker PIN is sent by SMS)");
    expectNothingBooked(client, d);
    expect((await bookShipment(emailOnly, deps(db(false), fakeClient()))).liveBlockers).toEqual(["no customer mobile number (the locker PIN is sent by SMS)"]);
    // door-to-door never needed one: the old mode, and the no-locker fallback
    expect((await bookShipment(emailOnly, deps(db(true, { deliveryMode: "door" }), fakeClient()))).waybill).toBe("WB1");
    expect((await bookShipment(emailOnly, deps(db(true), fakeClient({ points: [FAR] })))).deliveryMode).toBe("door");
  });

  it("with live off: a dry run of the door-to-door booking it would be, nothing created, no line for Junid", async () => {
    const client = fakeClient({ points: [FAR] });
    const d = db(false);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res).toMatchObject({ skipped: true, deliveryMode: "door", doorFallback: { kind: "none_near" }, quote: { mode: "door", code: "ECO", rate: 100 }, liveBlockers: [] });
    expect(res.dryRun).not.toHaveProperty("delivery_pickup_point_id");
    expect(res.junidLine).toBeUndefined();
    expectNothingBooked(client, d);
  });

  it("a lost create response on the door-to-door booking holds the claim as unknown, with why it was door on the claim", async () => {
    const d = db(true);
    const client = fakeClient({ points: [FAR], createErrors: { 1: Object.assign(new Error("HTTP 502"), { status: 502 }) } });
    await expect(bookShipment(ORDER(), deps(d, client))).rejects.toThrow(/502/);
    expect(d.root.online_orders["1001"].shipping.courierBooking).toMatchObject({ state: "unknown", ref: "#2257", shipments: 1, doorFallback: { kind: "none_near" } });
    expect(d.root.online_orders["1001"].shipping.courierBooking).not.toHaveProperty("locker");
  });
});

describe("the R500 ceiling, per shipment", () => {
  it("a locker quote over R500 is refused live as before, with the one line; named in a dry run", async () => {
    const client = fakeClient({ lockerRates: d2l(620, 700) });
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res.reason).toBe("quote R620.00 is over the R500 ceiling");
    expect(res.junidLine).toMatch(/#2257: Courier Guy quotes R620\.00 \(D2LM - ECO.*over the R500 ceiling, not booked/);
    expect(client.shipmentCalls()).toEqual([]);
    expect((await bookShipment(ORDER(), deps(db(false), fakeClient({ lockerRates: d2l(620, 700) })))).liveBlockers).toEqual(["quote R620.00 is over the R500 ceiling"]);
  });

  it("three parcels at R130.31 each (R390.93 together) are each under the ceiling: booked", async () => {
    const res = await bookShipment(SPLIT(3), deps(db(true, { maxChargeRand: 200 }), fakeClient()));
    expect(res.waybills).toEqual(["WB1", "WB2", "WB3"]);
  });
});

describe("a split: N one-shoe parcels, each its own shipment to the SAME locker", () => {
  it("ONE shipment per order however many pairs (Junid, 20 Nov 2026); only a person's count splits it", () => {
    expect(lockerParcelCount({}, { parcels: [{ pairs: 0 }] })).toBe(1);
    expect(lockerParcelCount({}, { parcels: [{ pairs: 1 }] })).toBe(1);
    expect(lockerParcelCount({}, { parcels: [{ pairs: 3 }] })).toBe(1);
    expect(lockerParcelCount({}, { parcels: [{ pairs: 5 }] })).toBe(1);
    expect(lockerParcelCount({ shipping: { lockerParcels: 2 } }, { parcels: [{ pairs: 1 }] })).toBe(2);
  });

  it("#2256 / #2309: two and five pairs are ONE create, ONE waybill, the whole order declared as one parcel", async () => {
    for (const qty of [2, 5]) {
      const d = db(true);
      const client = fakeClient();
      const res = await bookShipment(PAIRS(qty), deps(d, client));
      const sent = client.of("createShipment");
      expect(sent).toHaveLength(1);
      expect(sent[0].customer_reference).toBe("#2257");
      expect(sent[0].parcels).toHaveLength(1);
      // not the one-shoe box: the parcel the parcel rule packs the pairs in (so the locker booked is one it fits)
      const p = sent[0].parcels[0];
      expect(p.submitted_length_cm * p.submitted_width_cm * p.submitted_height_cm).toBeGreaterThan(34 * 23 * 13);
      // the price asked is for that same parcel
      expect(client.of("getRates").find((b) => b.delivery_pickup_point_id).parcels).toEqual(sent[0].parcels);
      const s = d.root.online_orders["1001"].shipping;
      expect(s.waybills).toEqual(["WB1"]);
      expect(s.shipments).toHaveLength(1);
      expect(s.parcel).toMatchObject({ declaredAs: "whole_order", parcelCount: 1 });
      expect(res.waybill).toBe("WB1");
    }
  });

  it("one pair with clothes stuffed inside is the M box (one shoe) at its own weight; with goods on top, the L box", () => {
    expect(declaredParcel({}, { parcels: [{ pairs: 1, lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 2.8, overflowBundles: 0 }] })).toEqual({ kind: "oneShoe", size: "M", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 2.8 });
    expect(declaredParcel({}, { parcels: [{ pairs: 1, lengthCm: 34, widthCm: 23, heightCm: 16, actualKg: 2.8, overflowBundles: 1 }] })).toEqual({ kind: "wholeOrder", size: "L", lengthCm: 34, widthCm: 23, heightCm: 16, actualKg: 2.8 });
    expect(declaredParcel({}, { parcels: [{ pairs: 2, lengthCm: 34, widthCm: 23, heightCm: 26, actualKg: 2.4 }] })).toEqual({ kind: "wholeOrder", size: "L", lengthCm: 34, widthCm: 23, heightCm: 26, actualKg: 2.4 });
    // a person's split is one-shoe shipments, whatever the pairs
    expect(declaredParcel({}, { parcels: [{ pairs: 2, lengthCm: 34, widthCm: 23, heightCm: 26, actualKg: 2.4 }] }, 2).kind).toBe("oneShoe");
  });

  it("three pairs: three creates to one locker, every waybill and the total cost recorded, the first as shipping.waybill", async () => {
    const d = db(true);
    const client = fakeClient();
    const res = await bookShipment(SPLIT(3), deps(d, client));
    const sent = client.of("createShipment");
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((b) => b.delivery_pickup_point_id))).toEqual(new Set(["RVM01240"]));
    for (const b of sent) expect(b.parcels).toEqual([{ parcel_description: "Retail", submitted_length_cm: 34, submitted_width_cm: 23, submitted_height_cm: 13, submitted_weight_kg: 1.5 }]);
    expect(sent.map((b) => b.customer_reference)).toEqual(["#2257 (1/3)", "#2257 (2/3)", "#2257 (3/3)"]);
    const s = d.root.online_orders["1001"].shipping;
    expect(s).toMatchObject({ waybill: "WB1", shipmentId: 1001, waybills: ["WB1", "WB2", "WB3"], cost: 390.93, priced: { quoted: 390.93 }, courierBooking: { state: "booked" } });
    expect(s.shipments.map((m) => [m.waybill, m.shipmentId, m.cost])).toEqual([["WB1", 1001, 130.31], ["WB2", 1002, 130.31], ["WB3", 1003, 130.31]]);
    expect(s.parcel).toMatchObject({ parcelCount: 3 });
    expect(s.partial).toBeUndefined();
    expect(res.waybills).toHaveLength(3);
    // ONE claim for the order: a second call books nothing more
    expect((await bookShipment({ ...SPLIT(3), shipping: s }, deps(d, client))).reason).toBe("already booked");
    expect(client.of("createShipment")).toHaveLength(3);
  });

  it("more parcels than locker.maxParcels goes to a person", async () => {
    const client = fakeClient();
    const res = await bookShipment(SPLIT(11), deps(db(true), client));
    expect(res.reason).toMatch(/needs 11 locker parcels, more than the 10 booked automatically/);
    expect(client.shipmentCalls()).toEqual([]);
  });

  it("a later parcel that fails keeps the booked ones; the retry books ONLY the rest, to the same locker", async () => {
    const d = db(true);
    const bad = Object.assign(new Error("HTTP 400 invalid"), { status: 400 });
    const client = fakeClient({ createErrors: { 2: bad } });
    await expect(bookShipment(SPLIT(3), deps(d, client))).rejects.toThrow(/400/);
    let s = d.root.online_orders["1001"].shipping;
    expect(s.waybill).toBeUndefined(); // not "booked": the order is held as courier not booked
    expect(s.courierBooking).toMatchObject({ state: "failed", booked: ["WB1"] });
    expect(s.partial).toMatchObject({ count: 3, locker: { id: "RVM01240" }, shipments: [{ waybill: "WB1" }] });
    // the retry: the nearest locker has changed meanwhile, the split still goes to the first one
    const client2 = fakeClient({ points: [SECOND, NEAR] });
    const res = await bookShipment({ ...SPLIT(3), shipping: { ...SPLIT(3).shipping, ...s } }, deps(d, client2));
    expect(client2.of("createShipment")).toHaveLength(2);
    expect(client2.of("createShipment").every((b) => b.delivery_pickup_point_id === "RVM01240")).toBe(true);
    expect(res.waybills).toEqual(["WB1", "WB1", "WB2"].map((w, i) => (i === 0 ? "WB1" : `WB${i}`)));
    s = d.root.online_orders["1001"].shipping;
    expect(s.partial).toBeUndefined();
    expect(s.courierBooking.state).toBe("booked");
  });

  it("a half-booked split is never finished as a different plan: the mode switched to door books nothing and keeps the checkpoint", async () => {
    const d = db(true);
    const client = fakeClient({ createErrors: { 2: Object.assign(new Error("HTTP 400 invalid"), { status: 400 }) } });
    await expect(bookShipment(SPLIT(3), deps(d, client))).rejects.toThrow(/400/);
    d.root.config.shipping.deliveryMode = "door";
    const client2 = fakeClient();
    const res = await bookShipment({ ...SPLIT(3), shipping: { ...SPLIT(3).shipping, ...d.root.online_orders["1001"].shipping } }, deps(d, client2));
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/a split is half booked \(WB1 to locker RVM01240\) and can no longer be finished as planned/);
    expect(client2.shipmentCalls()).toEqual([]);
    const s = d.root.online_orders["1001"].shipping;
    expect(s.partial).toMatchObject({ shipments: [{ waybill: "WB1" }] });
    expect(s.waybill).toBeUndefined();
  });

  it("booked parcels whose checkpoint cannot be written hold the claim as unknown, even on a 4xx (no blind re-book of parcel 1)", async () => {
    const d = db(true);
    const failing = { ...d, ref: (p) => (String(p).endsWith("/shipping/partial") ? { ...d.ref(p), set: async () => { throw new Error("write denied"); } } : d.ref(p)) };
    const client = fakeClient({ createErrors: { 2: Object.assign(new Error("HTTP 400 invalid"), { status: 400 }) } });
    await expect(bookShipment(SPLIT(2), deps(failing, client))).rejects.toThrow(/400/);
    expect(d.root.online_orders["1001"].shipping.courierBooking).toMatchObject({ state: "unknown", booked: ["WB1"] });
    const again = await bookShipment({ ...SPLIT(2), shipping: { ...SPLIT(2).shipping, ...d.root.online_orders["1001"].shipping } }, deps(d, client));
    expect(again.reason).toBe("booking already unknown");
    expect(client.of("createShipment")).toHaveLength(2);
  });

  it("a lost response mid-split holds the claim as unknown (never re-booked blind)", async () => {
    const d = db(true);
    const client = fakeClient({ createErrors: { 2: Object.assign(new Error("HTTP 502"), { status: 502 }) } });
    await expect(bookShipment(SPLIT(2), deps(d, client))).rejects.toThrow();
    expect(d.root.online_orders["1001"].shipping.courierBooking).toMatchObject({ state: "unknown", booked: ["WB1"] });
    const again = await bookShipment({ ...SPLIT(2), shipping: { ...SPLIT(2).shipping, ...d.root.online_orders["1001"].shipping } }, deps(d, client));
    expect(again.reason).toBe("booking already unknown");
    expect(client.of("createShipment")).toHaveLength(2);
  });

  it("cancelShipment cancels every shipment of a split; a dry run cancels none", async () => {
    const d = db(true);
    const client = fakeClient();
    await bookShipment(SPLIT(3), deps(d, client));
    const booked = { ...SPLIT(3), shipping: d.root.online_orders["1001"].shipping };
    const dry = fakeClient();
    expect((await cancelShipment(booked, deps(db(false), dry))).dryRun).toEqual({ tracking_references: ["WB1", "WB2", "WB3"] });
    expect(dry.shipmentCalls()).toEqual([]);
    await cancelShipment(booked, deps(d, client));
    expect(client.of("cancelShipment")).toEqual(["WB1", "WB2", "WB3"]);
    expect(d.root.online_orders["1001"].shipping.courierBooking.state).toBe("cancelled");
  });
});

describe("THE DRY-RUN GUARD, door-to-locker — nothing reaches createShipment / cancelShipment unless live === true", () => {
  const NOT_LIVE = [undefined, false, null, "true", "yes", 1, 0, {}, []];
  const ORDERS = [
    ["one shoe", ORDER()],
    ["split", SPLIT(4)],
    ["booked split", ORDER({ shipping: { ...ORDER().shipping, provider: "courier_guy", waybill: "WB1", trackingReference: "WB1", shipments: [{ waybill: "WB1" }, { waybill: "WB2" }], deliveryLocker: { id: "RVM01240" } } })],
    ["partial", ORDER({ shipping: { ...ORDER().shipping, partial: { count: 2, locker: { id: "RVM01240" }, shipments: [{ waybill: "WB1", shipmentId: 1 }] } } })],
    ["no locker", ORDER({ shipping: { address: { street: "1 Far Road", city: "Nowhere", zip: "0001" } } })],
  ];
  for (const live of NOT_LIVE) {
    for (const [name, order] of ORDERS) {
      it(`live=${JSON.stringify(live)} · ${name}: book, cancel and rebook make no shipment call and write nothing`, async () => {
        const client = fakeClient(name === "no locker" ? { points: [FAR] } : {});
        const d = db(live, {}, { online_orders: { 1001: order } });
        await bookShipment(order, deps(d, client)).catch(() => {});
        await cancelShipment(order, deps(d, client)).catch(() => {});
        await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW }).catch(() => {});
        expect(client.shipmentCalls()).toEqual([]);
        expect(d.writes).toEqual([]);
      });
    }
  }
});

describe("a locker a person chose (shipping/lockerChoice, lockerAvoid)", () => {
  it("lockerChoice books that locker instead of the nearest, whatever its distance", async () => {
    const order = ORDER({ shipping: { ...ORDER().shipping, lockerChoice: { id: "CG900", by: "rebook" } } });
    const res = await bookShipment(order, deps(db(false), fakeClient()));
    expect(res.deliveryLocker).toMatchObject({ id: "CG900", chosenBy: "rebook" });
  });
  it("a chosen locker that is not online near the address is refused", async () => {
    const order = ORDER({ shipping: { ...ORDER().shipping, lockerChoice: { id: "NOPE1" } } });
    const res = await bookShipment(order, deps(db(false), fakeClient()));
    expect(res.reason).toMatch(/locker NOPE1 is not among the online Courier Guy lockers near Ventersdorp/);
  });
  it("lockerAvoid passes over the named locker", async () => {
    const order = ORDER({ shipping: { ...ORDER().shipping, lockerAvoid: ["RVM01240"] } });
    expect((await bookShipment(order, deps(db(false), fakeClient()))).deliveryLocker.id).toBe("CG648");
  });
});

describe("rebook-locker: cancel the uncollected shipment and book the same parcel(s) to another locker", () => {
  async function bookedWorld(order = ORDER(), live = true) {
    const d = db(true, {}, { online_orders: { 1001: order } });
    await bookShipment(order, deps(d, fakeClient()));
    if (!live) d.root.config.shipping.live = false;
    d.writes.length = 0;
    return d;
  }

  it("the statuses before collection", () => {
    for (const s of ["submitted", "collection-assigned", "collection-unassigned"]) expect(UNCOLLECTED.test(s)).toBe(true);
    for (const s of ["collected", "at-hub", "in-transit", "out-for-delivery", "delivered", "cancelled", ""]) expect(UNCOLLECTED.test(s)).toBe(false);
  });

  it("the default is a dry run: the nearest OTHER locker is priced, nothing cancelled, nothing written", async () => {
    const d = await bookedWorld();
    const client = fakeClient();
    const out = await rebookLocker("1001", { db: d, client, geocoder: geo(), now: () => NOW });
    expect(out).toMatchObject({ ok: true, dryRun: true, from: { id: "RVM01240", waybills: ["WB1"] }, to: { id: "CG648" }, quote: { code: "D2LM - ECO", rate: 130.31 }, shipments: 1 });
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("--book with live on: checks it is uncollected, cancels, keeps the old booking, books the named locker", async () => {
    const d = await bookedWorld();
    const client = fakeClient();
    const out = await rebookLocker("1001", { db: d, client, lockerId: "CG900", book: true, geocoder: geo(), now: () => NOW + 5 });
    expect(out).toMatchObject({ ok: true, to: { id: "CG900" } });
    expect(client.calls.map((c) => c[0]).filter((c) => ["getShipments", "cancelShipment", "createShipment"].includes(c))).toEqual(["getShipments", "cancelShipment", "createShipment"]);
    expect(client.of("cancelShipment")).toEqual(["WB1"]);
    expect(client.of("createShipment")[0]).toMatchObject({ delivery_pickup_point_id: "CG900", parcels: [expect.objectContaining({ submitted_length_cm: 34 })] });
    const s = d.root.online_orders["1001"].shipping;
    expect(s).toMatchObject({ waybill: "WB1", deliveryLocker: { id: "CG900", chosenBy: "rebook" }, courierBooking: { state: "booked" }, lockerChoice: { id: "CG900" } });
    expect(s.cancelledAt).toBeUndefined();
    expect(Object.values(s.rebooks)[0]).toMatchObject({ waybills: ["WB1"], deliveryLocker: { id: "RVM01240" } });
    expect(s.address).toEqual(ORDER().shipping.address);
    expect(d.root.shipping_recon.open["1001"]).toBe(NOW + 5);
  });

  it("a split is rebooked whole: every shipment cancelled, the same number booked again", async () => {
    const d = await bookedWorld(SPLIT(2));
    const client = fakeClient();
    const out = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW + 5 });
    expect(out.ok).toBe(true);
    expect(client.of("cancelShipment")).toEqual(["WB1", "WB2"]);
    expect(client.of("createShipment")).toHaveLength(2);
    expect(d.root.online_orders["1001"].shipping.deliveryLocker.id).toBe("CG648");
  });

  it("--parcels books it again as more one-shoe parcels (Courier Guy refused it as too big for one)", async () => {
    const d = await bookedWorld();
    const client = fakeClient();
    const out = await rebookLocker("1001", { db: d, client, lockerId: "RVM01240", parcels: 2, book: true, geocoder: geo(), now: () => NOW + 5 });
    expect(out.ok).toBe(true);
    expect(client.of("createShipment")).toHaveLength(2);
    expect(d.root.online_orders["1001"].shipping.waybills).toHaveLength(2);
  });

  it("one rebook at a time: a second run while one holds the lock changes nothing; the lock is released after", async () => {
    const d = await bookedWorld();
    d.root.online_orders["1001"].shipping.rebooking = { at: NOW };
    const client = fakeClient();
    const out = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW + 1000 });
    expect(out.reason).toMatch(/another rebook of this order is running/);
    expect(client.shipmentCalls()).toEqual([]);
    // a stale lock (a run that died) is taken over, and a finished run leaves none behind
    const done = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW + 11 * 60_000 });
    expect(done.ok).toBe(true);
    expect(d.root.online_orders["1001"].shipping.rebooking).toBeUndefined();
  });

  it("the replacement is pinned to the locker that was priced: it is recorded as the order's chosen locker", async () => {
    const d = await bookedWorld();
    await rebookLocker("1001", { db: d, client: fakeClient(), book: true, geocoder: geo(), now: () => NOW + 5 });
    expect(d.root.online_orders["1001"].shipping).toMatchObject({ lockerChoice: { id: "CG648", by: "rebook" }, deliveryLocker: { id: "CG648" } });
  });

  it("already collected: refused, nothing cancelled", async () => {
    const d = await bookedWorld();
    const client = fakeClient({ statuses: { WB1: "collected" } });
    const out = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW });
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toMatch(/WB1 is "collected" at Courier Guy/);
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("the new locker cannot be booked: refused BEFORE anything is cancelled", async () => {
    const d = await bookedWorld();
    const client = fakeClient({ points: [NEAR] }); // no other locker near
    const out = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/the new locker cannot be booked: no Courier Guy locker within 30 km/);
    expect(client.shipmentCalls()).toEqual([]);
  });

  it("the new booking fails after the cancel: said plainly, and running it again books only (nothing more is cancelled)", async () => {
    const d = await bookedWorld();
    const bad = Object.assign(new Error("HTTP 400 locker full"), { status: 400 });
    const client = fakeClient({ createErrors: { 1: bad } });
    const failed = await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW + 5 });
    expect(failed).toMatchObject({ ok: false, cancelled: true });
    expect(failed.reason).toMatch(/the old booking is CANCELLED but the new one failed \(HTTP 400 locker full/);
    let s = d.root.online_orders["1001"].shipping;
    expect(s.waybill).toBeUndefined();
    expect(Object.values(s.rebooks)[0]).toMatchObject({ waybills: ["WB1"] });
    // again: a dry run first, then for real
    const client2 = fakeClient();
    expect(await rebookLocker("1001", { db: d, client: client2, geocoder: geo(), now: () => NOW + 9 })).toMatchObject({ ok: true, dryRun: true, resume: true, to: { id: "CG648" } });
    const out = await rebookLocker("1001", { db: d, client: client2, book: true, geocoder: geo(), now: () => NOW + 9 });
    expect(out).toMatchObject({ ok: true, resumed: true, to: { id: "CG648" } });
    expect(client2.of("cancelShipment")).toEqual([]);
    expect(client2.of("createShipment")).toHaveLength(1);
    s = d.root.online_orders["1001"].shipping;
    expect(s).toMatchObject({ provider: "courier_guy", waybill: "WB1", deliveryLocker: { id: "CG648" }, courierBooking: { state: "booked" } });
  });

  it("--book with live off is still a dry run; an order with no locker booking is refused", async () => {
    const d = await bookedWorld(ORDER(), false);
    const client = fakeClient();
    expect(await rebookLocker("1001", { db: d, client, book: true, geocoder: geo(), now: () => NOW })).toMatchObject({ ok: true, dryRun: true });
    expect(client.shipmentCalls()).toEqual([]);
    const plain = db(true, {}, { online_orders: { 1001: ORDER({ shipping: { ...ORDER().shipping, provider: "courier_guy", waybill: "OLD1" } }) } });
    expect((await rebookLocker("1001", { db: plain, client, book: true, geocoder: geo() })).reason).toMatch(/not door-to-locker/);
    expect((await rebookLocker("KQZ", { db: plain, client })).reason).toMatch(/not an \/online_orders key/);
  });
});

describe("the billed-vs-booked adjustment, on the order", () => {
  // runReconcile writes its fan-out through db.ref() (the root).
  const rooted = (d) => ({ ...d, ref: (p) => d.ref(p ?? "") });
  const delivered = (ref, rate, parcel = {}) => ({ short_tracking_reference: ref, status: "delivered", has_been_invoiced: true, rate, charged_weight: 6, service_level_code: "D2LM - ECO", delivered_date: "2026-11-24T09:00:00Z",
    parcels: [{ has_been_dimensioned: true, actual_length_cm: 36, actual_width_cm: 30, actual_height_cm: 22, actual_weight_kg: 2.4, ...parcel }] });
  const shoe = { kind: "oneShoe", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 1.5 };
  const booked = (over = {}) => ({ provider: "courier_guy", waybill: "WB1", trackingReference: "WB1", cost: 130.31, priced: { quoted: 130.31, mode: "door_to_locker" }, bookedAt: NOW, parcel: { declaredAs: "one_shoe", parcels: [shoe] }, ...over });

  it("reconcileOrder: billed − booked with what was declared and what Courier Guy measured; a one-shoe declaration never teaches the parcel table", () => {
    const r = reconcileOrder("1001", { shipping: booked() }, delivered("WB1", 192.72), NOW);
    expect(r.adjustment).toEqual({ booked: 130.31, bookedFrom: "charge", billed: 192.72, diff: 62.41, pct: 47.9, declared: [34, 23, 13, 1.5], measured: [36, 30, 22, 2.4], chargedKg: 6, waybills: ["WB1"], at: NOW });
    expect(r.sample).toBe(null);
    expect(reconcileOrder("1001", { shipping: booked() }, delivered("WB1", 130.31), NOW).adjustment).toMatchObject({ diff: 0, pct: 0 });
    // "booked" is what Courier Guy CHARGED at booking, not the quote: quoted 130.31, charged 150, billed 150 → no adjustment
    expect(reconcileOrder("1001", { shipping: booked({ cost: 150 }) }, delivered("WB1", 150), NOW).adjustment).toMatchObject({ booked: 150, bookedFrom: "charge", diff: 0 });
    // no recorded charge: the quote, and the record says so
    expect(reconcileOrder("1001", { shipping: booked({ cost: null }) }, delivered("WB1", 150), NOW).adjustment).toMatchObject({ booked: 130.31, bookedFrom: "quote", diff: 19.69 });
  });

  it("runReconcile writes shipping/adjustment on the order and lists a non-zero one at /shipping_recon/adjustments/<order>", async () => {
    const d = fakeDb({ shipping_recon: { seededAt: 1, open: { 1001: NOW, 1002: NOW } }, online_orders: { 1001: { shipping: booked() }, 1002: { shipping: booked({ waybill: "WB9", trackingReference: "WB9" }) } } });
    const client = { getShipments: async (q) => ({ shipments: q.tracking_reference ? [delivered(q.tracking_reference, q.tracking_reference === "WB1" ? 192.72 : 130.31)] : [] }) };
    const out = await runReconcile({ db: rooted(d), client, sendJunid: async () => true, now: NOW });
    expect(out).toMatchObject({ reconciled: 2, adjusted: 1 });
    expect(d.root.online_orders["1001"].shipping.adjustment).toMatchObject({ booked: 130.31, billed: 192.72, diff: 62.41, measured: [36, 30, 22, 2.4] });
    expect(d.root.online_orders["1001"].shipping.invoiced).toMatchObject({ rand: 192.72, quoted: 130.31 });
    expect(d.root.shipping_recon.adjustments).toEqual({ 1001: expect.objectContaining({ orderId: "1001", diff: 62.41, waybills: ["WB1"] }) });
    // billed exactly as booked: recorded on the order as zero, not listed
    expect(d.root.online_orders["1002"].shipping.adjustment).toMatchObject({ diff: 0 });
    expect(d.root.shipping_recon.open ?? {}).toEqual({});
    expect(adjustmentLines(Object.values(d.root.shipping_recon.adjustments)).join("\n")).toMatch(/order 1001 {2}WB1 {2}booked R130\.31 {2}billed R192\.72 {2}\+R62\.41 {2}measured 36x30x22 cm 2\.4 kg\n1 adjusted order\(s\), net \+R62\.41/);
  });

  it("a split is reconciled once EVERY shipment is delivered and invoiced, added up, each in parts", async () => {
    const split = booked({ cost: 260.62, priced: { quoted: 260.62 }, waybills: ["WB1", "WB2"], shipments: [{ waybill: "WB1", trackingReference: "WB1", cost: 130.31, quoted: 130.31 }, { waybill: "WB2", trackingReference: "WB2", cost: 130.31, quoted: 130.31 }], parcel: { declaredAs: "one_shoe", parcels: [shoe, shoe] } });
    expect(shipmentsOf(split).map((m) => m.ref)).toEqual(["WB1", "WB2"]);
    const d = fakeDb({ shipping_recon: { seededAt: 1, open: { 1001: NOW } }, online_orders: { 1001: { shipping: split } } });
    let second = { ...delivered("WB2", 130.31), status: "in-transit" };
    const client = { getShipments: async (q) => ({ shipments: q.tracking_reference === "WB1" ? [delivered("WB1", 192.72)] : q.tracking_reference === "WB2" ? [second] : [] }) };
    expect((await runReconcile({ db: rooted(d), client, sendJunid: async () => true, now: NOW })).reconciled).toBe(0);
    expect(d.root.online_orders["1001"].shipping.adjustment).toBeUndefined();
    second = delivered("WB2", 130.31);
    expect((await runReconcile({ db: rooted(d), client, sendJunid: async () => true, now: NOW })).reconciled).toBe(1);
    expect(d.root.online_orders["1001"].shipping.adjustment).toMatchObject({ booked: 260.62, billed: 323.03, diff: 62.41, waybills: ["WB1", "WB2"], parts: [{ waybill: "WB1", diff: 62.41 }, { waybill: "WB2", diff: 0 }] });
    expect(d.root.shipping_recon.diffs.WB1).toMatchObject({ waybill: "WB1", invoiced: 192.72 });
  });
});

describe("placeAddress: the street, else the postal code's own point, else the town", () => {
  const ADDRESS = { street_address: "12 Carmichael Street", local_area: "", city: "Soweto", code: "1804" };
  const hit = (lat, lon) => ({ ok: true, json: async () => [{ lat: String(lat), lon: String(lon) }] });
  const wait = async () => {};

  it("a street on the map is used as it is: no second lookup", async () => {
    const fetchImpl = vi.fn();
    const at = await placeAddress(ADDRESS, { fetchImpl, wait, base: async () => ({ lat: -26.25, lng: 27.9, from: "12 Carmichael Street, Soweto, 1804" }) });
    expect(at).toMatchObject({ lat: -26.25, by: "street" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a street the map does not know is placed by its postal code, not the town's centre", async () => {
    const fetchImpl = vi.fn(async () => hit(-26.262, 27.9175));
    const at = await placeAddress(ADDRESS, { fetchImpl, wait, base: async () => ({ lat: -26.223, lng: 27.89, from: "Soweto, 1804" }) });
    expect(at).toEqual({ lat: -26.262, lng: 27.9175, from: "postal code 1804", by: "postcode" });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/countrycodes=za&limit=5&addressdetails=1&postalcode=1804$/);
  });

  it("no postal-code point (or the lookup fails): the town's; nothing at all: null", async () => {
    const town = async () => ({ lat: -26.223, lng: 27.89, from: "Soweto, 1804" });
    expect(await placeAddress(ADDRESS, { fetchImpl: async () => ({ ok: true, json: async () => [] }), wait, base: town })).toMatchObject({ lat: -26.223, by: "town" });
    const noMatch = await placeAddress(ADDRESS, { fetchImpl: async () => ({ ok: true, json: async () => [] }), wait, base: town });
    expect(noMatch).not.toHaveProperty("postcodeFailed");
    // a lookup that FAILED is marked, so it is never read as "no locker near" (architect review, #984)
    expect(await placeAddress(ADDRESS, { fetchImpl: async () => { throw new Error("down"); }, wait, base: town })).toMatchObject({ by: "town", postcodeFailed: "down" });
    expect(await placeAddress(ADDRESS, { fetchImpl: async () => ({ ok: false, status: 429 }), wait, base: town })).toMatchObject({ by: "town", postcodeFailed: "HTTP 429" });
    expect(await placeAddress({ ...ADDRESS, code: "" }, { fetchImpl: async () => { throw new Error("never"); }, wait, base: async () => null })).toBe(null);
  });

  it("the booking records how the address was placed, and a postal-code placement gets the tighter limit", async () => {
    const res = await bookShipment(ORDER(), deps(db(false), fakeClient(), { geocoder: async () => ({ ...AT, from: "postal code 2710", by: "postcode" }) }));
    expect(res.deliveryLocker.placedBy).toBe("postcode");
    const mid = point("CG777", "Twenty-five away", -26.541, 26.8227);
    const far = await bookShipment(ORDER(), deps(db(false), fakeClient({ points: [mid] }), { geocoder: async () => ({ ...AT, from: "postal code 2710", by: "postcode" }) }));
    // no locker inside the tighter limit: the dry run is the door-to-door booking, the reason kept (Junid, 24 Nov 2026)
    expect(far.doorFallback.reason).toMatch(/within 20 km of Ventersdorp .*; only the postal code could be placed on the map/);
  });
});

describe("planShipment in locker mode is rates and lookups only", () => {
  it("never calls a shipment endpoint, whatever live says", async () => {
    const client = fakeClient();
    const plan = await planShipment(SPLIT(2), { db: db(true), client, geocoder: geo() });
    expect(plan).toMatchObject({ ok: true, locker: { id: "RVM01240" }, doorQuote: { code: "ECO" } });
    expect(plan.payloads).toHaveLength(2);
    expect(client.shipmentCalls()).toEqual([]);
  });
});


describe("the locker box size (Junid, 21 Nov 2026: the smallest real box each parcel fits, priced right up front)", () => {
  const est = (p) => ({ parcels: [p] });
  it("from what Courier Guy measured our parcels at: 1 pair M, 1 pair + goods on top L, 2+ pairs L, no footwear M", () => {
    expect(lockerSizeFor({}, null)).toBe("M");
    expect(lockerSizeFor({}, est({ pairs: 1, lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 1.3, overflowBundles: 0 }))).toBe("M");
    expect(lockerSizeFor({}, est({ pairs: 1, lengthCm: 34, widthCm: 23, heightCm: 19, actualKg: 2.1, overflowBundles: 2 }))).toBe("L");
    expect(lockerSizeFor({}, est({ pairs: 2, lengthCm: 34, widthCm: 23, heightCm: 26, actualKg: 2.4 }))).toBe("L");
    expect(lockerSizeFor({}, est({ pairs: 6, lengthCm: 34, widthCm: 46, heightCm: 39, actualKg: 8 }))).toBe("L");
    // clothes only: never S (half of them measured taller than the S box's 8 cm), even when the estimate is a big box
    expect(lockerSizeFor({}, est({ kind: "flatBag", pairs: 0, lengthCm: 41, widthCm: 34, heightCm: 4, actualKg: 0.4 }))).toBe("M");
    expect(lockerSizeFor({}, est({ kind: "box", pairs: 0, lengthCm: 55, widthCm: 40, heightCm: 35, actualKg: 2 }))).toBe("M");
  });
  it("weight moves it up a box (M takes 10 kg); past 15 kg, or a shoebox stack bigger than L, no locker takes it", () => {
    expect(lockerSizeFor({}, est({ pairs: 0, lengthCm: 40, widthCm: 30, heightCm: 18, actualKg: 11 }))).toBe("L");
    expect(lockerSizeFor({}, est({ pairs: 0, lengthCm: 40, widthCm: 30, heightCm: 18, actualKg: 16 }))).toBeNull();
    expect(lockerSizeFor({}, est({ pairs: 8, lengthCm: 34, widthCm: 46, heightCm: 52, actualKg: 12 }))).toBeNull();
    expect(declaredParcel({}, est({ pairs: 8, lengthCm: 34, widthCm: 46, heightCm: 52, actualKg: 12 }))).toMatchObject({ kind: "tooBig", size: null });
    // one pair with so much on top it is longer than the L box any way round (60 × 41 × 41): no locker, a person books it
    expect(lockerSizeFor({}, est({ pairs: 1, lengthCm: 34, widthCm: 23, heightCm: 62, actualKg: 6, overflowBundles: 8 }))).toBeNull();
  });
  it("the declaration fits its box: a one-shoe override heavier or taller than M is declared L; past 15 kg refused", () => {
    const cfg = (parcel) => ({ locker: { parcel } });
    expect(declaredParcel(cfg({ lengthCm: 34, widthCm: 23, heightCm: 13, kg: 11 }), null)).toMatchObject({ size: "L", actualKg: 11 });
    expect(declaredParcel(cfg({ lengthCm: 34, widthCm: 23, heightCm: 22, kg: 1.5 }), null)).toMatchObject({ size: "L", heightCm: 41 });
    expect(declaredParcel(cfg({ lengthCm: 34, widthCm: 23, heightCm: 13, kg: 16 }), null)).toMatchObject({ kind: "tooBig", size: null });
    expect(declaredParcel({}, null)).toEqual({ kind: "oneShoe", size: "M", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 1.5 });
  });
  it("the service: the cheapest quoted for a box at least the chosen size", () => {
    const rates = [{ code: "D2LXS - ECO", rate: 86.51 }, { code: "D2LS - ECO", rate: 97.46 }, { code: "D2LM - ECO", rate: 130.31 }, { code: "D2LL - ECO", rate: 192.72 }];
    expect(chooseLockerRate(rates, "M").code).toBe("D2LM - ECO");
    expect(chooseLockerRate(rates, "L").code).toBe("D2LL - ECO");
    expect(serviceSize("D2LXS - ECO")).toBe("XS");
    expect(serviceSize("ECO")).toBeNull();
  });
  it("one pair with a cap on top is booked on the L service up front (#2257 was booked M and re-rated to L)", async () => {
    const client = fakeClient();
    const d = db(true);
    const order = ORDER({ lines: [{ category: "Footwear", subcategory: "Sneakers", size: "9", qty: 1 }, { category: "Accessories", subcategory: "Bags", qty: 1 }] });
    await bookShipment(order, deps(d, client));
    expect(client.of("createShipment")[0].service_level_code).toBe("D2LL - ECO");
    expect(d.root.online_orders["1001"].shipping.parcel.lockerSize).toBe("L");
  });
});

// THE FIRST SWEEP (Junid, 24 Nov 2026: "Retry every order that's currently 'courier not booked' for this reason"):
// doorRetryDue picks the orders, retry-no-locker.mjs lists them (--dry, the default) or books them (--commit).
describe("orders already refused for no locker: doorRetryDue and retry-no-locker.mjs", () => {
  const WHY = "no Courier Guy locker within 30 km of Ventersdorp (the nearest, Potchefstroom Mall, is 52.1 km away)";
  const REFUSED = (over = {}, shipping = {}) => {
    const o = ORDER();
    return { ...o, status: "packed", fulfilState: "courier_failed", courierError: WHY, attention: { kind: "courier_failed", reason: `Packed, but Courier Guy was not booked: ${WHY}`, at: 1 }, attentionOpen: true,
      ...over, shipping: { ...o.shipping, booking: { skipped: true, reason: WHY, noLocker: true, at: 1 }, ...shipping } };
  };
  const world = (order, live = true, cfg = {}) => db(live, cfg, { online_orders: { 1001: order } });
  const run = (d, client, over = {}) => retryNoLocker({ db: d, client, orders: { 1001: d.root.online_orders["1001"] }, geocoder: geo(), now: () => NOW, ...over });

  it("due: packed + courier_failed for one of the three no-locker reasons, nothing booked, no claim held, nobody steering, not yet handed back", () => {
    expect(doorRetryDue(REFUSED())).toBe(WHY);
    expect(doorRetryDue(REFUSED({ courierError: "the parcel is bigger or heavier than the largest Courier Guy locker box (L: 60 × 41 × 41 cm, 15 kg)" }))).toMatch(/largest/);
    expect(doorRetryDue(REFUSED({ courierError: "Courier Guy quoted no door-to-locker service to the lockers near Ventersdorp (A, B)" }))).toMatch(/quoted no/);
    for (const not of [
      REFUSED({ courierError: "no Courier Guy locker could be chosen for Ventersdorp: the address could not be placed on the map" }),
      REFUSED({ courierError: "locker CG404 is not among the online Courier Guy lockers near Ventersdorp" }),
      REFUSED({ courierError: "quote R612.00 is over the R500 ceiling" }),
      REFUSED({ courierError: "HTTP 400 bad address" }),
      REFUSED({ fulfilState: "pending" }), REFUSED({ fulfilState: "done" }), REFUSED({ status: "cancelled" }),
      REFUSED({}, { shipmentId: 7 }), REFUSED({}, { waybill: "WB9" }),
      REFUSED({}, { courierBooking: { state: "unknown" } }), REFUSED({}, { courierBooking: { state: "booking" } }),
      REFUSED({}, { doorRetry: { at: 5, by: "tick" } }),
      REFUSED({}, { booking: { skipped: true, noLocker: true, doorTried: true } }),
      REFUSED({}, { lockerChoice: { id: "CG1" } }), REFUSED({}, { lockerAvoid: ["CG1"] }), REFUSED({}, { lockerParcels: 2 }),
      REFUSED({}, { partial: { count: 2, locker: { id: "CG1" }, shipments: [{ waybill: "WB1" }] } }),
    ]) expect(doorRetryDue(not)).toBeNull();
    // a failed claim (a refused create released it) and a rebook's lockerParcels: 1 do not stop it
    expect(doorRetryDue(REFUSED({}, { courierBooking: { state: "failed" }, lockerParcels: 1 }))).toBe(WHY);
  });

  it("the default is a dry run: lists the order with the door-to-door rate quoted now; nothing created, nothing written", async () => {
    const d = world(REFUSED());
    const client = fakeClient({ points: [FAR] });
    const out = await run(d, client);
    expect(out).toMatchObject({ commit: false, rows: [{ key: "1001", ref: "#2257", town: "Ventersdorp", reason: WHY, would: "door-to-door", quote: { code: "ECO", rate: 100 }, blockers: [] }] });
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("the dry run says what would stop it: over the ceiling", async () => {
    const out = await run(world(REFUSED(), true, { maxChargeRand: 99 }), fakeClient({ points: [FAR] }));
    expect(out.rows[0]).toMatchObject({ would: "door-to-door", quote: { rate: 100 }, blockers: ["quote R100.00 is over the R99 ceiling"] });
  });

  it("--commit books it door-to-door through bookShipment, records it, queues Junid's line and hands the order to the ship step", async () => {
    const d = world(REFUSED());
    const client = fakeClient({ points: [FAR] });
    const out = await run(d, client, { commit: true });
    expect(out).toMatchObject({ commit: true, rows: [{ key: "1001", booked: true, waybill: "WB1", mode: "door", service: "ECO" }] });
    expect(client.of("createShipment")).toHaveLength(1);
    expect(client.of("createShipment")[0]).not.toHaveProperty("delivery_pickup_point_id");
    const o = d.root.online_orders["1001"];
    expect(o).toMatchObject({ fulfilState: "pending", fulfil: { state: "pending" }, shipping: { waybill: "WB1", deliveryMode: "door", doorFallback: { kind: "none_near" }, doorRetry: { by: "cli", at: NOW }, booking: { waybill: "WB1" }, courierBooking: { state: "booked" } } });
    expect(o.courierError).toBeUndefined();
    expect(o.attention).toBeUndefined();
    expect(o.shipping.booking.noLocker).toBeUndefined();
    expect(d.root.shipping_recon.junidLines["1001-door"].text).toMatch(/^#2257: booked door-to-door: no Courier Guy locker within 30 km/);
    expect(d.root.shipping_recon.open["1001"]).toBe(NOW);
  });

  it("ONCE: a second --commit (or the tick) finds the claim and books nothing; a refused door booking is not tried again", async () => {
    const d = world(REFUSED(), true, { maxChargeRand: 99 });
    const client = fakeClient({ points: [FAR] });
    const first = await run(d, client, { commit: true });
    expect(first.rows[0]).toMatchObject({ error: "quote R100.00 is over the R99 ceiling" });
    expect(first.rows[0].booked).toBeUndefined();
    expect(client.shipmentCalls()).toEqual([]);
    const o = d.root.online_orders["1001"];
    expect(o).toMatchObject({ fulfilState: "courier_failed", courierError: "quote R100.00 is over the R99 ceiling", shipping: { doorRetry: { by: "cli" } } });
    expect(doorRetryDue(o)).toBeNull();
    // even if it is listed again (a stale list), the claim stops it
    const again = fakeClient({ points: [FAR] });
    const second = await retryNoLocker({ db: d, client: again, orders: { 1001: REFUSED() }, commit: true, geocoder: geo(), now: () => NOW });
    expect(second.rows[0].skipped).toMatch(/already handed back/);
    expect(again.calls).toEqual([]);
  });

  it("--commit with the live switch off is a dry run: nothing booked, nothing claimed", async () => {
    const d = world(REFUSED(), false);
    const client = fakeClient({ points: [FAR] });
    const out = await run(d, client, { commit: true });
    expect(out).toMatchObject({ live: false, commit: false, asked: true, rows: [{ would: "door-to-door" }] });
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it("Junid's condition hold on an exchange stops the hand-back until it is lifted (CodeRabbit, #984)", () => {
    expect(doorRetryDue(REFUSED({ incoming: { conditionHold: { at: 1, by: "junid" } } }))).toBeNull();
    expect(doorRetryDue(REFUSED({ incoming: { conditionHold: null } }))).toBe(WHY);
  });

  it("the once is checked on the order as it is NOW: an order that changed since the listing is never booked (CodeRabbit, #984)", async () => {
    // listed for no locker; meanwhile a person pressed Retry and it failed for another reason
    const d = world(REFUSED({ courierError: "HTTP 400 bad address" }));
    const client = fakeClient({ points: [FAR] });
    const out = await retryNoLocker({ db: d, client, orders: { 1001: REFUSED() }, commit: true, geocoder: geo(), now: () => NOW });
    expect(out.rows[0].skipped).toMatch(/no longer due/);
    expect(client.calls).toEqual([]);
    expect(d.root.online_orders["1001"].shipping.doorRetry).toBeUndefined();
  });

  it("a refused door-to-door try keeps its own record and queues its own line for Junid (CodeRabbit, #984)", async () => {
    const d = world(REFUSED(), true, { maxChargeRand: 99 });
    await run(d, fakeClient({ points: [FAR] }), { commit: true });
    const o = d.root.online_orders["1001"];
    expect(o.shipping.booking).toMatchObject({ skipped: true, noLocker: true, doorTried: true, doorFallback: { kind: "none_near" }, at: NOW });
    expect(d.root.shipping_recon.junidLines["1001-door-refused"].text).toMatch(/door-to-door/);
    expect(d.root.shipping_recon.junidLines["1001-door"]).toBeUndefined();
  });

  it("booked, but the hand-back did not land: the order is due for the hand-back only, which never undoes a later fulfilment (CodeRabbit, #984)", async () => {
    const d = world(REFUSED());
    const client = fakeClient({ points: [FAR] });
    // the hand-back's transaction on the order fails once (network), after the booking was made
    const ref = d.ref.bind(d);
    let broken = true;
    d.ref = (p) => {
      const r = ref(p);
      if (p !== "online_orders/1001") return r;
      return { ...r, transaction: async (fn) => { const cur = (await r.get()).val(); if (broken && cur?.shipping?.waybill) { broken = false; throw new Error("network"); } return r.transaction(fn); } };
    };
    const out = await run(d, client, { commit: true });
    expect(out.rows[0]).toMatchObject({ booked: true, waybill: "WB1", handedBack: false });
    let o = d.root.online_orders["1001"];
    expect(o.fulfilState).toBe("courier_failed");
    expect(doorRetryDue(o)).toBeNull();
    expect(doorHandBackDue(o)).toBe(true);
    // the tick's finish: handed back, nothing booked again
    expect(await handBackBooked(d, "1001", { at: NOW + 1 })).toBe(true);
    o = d.root.online_orders["1001"];
    expect(o).toMatchObject({ fulfilState: "pending", fulfil: { state: "pending" } });
    expect(o.courierError).toBeUndefined();
    expect(client.of("createShipment")).toHaveLength(1);
    // already moved on (pending / done): left exactly as it is
    expect(doorHandBackDue(o)).toBe(false);
    expect(await handBackBooked(d, "1001", { at: NOW + 2 })).toBe(false);
    expect(d.root.online_orders["1001"].updatedAt).toBe(NOW + 1);
  });

  it("an order that is not there for a no-locker reason is not listed; --only narrows to one order", async () => {
    const d = db(true, {}, { online_orders: { 1001: REFUSED(), 1002: { ...REFUSED({ courierError: "HTTP 400 bad address" }), key: "1002" }, 1003: { ...REFUSED(), key: "1003" } } });
    const all = await retryNoLocker({ db: d, client: fakeClient({ points: [FAR] }), orders: d.root.online_orders, geocoder: geo() });
    expect(all.rows.map((r) => r.key)).toEqual(["1001", "1003"]);
    expect(all.failed).toBe(3);
    const one = await retryNoLocker({ db: d, client: fakeClient({ points: [FAR] }), orders: d.root.online_orders, only: "1003", geocoder: geo() });
    expect(one.rows.map((r) => r.key)).toEqual(["1003"]);
  });
});

// Junid's quiet rule (26 Nov 2026): courier-recon lines are held, not WhatsApped.
import { heldSender } from "./courier-recon.mjs";
import { describe as d2, it as i2, expect as e2 } from "vitest";
d2("courier-recon heldSender (quiet rule)", () => {
  i2("holds every line; only an address-hold line needs a decision; counts as delivered", async () => {
    const rows = [];
    const send = heldSender({ append: (r) => rows.push(r) });
    e2(await send("ceiling line", "courier-ceiling-123")).toBe(true);
    e2(await send("address line", "courier-ceiling-123-address")).toBe(true);
    e2(await send("weekly", "courier-week-2026-11-23")).toBe(true);
    e2(rows.map((r) => [r.channel, r.needsDecision])).toEqual([["whatsapp", false], ["whatsapp", true], ["whatsapp", false]]);
  });
});
