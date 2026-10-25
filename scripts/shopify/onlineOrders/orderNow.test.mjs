// ── POS "Order it now" → poller → the new-order route (Junid, 2026-10-25) ────
// Through the real poll tick against the fake RTDB.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { orderNowBlocker, describeChecked, ORDER_NOW } from "./orderNowRequests.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-25T08:00:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;
const JUNID = { uid: "u-junid", name: "Junid" };
const REFILL = "web_9001_0_r1s0";

// #1794's shape: Nike Shox size 7, Hub 1 said out of stock, Central asked for a refill.
const shox = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: LI(1), variantId: V(1107), productGid: P(111), pid: "SHX", size: "7", sizeKey: "7", qty: 1,
  title: "Nike Shox TL Full Black", isFootwear: true, unitPriceCents: 250000, category: "Footwear",
  source: { status: "resolving", locationId: "hub1" },
  escalation: { chain: "footwear", home: "hub1", round: 1, idx: 0, phase: "await", request: { kind: "refill", key: REFILL, from: "central", to: "hub1", at: NOW - 86400e3 }, attempts: [{ location: "hub1", action: "routed", result: "no_stock", at: NOW - 90000e3 }] },
  ...over,
});
const tee = (over = {}) => ({
  lineId: "l1", shopifyLineItemId: LI(2), variantId: V(222001), productGid: P(222), pid: "TEE", size: "M", sizeKey: "M", qty: 1,
  title: "Club Tee", isFootwear: false, unitPriceCents: 25000, category: "Clothing",
  source: { status: "handed", locationId: "marathon-pe", entryKey: "displayChecks_active/marathon-pe/online__9001__1" },
  ...over,
});
const tap = (i, line, over = {}) => ({ lineIndex: i, expectPid: line.pid, expectSizeKey: line.sizeKey, expectStatus: line.source.status, expectRouteGen: line.routeGen || 0, by: JUNID, at: NOW - 60e3, state: "pending", ...over });

function world({ lines = [shox(), tee()], stock = {}, requests = null, refill = { status: "open" }, enabled = true, over = {} } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 5 * 86400e3, cursorMs: NOW },
    config: { onlineOrders: { enabled } },
    products: { SHX: { name: "Nike Shox TL", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8"] }, TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", sizes: ["M"], barcodes: { M: "6001" } } },
    shopify_sync: {
      _claims: { 111: "SHX", 222: "TEE" },
      SHX: { shopifyProductId: P(111), variants: { 7: { shopifyVariantId: V(1107) } } },
      TEE: { shopifyProductId: P(222), variants: { M: { shopifyVariantId: V(222001) } } },
    },
    stock: { hub1: {}, hub2: {}, "marathon-pe": {}, trophy: {}, central: {}, ...stock },
    refill_requests: refill ? { [REFILL]: { productId: "SHX", size: "7", qty: 1, requestingLocation: "hub1", createdFrom: { via: "online_escalation" }, ...refill } } : {},
    online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "await" } },
    online_orders: {
      9001: {
        orderNumber: 1794, shopifyGid: "gid://shopify/Order/9001", shopifyName: "#1794", status: "picking",
        customer: { name: "Sipho N" }, lines,
        ...(requests ? { orderNowRequests: requests } : {}),
      },
    },
    ...over,
  };
}
const deps = (f, at = NOW) => ({ db: f.db, graphql: null, nowMs: async () => at, send: async () => {}, increment, saDate: () => "2026-10-25", log: () => {} });
const tick = (f, at = NOW) => runOrdersPoll(deps(f, at));
const req = (f, rid = "0_0") => f.read(`online_orders/9001/orderNowRequests/${rid}`);
const line0 = (f) => f.read("online_orders/9001/lines/0");

describe("Order it now", () => {
  // ── Junid, 25 Oct 09:52: only the online order's piece of an open request ──
  const OURS = { via: "online_escalation", orderKey: "9001", lineIndex: 0, ref: "#1794" };
  const wa = [];
  const tickWa = (f) => runOrdersPoll({ ...deps(f), whatsappJunid: async (m) => { wa.push(m); } });
  beforeEach(() => { wa.length = 0; });

  it("a request raised FOR this order (qty 1): withdrawn 1 → 0, the line goes to the pick, the change is logged", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 1 } } } }, refill: { status: "open", createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    await tickWa(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, routedTo: "hub1", released: { key: REFILL, action: "cancel", before: 1, after: 0 } });
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "cancelled", cancelReason: "no_longer_needed", qty: 1 });
    expect(line0(f).source).toMatchObject({ status: "pick", locationId: "hub1" });
    expect(Object.values(f.read("online_orders/9001/requestChanges"))).toEqual([expect.objectContaining({ key: REFILL, action: "cancel", before: 1, after: 0 })]);
    expect(wa).toEqual([]);
  });

  it("a MIXED request (3 = 1 online + 2 genuine): reduced by exactly 1 → 2, still open for the 2 genuine", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 5 } } } }, refill: { status: "open", qty: 3, createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    await tickWa(f);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", qty: 2, onlineReleased: { qty: 1, before: 3, after: 2 } });
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, released: { action: "reduce", before: 3, after: 2 } });
    // Exactly the line's quantity is pulled, never more — Hub 1 holds 5.
    const codes = line0(f).source.orderKeys;
    expect(codes.length).toBe(1);
    expect(f.read(`orders/${codes[0]}`)).toMatchObject({ onlineUnit: 0, hub: "hub1" });   // one hub order = one unit
  });

  it("a genuine refill (no website-order tag) is never cancelled or reduced: nothing changes, Junid gets a WhatsApp", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 1 } } } }, refill: { status: "open", qty: 3, createdFrom: { manual: false, source: "scan" } }, requests: { "0_0": tap(0, shox()) } }));
    await tickWa(f);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", qty: 3 });
    expect(f.read(`refill_requests/${REFILL}`).onlineReleased).toBeUndefined();
    expect(req(f)).toMatchObject({ state: ORDER_NOW.REFUSED });
    expect(req(f).why).toMatch(/could not be told .*nothing was changed and Junid has been told/);
    expect(line0(f)).toMatchObject({ source: { status: "resolving" }, escalation: { phase: "await" } });
    expect(wa.length).toBe(1);
    expect(wa[0]).toMatch(/#1794, line 1 .*could not tell which part of the refill request web_9001_0_r1s0/);
    expect(f.read("online_orders/9001/requestChanges")).toBeNull();
  });

  it("can't tell: a tagged request holding LESS than the line asked for is left alone and Junid is told", async () => {
    const two = shox({ qty: 2 });
    const f = fakeDb(world({ lines: [two, tee()], stock: { hub1: { SHX: { 7: { qty: 3 } } } }, refill: { status: "open", qty: 1, createdFrom: OURS }, requests: { "0_0": tap(0, two) } }));
    await tickWa(f);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", qty: 1 });
    expect(req(f).state).toBe(ORDER_NOW.REFUSED);
    expect(wa.length).toBe(1);
  });

  it("a request Central is already picking is left to Central: refused as already ordered, nothing changes", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 1 } } } }, refill: { status: "open", picking: { by: "x" }, createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    await tickWa(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.REFUSED });
    expect(req(f).why).toMatch(/^already ordered: a refill from Central for this line \(web_9001_0_r1s0\) is being worked on/);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open" });
    expect(line0(f).source.status).toBe("resolving");
    expect(wa).toEqual([]);
  });

  it("no stock found: the request is not touched at all", async () => {
    const f = fakeDb(world({ refill: { status: "open", createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    await tickWa(f);
    expect(req(f).state).toBe(ORDER_NOW.NOT_IN_STOCK);
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ status: "open", qty: 1 });
  });

  it("stock fixed at Hub 1 on a line Hub 1 said out of stock (no request open): a hub pick is raised through the new-order route", async () => {
    const l = shox({ escalation: { chain: "footwear", home: "hub1", round: 1, idx: 0, phase: "unavailable", attempts: [] }, source: { status: "unavailable" } });
    const f = fakeDb(world({ lines: [l, tee()], refill: null, stock: { hub1: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": tap(0, l) } }));
    await tick(f);
    const r = req(f);
    expect(r).toMatchObject({ state: ORDER_NOW.ORDERED, routedTo: "hub1", by: JUNID });
    const ln = line0(f);
    expect(ln.source).toMatchObject({ status: "pick", locationId: "hub1" });
    expect(ln.source.orderKeys).toHaveLength(1);
    expect(ln.escalation).toBeUndefined();
    expect(ln.routeGen).toBe(1);
    expect(ln.orderNow).toMatchObject({ rid: "0_0", by: JUNID, at: NOW - 60e3 });
    const hub = f.read(`orders/${ln.source.orderKeys[0]}`);
    expect(hub).toMatchObject({ customerName: "Shopify", channel: "online", onlineOrderId: "9001", onlineLineIndex: 0 });
    expect(f.read("online_escalations/9001_0")).toBeNull();
    expect(f.read("online_reservations/SHX/7/9001")).toMatchObject({ qty: 1, locs: { hub1: 1 } });
    expect(f.read("online_orders/9001/status")).toBe("picking");
    expect(f.read("stock/hub1/SHX/7/qty")).toBe(1); // nothing deducted: only the Pack does
  });

  it("not there yet: says where it looked and leaves the line grey", async () => {
    const un = shox({ escalation: { chain: "footwear", home: "hub1", round: 1, idx: 0, phase: "unavailable", attempts: [] }, source: { status: "unavailable" } });
    const f = fakeDb(world({ lines: [un, tee()], stock: { central: { SHX: { 7: { qty: 2 } } } }, requests: { "0_0": tap(0, un) } }));
    await tick(f);
    const r = req(f);
    expect(r.state).toBe(ORDER_NOW.NOT_IN_STOCK);
    expect(r.checked).toEqual({ free: [{ loc: "hub1", free: 0 }, { loc: "hub2", free: 0 }], central: 2 });
    expect(describeChecked(r.checked)).toBe("Hub 1: 0 free, Hub 2: 0 free · Central has 2 (Central sends by refill, not a pick)");
    expect(line0(f)).toMatchObject({ source: { status: "unavailable" }, escalation: { phase: "unavailable" } });
  });

  it("units another website order holds do not count", async () => {
    const un = shox({ escalation: undefined, source: { status: "no_stock", locationId: null } });
    const f = fakeDb(world({ lines: [un, tee()], refill: null, stock: { hub1: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": tap(0, un) }, over: { online_escalations: {}, config: { onlineOrders: { enabled: true, escalationOff: true } }, online_reservations: { SHX: { 7: { 8888: { qty: 1, locs: { hub1: 1 } } } } } } }));
    await tick(f);
    expect(req(f).state).toBe(ORDER_NOW.NOT_IN_STOCK);
  });

  it("never twice: a line already on a pick, being routed, sent and on its way, or mid-raise is refused", () => {
    const base = { enabled: true };
    const pick = shox({ source: { status: "pick", locationId: "hub1", orderKeys: ["QGZ"] }, escalation: undefined });
    expect(orderNowBlocker({ ...base, line: pick, req: tap(0, pick) })).toMatch(/a pick is already open for this line at Hub 1 \(QGZ\)/);
    const rr = shox({ source: { status: "reroute" } });
    expect(orderNowBlocker({ ...base, line: rr, req: tap(0, rr) })).toMatch(/already being routed/);
    const wait = shox({ escalation: { ...shox().escalation, phase: "wait", request: null, deliverAt: "hub1", waitUntil: NOW + 3600e3 } });
    expect(orderNowBlocker({ ...base, line: wait, req: tap(0, wait) })).toMatch(/already ordered: it was sent to Hub 1/);
    const raising = shox({ escalation: { ...shox().escalation, phase: "raise", pending: { kind: "refill" } } });
    expect(orderNowBlocker({ ...base, line: raising, req: tap(0, raising) })).toMatch(/being raised right now/);
    const swapped = shox({ swappedFrom: { pid: "OLD" } });
    expect(orderNowBlocker({ ...base, line: swapped, req: tap(0, swapped) })).toMatch(/replaced/);
    const offered = shox({ escalation: undefined, awaitingCustomer: { since: NOW, what: "pick an alternative", by: "jimmy-auto" } });
    expect(orderNowBlocker({ ...base, line: offered, req: tap(0, offered) })).toMatch(/offered alternatives/);
    expect(orderNowBlocker({ enabled: false, line: shox(), req: tap(0, shox()) })).toMatch(/switched off/);
    expect(orderNowBlocker({ ...base, line: shox(), req: tap(0, shox(), { expectSizeKey: "8" }) })).toMatch(/changed since the tap/);
    const free = shox({ escalation: undefined, source: { status: "no_stock" } });
    expect(orderNowBlocker({ ...base, line: free, req: tap(0, free) })).toBeNull();
  });

  it("a request is answered once; a second tick does nothing more", async () => {
    const un = shox({ escalation: undefined, source: { status: "no_stock", locationId: null } });
    const f = fakeDb(world({ lines: [un, tee()], refill: null, stock: { hub1: { SHX: { 7: { qty: 2 } } } }, requests: { "0_0": tap(0, un) }, over: { online_escalations: {}, config: { onlineOrders: { enabled: true, escalationOff: true } } } }));
    await tick(f);
    const code = line0(f).source.orderKeys[0];
    await tick(f, NOW + 120e3);
    expect(line0(f).source.orderKeys).toEqual([code]);
    expect(req(f).state).toBe(ORDER_NOW.ORDERED);
    expect(Object.keys(f.read("orders") || {}).filter((k) => f.read(`orders/${k}`)?.onlineOrderId === "9001")).toHaveLength(1);
  });

  it("a crash after the line went to reroute is resumed as ordered, never refused", async () => {
    const l = shox({ source: { status: "reroute" }, escalation: undefined, orderNow: { rid: "0_0", by: JUNID, at: NOW - 60e3 } });
    const f = fakeDb(world({ lines: [l, tee()], stock: { hub1: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": { ...tap(0, shox()), state: "applying", claimedAt: NOW - 10 * 60e3 } } }));
    await tick(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, resumed: true });
    expect(line0(f).source.status).toBe("pick");
  });

  it("a not-found shirt with no escalation goes back on the shop's list (the non-footwear route)", async () => {
    const t = tee({ lineId: "l0", source: { status: "not_found", locationId: "marathon-pe" } });
    const f = fakeDb(world({ lines: [t], refill: null, stock: { trophy: { TEE: { M: { qty: 1 } } } }, requests: { "0_0": tap(0, t) }, over: { online_escalations: {}, config: { onlineOrders: { enabled: true, escalationOff: true } } } }));
    await tick(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, routedTo: "trophy" });
    expect(line0(f).source).toMatchObject({ status: "display", locationId: "trophy" });
  });

  it("never twice: a hub already sent a unit of this line (the wrong size) → refused, the sent unit is not orphaned", async () => {
    const l = shox({ escalation: undefined, source: { status: "needs_attention", locationId: "hub1", orderKeys: ["QGZ"], entryKey: "orders/QGZ", reason: "Hub 1 sent size 8" } });
    const f = fakeDb(world({ lines: [l, tee()], refill: null, stock: { hub1: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": tap(0, l) },
      over: { online_escalations: {}, orders: { QGZ: { channel: "online", onlineOrderId: "9001", onlineLineIndex: 0, status: "ready", sentSize: "8", hub: "hub1" } } } }));
    await tick(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.REFUSED });
    expect(req(f).why).toMatch(/Hub 1 already sent a unit of this line \(QGZ\)/);
    expect(line0(f).source.status).toBe("needs_attention");
  });

  it("a walk-in line whose hub order is still open: re-routed, the OLD hub order is cancelled, one live pick only; the attention is cleared", async () => {
    const l = shox({ escalation: undefined, source: { status: "needs_attention", locationId: "hub1", orderKeys: ["QGZ"], entryKey: "orders/QGZ" } });
    const f = fakeDb(world({ lines: [l, tee()], refill: null, stock: { hub2: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": tap(0, l) },
      over: { online_escalations: {}, orders: { QGZ: { channel: "online", onlineOrderId: "9001", onlineLineIndex: 0, status: "incoming", hub: "hub1" } } } }));
    f.db.ref("online_orders/9001").update({ status: "needs_attention", attention: { kind: "walkin_override", at: NOW - 1 }, attentionOpen: true });
    await tick(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, routedTo: "hub2" });
    expect(f.read("orders/QGZ")).toBeNull();
    const keys = line0(f).source.orderKeys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe("QGZ");
    expect(f.read("online_orders/9001/attention")).toBeNull();
    expect(f.read("online_orders/9001/status")).toBe("picking");
  });

  it("refused while the order is being packed, while Junid's override is pending, or with money on the line", () => {
    const base = { enabled: true };
    expect(orderNowBlocker({ ...base, line: shox(), req: tap(0, shox()), order: { packClaim: { saleId: "s" } } })).toMatch(/being packed/);
    const ov = shox({ escalation: undefined, escalationOverride: { kind: "unavailable", by: "Junid", at: 1 } });
    expect(orderNowBlocker({ ...base, line: ov, req: tap(0, ov) })).toMatch(/Junid's decision/);
    const money = shox({ escalation: undefined, resolution: { money: { kind: "credit" } } });
    expect(orderNowBlocker({ ...base, line: money, req: tap(0, money) })).toMatch(/refund, credit/);
    const nb = shox({ escalation: undefined, source: { status: "no_stock" } });
    expect(orderNowBlocker({ ...base, line: nb, req: tap(0, nb), order: { basket: { 0: true } }, i: 0 })).toMatch(/already in the basket/);
  });

  it("a check that keeps failing is answered after 3 attempts, so Pack is never blocked forever", async () => {
    const un = shox({ escalation: undefined, source: { status: "no_stock", locationId: null } });
    const f = fakeDb(world({ lines: [un, tee()], refill: null, stock: { hub1: { SHX: { 7: { qty: 1 } } } }, requests: { "0_0": { ...tap(0, un), state: "applying", claimedAt: NOW - 10 * 60e3, attempts: 2 } }, over: { online_escalations: {}, config: { onlineOrders: { enabled: true, escalationOff: true } } } }));
    const orig = f.db.ref.bind(f.db);
    f.db.ref = (p) => (String(p).startsWith("stock/central") ? { get: async () => { throw new Error("read timed out"); } } : orig(p));
    await tick(f);
    expect(req(f)).toMatchObject({ state: ORDER_NOW.REFUSED });
    expect(req(f).why).toMatch(/could not be checked \(read timed out\)/);
  });
});

// ── Review fixes (Sonnet architect, #792) ─────────────────────────────────────
describe("Order it now — after a release", () => {
  const OURS = { via: "online_escalation", orderKey: "9001", lineIndex: 0, ref: "#1794" };
  it("a reduced request loses its online tag (never taken back twice) and the line's next chain gets new keys", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 5 } } } }, refill: { status: "open", qty: 3, createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    await runOrdersPoll({ ...deps(f), whatsappJunid: async () => {} });
    const row = f.read(`refill_requests/${REFILL}`);
    expect(row).toMatchObject({ qty: 2, createdFrom: { via: "online_escalation_released" }, onlineReleased: { before: 3, after: 2, escKey: REFILL, tag: OURS } });
    expect(row.onlineRef).toBeUndefined();   // RTDB drops a null
    expect(line0(f).escalationGen).toBe(1);
    expect(line0(f).orderNow.release).toMatchObject({ kind: "refill", key: REFILL, piece: 1 });
  });

  it("a crash between the re-route and the release: the retry finishes it, once (3 → 2, never 2 → 1)", async () => {
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 5 } } } }, refill: { status: "open", qty: 3, createdFrom: OURS }, requests: { "0_0": tap(0, shox()) } }));
    // The state a crash leaves: the line already re-routed with its release recorded, the request untouched, "applying".
    const l = { ...shox(), escalation: null, escalationGen: 1, source: { status: "reroute", locationId: "hub1" },
      orderNow: { rid: "0_0", by: JUNID, at: NOW - 60e3, appliedAt: NOW - 600e3, release: { kind: "refill", key: REFILL, from: "central", to: "hub1", escKey: REFILL, piece: 1 } } };
    await f.db.ref("online_orders/9001/lines/0").set(l);
    await f.db.ref("online_orders/9001/orderNowRequests/0_0").set({ ...tap(0, shox()), state: "applying", claimedAt: NOW - 600e3 });
    await runOrdersPoll({ ...deps(f), whatsappJunid: async () => {} });
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ qty: 2, status: "open" });
    expect(req(f)).toMatchObject({ state: ORDER_NOW.ORDERED, resumed: true, released: { action: "reduce", before: 3, after: 2 } });
    // A further retry finds the piece already taken back.
    await f.db.ref("online_orders/9001/orderNowRequests/0_0").set({ ...tap(0, shox()), state: "applying", claimedAt: NOW - 600e3 });
    await runOrdersPoll({ ...deps(f), whatsappJunid: async () => {} });
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ qty: 2 });
  });

  it("Junid is told ONCE per request, however many taps", async () => {
    const wa = [];
    const genuine = { status: "open", qty: 3, createdFrom: { source: "scan" } };
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 1 } } } }, refill: genuine, requests: { "0_0": tap(0, shox()) } }));
    await runOrdersPoll({ ...deps(f), whatsappJunid: async (m) => { wa.push(m); } });
    await f.db.ref("online_orders/9001/orderNowRequests/0_0").set({ ...tap(0, shox()), at: NOW });
    await runOrdersPoll({ ...deps(f), whatsappJunid: async (m) => { wa.push(m); } });
    expect(wa).toHaveLength(1);
    expect(req(f).state).toBe(ORDER_NOW.REFUSED);   // the second tap was answered too — just not re-sent
    expect(f.read(`refill_requests/${REFILL}`)).toMatchObject({ qty: 3, status: "open" });
  });

  it("WhatsApp down → Junid is emailed instead", async () => {
    const mails = [];
    const f = fakeDb(world({ stock: { hub1: { SHX: { 7: { qty: 1 } } } }, refill: { status: "open", qty: 3, createdFrom: { source: "scan" } }, requests: { "0_0": tap(0, shox()) } }));
    await runOrdersPoll({ ...deps(f), send: async (m) => { mails.push(m); }, whatsappJunid: async () => { throw new Error("gateway down"); } });
    const ours = mails.filter((m) => /a request needs your eye/.test(m.subject));
    expect(ours).toHaveLength(1);
    expect(ours[0].text).toMatch(/could not tell which part/);
  });
});
