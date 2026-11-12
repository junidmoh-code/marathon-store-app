// ── Junid, 12 Nov 2026: website lines pick from Hub 3, Concrete and Pine too ──
// Through the real poll tick against the fake RTDB: a line the Marathon
// division cannot fill falls back to the Concrete division (Hub 3 → a hub
// order "Shopify" + three-letter code; Concrete / Pine → their website strip),
// Central is never a source, a line nobody holds WAITS on refill and routes
// itself the tick stock lands, nothing raises a request, nothing deducts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { isWaitingOnRefill, waitingBlocker, waitingStamp } from "./waitingReroute.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-11-12T08:00:00Z");
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;

const shoe = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: LI(1), variantId: V(1107), productGid: P(111), pid: "SHX", size: "7", sizeKey: "7", qty: 1,
  title: "Nike Shox TL", isFootwear: true, unitPriceCents: 250000, category: "Footwear",
  source: { status: "no_stock" }, ...over,
});
const tee = (over = {}) => ({
  lineId: "l1", shopifyLineItemId: LI(2), variantId: V(222001), productGid: P(222), pid: "TEE", size: "M", sizeKey: "M", qty: 1,
  title: "Club Tee", isFootwear: false, unitPriceCents: 25000, category: "Clothing",
  source: { status: "no_stock" }, ...over,
});

function world({ lines, stock = {}, enabled = true, settings = {} } = {}) {
  return {
    online_orders_meta: { goLiveAtMs: NOW - 5 * 86400e3, cursorMs: NOW },
    config: { onlineOrders: { enabled, escalationOff: true } },
    displayChecks_settings: settings,
    products: {
      SHX: { name: "Nike Shox TL", categoryKey: "sneakers", category: "Footwear", sizes: ["7"] },
      TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", sizes: ["M"] },
    },
    shopify_sync: {
      _claims: { 111: "SHX", 222: "TEE" },
      SHX: { shopifyProductId: P(111), variants: { 7: { shopifyVariantId: V(1107) } } },
      TEE: { shopifyProductId: P(222), variants: { M: { shopifyVariantId: V(222001) } } },
    },
    stock: { hub1: {}, hub2: {}, hub3: {}, "marathon-pe": {}, trophy: {}, concrete: {}, "marathon-pine": {}, central: {}, ...stock },
    online_orders: {
      9100: { orderNumber: 2100, shopifyGid: "gid://shopify/Order/9100", shopifyName: "#2100", status: "needs_attention", customer: { name: "Thandi" }, lines },
    },
  };
}
// The CLI's judge (orders-poll.mjs → isWebsiteStripEnabled): a strip is on
// unless that store's Display Checks are switched OFF explicitly.
const stripJudge = (f) => async (shop) => f.read(`displayChecks_settings/${shop}/enabled`) !== false;
const tick = (f, at = NOW) => runOrdersPoll({
  db: f.db, graphql: null, nowMs: async () => at, send: async () => {}, increment, saDate: () => "2026-11-12", log: () => {},
  displayFeedEnabled: stripJudge(f),
});
const line = (f, i) => f.read(`online_orders/9100/lines/${i}`);
const snapshotStock = (f) => JSON.stringify(f.read("stock"));

describe("a waiting line routes itself to the Concrete division when only it holds the stock", () => {
  it("Hub 3 sneaker → a hub order: customer Shopify, three-letter code, hub hub3, delivered to shipping; nothing deducted", async () => {
    const f = fakeDb(world({ lines: [shoe()], stock: { hub3: { SHX: { 7: { qty: 2 } } } } }));
    const before = snapshotStock(f);
    await tick(f);
    const l = line(f, 0);
    expect(l.source).toMatchObject({ status: "pick", locationId: "hub3" });
    const [code] = l.source.orderKeys;
    expect(code).toMatch(/^[A-Z]{3}$/);
    expect(f.read(`orders/${code}`)).toMatchObject({
      customerName: "Shopify", hub: "hub3", placedAtHub: "hub3", destShop: "marathon-pe",
      channel: "online", onlineOrderId: "9100", onlineLineIndex: 0, productType: "sneaker", status: "incoming",
    });
    expect(snapshotStock(f)).toBe(before);              // stock deducts only at Pack
    expect(f.read("refill_requests") ?? null).toBeNull();  // nothing requested
    expect(f.read("online_reservations/SHX/7/9100")).toMatchObject({ locs: { hub3: 1 } });
  });

  it("Concrete clothing → Concrete's website strip (online_pick), exactly like PE / Trophy", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { concrete: { TEE: { M: { qty: 1 } } } } }));
    const before = snapshotStock(f);
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "display", locationId: "concrete", entryKey: "displayChecks_active/concrete/online__9100__0_r1" });
    expect(f.read("displayChecks_active/concrete/online__9100__0_r1")).toMatchObject({ kind: "online_pick", productId: "TEE", size: "M", qty: 1, status: "open", orderId: "9100", ref: "#2100" });
    expect(snapshotStock(f)).toBe(before);
    expect(f.read("refill_requests") ?? null).toBeNull();
  });

  it("Pine clothing → Pine's website strip, even though Pine's Display Checks are not switched on", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { "marathon-pine": { TEE: { M: { qty: 3 } } } } }));
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "display", locationId: "marathon-pine" });
    expect(f.read("displayChecks_active/marathon-pine/online__9100__0_r1")).toMatchObject({ kind: "online_pick", status: "open" });
  });

  it("a store whose Display Checks are switched OFF explicitly is skipped (it could not close the entry)", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { concrete: { TEE: { M: { qty: 1 } } }, "marathon-pine": { TEE: { M: { qty: 1 } } } }, settings: { concrete: { enabled: false } } }));
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "display", locationId: "marathon-pine" });
  });

  it("Marathon still wins: PE before Concrete", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { "marathon-pe": { TEE: { M: { qty: 1 } } }, concrete: { TEE: { M: { qty: 5 } } } } }));
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "display", locationId: "marathon-pe" });
  });
});

describe("waiting on refill — Central is listed but never picked, and nothing is requested", () => {
  it("only Central holds it: the line WAITS, stamped with what it waits on; no request, no hub order, no strip entry", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { central: { TEE: { M: { qty: 6 } } } } }));
    const before = snapshotStock(f);
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "no_stock", waiting: { on: "refill", centralQty: 6, checkedAt: NOW } });
    expect(line(f, 0).source.locationId ?? null).toBeNull();
    expect(f.read("refill_requests") ?? null).toBeNull();
    expect(f.read("orders") ?? null).toBeNull();
    expect(f.read("displayChecks_active") ?? null).toBeNull();
    expect(snapshotStock(f)).toBe(before);
  });

  it("a second quiet tick writes nothing new (the stamp only changes with Central's count)", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { central: { TEE: { M: { qty: 6 } } } } }));
    await tick(f);
    await tick(f, NOW + 120e3);
    expect(line(f, 0).source.waiting).toEqual({ on: "refill", centralQty: 6, checkedAt: NOW });
  });

  it("the refill scan's box lands at Hub 2: the next tick routes it as normal", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { central: { TEE: { M: { qty: 6 } } } } }));
    await tick(f);
    await f.db.ref("stock/hub2/TEE/M").set({ qty: 1 });   // the scan's refill arrived
    await tick(f, NOW + 120e3);
    const l = line(f, 0);
    expect(l.source).toMatchObject({ status: "pick", locationId: "hub2" });
    expect(l.source.waiting ?? null).toBeNull();
    expect(f.read(`orders/${l.source.orderKeys[0]}`)).toMatchObject({ hub: "hub2", customerName: "Shopify" });
  });

  it("a no_stock a HUB gave (it has a location) is left for a person — never bounced back to that hub", async () => {
    const f = fakeDb(world({ lines: [shoe({ source: { status: "no_stock", locationId: "hub1", reason: "hub1 marked it out of stock" } })], stock: { hub1: { SHX: { 7: { qty: 1 } } } } }));
    await tick(f);
    expect(line(f, 0).source).toMatchObject({ status: "no_stock", locationId: "hub1" });
    expect(f.read("orders") ?? null).toBeNull();
  });

  it("feeds switched off: nothing is routed or stamped", async () => {
    const f = fakeDb(world({ lines: [tee()], stock: { concrete: { TEE: { M: { qty: 1 } } } }, enabled: false }));
    await tick(f);
    expect(line(f, 0).source).toEqual({ status: "no_stock" });
  });
});

describe("the pure parts", () => {
  it("isWaitingOnRefill: no_stock with no location only", () => {
    expect(isWaitingOnRefill(tee())).toBe(true);
    expect(isWaitingOnRefill(tee({ source: { status: "no_stock", locationId: "hub2" } }))).toBe(false);
    expect(isWaitingOnRefill(tee({ source: { status: "not_found" } }))).toBe(false);
  });
  it("waitingBlocker leaves busy lines alone", () => {
    expect(waitingBlocker({ line: tee(), order: {}, enabled: true })).toBeNull();
    expect(waitingBlocker({ line: tee(), order: { packClaim: {} }, enabled: true })).toMatch(/packed/);
    expect(waitingBlocker({ line: tee({ awaitingCustomer: true }), order: {}, enabled: true })).toMatch(/customer/);
    expect(waitingBlocker({ line: tee({ swappedFrom: {} }), order: {}, enabled: true })).toMatch(/replaced/);
    expect(waitingBlocker({ line: tee({ escalation: { phase: "await" } }), order: {}, enabled: true })).toMatch(/escalation/);
  });
  it("waitingStamp is stable for an unchanged count", () => {
    const s = waitingStamp(null, 3, 1);
    expect(waitingStamp(s, 3, 2)).toBe(s);
    expect(waitingStamp(s, 0, 2)).toEqual({ on: "refill", centralQty: 0, checkedAt: 2 });
  });
});
