// A booking whose answer was lost ("unknown"), and the #2181 address failures (21 Nov 2026) — fakes only, never the network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bookShipment, isGeocodeRefusal } from "./bookShipment.mjs";
import { lockerAddressPayload, placeAddress, pointInProvince } from "./lockerDelivery.mjs";
import { geocode, inProvince, nearestLockers } from "./bookReturn.mjs";
import { CourierHttpError } from "./courier-client.mjs";
import { recheckUnknownBooking, sweepUnknownBookings, matchShipments, findShipments, lateShipmentCheck, UNKNOWN_WAIT_MS, RELEASED_PATH } from "./unknownBooking.mjs";
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
// As bookShipment writes it since this change: the reference and the shipment count are on the claim.
const UNKNOWN = (over = {}) => ({ state: "unknown", at: CLAIM_AT, error: "Courier Guy POST /shipments → HTTP 502: Bad Gateway", ref: "#2181", shipments: 1, ...over });
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
const dbWith = (order, live = true) => fakeDb({ config: { shipping: { live } }, online_orders: { 1901: order } });
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
  it("a door-to-door booking made because there was no locker is attached as door, keeps why on the claim, and queues Junid's door line once (CodeRabbit, #984)", async () => {
    const fb = { reason: "no Courier Guy locker within 30 km of Khomanani", kind: "none_near" };
    const order = ORDER({ courierBooking: UNKNOWN({ ref: "#2181", shipments: 1, doorFallback: fb }) });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[row({ service_level_code: "ECO", charged_amount: 185 })]])));
    expect(res).toMatchObject({ action: "attached", waybill: "ABC123" });
    const s = d.root.online_orders["1901"].shipping;
    expect(s).toMatchObject({ deliveryMode: "door", doorFallback: { ...fb, at: NOW }, courierBooking: { state: "booked", recovered: true } });
    expect(s).not.toHaveProperty("deliveryLocker");
    expect(d.root.shipping_recon.junidLines["1901-door"]).toMatchObject({ orderId: "1901", at: NOW });
    expect(d.root.shipping_recon.junidLines["1901-door"].text).toBe("#2181: booked door-to-door: no Courier Guy locker within 30 km of Khomanani. ECO R185.00, waybill ABC123.");
  });

  it("the booked claim keeps the door-to-door reason even when the order's own write fails (CodeRabbit, #984)", async () => {
    const fb = { reason: "no Courier Guy locker within 30 km of Khomanani", kind: "none_near" };
    const order = ORDER({ courierBooking: UNKNOWN({ ref: "#2181", shipments: 1, doorFallback: fb }) });
    const d = dbWith(order);
    const ref = d.ref;
    d.ref = (p) => (p === "online_orders/1901" ? { ...ref(p), update: async () => { throw new Error("network"); } } : ref(p));
    await expect(recheckUnknownBooking("1901", order, deps(d, listClient([[row()]])))).rejects.toThrow(/network/);
    expect(d.root.online_orders["1901"].shipping.courierBooking).toMatchObject({ state: "booked", waybill: "ABC123", doorFallback: fb });
  });

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
    expect(o.shipping.unknownRecheck).toMatchObject({ releasedAt: NOW, claimAt: CLAIM_AT });
    expect(o.fulfilState).toBe("pending");
    // The late look for a create that lands after all.
    expect(d.root.shipping_recon.unknownReleased["1901"]).toMatchObject({ ref: "#2181", claimAt: CLAIM_AT, wanted: 1 });
  });

  it("after one automatic re-book, a second unknown is never re-booked again: the reason stays on the order", async () => {
    const order = ORDER({ courierBooking: UNKNOWN({ released: "no shipment at Courier Guy", rebooks: 1 }) });
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
    // No typed province: the postal code (0933, Limpopo) still judges; with neither, nothing is judged.
    expect(inProvince(capeTown, { ...LP, zone: "" })).toBe(false);
    expect(inProvince(capeTown, { ...LP, zone: "", code: "" })).toBe(true);
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
    // The real placeAddress, with OpenStreetMap answering: the reverse lookup puts the point in Limpopo; nothing else is known.
    const limpopo = async (url) => ({ ok: true, json: async () => (url.includes("/reverse") ? { address: { state: "Limpopo" }, display_name: "Greater Giyani, Limpopo" } : []) });
    const asked = [];
    const geocoder = async (a, o) => { asked.push(o ?? null); return placeAddress(a, { ...(o ?? {}), fetchImpl: limpopo, wait: async () => {}, base: async () => null }); };
    const d = fakeDb({ config: { shipping: { live: false, collectionContact: CONTACT } }, online_orders: { 1901: FRESH() } });
    const client = bookingClient();
    const res = await bookShipment({ ...ORDER({ geo }, { fulfilState: "pending" }), key: "1901" }, { ...bookDeps(d, client), geocoder });
    expect(asked[0]).toEqual({ geo: { lat: -23.2624211, lng: 30.396869 } });
    expect(res.deliveryLocker).toMatchObject({ id: "CG249", placedBy: "shopify" });
    // The address changed since: Shopify's point is not the customer's any more.
    const moved = await bookShipment({ ...ORDER({ geo, address: { ...ADDRESS, address1: "5 Other Road" } }, { fulfilState: "pending" }), key: "1901" }, { ...bookDeps(d, client), geocoder });
    expect(asked[1]).toBe(null);
    expect(moved.reason).toMatch(/could not be placed on the map/);
  });

  it("placeAddress takes a geo first; the postal-code lookup ignores a point in another province", async () => {
    // The reverse lookup failing (the network) does not throw the point away: Shopify validated it.
    expect(await placeAddress(LP, { geo: { lat: -23.26, lng: 30.39 }, fetchImpl: async () => { throw new Error("down"); }, base: async () => { throw new Error("never"); } })).toMatchObject({ by: "shopify" });
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

// ── the architect review of #956 ──────────────────────────────────────────────
describe("splits: the parcels an earlier attempt booked are never booked again (B1)", () => {
  const P1 = { shipmentId: 136900000, waybill: "P1WB", trackingReference: "P1WB", service: "D2LM - ECO", cost: 130.31 };
  const split = (rows) => {
    const order = ORDER({ courierBooking: UNKNOWN({ shipments: 2, locker: LOCKER, booked: ["P1WB"] }), partial: { count: 2, locker: LOCKER, shipments: [P1], at: CLAIM_AT - 60_000 }, lockerParcels: 2 });
    return { order, d: dbWith(order), client: listClient([rows]) };
  };

  it("parcel 1 booked earlier (before the claim window) + parcel 2 found → BOTH attached, nothing re-booked", async () => {
    const { order, d, client } = split([row({ id: 136900002, customer_reference: "#2181 (2/2)", short_tracking_reference: "P2WB" })]);
    const res = await recheckUnknownBooking("1901", order, deps(d, client));
    expect(res).toMatchObject({ action: "attached", waybills: ["P1WB", "P2WB"] });
    const s = d.root.online_orders["1901"].shipping;
    expect(s).toMatchObject({ waybill: "P1WB", waybills: ["P1WB", "P2WB"], shipmentId: 136900000 });
    expect(s.partial).toBeUndefined();
    expect(s.shipments.map((m) => m.waybill)).toEqual(["P1WB", "P2WB"]);
  });

  it("parcel 1 listed AGAIN by Courier Guy (same id) counts once", async () => {
    const { order, d, client } = split([
      row({ id: 136900000, customer_reference: "#2181 (1/2)", short_tracking_reference: "P1WB" }),
      row({ id: 136900002, customer_reference: "#2181 (2/2)", short_tracking_reference: "P2WB" }),
    ]);
    expect((await recheckUnknownBooking("1901", order, deps(d, client))).waybills).toEqual(["P1WB", "P2WB"]);
  });

  it("parcel 2 NOT found: the checkpoint keeps parcel 1 and bookShipment books only parcel 2", async () => {
    const { order, d, client } = split([]);
    const res = await recheckUnknownBooking("1901", order, { ...deps(d, client), now: () => NOW });
    expect(res.action).toBe("rebook");
    // The checkpoint is untouched (parcel 1 still on it): bookShipment's retry starts at parcel 2.
    expect(d.root.online_orders["1901"].shipping.partial.shipments.map((m) => m.waybill)).toEqual(["P1WB"]);
  });
});

describe("the shipment list is believed only when it IS a list (B2)", () => {
  const since = CLAIM_AT - 5 * 60_000;
  it("an answer without a shipments array throws — never read as \"no shipment\"", async () => {
    for (const body of [null, {}, { shipments: null }, { message: "Internal error" }, "oops"]) {
      await expect(findShipments({ getShipments: async () => body }, "#2181", since)).rejects.toThrow(/without a shipments list/);
    }
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const res = await sweepUnknownBookings({ ...deps(d, { getShipments: async () => ({ error: "x" }) }), orders: { 1901: order } });
    expect(res[0].action).toBe("error");
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("unknown");
  });

  it("the page cap reached with the last page still full throws", async () => {
    let n = 0;
    const client = { getShipments: async () => ({ shipments: [row({ id: ++n, customer_reference: "#9" })] }) };
    await expect(findShipments(client, "#2181", since, { maxPages: 3 })).rejects.toThrow(/did not end within 3 pages/);
  });

  it("an ignored offset (the same page again) throws instead of reading page 1 twenty times", async () => {
    const client = { getShipments: async () => ({ shipments: [row({ id: 1, customer_reference: "#9" }), row({ id: 2, customer_reference: "#8" })] }) };
    await expect(findShipments(client, "#2181", since)).rejects.toThrow(/offset ignored/);
  });

  it("pages are read by offset until an empty one", async () => {
    const client = listClient([[row({ id: 1, customer_reference: "#9" })], [row({ id: 2 })]]);
    expect((await findShipments(client, "#2181", since)).map((s) => s.id)).toEqual([2]);
    expect(client.calls.map((c) => c[1].offset)).toEqual([0, 1, 2]);
  });

  it("a row of this order with an unreadable time_created is an error, not a silent drop", () => {
    expect(() => matchShipments([row({ time_created: "garbage" })], "#2181", since)).toThrow(/no readable time_created/);
    // Another order's odd row is not this order's business.
    expect(matchShipments([row({ customer_reference: "#1", time_created: "garbage" })], "#2181", since)).toEqual([]);
  });

  it("#1941 never matches #1941-EX, and the other way round", () => {
    const rows = [row({ id: 1, customer_reference: "#1941" }), row({ id: 2, customer_reference: "#1941-EX" }), row({ id: 3, customer_reference: "#1941-EX (1/2)" })];
    expect(matchShipments(rows, "#1941", since).map((r) => r.id)).toEqual([1]);
    expect(matchShipments(rows, "#1941-EX", since).map((r) => r.id)).toEqual([2, 3]);
  });

  it("a cancelled shipment and a newer valid one: only the valid one counts", async () => {
    const order = ORDER({ courierBooking: UNKNOWN({ locker: LOCKER }) });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[row({ id: 1, short_tracking_reference: "OLD1", status: "cancelled" }), row({ id: 2, short_tracking_reference: "NEW2", time_created: "2026-11-21T10:33:00Z" })]])));
    expect(res).toMatchObject({ action: "attached", waybill: "NEW2" });
  });
});

describe("never guessed, never spent for nothing (should-fix)", () => {
  it("live off: nothing released, the order left as it is", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order, false);
    expect((await recheckUnknownBooking("1901", order, deps(d, listClient([[]])))).action).toBe("live_off");
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("unknown");
    expect(d.root.online_orders["1901"].fulfilState).toBe("courier_failed");
  });

  it("more shipments than the order needs → attention, nothing attached", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[row({ id: 1, short_tracking_reference: "A1" }), row({ id: 2, short_tracking_reference: "B2" })]])));
    expect(res.action).toBe("attention");
    const o = d.root.online_orders["1901"];
    expect(o.attention.reason).toMatch(/2 shipments for #2181 .*A1, B2.*possibly booked twice/);
    expect(o.shipping.waybill).toBeUndefined();
    expect(o.shipping.courierBooking.state).toBe("unknown");
  });

  it("a claim written before this change (no shipment count) goes to attention, never attached on a guess", async () => {
    const order = ORDER({ courierBooking: { state: "unknown", at: CLAIM_AT, error: "HTTP 502" } });
    const d = dbWith(order);
    const res = await recheckUnknownBooking("1901", order, deps(d, listClient([[row()]])));
    expect(res.action).toBe("attention");
    expect(d.root.online_orders["1901"].attention.reason).toMatch(/Courier Guy shows ABC123 for #2181/);
    expect(d.root.online_orders["1901"].shipping.waybill).toBeUndefined();
  });

  it("the attach crash: the claim already carries the waybill when the order's write fails", async () => {
    const order = ORDER({ courierBooking: UNKNOWN() });
    const d = dbWith(order);
    const real = d.ref.bind(d);
    d.ref = (path) => (path === "online_orders/1901" ? { ...real(path), update: async () => { throw new Error("connection lost"); } } : real(path));
    await expect(recheckUnknownBooking("1901", order, deps(d, listClient([[row()]])))).rejects.toThrow(/connection lost/);
    // bookShipment's "booked but not recorded" shape: nothing books it again, and shipOrder ships with this waybill.
    expect(d.root.online_orders["1901"].shipping.courierBooking).toMatchObject({ state: "booked", waybill: "ABC123", shipmentId: 136900001 });
  });

  it("the late look: a create that landed after the release makes a second shipment → attention", async () => {
    const d = fakeDb({ online_orders: { 1901: ORDER({ waybill: "NEW2", courierBooking: { state: "booked", at: NOW } }, { fulfilState: "done", attention: undefined, attentionOpen: undefined }) }, shipping_recon: { unknownReleased: { 1901: { ref: "#2181", claimAt: CLAIM_AT, releasedAt: NOW - 31 * 60_000, wanted: 1 } } } });
    const out = await lateShipmentCheck({ ...deps(d, listClient([[row({ id: 1, short_tracking_reference: "LATE1" }), row({ id: 2, short_tracking_reference: "NEW2" })]])) });
    expect(out).toEqual([{ key: "1901", action: "double" }]);
    expect(d.root.online_orders["1901"].attention.reason).toMatch(/2 shipments for #2181 .*LATE1, NEW2.*double booking/);
    expect(d.root.shipping_recon.unknownReleased?.["1901"]).toBeUndefined();
  });
});

describe("the re-book is counted only when it reaches a create", () => {
  const RELEASED = (over = {}) => ({ state: "failed", at: NOW - 1000, released: "no shipment at Courier Guy", rebooks: 0, ...over });
  it("a released claim re-booked and lost again → rebooks 1 on the unknown claim → no third booking", async () => {
    const o = FRESH(); o.shipping.courierBooking = RELEASED();
    const d = liveDb(o);
    const client = bookingClient({ createErrors: [LOST_500()] });
    await expect(bookShipment({ ...o, key: "1901" }, bookDeps(d, client))).rejects.toThrow(/502/);
    const claim = d.root.online_orders["1901"].shipping.courierBooking;
    expect(claim).toMatchObject({ state: "unknown", rebooks: 1 });
    const after = { ...d.root.online_orders["1901"], fulfilState: "courier_failed" };
    const res = await recheckUnknownBooking("1901", after, { ...deps(d, listClient([[]])), now: () => Number(claim.at) + UNKNOWN_WAIT_MS + 1 });
    expect(res.action).toBe("gave_up");
  });

  it("a re-book refused before any create (ceiling) spends nothing: the claim stays released with rebooks 0", async () => {
    const o = FRESH(); o.shipping.courierBooking = RELEASED();
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT, maxChargeRand: 100 } }, online_orders: { 1901: o } });
    const client = bookingClient();
    const res = await bookShipment({ ...o, key: "1901" }, bookDeps(d, client));
    expect(res.skipped).toBe(true);
    expect(client.creates()).toHaveLength(0);
    expect(d.root.online_orders["1901"].shipping.courierBooking).toMatchObject({ state: "failed", rebooks: 0 });
  });
});

describe("the address fallback is decided once per order", () => {
  it("a split: parcel 1 refused then sent to the locker's address; parcel 2 goes straight to the locker's address", async () => {
    const o = FRESH(); o.shipping.lockerParcels = 2;
    const d = liveDb(o);
    const client = bookingClient({ createErrors: [GEOCODE_500()] });
    await bookShipment({ ...o, key: "1901" }, bookDeps(d, client));
    const c = client.creates();
    expect(c).toHaveLength(3);
    expect(c.map((b) => b.delivery_address.company)).toEqual(["", "Masingita Plaza", "Masingita Plaza"]);
  });

  it("door-to-door: a geocode 500 is \"failed\" after ONE create (no locker to fall back to) — attention, no loop", async () => {
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT, deliveryMode: "door" } }, online_orders: { 1901: FRESH() } });
    const client = { ...bookingClient({ createErrors: [GEOCODE_500()] }) };
    client.getRates = async () => ({ rates: [{ rate: 120, service_level: { code: "ECO", name: "Economy" }, charged_weight: 2 }] });
    await expect(bookShipment({ ...FRESH(), key: "1901" }, bookDeps(d, client))).rejects.toThrow(/latitude/);
    expect(client.creates()).toHaveLength(1);
    expect(d.root.online_orders["1901"].shipping.courierBooking.state).toBe("failed");
  });
});

describe("Shopify's point in the wrong province is not used (should-fix 5)", () => {
  const LP = { street_address: "1 X", city: "Khomanani", zone: "LP", code: "0933" };
  it("pointInProvince: false for a Western Cape point on a Limpopo order; placeAddress then falls back", async () => {
    const wc = async () => ({ ok: true, json: async () => ({ address: { state: "Western Cape" }, display_name: "Cape Town, Western Cape" }) });
    expect(await pointInProvince({ lat: -34, lng: 18.6 }, LP, { fetchImpl: wc })).toBe(false);
    const at = await placeAddress(LP, { geo: { lat: -34, lng: 18.6 }, fetchImpl: wc, wait: async () => {}, base: async () => ({ lat: -23.3, lng: 30.7, from: "Khomanani, Limpopo" }) });
    expect(at.by).not.toBe("shopify");
    expect(at.lat).toBe(-23.3);
  });
});

// ── 21 Nov 2026 regression: customers type the wrong province (#2330, #2338, #2340) ──
import { postalProvinces, allowedProvinces, isPlace } from "./bookReturn.mjs";
describe("the province the order may be in: the typed one AND the postal code's", () => {
  const fs = (name) => ({ lat: "-29.2", lon: "26.7", class: "place", type: "town", display_name: `${name}, Free State, South Africa`, address: { state: "Free State" } });
  it("postal codes → provinces", () => {
    expect(postalProvinces("0500")).toEqual(["LP"]);
    expect(postalProvinces("0933")).toEqual(["LP"]);
    expect(postalProvinces("9781")).toEqual(["FS"]);
    expect(postalProvinces("9585")).toEqual(["FS"]);
    expect(postalProvinces("4001")).toEqual(["KZN"]);
    expect(postalProvinces("7785")).toEqual(["WC"]);
    expect(postalProvinces("")).toEqual([]);
  });

  it("#2338 Botshabelo 9781 typed Western Cape: a Free State hit is accepted", () => {
    const a = { city: "Botshabelo", zone: "WC", code: "9781" };
    expect(allowedProvinces(a)).toEqual(["WC", "FS"]);
    expect(inProvince(fs("Botshabelo"), a)).toBe(true);
  });

  it("#2340 Tumahole, Parys 9585 typed Gauteng: Free State accepted; #2330 Rooiberg 0500 typed Gauteng: Limpopo accepted", () => {
    expect(inProvince(fs("Parys"), { city: "Tumahole, Parys", zone: "GP", code: "9585" })).toBe(true);
    expect(inProvince({ address: { state: "Limpopo" } }, { city: "27 Blankblaar Rooiberg", zone: "GP", code: "0500" })).toBe(true);
  });

  it("#2181 is still safe: Khomanani 0933 typed Limpopo never takes the Cape Town building", () => {
    expect(inProvince({ address: { state: "Western Cape" } }, { city: "Khomanani", zone: "LP", code: "0933" })).toBe(false);
  });

  it("Shopify's point in the postal code's province is used even when the typed province is wrong", async () => {
    const freeState = async () => ({ ok: true, json: async () => ({ address: { state: "Free State" }, display_name: "Botshabelo, Free State" }) });
    const a = { street_address: "1564 section A", city: "Botshabelo", zone: "WC", code: "9781" };
    expect(await pointInProvince({ lat: -29.27, lng: 26.73 }, a, { fetchImpl: freeState })).toBe(true);
    expect(await placeAddress(a, { geo: { lat: -29.27, lng: 26.73 }, fetchImpl: freeState, base: async () => { throw new Error("never"); } })).toMatchObject({ by: "shopify" });
  });

  it("a residential area is a place (Rooiberg is mapped as landuse=residential); a street or a peak is not", () => {
    expect(isPlace({ class: "landuse", type: "residential" })).toBe(true);
    expect(isPlace({ class: "highway", type: "residential" })).toBe(false);
    expect(isPlace({ class: "natural", type: "peak" })).toBe(false);
  });

  it("a street typed into the town field: the town's last word is tried with each allowed province", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const asked = [];
      const fetchImpl = async (url) => { asked.push(decodeURIComponent(url.split("q=")[1])); return { ok: true, json: async () => (asked.at(-1) === "Rooiberg, Limpopo" ? [{ lat: "-24.77", lon: "27.73", class: "landuse", type: "residential", address: { state: "Limpopo" } }] : []) }; };
      const p = geocode({ street_address: "27 Blankblaar rooiberg", city: "27 Blankblaar Rooiberg", zone: "GP", code: "0500" }, { fetchImpl });
      await vi.runAllTimersAsync();
      expect(await p).toMatchObject({ lat: -24.77, from: "Rooiberg, Limpopo" });
    } finally { vi.useRealTimers(); }
  });
});

it("postal ranges keep the real province at the borders (CodeRabbit on #958)", async () => {
  const { postalProvinces } = await import("./bookReturn.mjs");
  expect(postalProvinces("0480")).toContain("LP"); // Bela-Bela
  expect(postalProvinces("8160")).toContain("WC"); // Vredendal
  expect(postalProvinces("0933")).toEqual(["LP"]); // #2181 stays Limpopo only
});
