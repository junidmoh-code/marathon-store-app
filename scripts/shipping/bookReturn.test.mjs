// bookReturn — an online exchange's return leg, locker-to-door from the locker nearest the customer; with no locker for
// it, a courier collection from the customer's door when that is switched on (Junid, 24 Nov 2026). Recorded fixtures
// and fakes only, never the network.
import { describe, it, expect } from "vitest";
import { bookReturn, planReturn, nearestLocker, geocode, shopReturnContact } from "./bookReturn.mjs";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { fakeDb } from "./fakeDb.testutil.mjs";
import lockerCpt from "./fixtures/rates-locker-capetown.json";
import shipmentLocker from "./fixtures/shipment-locker.json";

const KEY = "exchange-1793-1793333411004";
const SHOP_CONTACT = { name: "Junid Atugar", mobile_number: "0310000000", email: "shop@example.com" };
const RETURN_CONTACT = { name: "Yusuf", mobile_number: "+27600000001", email: "" };
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
const db = ({ live = true, exchange = EXCHANGE(), extra = {}, returnContact = RETURN_CONTACT, cfg = {} } = {}) => fakeDb({
  config: { shipping: { live, collectionContact: SHOP_CONTACT, ...(returnContact ? { returnContact } : {}), ...cfg } },
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
      delivery_contact: RETURN_CONTACT,
      service_level_code: "L2DM - ECO",
      customer_reference: "1793-EX return",
    });
    expect(plan.payload.delivery_address.company).toBeTruthy(); // the shop
  });
  it("our side of a return is the return contact (Yusuf), never the outbound collection contact (Junid, 20 Nov 2026)", async () => {
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient(), geocoder, key: KEY, products: {} });
    expect(plan.payload.delivery_contact).toEqual(RETURN_CONTACT);
    expect(JSON.stringify(plan.payload)).not.toContain(SHOP_CONTACT.mobile_number);
    expect(JSON.stringify(plan.payload)).not.toContain(SHOP_CONTACT.email);
  });
  it("the code default is Yusuf, and without his mobile a return refuses rather than fall back to the shop contact", async () => {
    expect(mergeShippingConfig({}).returnContact.name).toBe("Yusuf");
    expect(shopReturnContact(mergeShippingConfig({ returnContact: { mobile_number: " +27000000002 " } }))).toEqual({ name: "Yusuf", mobile_number: "+27000000002", email: "" });
    const client = fakeClient();
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db({ returnContact: null }), client, geocoder, key: KEY, products: {} });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/return contact's name and SA mobile/);
    expect(plan.transient).toBe(true); // retried once the config is fixed, never stuck as refused
    const typo = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db({ returnContact: { name: "Yusuf", mobile_number: "069888222" } }), client, geocoder, key: KEY, products: {} });
    expect(typo.ok).toBe(false);
    const emailOnly = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db({ returnContact: { name: "Yusuf", mobile_number: "", email: "y@example.com" } }), client, geocoder, key: KEY, products: {} });
    expect(emailOnly.ok).toBe(false);
    expect(client.calls).toHaveLength(0); // refused before any quote
  });
  it("with the door collection switched off (the default) it never falls back to one: refused, and the refusal says it was a no-locker one", async () => {
    const plan = await planReturn({ ...EXCHANGE(), key: KEY }, { db: db(), client: fakeClient({ rates: { rates: null } }), geocoder, key: KEY, products: {} });
    expect(plan).toMatchObject({ ok: false, noLockerKind: "none_priced" });
    expect(plan.reason).toMatch(/no locker rate/);
    expect(mergeShippingConfig({}).returnDoorCollection).toBe(false);
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
  // A RETURN-ONLY record (store credit / refund instead of a replacement, Junid 26 Nov 2026): its one line is the
  // item coming back (returnOnly), status "new". Its collection is booked exactly like an exchange's return leg.
  it("a return-only record (store credit / refund, nothing ships): the return collection still books, once", async () => {
    const exchange = EXCHANGE({
      status: "new",
      exchange: { paidAt: 1793333411004, contactPhone: "27600000000", returnOnly: true, desk: { id: 7, outcome: "credit" }, relatedOrders: ["9001"] },
      lines: [{ pid: "p1", category: "Footwear", isFootwear: true, title: "Diesel", size: "7", sizeKey: "7", qty: 1, unitPriceCents: 0, returnOnly: true, exchangeFor: "Diesel" }],
    });
    const d = db({ exchange });
    const client = fakeClient();
    const out = await bookReturn(KEY, deps(d, client));
    expect(out).toMatchObject({ booked: true, waybill: "TEST01", locker: { id: "RVM01017" } });
    expect(client.creates()).toHaveLength(1);
    expect(client.creates()[0][1]).toMatchObject({ collection_pickup_point_id: "RVM01017" });
    expect(d.root.online_orders[KEY].returnShipping).toMatchObject({ waybill: "TEST01", courierBooking: { state: "booked" } });
    expect(d.root.online_orders[KEY].shipping.courierBooking).toBeUndefined(); // the outbound is never touched
    expect((await bookReturn(KEY, deps(d, client))).skipped).toBe(true);
    expect(client.creates()).toHaveLength(1);
  });
  it("a return-only record still unpaid (awaitingPayment, paidAt null, as the desk first writes it) books nothing", async () => {
    const exchange = EXCHANGE({ status: "new", exchange: { paidAt: null, awaitingPayment: true, returnOnly: true }, lines: [{ pid: "p1", title: "Diesel", size: "7", qty: 1, returnOnly: true }] });
    const client = fakeClient();
    expect(await bookReturn(KEY, deps(db({ exchange }), client))).toMatchObject({ skipped: true, reason: expect.stringMatching(/no paid exchange/) });
    expect(client.calls).toEqual([]);
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
    const rates = { rates: [{ rate: 600, service_level: { code: "L2DL - ECO" } }] }; // over the R500 ceiling (raised from R300, 20 Nov 2026)
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

// NO LOCKER → A COURIER COLLECTS FROM THE CUSTOMER'S DOOR (Junid, 24 Nov 2026: "book DOOR-TO-DOOR … automatically instead
// of failing. Never leave an order unbooked because there's no locker", "Apply it to exchange returns too (e.g. #1934's
// refused return)"). Switched by /config/shipping/returnDoorCollection (or doorCollection: true), off by default until
// Jimmy tells the customer "a courier will collect" instead of "drop it at the locker".
describe("no locker for the return → a door collection from the customer's address (when switched on)", () => {
  const DOOR = { rates: [{ rate: 140, service_level: { code: "ECO" } }, { rate: 90, service_level: { code: "SDX" } }, { rate: 60, service_level: { code: "L2DM - ECO" } }] };
  const DOOR_SHIPMENT = { id: 4242, short_tracking_reference: "DOOR42", custom_tracking_reference: "DOOR42", service_level_code: "ECO", rate: 140 };
  const ON = { cfg: { returnDoorCollection: true } };
  const noLockers = (over = {}) => fakeClient({ points: { pickup_points: [] }, rates: DOOR, createResult: DOOR_SHIPMENT, ...over });

  it("books a normal shipment from the customer's address to our door: no pickup point, the cheapest DOOR service, the record says door_collection", async () => {
    const d = db(ON);
    const client = noLockers();
    const out = await bookReturn(KEY, deps(d, client));
    expect(client.creates()).toHaveLength(1);
    const sent = client.creates()[0][1];
    expect(sent).not.toHaveProperty("collection_pickup_point_id");
    expect(sent).not.toHaveProperty("delivery_pickup_point_id");
    expect(sent).toMatchObject({
      collection_address: { street_address: "519 ilitha township Qonce", city: "Qonce", zone: "EC", code: "5600" },
      collection_contact: { name: "Thanduxolo Tyebi", mobile_number: "27600000000", email: "t@example.com" },
      delivery_address: { company: "Bhoola Centre Shop Nr 9", code: "4001" },
      delivery_contact: RETURN_CONTACT,
      // ECO, not the cheaper SDX (excluded) and never the locker service quoted beside it
      service_level_code: "ECO", customer_reference: "1793-EX return",
    });
    expect(out).toMatchObject({
      booked: true, mode: "door_collection", waybill: "DOOR42", dropOffRef: null, locker: null, service: "ECO", cost: 140,
      collection: { from: "door", address: "519 ilitha township Qonce, Qonce, 5600", contactMobile: "27600000000" },
      doorFallback: { kind: "none_near", reason: "no Courier Guy locker near the customer fits a M parcel", at: 1000 },
    });
    const rs = d.root.online_orders[KEY].returnShipping;
    expect(rs).toMatchObject({ mode: "door_collection", waybill: "DOOR42", collection: { from: "door" }, doorFallback: { kind: "none_near" }, courierBooking: { state: "booked" } });
    // Truthful for whoever messages the customer: no drop-off reference and no locker on a door collection.
    expect(rs).not.toHaveProperty("dropOffRef");
    expect(rs).not.toHaveProperty("locker");
  });

  it("the same once-only guards: a second call books nothing, and a held claim blocks it", async () => {
    const d = db(ON);
    const client = noLockers();
    await bookReturn(KEY, deps(d, client));
    expect(await bookReturn(KEY, deps(d, client))).toMatchObject({ skipped: true, reason: "return already booked" });
    expect(client.creates()).toHaveLength(1);
    const held = db({ ...ON, exchange: EXCHANGE({ returnShipping: { courierBooking: { state: "unknown", at: 5 } } }) });
    const client2 = noLockers();
    expect(await bookReturn(KEY, deps(held, client2))).toMatchObject({ skipped: true, reason: "return booking already unknown" });
    expect(client2.creates()).toHaveLength(0);
  });

  it("the same ceiling: a door rate under it books, over it is refused with nothing created", async () => {
    expect(await bookReturn(KEY, deps(db({ cfg: { returnDoorCollection: true, maxChargeRand: 140 } }), noLockers()))).toMatchObject({ booked: true, mode: "door_collection" });
    const client = noLockers();
    const d = db({ cfg: { returnDoorCollection: true, maxChargeRand: 139 } });
    const out = await bookReturn(KEY, deps(d, client));
    expect(out).toMatchObject({ skipped: true, refused: true, reason: "quote R140.00 is over the R139 ceiling", noLocker: true, doorTried: true, doorFallback: { kind: "none_near" } });
    expect(client.creates()).toHaveLength(0);
    expect(d.root.online_orders[KEY].returnShipping).toBeUndefined();
  });

  it("live off is a dry run of the door collection: the payload and the mode, no create", async () => {
    const client = noLockers();
    const out = await bookReturn(KEY, deps(db({ live: false, ...ON }), client));
    expect(out).toMatchObject({ skipped: true, mode: "door_collection", quote: { code: "ECO", rate: 140 }, doorFallback: { kind: "none_near" }, collection: { from: "door" } });
    expect(out.dryRun).not.toHaveProperty("collection_pickup_point_id");
    expect(client.creates()).toHaveLength(0);
  });

  it("every no-locker reason falls back: the nearest too far, only the town placed and its locker too far, no locker rate quoted, a parcel no locker takes", async () => {
    const plan = (o) => planReturn({ ...EXCHANGE(), key: KEY, ...(o.exchange ?? {}) }, { db: db(ON), client: o.client ?? fakeClient({ rates: DOOR }), geocoder: o.geocoder ?? geocoder, key: KEY, products: {} });
    const far = await plan({ geocoder: async () => ({ lat: -30, lng: 25, from: "x" }) });
    expect(far).toMatchObject({ ok: true, mode: "door_collection", doorFallback: { kind: "none_near" } });
    expect(far.doorFallback.reason).toMatch(/km from the customer's address/);
    // ~17 km from the nearest listed locker, placed only by the town: past MAX_TOWN_LOCKER_KM (15)
    const town = await plan({ geocoder: async () => ({ lat: -32.74, lng: 27.3919, from: "Qonce, 5600" }) });
    expect(town).toMatchObject({ ok: true, mode: "door_collection", doorFallback: { kind: "none_near" } });
    expect(town.doorFallback.reason).toMatch(/their street isn't on the map/);
    // a locker near, but Courier Guy quotes no locker service for it (only door services)
    const unpriced = await plan({ client: fakeClient({ rates: { rates: [{ rate: 140, service_level: { code: "ECO" } }] } }) });
    expect(unpriced).toMatchObject({ ok: true, mode: "door_collection", rate: { code: "ECO" }, doorFallback: { kind: "none_priced", reason: "no locker rate (none quoted)" } });
    // ten pairs: no locker compartment takes the parcel, a standard box does
    const big = await plan({ exchange: { lines: [{ pid: "p1", category: "Footwear", isFootwear: true, title: "Diesel", size: "7", qty: 10 }] } });
    expect(big).toMatchObject({ ok: true, mode: "door_collection", doorFallback: { kind: "too_big", reason: "the parcel fits no Courier Guy locker" } });
  });

  it("everything else still refuses or retries exactly as before, even switched on", async () => {
    const plan = (o = {}) => planReturn({ ...EXCHANGE(o.exchange ?? {}), key: KEY }, { db: o.db ?? db(ON), client: o.client ?? noLockers(), geocoder: o.geocoder ?? geocoder, key: KEY, products: {} });
    // the address cannot be placed on the map
    expect(await plan({ geocoder: async () => null })).toMatchObject({ ok: false, transient: true, reason: expect.stringMatching(/could not be placed/) });
    // …even for a parcel no locker takes: placed first, so an unplaceable address never gets a door collection (architect review, #984)
    const bulky = await plan({ geocoder: async () => null, exchange: { lines: [{ pid: "p1", category: "Footwear", isFootwear: true, title: "Diesel", size: "7", qty: 10 }] } });
    expect(bulky).toMatchObject({ ok: false, transient: true, reason: expect.stringMatching(/could not be placed/) });
    expect(bulky.doorFallback).toBeUndefined();
    // the locker list could not be read
    const down = noLockers(); down.getPickupPoints = async () => { throw new Error("HTTP 503"); };
    expect(await plan({ client: down })).toMatchObject({ ok: false, transient: true, reason: expect.stringMatching(/locker list could not be read/) });
    // the locker rate lookup FAILED (not "none quoted")
    const failing = fakeClient(); failing.getRates = async () => { throw new Error("HTTP 502"); };
    const lookup = await plan({ client: failing });
    expect(lookup).toMatchObject({ ok: false, transient: true, reason: "no locker rate (HTTP 502)" });
    expect(lookup.doorFallback).toBeUndefined();
    // a pickup-points reply with no pickup_points list is a broken answer, not "no locker here" (CodeRabbit, #984)
    const broken = noLockers({ points: { count: 0 } });
    expect(await plan({ client: broken })).toMatchObject({ ok: false, transient: true, reason: expect.stringMatching(/locker list could not be read \(the pickup-points reply has no pickup_points list\)/) });
    expect(broken.creates()).toHaveLength(0);
    // the locker rate answered empty, and its retry with the town as the suburb FAILED: a failed lookup (CodeRabbit, #984)
    const halfDown = fakeClient(); let asked = 0;
    halfDown.getRates = async () => { asked += 1; if (asked === 1) return { rates: [] }; throw new Error("HTTP 504"); };
    const retried = await plan({ client: halfDown });
    expect(asked).toBe(2);
    expect(retried).toMatchObject({ ok: false, transient: true, reason: "no locker rate (HTTP 504)" });
    expect(retried.doorFallback).toBeUndefined();
    // the return contact is not set
    expect(await plan({ db: db({ ...ON, returnContact: { name: "Yusuf", mobile_number: "" } }) })).toMatchObject({ ok: false, transient: true });
    // missing address
    expect((await plan({ exchange: { shipping: { address: {} } } })).reason).toMatch(/^missing: /);
  });

  it("a door collection needs the customer's mobile (the driver calls) and a door rate; without either it is refused, saying both reasons", async () => {
    const emailOnly = EXCHANGE({ exchange: { paidAt: 1793333411004 }, shipping: { address: { address1: "519 ilitha township Qonce", city: "Qonce", province: "Eastern Cape", zip: "5600", name: "Thanduxolo Tyebi" } } });
    const client = noLockers();
    const noPhone = await bookReturn(KEY, deps(db({ ...ON, exchange: emailOnly }), client));
    expect(noPhone).toMatchObject({ skipped: true, refused: true, noLocker: true, doorTried: true });
    expect(noPhone.reason).toMatch(/^no Courier Guy locker near the customer fits a M parcel; a door collection was not booked either: the customer's SA mobile number is missing/);
    expect(client.creates()).toHaveLength(0);
    const noRate = await bookReturn(KEY, deps(db(ON), noLockers({ rates: { rates: null } })));
    expect(noRate.reason).toMatch(/a door collection was not booked either: no door rate \(none quoted\)/);
    expect(noRate).toMatchObject({ skipped: true, refused: true });
  });

  it("the switch: off in the database → refused as before; the caller's doorCollection true / false overrides it either way", async () => {
    const off = noLockers();
    expect(await bookReturn(KEY, deps(db(), off))).toMatchObject({ skipped: true, refused: true, noLocker: true, noLockerKind: "none_near", reason: "no Courier Guy locker near the customer fits a M parcel" });
    expect(off.creates()).toHaveLength(0);
    expect(await bookReturn(KEY, deps(db(), noLockers(), { doorCollection: true }))).toMatchObject({ booked: true, mode: "door_collection" });
    const forcedOff = noLockers();
    expect(await bookReturn(KEY, deps(db(ON), forcedOff, { doorCollection: false }))).toMatchObject({ skipped: true, refused: true });
    expect(forcedOff.creates()).toHaveLength(0);
  });

  it("a locker booking is unchanged and now says mode: locker_dropoff, even with the door collection switched on", async () => {
    const d = db(ON);
    const out = await bookReturn(KEY, deps(d, fakeClient()));
    expect(out).toMatchObject({ booked: true, mode: "locker_dropoff", waybill: "TEST01", dropOffRef: "LD-TEST01", locker: { id: "RVM01017" } });
    expect(out.doorFallback).toBeUndefined();
    expect(d.root.online_orders[KEY].returnShipping).not.toHaveProperty("collection");
  });
});
