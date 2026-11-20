// Fast courier booking (fastShip.mjs + poll.mjs shipOrderLocked): a packed
// order ships the moment it is packed, and the fast path and the tick never
// ship one order twice — however they interleave.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFastShipper, listenForPacked } from "./fastShip.mjs";
import { runOrdersPoll, takeShipLock, releaseShipLock, shipLockHeld, shipOrderLocked, SHIP_LOCKS_PATH, SHIP_LOCK_TTL_MS, META_PATH } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import doorRates from "../../shipping/fixtures/rates-door-capetown.json";
import lockerRates from "../../shipping/fixtures/rates-locker-capetown.json";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-20T10:00:00Z");
const GO_LIVE = Date.parse("2026-10-21T09:00:00Z");
const fos = [{ id: "gid://shopify/FulfillmentOrder/7", status: "OPEN", lineItems: { nodes: [{ remainingQuantity: 1 }] } }];

function world({ order = {}, live = true } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: GO_LIVE, cursorMs: NOW },
    config: { onlineOrders: { enabled: false }, shipping: { deliveryMode: "door", live, collectionContact: { name: "The Marathon", mobile_number: "0310000000" } } },
    products: { TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", productType: "clothing", sizes: ["M"] } },
    online_orders: {
      9001: {
        ref: "KQZ", shopifyName: "#2301", shopifyGid: "gid://shopify/Order/9001", status: "packed",
        fulfilState: "pending", fulfil: { state: "pending", attempts: 0, requestedAt: NOW - 1000 },
        pack: { saleId: "S1", by: "u1", at: NOW - 1000 },
        customer: { name: "Thandi M", phone: "+27820000000", email: "buyer@example.com" },
        shipping: { address: { address1: "5 Esplanade Road", city: "Cape Town", province: "Western Cape", zip: "7441", country: "South Africa" } },
        lines: [{ pid: "TEE", sizeKey: "M", qty: 1, source: { status: "handed", orderKeys: ["H1"] } }],
        ...order,
      },
    },
    orders: { H1: { onlineOrderId: "9001", channel: "online", status: "ready" } },
  };
}

// Courier Guy, faked. `gate` (a promise) holds the create open, so a test can
// run the other shipper while this one is mid-booking.
function courier({ gate = null, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    getRates: async (body) => { calls.push("getRates"); return body.collection_pickup_point_id ? lockerRates : doorRates; },
    createShipment: async () => {
      calls.push("createShipment");
      if (gate) await gate;
      if (fail) throw fail;
      return { id: 7, short_tracking_reference: "PTJJDH", charged_amount: 129.95 };
    },
    cancelShipment: async () => { throw new Error("never"); },
  };
}

function shopify() {
  const calls = [];
  const graphql = async (query, vars) => {
    calls.push(query);
    if (query.includes("orders(")) return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
    if (query.includes("fulfillmentOrders(")) return { order: { id: vars.id, cancelledAt: null, fulfillmentOrders: { nodes: fos } } };
    if (query.includes("fulfillmentCreate")) return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS" }, userErrors: [] } };
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  return { graphql, calls, fulfils: () => calls.filter((q) => q.includes("fulfillmentCreate")).length };
}

const deps = (f, sh, c, over = {}) => ({
  db: f.db, graphql: sh.graphql, nowMs: async () => NOW, increment, courier: c, courierLog: () => {},
  send: async () => {}, saDate: () => "2026-11-20", resolveAssignment: () => null, log: () => {}, clock: () => NOW + 500,
  ...over,
});
const order = (f) => f.read("online_orders/9001");
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

describe("the fast path ships a packed order at once", () => {
  it("books the waybill, closes the hub order and fulfils Shopify — the tick's own shipOrder, nothing different", async () => {
    const f = fakeDb(world());
    const c = courier();
    const sh = shopify();
    const lines = [];
    const shipper = createFastShipper(deps(f, sh, c, { log: (l) => lines.push(l) }));
    expect(await shipper.consider("9001", order(f))).toBe("shipped");
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(order(f)).toMatchObject({ fulfilState: "done", shipping: { provider: "courier_guy", waybill: "PTJJDH", courierBooking: { state: "booked" }, booking: { waybill: "PTJJDH" } } });
    expect(sh.fulfils()).toBe(1);
    expect(f.read("orders/H1/status")).toBe("collected");
    expect(f.read(`${SHIP_LOCKS_PATH}/9001`)).toBeNull(); // released
    expect(lines.some((l) => /⚡ #2301: waybill PTJJDH/.test(l))).toBe(true);
  });

  it("ignores what is not a packed, pending order", async () => {
    const f = fakeDb(world());
    const shipper = createFastShipper(deps(f, shopify(), courier()));
    expect(shipper.consider("9001", { ...order(f), status: "picking" })).toBeNull();
    expect(shipper.consider("9001", { ...order(f), fulfilState: "done" })).toBeNull();
    expect(shipper.consider("9001", null)).toBeNull();
  });

  it("our own writes re-firing child_changed while shipping run it once", async () => {
    const f = fakeDb(world());
    const gate = deferred();
    const c = courier({ gate: gate.p });
    const sh = shopify();
    const shipper = createFastShipper(deps(f, sh, c));
    const a = shipper.consider("9001", order(f));
    const b = shipper.consider("9001", order(f));
    expect(b).toBe(a);
    gate.resolve();
    await shipper.idle();
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
  });

  it("a stale event for an order already shipped does nothing (fresh read under the lock)", async () => {
    const f = fakeDb(world());
    const staleCopy = order(f);
    const c = courier();
    const sh = shopify();
    const shipper = createFastShipper(deps(f, sh, c));
    await shipper.consider("9001", staleCopy);
    expect(await shipper.consider("9001", staleCopy)).toBe("not_pending");
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
  });

  it("never ships another store's order (Concrete's poller owns it)", async () => {
    const f = fakeDb(world({ order: { sourceStore: "concrete" } }));
    const c = courier();
    const shipper = createFastShipper(deps(f, shopify(), c));
    expect(await shipper.consider("9001", order(f))).toBe("not_ours");
    expect(c.calls).toHaveLength(0);
  });

  it("a refused booking takes the same 'Packed, courier not booked' path, and the next tick's sweep emails it", async () => {
    const f = fakeDb(world());
    await f.db.ref(`${META_PATH}/attentionSweepAt`).set(NOW - 1000);
    const c = courier({ fail: Object.assign(new Error("HTTP 400 bad address"), { status: 400 }) });
    const shipper = createFastShipper(deps(f, shopify(), c));
    expect(await shipper.consider("9001", order(f))).toBe("shipped");
    expect(order(f)).toMatchObject({ fulfilState: "courier_failed", attention: { kind: "courier_failed" }, attentionOpen: true });
    expect(f.read(`${META_PATH}/attentionSweepAt`)).toBe(0); // 0 = never swept: the next tick sweeps
  });

  it("a throw leaves the order pending for the tick, and says so", async () => {
    const f = fakeDb(world());
    const lines = [];
    const shipper = createFastShipper(deps(f, shopify(), courier(), { log: (l) => lines.push(l), shipOne: async () => { throw new Error("boom"); } }));
    expect(await shipper.consider("9001", order(f))).toBe("error");
    expect(order(f).fulfilState).toBe("pending");
    expect(lines.join("\n")).toMatch(/fast ship failed — boom; the next tick retries/);
  });
});

describe("review fixes (architect review)", () => {
  it("a hub-order close that fails after the booking: order left pending, never 'not booked'; the retry fulfils with the same waybill", async () => {
    const f = fakeDb(world());
    const c = courier();
    const sh = shopify();
    const realRef = f.db.ref;
    let breakHub = true;
    const db = { ref: (path) => {
      const r = realRef(path);
      return path.startsWith("orders/") && breakHub ? { ...r, transaction: async () => { throw new Error("hub write refused"); } } : r;
    } };
    const shipper = createFastShipper(deps({ ...f, db }, sh, c));
    expect(await shipper.consider("9001", order(f))).toBe("error");
    expect(order(f)).toMatchObject({ fulfilState: "pending", shipping: { waybill: "PTJJDH" } });
    expect(sh.fulfils()).toBe(0);
    breakHub = false;
    await runOrdersPoll(deps({ ...f, db }, sh, c)); // the tick's fallback
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(order(f)).toMatchObject({ fulfilState: "done", shipping: { waybill: "PTJJDH" } });
    expect(sh.fulfils()).toBe(1);
  });

  it("a throw before the ship (the ownership read) is caught, never an unhandled rejection", async () => {
    const f = fakeDb(world({ order: { sourceStore: undefined } }));
    const db = { ref: (path) => (path.endsWith("/sourceStore") ? { get: async () => { throw new Error("read refused"); } } : f.db.ref(path)) };
    // A second parcel key makes ownsOrderAt read its parent's store.
    const shipper = createFastShipper(deps({ ...f, db }, shopify(), courier(), { shipOne: async () => { throw new Error("must not be reached"); } }));
    await expect(shipper.consider("9001r1", { ...order(f), status: "packed", fulfilState: "pending" })).resolves.toBeTypeOf("string");
  });

  it("ships at most maxParallel orders at a time (the backlog on attach)", async () => {
    const f = fakeDb(world());
    let now = 0, peak = 0;
    const gates = [];
    const shipOne = async () => { now++; peak = Math.max(peak, now); await new Promise((r) => gates.push(r)); now--; return { result: "shipped" }; };
    const shipper = createFastShipper(deps(f, shopify(), courier(), { shipOne, maxParallel: 2 }));
    for (const id of ["1", "2", "3", "4", "5"]) shipper.consider(id, { status: "packed", fulfilState: "pending" });
    for (let i = 0; i < 5; i++) { await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0)); gates.shift()(); }
    await shipper.idle();
    expect(peak).toBe(2);
  });

  it("the listener passes its cancel callback to both queries", () => {
    const ons = [];
    const q = { on: (ev, cb, cancel) => ons.push([ev, cancel]), off: () => {} };
    const db = { ref: () => ({ orderByChild: () => ({ equalTo: () => q }) }) };
    const onCancel = () => {};
    listenForPacked(db, () => {}, { onCancel });
    expect(ons).toEqual([["child_added", onCancel], ["child_changed", onCancel]]);
  });
});

describe("the tick and the fast path never ship one order twice", () => {
  it("fast path mid-booking, the tick comes round: the tick leaves it, one waybill, one fulfilment, done", async () => {
    const f = fakeDb(world());
    const gate = deferred();
    const c = courier({ gate: gate.p });
    const sh = shopify();
    const shipper = createFastShipper(deps(f, sh, c));
    const fast = shipper.consider("9001", order(f));
    await vi.waitFor(() => expect(c.calls).toContain("createShipment"));
    const tickLines = [];
    const tick = await runOrdersPoll(deps(f, sh, c, { log: (l) => tickLines.push(l) }));
    expect(tickLines.join("\n")).toMatch(/being shipped by the other shipper/);
    expect(tick.courierFailed ?? 0).toBe(0);
    gate.resolve();
    expect(await fast).toBe("shipped");
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
    expect(order(f)).toMatchObject({ fulfilState: "done", shipping: { waybill: "PTJJDH" } });
    expect(order(f).attention ?? null).toBeNull();
  });

  it("the tick mid-booking, the Pack's event arrives: the fast path leaves it", async () => {
    const f = fakeDb(world());
    const gate = deferred();
    const c = courier({ gate: gate.p });
    const sh = shopify();
    const tick = runOrdersPoll(deps(f, sh, c));
    await vi.waitFor(() => expect(c.calls).toContain("createShipment"));
    const shipper = createFastShipper(deps(f, sh, c));
    expect(await shipper.consider("9001", order(f))).toBe("locked");
    gate.resolve();
    await tick;
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
    expect(order(f).fulfilState).toBe("done");
  });

  it("fast path finished first: the tick's pending list is stale, the fresh read says done, nothing more happens", async () => {
    const f = fakeDb(world());
    const c = courier();
    const sh = shopify();
    const snapshot = order(f);
    await createFastShipper(deps(f, sh, c)).consider("9001", snapshot);
    // The tick queried pending before the fast path finished, then reaches the order.
    expect(await shipOrderLocked({ db: f.db, log: () => {} }, "9001", snapshot, { owner: "tick" })).toBe("not_pending");
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
  });

  it("two fast shippers (a second copy started by hand) racing: one waybill", async () => {
    const f = fakeDb(world());
    const gate = deferred();
    const c = courier({ gate: gate.p });
    const sh = shopify();
    const a = createFastShipper(deps(f, sh, c)).consider("9001", order(f));
    await vi.waitFor(() => expect(c.calls).toContain("createShipment"));
    const b = createFastShipper(deps(f, sh, c)).consider("9001", order(f));
    gate.resolve();
    expect(new Set([await a, await b])).toEqual(new Set(["shipped", "locked"]));
    expect(c.calls.filter((x) => x === "createShipment")).toHaveLength(1);
    expect(sh.fulfils()).toBe(1);
  });
});

describe("the ship lock", () => {
  const T = NOW;
  it("is held while young and its owner lives; lapses when old, or when its owner on this machine is dead", () => {
    const rec = { owner: "tick", host: "mini", pid: 4242, token: "x", at: T };
    expect(shipLockHeld(rec, { nowMs: T + 1000, host: "mini", isAlive: () => true })).toBe(true);
    expect(shipLockHeld(rec, { nowMs: T + SHIP_LOCK_TTL_MS, host: "mini", isAlive: () => true })).toBe(false);
    expect(shipLockHeld(rec, { nowMs: T + 1000, host: "mini", isAlive: () => false })).toBe(false);
    // Another machine's pid cannot be checked from here: only age counts.
    expect(shipLockHeld(rec, { nowMs: T + 1000, host: "laptop", isAlive: () => false })).toBe(true);
    // A stamp from far in the future is not a lock.
    expect(shipLockHeld({ ...rec, at: T + 3600_000 }, { nowMs: T, host: "mini", isAlive: () => true })).toBe(false);
    expect(shipLockHeld(null, { nowMs: T })).toBe(false);
  });

  it("one taker wins; release by the wrong token does nothing; the right token frees it", async () => {
    const f = fakeDb({});
    const a = await takeShipLock(f.db, "9001", { owner: "fast", nowMs: T, host: "mini", pid: 1, isAlive: () => true });
    const b = await takeShipLock(f.db, "9001", { owner: "tick", nowMs: T + 10, host: "mini", pid: 2, isAlive: () => true });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    await releaseShipLock(f.db, "9001", "not-mine");
    expect(f.read(`${SHIP_LOCKS_PATH}/9001/token`)).toBe(a);
    await releaseShipLock(f.db, "9001", a);
    expect(f.read(`${SHIP_LOCKS_PATH}/9001`)).toBeNull();
    // A dead owner's lock (a tick SIGKILLed by the runner) is taken over at once.
    await takeShipLock(f.db, "9002", { owner: "tick", nowMs: T, host: "mini", pid: 3, isAlive: () => true });
    expect(await takeShipLock(f.db, "9002", { owner: "fast", nowMs: T + 5, host: "mini", pid: 4, isAlive: (pid) => pid !== 3 })).toBeTruthy();
  });

  it("refuses a key that is not a database segment", async () => {
    await expect(takeShipLock(fakeDb({}).db, "a/b", { owner: "fast" })).rejects.toThrow();
  });
});
