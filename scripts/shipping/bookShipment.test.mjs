// bookShipment / cancelShipment — recorded fixtures only, never the network.
//
// THE GUARD. With /config/shipping/live anything but the boolean true, no
// code path may reach client.createShipment or client.cancelShipment. The
// "live-flag guard" block below drives every live value that is NOT true
// through every order shape and fails on the first shipment call.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bookShipment, cancelShipment, readLive } from "./bookShipment.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";
import doorCpt from "./fixtures/rates-door-capetown.json";
import lockerCpt from "./fixtures/rates-locker-capetown.json";
import shipmentLocker from "./fixtures/shipment-locker.json";

const CONTACT = { name: "The Marathon", mobile_number: "0310000000", email: "" };

function fakeClient({ createResult = shipmentLocker, createError = null } = {}) {
  const calls = [];
  return {
    calls,
    shipmentCalls: () => calls.filter((c) => c[0] !== "getRates"),
    getRates: async (body) => { calls.push(["getRates", body]); return body.collection_pickup_point_id ? lockerCpt : doorCpt; },
    createShipment: async (body) => { calls.push(["createShipment", body]); if (createError) throw createError; return createResult; },
    cancelShipment: async (ref) => { calls.push(["cancelShipment", ref]); return { ok: true }; },
  };
}

const ORDER = (over = {}) => ({
  key: "W1001",
  ref: "W1001",
  lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "9", qty: 1 }],
  shipping: { address: { street: "5 Esplanade Road", suburb: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441" } },
  customer: { name: "A Customer", phone: "0820000000", email: "a@example.com" },
  ...over,
});
const DOOR_ORDER = () => ORDER({ lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "10", qty: 10 }] });

const db = (live, extra = {}) => fakeDb({
  config: { shipping: { ...(live === undefined ? {} : { live }), collectionContact: CONTACT } },
  online_orders: { W1001: ORDER() },
  ...extra,
});
const deps = (d, client, logs = []) => ({ db: d, client, log: (l) => logs.push(l), now: () => 1_700_000_000_000 });

let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchSpy.mockRestore());

describe("readLive", () => {
  it.each([[undefined, false], [false, false], [null, false], ["true", false], [1, false], [{}, false], [true, true]])(
    "live=%j → %s", async (live, expected) => expect(await readLive(db(live))).toBe(expected));
});

describe("bookShipment — dry run (live off)", () => {
  it("logs and returns the exact payload, makes no shipment call", async () => {
    const client = fakeClient();
    const logs = [];
    const res = await bookShipment(ORDER(), deps(db(false), client, logs));
    expect(client.shipmentCalls()).toEqual([]);
    expect(res.skipped).toBe(true);
    expect(res.dryRun).toEqual({
      collection_address: expect.objectContaining({ company: "Bhoola Centre Shop Nr 9", code: "4001" }),
      collection_pickup_point_id: "CG0000",
      collection_pickup_point_provider: "tcg-locker",
      collection_contact: CONTACT,
      delivery_address: { type: "residential", company: "", street_address: "5 Esplanade Road", local_area: "Century City", city: "Cape Town", zone: "WC", country: "ZA", code: "7441" },
      delivery_contact: { name: "A Customer", mobile_number: "0820000000", email: "a@example.com" },
      parcels: [{ parcel_description: "Retail", submitted_length_cm: 35, submitted_width_cm: 23, submitted_height_cm: 14, submitted_weight_kg: 1.5 }],
      service_level_code: "L2DM - ECO",
      customer_reference: "W1001",
      customer_reference_name: "Order no.",
      mute_notifications: false,
    });
    expect(logs.join("\n")).toContain("DRY RUN");
    expect(logs.join("\n")).toContain(JSON.stringify(res.dryRun));
  });

  it("a parcel over the drop-box threshold is a door booking on the cheapest door service", async () => {
    const client = fakeClient();
    const res = await bookShipment(DOOR_ORDER(), deps(db(false), client));
    expect(res.dryRun.service_level_code).toBe("ECO");
    expect(res.dryRun).not.toHaveProperty("collection_pickup_point_id");
    expect(res.quote).toMatchObject({ mode: "door", code: "ECO" });
  });

  it("an empty collection contact still dry-runs, naming what would stop a live booking", async () => {
    const d = fakeDb({ config: { shipping: {} }, online_orders: {} });
    const res = await bookShipment(ORDER(), deps(d, fakeClient()));
    expect(res.dryRun).toBeTruthy();
    expect(res.liveBlockers).toEqual(["collection_contact"]);
  });

  it("refuses an order with no address before pricing anything", async () => {
    const client = fakeClient();
    const res = await bookShipment(ORDER({ shipping: {} }), deps(db(false), client));
    expect(res).toMatchObject({ skipped: true });
    expect(res.reason).toMatch(/street_address, city, code/);
    expect(client.calls).toEqual([]);
  });

  it("rates are allowed with live off (they book nothing)", async () => {
    const client = fakeClient();
    await bookShipment(ORDER(), deps(db(false), client));
    expect(client.calls.map((c) => c[0])).toEqual(["getRates", "getRates"]);
  });

  it("writes nothing to the order", async () => {
    const d = db(false);
    await bookShipment(ORDER(), deps(d, fakeClient()));
    expect(d.writes).toEqual([]);
  });
});

describe("THE LIVE-FLAG GUARD — no shipment call can be reached unless live === true", () => {
  const NOT_LIVE = [undefined, false, null, "true", "yes", 1, 0, {}, []];
  const ORDERS = [
    ["locker", ORDER()],
    ["door", DOOR_ORDER()],
    ["booked", ORDER({ shipping: { ...ORDER().shipping, provider: "courier_guy", shipmentId: 1, waybill: "LD-X", trackingReference: "X" } })],
    ["oversize", ORDER({ lines: [{ category: "Footwear", subcategory: "Sneakers", size: "10", qty: 20 }] })],
  ];
  for (const live of NOT_LIVE) {
    for (const [name, order] of ORDERS) {
      it(`live=${JSON.stringify(live)} · ${name}: bookShipment and cancelShipment make no shipment call`, async () => {
        const client = fakeClient();
        await bookShipment(order, deps(db(live), client)).catch(() => {});
        await cancelShipment(order, deps(db(live), client)).catch(() => {});
        expect(client.shipmentCalls()).toEqual([]);
      });
    }
  }
});

describe("bookShipment — live", () => {
  it("creates once, writes {provider, shipmentId, waybill, service, parcel, cost, bookedAt} to the order", async () => {
    const d = db(true);
    const client = fakeClient();
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(client.shipmentCalls().map((c) => c[0])).toEqual(["createShipment"]);
    expect(client.shipmentCalls()[0][1].customer_reference).toBe("W1001");
    expect(res).toEqual({
      provider: "courier_guy", shipmentId: 0, waybill: "LD-TEST01", trackingReference: "TEST01",
      service: "L2DS - ECO", parcel: expect.objectContaining({ boxCode: "SHOE" }), cost: 100, bookedAt: 1_700_000_000_000,
    });
    expect(d.root.online_orders.W1001.shipping).toMatchObject({ provider: "courier_guy", waybill: "LD-TEST01", courierBooking: { state: "booked" } });
  });

  it("an order already carrying a shipmentId is never booked again", async () => {
    const client = fakeClient();
    const res = await bookShipment(ORDER({ shipping: { ...ORDER().shipping, shipmentId: 9 } }), deps(db(true), client));
    expect(res.reason).toBe("already booked");
    expect(client.calls).toEqual([]);
  });

  it("a held claim (another packer, or a lost response) blocks a second booking", async () => {
    for (const state of ["booking", "unknown", "booked"]) {
      const d = db(true, { online_orders: { W1001: { ref: "W1001", shipping: { courierBooking: { state } } } } });
      const client = fakeClient();
      const res = await bookShipment(ORDER(), deps(d, client));
      expect(res.reason).toBe(`booking already ${state}`);
      expect(client.shipmentCalls()).toEqual([]);
    }
  });

  it("a 4xx releases the claim as failed (re-bookable); a 5xx/timeout leaves it unknown", async () => {
    const bad = Object.assign(new Error("HTTP 400 invalid"), { status: 400 });
    const d1 = db(true);
    await expect(bookShipment(ORDER(), deps(d1, fakeClient({ createError: bad })))).rejects.toThrow(/400/);
    expect(d1.root.online_orders.W1001.shipping.courierBooking.state).toBe("failed");
    const d2 = db(true);
    await expect(bookShipment(ORDER(), deps(d2, fakeClient({ createError: Object.assign(new Error("HTTP 502"), { status: 502 }) })))).rejects.toThrow();
    expect(d2.root.online_orders.W1001.shipping.courierBooking.state).toBe("unknown");
    // failed → a retry may book
    const client = fakeClient();
    await bookShipment(ORDER(), deps(d1, client));
    expect(client.shipmentCalls()).toHaveLength(1);
  });

  it("refuses live without a collection contact, and when no box fits", async () => {
    const d = fakeDb({ config: { shipping: { live: true } }, online_orders: { W1001: { ref: "W1001" } } });
    const client = fakeClient();
    expect((await bookShipment(ORDER(), deps(d, client))).reason).toBe("collection_contact");
    const res = await bookShipment(ORDER({ lines: [{ category: "Footwear", subcategory: "Sneakers", size: "10", qty: 20 }] }), deps(db(true), client));
    expect(res.reason).toMatch(/no standard box fits/);
    expect(client.shipmentCalls()).toEqual([]);
  });

  it("an illegal order key is refused before anything", async () => {
    const client = fakeClient();
    await expect(bookShipment({ ...ORDER(), key: "a/b" }, deps(db(true), client))).rejects.toThrow(/Illegal RTDB path/);
    expect(client.calls).toEqual([]);
  });
});

describe("cancelShipment", () => {
  const BOOKED = () => ORDER({ shipping: { provider: "courier_guy", shipmentId: 5, waybill: "LD-TEST01", trackingReference: "TEST01" } });

  it("dry run returns the payload and calls nothing", async () => {
    const client = fakeClient();
    expect(await cancelShipment(BOOKED(), deps(db(false), client))).toEqual({ skipped: true, dryRun: { tracking_reference: "TEST01" } });
    expect(client.calls).toEqual([]);
  });

  it("live cancels by tracking reference and stamps the order", async () => {
    const d = db(true);
    const client = fakeClient();
    const res = await cancelShipment(BOOKED(), deps(d, client));
    expect(client.calls).toEqual([["cancelShipment", "TEST01"]]);
    expect(res.cancelledAt).toBe(1_700_000_000_000);
    expect(d.root.online_orders.W1001.shipping.courierBooking.state).toBe("cancelled");
  });

  it("no booking / already cancelled → nothing", async () => {
    const client = fakeClient();
    expect((await cancelShipment(ORDER(), deps(db(true), client))).reason).toMatch(/no Courier Guy booking/);
    expect((await cancelShipment(ORDER({ shipping: { ...BOOKED().shipping, cancelledAt: 1 } }), deps(db(true), client))).reason).toBe("already cancelled");
    expect(client.calls).toEqual([]);
  });
});

describe("the website-order ingester's real shape (feat/online-orders orderModel.mjs)", () => {
  // /online_orders/{Shopify order id}; ref is a FIELD ("WEB-1042"), lines carry pid.
  const INGESTED = () => ({
    ref: "WEB-1042", orderNumber: 1042, shopifyGid: "gid://shopify/Order/5551234", shopifyName: "#1042",
    customer: { name: "Ann Bee", phone: "+27820000000", email: "ann@example.com" },
    shipping: { address: { name: "Ann Bee", address1: "5 Esplanade Road", address2: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa", phone: "+27820000000" } },
    lines: [{ pid: "p_x", title: "Item 7", category: "Clothing", size: "32", qty: 2 }],
  });

  it("keys by the Shopify id, references by WEB-ref, classifies from /products/{pid}", async () => {
    const d = fakeDb({
      config: { shipping: { live: true, collectionContact: CONTACT } },
      products: { p_x: { name: "Item 7", category: "Clothing", subcategory: "Jeans & Denim" } },
      online_orders: { 5551234: { ref: "WEB-1042" } },
    });
    const client = fakeClient();
    await bookShipment(INGESTED(), deps(d, client));
    const body = client.shipmentCalls()[0][1];
    expect(body.customer_reference).toBe("WEB-1042");
    expect(body.delivery_address).toMatchObject({ street_address: "5 Esplanade Road, Century City", zone: "WC", country: "ZA", code: "7441" });
    expect(body.delivery_contact).toEqual({ name: "Ann Bee", mobile_number: "+27820000000", email: "ann@example.com" });
    // "Item 7" says nothing; /products/p_x says jeans → 2 × 0.5 kg + the flat mailer
    expect(body.parcels[0]).toMatchObject({ submitted_height_cm: 8, submitted_weight_kg: 1.15 });
    expect(d.root.online_orders["5551234"].shipping.provider).toBe("courier_guy");
    expect(d.root.online_orders["WEB-1042"]).toBeUndefined();
  });

  it("an order with no key at all is refused before any call — the ref is never used as a key", async () => {
    const client = fakeClient();
    const { shopifyGid, ...noKey } = INGESTED();
    await expect(bookShipment(noKey, deps(db(true), client))).rejects.toThrow(/no \/online_orders key/);
    expect(client.calls).toEqual([]);
  });
});

describe("review hardening (Sonnet architect review, PR #774)", () => {
  it("a WEB- ref passed as the key is refused before any call", async () => {
    const client = fakeClient();
    await expect(bookShipment({ ...ORDER(), key: "WEB-1042" }, deps(db(true), client))).rejects.toThrow(/order REF/);
    expect(client.calls).toEqual([]);
  });

  it("no order at the key → refused, nothing minted, no shipment call", async () => {
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT } } });
    const client = fakeClient();
    expect((await bookShipment(ORDER({ key: "999" }), deps(d, client))).reason).toBe("no order at /online_orders/999");
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.root.online_orders).toBeUndefined();
  });

  it("live switched off after the claim → no create, claim released", async () => {
    const d = db(true);
    const client = fakeClient();
    const realGet = d.ref;
    let liveReads = 0;
    d.ref = (path) => {
      const r = realGet(path);
      if (path !== "config/shipping/live") return r;
      return { ...r, get: async () => { liveReads++; return { exists: () => true, val: () => liveReads === 1 } ; } };
    };
    const res = await bookShipment(ORDER(), deps(d, client));
    expect(res.dryRun).toBeTruthy();
    expect(client.shipmentCalls()).toEqual([]);
    expect(d.root.online_orders.W1001.shipping.courierBooking.state).toBe("failed");
  });

  it("a quote over the spend ceiling is refused live, named in a dry run", async () => {
    const client = fakeClient();
    const low = (live) => fakeDb({ config: { shipping: { live, collectionContact: CONTACT, maxChargeRand: 50 } }, online_orders: { W1001: { ref: "W1001" } } });
    expect((await bookShipment(ORDER(), deps(low(true), client))).reason).toMatch(/over the R50 ceiling/);
    expect((await bookShipment(ORDER(), deps(low(false), client))).liveBlockers).toEqual(["quote R100.00 is over the R50 ceiling"]);
    expect(client.shipmentCalls()).toEqual([]);
  });

  it("a 408 leaves the claim UNKNOWN (the create may have run)", async () => {
    const d = db(true);
    await expect(bookShipment(ORDER(), deps(d, fakeClient({ createError: Object.assign(new Error("HTTP 408"), { status: 408 }) })))).rejects.toThrow();
    expect(d.root.online_orders.W1001.shipping.courierBooking.state).toBe("unknown");
  });

  it("a booked waybill whose record write fails is kept on the claim and returned", async () => {
    const d = db(true);
    const realRef = d.ref;
    d.ref = (path) => {
      const r = realRef(path);
      return path === "online_orders/W1001/shipping" ? { ...r, update: async () => { throw new Error("write refused"); } } : r;
    };
    const logs = [];
    const res = await bookShipment(ORDER(), deps(d, fakeClient(), logs));
    expect(res.waybill).toBe("LD-TEST01");
    expect(d.root.online_orders.W1001.shipping.courierBooking).toMatchObject({ state: "booked", waybill: "LD-TEST01" });
    expect(logs.join("\n")).toContain("BOOKED BUT NOT RECORDED LD-TEST01");
  });

  it("a non-finite charge is recorded as null, never NaN", async () => {
    const d = db(true);
    const res = await bookShipment(ORDER(), deps(d, fakeClient({ createResult: { id: 7, short_tracking_reference: "ABC", charged_amount: "n/a", rate: "n/a" } })));
    expect(res.cost).toBeNull();
    expect(res.waybill).toBe("ABC");
  });
});
