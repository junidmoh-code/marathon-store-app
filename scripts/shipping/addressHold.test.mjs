// The address gate's order side (Junid, 24 Nov 2026): the gate in bookShipment, the hold, the ONE question, the answer.
import { describe, it, expect } from "vitest";
import { bookShipment } from "./bookShipment.mjs";
import { addressGate, lockerGate, askText, sweepAddressHolds, confirmAddress } from "./addressHold.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";

const BAD = { name: "Mpilo Ndwandwe", address1: "BB 1112 Zibhebhu Avenue", address2: "Umlazi", city: "Umlazi BB, eThekwini", province: "KwaZulu-Natal", zip: "1475", country: "South Africa", phone: "0682705674" };
const ORDER = (shipping = {}, over = {}) => ({
  key: "19024021749909", orderNumber: 2316, shopifyGid: "gid://shopify/Order/19024021749909", status: "packed", fulfilState: "courier_failed",
  lines: [{ category: "Clothing", name: "Tee", size: "M", qty: 1 }],
  customer: { name: "Prosperity Mpilo Ndwandwe", phone: "0682705674", email: "p@example.com" },
  shipping: { address: { ...BAD }, ...shipping }, ...over,
});
const CFG = { deliveryMode: "door", live: true, collectionContact: { name: "The Marathon", mobile_number: "0310000000" } };
const client = (calls) => ({
  getRates: async (b) => { calls.push(["getRates", b]); throw new Error("no rates may be asked for a held address"); },
  getPickupPoints: async () => { calls.push(["getPickupPoints"]); return { pickup_points: [] }; },
  createShipment: async (b) => { calls.push(["createShipment", b]); throw new Error("must not book"); },
});

describe("the gate in bookShipment", () => {
  it("#2316 books NOTHING: no quote, no create; the hold and its index are written (live)", async () => {
    const calls = [];
    const db = fakeDb({ config: { shipping: CFG }, online_orders: { 19024021749909: ORDER() } });
    const out = await bookShipment(ORDER(), { db, client: client(calls), log: () => {}, now: () => 1000 });
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ skipped: true, reason: expect.stringMatching(/^address check: the address says Umlazi but postal code 1475/), addressHold: { state: "asking", kind: "mismatch" } });
    expect(db.root.online_orders["19024021749909"].shipping.addressHold).toMatchObject({ at: 1000, state: "asking", code: "1475", addressPlace: "Umlazi", zipPlace: "Vosloorus", zipProvince: "Gauteng" });
    expect(db.root.shipping_recon.addressHolds["19024021749909"]).toMatchObject({ state: "asking" });
  });

  it("live off: refused the same, nothing written (a dry run asks nobody)", async () => {
    const db = fakeDb({ config: { shipping: { ...CFG, live: false } }, online_orders: { 19024021749909: ORDER() } });
    const out = await bookShipment(ORDER(), { db, client: client([]), log: () => {}, now: () => 1 });
    expect(out.reason).toMatch(/^address check:/);
    expect(db.root.online_orders["19024021749909"].shipping.addressHold).toBeUndefined();
  });

  it("own courier: never booked, whatever the address", async () => {
    const calls = [];
    const o = ORDER({ address: { ...BAD, zip: "4031" }, ownCourier: { at: 1 } });
    const out = await bookShipment(o, { db: fakeDb({ config: { shipping: CFG }, online_orders: { 19024021749909: o } }), client: client(calls), log: () => {}, now: () => 1 });
    expect(out).toMatchObject({ skipped: true, ownCourier: true });
    expect(calls).toEqual([]);
  });

  it("addressGate: a confirmation holds for that exact address only; /config/shipping/addressCheck false switches it off", () => {
    const g = addressGate(ORDER());
    expect(g.hold.sig).toBeTruthy();
    expect(addressGate(ORDER({ addressHold: { state: "confirmed", sig: g.hold.sig } }))).toBeNull();
    expect(addressGate(ORDER({ address: { ...BAD, address2: "Umlazi Q" }, addressHold: { state: "confirmed", sig: g.hold.sig } }))).not.toBeNull();
    expect(addressGate(ORDER(), { addressCheck: false })).toBeNull();
    expect(addressGate(ORDER({ address: { ...BAD, zip: "4031" } }))).toBeNull();
  });

  it("lockerGate: a locker in another town than the (consistent) address is held, not asked", () => {
    const good = ORDER({ address: { ...BAD, zip: "4031" } });
    const g = lockerGate(good, { id: "CG306", name: "Pick n Pay Sam Sekoti", lat: -26.3525, lng: 28.2134, tcgAddress: { city: "Vosloorus", code: "1475" } });
    expect(g.reason).toMatch(/^address check: the chosen locker is not in the customer's area/);
    expect(g.hold).toMatchObject({ state: "held", kind: "locker", locker: { id: "CG306" } });
    expect(lockerGate(good, { id: "RVM02045", name: "BP Sam", lat: -29.98, lng: 30.892, tcgAddress: { city: "Umlazi", code: "4066" } })).toBeNull();
  });
});

describe("the ONE question and Junid's line", () => {
  it("askText names the two conflicting parts and asks which is right", () => {
    const g = addressGate(ORDER());
    expect(askText(ORDER(), g.hold, "19024021749909")).toBe("Hi Prosperity, about your Marathon Club order #2316: your address says Umlazi but the postal code is 1475 (Vosloorus, Gauteng). Which is right, so your parcel goes to the right place?");
  });

  it("the sweep asks once (lifecycle/order_first, ref address:<key>) and tells Junid once; a second pass sends nothing", async () => {
    const g = addressGate(ORDER());
    const db = fakeDb({ online_orders: { 19024021749909: ORDER({ addressHold: { ...g.hold, at: 1 } }) }, shipping_recon: { addressHolds: { 19024021749909: { at: 1, state: "asking" } } } });
    const sent = [];
    const queue = async (args) => { sent.push(args); return sent.length + 100; };
    const out = await sweepAddressHolds({ db, queue, now: () => 5 });
    expect(out).toEqual([{ key: "19024021749909", asked: true, outboxId: 101, junid: true }]);
    expect(sent[0]).toEqual(["--to", "0682705674", "--kind", "lifecycle", "--sub", "order_first", "--ref", "address:19024021749909", "--text", expect.stringMatching(/your address says Umlazi but the postal code is 1475/)]);
    expect(sent[1].slice(0, 4)).toEqual(["--kind", "junid", "--to", "27813995333"]);
    expect(db.root.online_orders["19024021749909"].shipping.addressHold).toMatchObject({ askedAt: 5, outboxId: 101 });
    expect(db.root.shipping_recon.junidLines["19024021749909-address"]).toMatchObject({ sentAt: 5 });
    await sweepAddressHolds({ db, queue, now: () => 9 });
    expect(sent).toHaveLength(2);
  });

  it("a refused send is released and asked again next pass", async () => {
    const g = addressGate(ORDER());
    const db = fakeDb({ online_orders: { 19024021749909: ORDER({ addressHold: { ...g.hold, at: 1 } }) }, shipping_recon: { addressHolds: { 19024021749909: { at: 1 } } } });
    const out = await sweepAddressHolds({ db, queue: async () => null, now: () => 5 });
    expect(out[0]).toMatchObject({ asked: false });
    expect(db.root.online_orders["19024021749909"].shipping.addressHold.askedAt).toBeUndefined();
  });
});

describe("the answer: confirmAddress", () => {
  it("--zip 4031 fixes the address, clears the hold and hands the packed order back to the ship step", async () => {
    const g = addressGate(ORDER());
    const db = fakeDb({ online_orders: { 19024021749909: ORDER({ addressHold: { ...g.hold, at: 1 } }, { courierError: g.reason, attention: { kind: "courier_failed" }, attentionOpen: true }) }, shipping_recon: { addressHolds: { 19024021749909: { at: 1 } } } });
    const out = await confirmAddress(db, "19024021749909", { zip: "4031", by: "jamie", now: 7 });
    expect(out).toMatchObject({ ok: true, cleared: true, handedBack: true });
    const o = db.root.online_orders["19024021749909"];
    expect(o).toMatchObject({ fulfilState: "pending", shipping: { address: { zip: "4031" }, addressBefore: { zip: "1475" }, addressHold: { state: "cleared", resolvedBy: "jamie" } } });
    expect(o.courierError).toBeUndefined();
    expect(o.attention).toBeUndefined();
    expect(db.root.shipping_recon.addressHolds?.["19024021749909"]).toBeUndefined();
    expect(addressGate(o)).toBeNull();
  });

  it("an answer that still disagrees writes nothing; --as-is confirms the exact address", async () => {
    const db = fakeDb({ online_orders: { 19024021749909: ORDER() } });
    const out = await confirmAddress(db, "19024021749909", { zip: "1476" });
    expect(out.ok).toBe(false);
    expect(db.writes).toEqual([]);
    const ok = await confirmAddress(db, "19024021749909", { asIs: true, now: 3 });
    expect(ok).toMatchObject({ ok: true, cleared: false });
    expect(addressGate(db.root.online_orders["19024021749909"])).toBeNull();
  });
});
