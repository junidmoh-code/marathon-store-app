// A booking whose answer was lost ("unknown"), and the #2181 address failures (21 Nov 2026) — fakes only, never the network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bookShipment, isGeocodeRefusal } from "./bookShipment.mjs";
import { lockerAddressPayload, placeAddress } from "./lockerDelivery.mjs";
import { geocode, inProvince, nearestLockers } from "./bookReturn.mjs";
import { CourierHttpError } from "./courier-client.mjs";
import { recheckUnknownBooking, sweepUnknownBookings, matchShipments, UNKNOWN_WAIT_MS } from "./unknownBooking.mjs";
import { shippingOf } from "../shopify/onlineOrders/orderModel.mjs";
import { addressSig } from "../../src/shipping/orderShipment.js";
import { fakeDb } from "./fakeDb.testutil.mjs";

const NOW = Date.parse("2026-11-21T10:50:00Z");
const CLAIM_AT = Date.parse("2026-11-21T10:32:34Z");
const CONTACT = { name: "The Marathon", mobile_number: "0310000000", email: "" };
const GEOCODE_500 = () => new CourierHttpError("POST", "/shipments", 500, "cannot find a latitude/longitude for the address. Try to add more detail to get a more accurate location.");
const LOST_500 = () => new CourierHttpError("POST", "/shipments", 502, "Bad Gateway");

const ADDRESS = { address1: "291 Madobi villge", address2: "Mhangani brickyard", city: "Khomanani", province: "Limpopo", zip: "0933", country: "South Africa", phone: "0730000000" };
const ORDER = (shipping = {}, over = {}) => ({
  orderNumber: 2181, shopifyName: "#2181", shopifyGid: "gid://shopify/Order/1901",
  status: "packed", fulfilState: "courier_failed",
  lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "7", qty: 1 }],
  customer: { name: "A Customer", phone: "0730000000", email: "a@example.com" },
  attention: { kind: "courier_failed", reason: "Packed, but Courier Guy was not booked: booking already unknown", at: CLAIM_AT },
  attentionOpen: true,
  shipping: { address: ADDRESS, ...shipping },
  ...over,
});
const UNKNOWN = (over = {}) => ({ state: "unknown", at: CLAIM_AT, error: "Courier Guy POST /shipments → HTTP 502: Bad Gateway", ...over });
const LOCKER = { id: "CG249", provider: "tcg-locker", name: "Masingita Plaza", address: "First Road, Giyani", km: 30, lat: -23.3, lng: 30.69, tcgAddress: { street_address: "First Road", local_area: "Giyani", city: "Giyani", zone: "LP", code: "0826" } };
const row = (over = {}) => ({ id: 136900001, customer_reference: "#2181", short_tracking_reference: "ABC123", time_created: "2026-11-21T10:32:35.1Z", status: "collection-assigned", service_level_code: "D2LL - ECO", charged_amount: 192.72, ...over });

function listClient(pages) {
  const calls = [];
  // Page i starts at the sum of the earlier pages' lengths; past the last page, an empty one.
  const starts = pages.reduce((acc, p, i) => [...acc, (acc[i] ?? 0) + p.length], [0]);
  return {
    calls,
    getShipments: async (q) => { calls.push(["getShipments", q]); const i = starts.indexOf(q.offset); return { shipments: i >= 0 && i < pages.length ? pages[i] : [] }; },
    createShipment: async () => { throw new Error("the check never creates"); },
    cancelShipment: async () => { throw new Error("the check never cancels"); },
  };
}
const dbWith = (order) => fakeDb({ online_orders: { 1901: order } });
const deps = (d, client, logs = []) => ({ db: d, client, now: () => NOW, log: (l) => logs.push(l) });

let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchSpy.mockRestore());

describe("matchShipments: this order's reference, made since the claim, not cancelled", () => {
  it("matches the reference and a split's (i/n), never another order's or an older or cancelled one", () => {
    const since = CLAIM_AT - 5 * 60_000;
    const rows = [
      row(), row({ id: 2, customer_reference: "#2181 (2/2)" }), row({ id: 3, customer_reference: "#21810" }),
      row({ id: 4, time_created: "2026-11-20T09:00:00Z" }), row({ id: 5, status: "cancelled" }), row({ id: 6, customer_reference: "#2182" }),
    ];
    expect(matchShipments(rows, "#2181", since).map((r) => r.id)).toEqual([136900001, 2]);
  });
});

describe("recheckUnknownBooking", () => {
  it("a shipment Courier Guy DID make is attached: waybill, locker, claim booked, back to the ship flow — nothing created", async () => {
    const order = ORDER({ courierBooking: UNKNOWN({ ref: "#2181", locker: LOCKER, shipments: 1 }) });
    const d = dbWith(order);
    const client = listClient([[row({ customer_reference: "#2001" }), row()]]);
    const res = await recheckUnknownBooking("1901", order, deps(d, client));
    expect(res).toMatchObject({ action: "attached", waybill: "ABC123" });
    const o = d.root.online_orders["1901"];
    expect(o.shipping).toMatchObject({
      provider: "courier_guy", shipmentId: 136900001, waybill: "ABC123", trackingReference: "ABC123", service: "D2LL - ECO", cost: 192.72,
      deliveryMode: "locker", deliveryLocker: { id: "CG249", name: "Masingita Plaza" }, waybills: ["ABC123"],
      courierBooking: { state: "booked", recovered: true },
    });
    expect(o).toMatchObject({ fulfilState: "pending", fulfil: { state: "pending" } });
    expect(o.attention).toBeUndefined();
    expect(o.attentionOpen).toBeUndefined();
    expect(d.root.shipping_recon.open["1901"]).toBe(NOW);
    // Listed from the day before the claim (SAST), every page.
    expect(client.calls[0][1]).toMatchObject({ limit: 100, offset: 0, start_date: "2026-11-20" });
  });

  it("none yet, inside 10 minutes: waits — the claim is not touched", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, { ...deps(d, listClient([[]])), now: () => CLAIM_AT + 3 * 60_000 });
    expect(res.action).toBe("wait");
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("unknown");
    expect(d.writes).toHaveLength(0);
  });

  it("none after 10 minutes: the claim is released and the order handed back for ONE re-book", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[row({ customer_reference: "#2180" })]])));
    expect(res.action).toBe("rebook");
    const o = d.root.online_orders["1901"];
    expect(o.shipping.courierBooking).toMatchObject({ state: "failed", released: "no shipment at Courier Guy" });
    expect(o.shipping.unknownRecheck).toMatchObject({ rebooks: 1, claimAt: CLAIM_AT });
    expect(o.fulfilState).toBe("pending");
  });

  it("after one automatic re-book, a second unknown is never re-booked again: the reason stays on the order", async () => {
    const order = ORDER({ courierBooking: UNKNOWN(), unknownRecheck: { rebooks: 1, at: CLAIM_AT - 3600_000 } });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[]])));
    expect(res.action).toBe("gave_up");
    const o = d.root.online_orders["1901"];
    expect(o.shipping.courierBooking.state).toBe("unknown");
    expect(o.fulfilState).toBe("courier_failed");
    expect(o.attention.reason).toMatch(/no shipment for #2181 at Courier Guy, after one automatic re-book/);
    expect(o.attention.reason).not.toMatch(/portal/i);
  });

  it("never double-books: a claim that moved on since the list (another sweeper) is left alone", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith({ ...order, shipping: { ...order.shipping, courierBooking: { state: "booking", at: NOW - 1000 } } });
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[]])));
    expect(res.action).toBe("raced");
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("booking");
    expect(d.root.online_orders["1901"].fulfilState).toBe("courier_failed");
  });

  it("the Admin SDK's cold first pass (null) neither aborts nor writes: the claim is released on the real value", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const real = d.ref.bind(d);
    // RTDB Admin: the update function is first called with null (nothing cached), then with the server's value.
    d.ref = (path) => {
      const r = real(path);
      return { ...r, transaction: async (fn) => { if (fn(null) === undefined) return { committed: false, snapshot: { val: () => null } }; return r.transaction(fn); } };
    };
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[]])));
    expect(res.action).toBe("rebook");
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("failed");
  });

  it("a claim that is not unknown, or an order with a waybill, is never looked at", async () => {
    const client = listClient([[row()]]);
    expect((await recheckUnknownBooking("1901", ORDER({ courierBooking: { state: "failed", at: CLAIM_AT } }), deps(dbWith(ORDER()), client))).action).toBe("none");
    expect((await recheckUnknownBooking("1901", ORDER({ courierBooking: UNKNOWN(), waybill: "X" }), deps(dbWith(ORDER()), client))).action).toBe("none");
    expect(client.calls).toHaveLength(0);
  });

  it("the sweep checks only courier_failed orders with an unknown claim", async () => {
    const client = listClient([[row()]]);
    const orders = {
      1901: ORDER({ courierBooking: UNKNOWN({ locker: LOCKER }) }),
      1902: ORDER({ courierBooking: { state: "failed", at: CLAIM_AT } }, { shopifyName: "#2182" }),
    };
    const d = fakeDb({ online_orders: orders });
    const out = await sweepUnknownBookings({ ...deps(d, client), orders });
    expect(out).toEqual([expect.objectContaining({ key: "1901", action: "attached" })]);
  });
});

// ── the create itself ─────────────────────────────────────────────────────────
const AT = { lat: -23.2624, lng: 30.3969 };
const point = (id, name, lat, lng) => ({
  pickup_point_id: id, pickup_point_provider: "tcg-locker", name, type: "locker", lat, lng,
  address: { street_address: "First Road", local_area: "Giyani", city: "Giyani", zone: "Limpopo", code: "0826" },
  available_compartment_sizes: ["V4-L", "V4-M"], status: "online",
});
const GIYANI = point("CG249", "Masingita Plaza", -23.2700, 30.4000); // ~1 km from AT
function bookingClient({ createErrors = [] } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    creates: () => calls.filter((c) => c[0] === "createShipment").map((c) => c[1]),
    getRates: async (body) => { calls.push(["getRates", body]); return { rates: [{ rate: 192.72, service_level: { code: "D2LL - ECO", name: "Door to locker large" }, charged_weight: 3 }] }; },
    getPickupPoints: async (q) => { calls.push(["getPickupPoints", q]); return { pickup_points: [GIYANI] }; },
    createShipment: async (body) => {
      calls.push(["createShipment", body]);
      const err = createErrors[n++];
      if (err) throw err;
      return { id: 5000 + n, short_tracking_reference: `WB${n}`, service_level_code: body.service_level_code, charged_amount: 192.72 };
    },
    cancelShipment: async () => { throw new Error("never"); },
  };
}
const liveDb = (order) => fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT } }, online_orders: { 1901: order } });
const bookDeps = (d, client, logs = []) => ({ db: d, client, geocoder: async () => ({ ...AT, from: "291 Madobi villge, Mhangani brickyard, Khomanani, 0933", by: "street" }), log: (l) => logs.push(l), now: () => NOW });
const FRESH = () => ORDER({}, { fulfilState: "pending", attention: undefined, attentionOpen: undefined });

describe("a geocode 500 is a definite refusal: the locker's own address, once", () => {
  it("isGeocodeRefusal tells Courier Guy's map failure from a lost answer", () => {
    expect(isGeocodeRefusal(GEOCODE_500())).toBe(true);
    expect(isGeocodeRefusal(LOST_500())).toBe(false);
    expect(isGeocodeRefusal(new Error("socket hang up"))).toBe(false);
  });

  it("the create is sent once more with the locker's address and point, and books — the customer stays the contact", async () => {
    const d = liveDb(FRESH());
    const client = bookingClient({ createErrors: [GEOCODE_500()] });
    const res = await bookShipment({ ...FRESH(), key: "1901" }, bookDeps(d, client));
    expect(client.creates()).toHaveLength(2);
    const [first, second] = client.creates();
    expect(first.delivery_address.street_address).toBe("291 Madobi villge, Mhangani brickyard");
    expect(second.delivery_address).toMatchObject({ type: "business", company: "Masingita Plaza", street_address: "First Road", city: "Giyani", zone: "LP", lat: -23.27, lng: 30.4 });
    expect(second).toMatchObject({ delivery_pickup_point_id: "CG249", delivery_contact: first.delivery_contact, customer_reference: "#2181" });
    expect(res).toMatchObject({ waybill: "WB2", deliveryAddressFallback: "locker", deliveryLocker: { id: "CG249" } });
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("booked");
  });

  it("refused again with the locker's address: a definite failure (\"failed\", free to retry), never \"unknown\"", async () => {
    const d = liveDb(FRESH());
    const client = bookingClient({ createErrors: [GEOCODE_500(), GEOCODE_500()] });
    await expect(bookShipment({ ...FRESH(), key: "1901" }, bookDeps(d, client))).rejects.toThrow(/latitude\/longitude/);
    expect(client.creates()).toHaveLength(2);
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("failed");
  });

  it("a lost answer (502) is still \"unknown\", and records the reference and locker for the check", async () => {
    const d = liveDb(FRESH());
    const client = bookingClient({ createErrors: [LOST_500()] });
    await expect(bookShipment({ ...FRESH(), key: "1901" }, bookDeps(d, client))).rejects.toThrow(/502/);
    expect(client.creates()).toHaveLength(1);
    expect(d.root.online_orders["1901"].shipping.courierBooking).toMatchObject({ state: "unknown", ref: "#2181", shipments: 1, locker: { id: "CG249" } });
  });

  it("lockerAddressPayload: null without a locker address", () => {
    expect(lockerAddressPayload({ delivery_address: {} }, { name: "x" })).toBe(null);
  });
});

describe("placing the customer (#2181: a Limpopo customer was placed in Cape Town)", () => {
  const LP = { street_address: "291 Madobi villge, Mhangani brickyard", local_area: "Mhangani brickyard", city: "Khomanani", zone: "LP", code: "0933" };
  const capeTown = { lat: "-34.058", lon: "18.667", class: "amenity", display_name: "Khomanani, Phamba Street, Khayelitsha, Cape Town, Western Cape, 7748, South Africa", address: { state: "Western Cape" } };
  const street = { lat: "-23.88", lon: "30.29", class: "highway", display_name: "Khomanani Street, Nkowankowa, Limpopo, 0859, South Africa", address: { state: "Limpopo" } };

  it("inProvince refuses a hit in another province", () => {
    expect(inProvince(capeTown, LP)).toBe(false);
    expect(inProvince(street, LP)).toBe(true);
    expect(inProvince(capeTown, { ...LP, zone: "" })).toBe(true);
  });

  it("geocode never returns a point outside the province, nor a street for the town", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const asked = [];
      const fetchImpl = async (url) => { asked.push(decodeURIComponent(url.split("q=")[1])); return { ok: true, json: async () => [capeTown, street] }; };
      const p = geocode(LP, { fetchImpl });
      await vi.runAllTimersAsync();
      // The street try would take the Limpopo street; the first label is the full street, so it is used for it only.
      const at = await p;
      expect(at).toMatchObject({ lat: -23.88 });
      expect(at.from).toMatch(/^291 Madobi villge/);
      // Wider tries: only places in the province — both hits refused.
      const asked2 = [];
      const fetch2 = async (url) => { asked2.push(decodeURIComponent(url.split("q=")[1])); return { ok: true, json: async () => (asked2.length === 1 ? [] : [capeTown, street]) }; };
      const p2 = geocode(LP, { fetchImpl: fetch2 });
      await vi.runAllTimersAsync();
      expect(await p2).toBe(null);
      expect(asked2.at(-1)).toBe("Khomanani, Limpopo");
    } finally { vi.useRealTimers(); }
  });

  it("Shopify's point (shipping/geo) is used first, and only for the address it was made for", async () => {
    const geo = shippingOf({ shippingAddress: { ...ADDRESS, latitude: -23.2624211, longitude: 30.396869, coordinatesValidated: true } }).geo;
    expect(geo).toEqual({ lat: -23.2624211, lng: 30.396869, sig: addressSig(ADDRESS) });
    expect(shippingOf({ shippingAddress: { ...ADDRESS, latitude: -23.2, longitude: 30.3, coordinatesValidated: false } }).geo).toBeUndefined();
    const geocoder = vi.fn(async () => null);
    const d = fakeDb({ config: { shipping: { live: false, collectionContact: CONTACT } }, online_orders: { 1901: FRESH() } });
    const client = bookingClient();
    const res = await bookShipment({ ...ORDER({ geo }, { fulfilState: "pending" }), key: "1901" }, { ...bookDeps(d, client), geocoder });
    expect(geocoder).not.toHaveBeenCalled();
    expect(res.deliveryLocker).toMatchObject({ id: "CG249", placedBy: "shopify" });
    // The address changed since: Shopify's point is not the customer's any more.
    const moved = await bookShipment({ ...ORDER({ geo, address: { ...ADDRESS, address1: "5 Other Road" } }, { fulfilState: "pending" }), key: "1901" }, { ...bookDeps(d, client), geocoder });
    expect(geocoder).toHaveBeenCalledTimes(1);
    expect(moved.reason).toMatch(/could not be placed on the map/);
  });

  it("placeAddress takes a geo first; the postal-code lookup ignores a point in another province", async () => {
    expect(await placeAddress(LP, { geo: { lat: -23.26, lng: 30.39 }, base: async () => { throw new Error("never"); } })).toMatchObject({ by: "shopify" });
    const fetchImpl = async () => ({ ok: true, json: async () => [capeTown] });
    expect(await placeAddress(LP, { fetchImpl, wait: async () => {}, base: async () => null })).toBe(null);
  });

  it("nearestLockers asks out to the limit when Courier Guy's own radius finds nothing", async () => {
    const asked = [];
    const client = { getPickupPoints: async (q) => { asked.push(q); return q.max_distance ? { pickup_points: [GIYANI] } : { pickup_points: null, count: 0 }; } };
    const list = await nearestLockers(client, AT, "L", { maxKm: 30 });
    expect(list.map((l) => l.id)).toEqual(["CG249"]);
    expect(asked[1]).toMatchObject({ max_distance: 30 });
  });
});

describe("the unknown wait", () => {
  it("is ten minutes", () => expect(UNKNOWN_WAIT_MS).toBe(600_000));
});
