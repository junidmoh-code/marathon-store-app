// ── The line swap: POS "Replace" → poller → THE swap (scripts/lib/swap-line.mjs) ──
// Through the real poll tick against the fake RTDB:
//   • swap before the pick (clothing): old strip entry closed, new one raised,
//     holds moved, difference owed → the agent's money slot + Junid emailed
//   • swap after the handover: RETURN TO SHELF (hub order stamped / Trophy strip
//     row / the order's returns record), nothing deducted, nothing moved
//   • footwear: the old three-letter hub order cancelled, a NEW code issued
//   • dearer: refused without the second tap; recorded with it
//   • the customer agent's swap and the manual swap leave the same line record
//   • the reconciler: after pack + fulfil both variants are pushed from app stock
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runOrdersPoll } from "./poll.mjs";
import { candidateCode } from "./orderRefs.mjs";
import { fakeDb, increment } from "./fakeDb.testutil.mjs";
import { swapOnlineOrderLine, swappedLine, swapFromRecord } from "../../lib/swap-line.mjs";
import { runCustomerAgent } from "../../online/agent/run.mjs";
import { planProduct } from "../inventorySync.mjs";
import { holdRowsFor } from "./orderModel.mjs";

let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-24T08:00:00Z");
const GO_LIVE = Date.parse("2026-10-24T07:00:00Z");
const C = (i, g = 0, id = "9001") => candidateCode(`${id}:${i}:0:${g}`, 0);
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const P = (n) => `gid://shopify/Product/${n}`;
const YASMIN = { uid: "u-yasmin", name: "Yasmin" };

function world(over = {}) {
  return {
    online_orders_meta: { goLiveAtMs: GO_LIVE },
    config: { onlineOrders: { enabled: true } },
    products: {
      SNK: { name: "Air Runner", categoryKey: "sneakers", category: "Footwear", sizes: ["8", "9"], retailPrice: 500, photoUrl: "https://x/snk.jpg" },
      KAP: { name: "Kapri White", categoryKey: "sneakers", category: "Footwear", sizes: ["8"], retailPrice: 500, photoUrl: "https://x/kap.jpg" },
      TEE: { name: "Club Tee", categoryKey: "tees", category: "Clothing", sizes: ["M"], barcodes: { M: "6001" }, retailPrice: 250, photoUrl: "https://x/tee.jpg" },
      POLO: { name: "Club Polo", categoryKey: "tees", category: "Clothing", sizes: ["M"], barcodes: { M: "7001" }, retailPrice: 200, photoUrl: "https://x/polo.jpg" },
      JKT: { name: "Club Jacket", categoryKey: "jackets", category: "Clothing", sizes: ["M"], barcodes: { M: "8001" }, retailPrice: 900 },
    },
    shopify_sync: {
      _claims: { 111: "SNK", 222: "TEE" },
      SNK: { shopifyProductId: P(111), variants: { 8: { shopifyVariantId: V(1108), shopifyInventoryItemId: "inv-snk-8" } } },
      TEE: { shopifyProductId: P(222), variants: { M: { shopifyVariantId: V(222001), shopifyInventoryItemId: "inv-tee-m" } } },
    },
    stock: {
      hub1: { SNK: { 8: { qty: 1 } }, KAP: { 8: { qty: 1 } } },
      hub2: {},
      "marathon-pe": { TEE: { M: { qty: 1 } }, JKT: { M: { qty: 1 } } },
      trophy: { POLO: { M: { qty: 2 } } },
    },
    ...over,
  };
}

function shopifyOrder() {
  return {
    id: "gid://shopify/Order/9001", legacyResourceId: "9001", name: "#1801", number: 1801,
    createdAt: "2026-10-24T07:30:00Z", updatedAt: "2026-10-24T07:31:00Z", cancelledAt: null,
    displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED",
    email: "buyer@example.com", phone: null,
    customer: { firstName: "Thandi", lastName: "M" },
    shippingAddress: { name: "Thandi M", address1: "1 Main Rd", city: "Gqeberha", zip: "6001", country: "South Africa" },
    currentSubtotalPriceSet: { shopMoney: { amount: "750.00", currencyCode: "ZAR" } },
    currentTotalPriceSet: { shopMoney: { amount: "850.00", currencyCode: "ZAR" } },
    totalShippingPriceSet: { shopMoney: { amount: "100.00" } },
    currentTotalTaxSet: { shopMoney: { amount: "0.00" } },
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/1", title: "Air Runner", variantTitle: "8", quantity: 1, currentQuantity: 1, variant: { id: V(1108), product: { id: P(111) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "500.00" } } },
      { id: "gid://shopify/LineItem/2", title: "Club Tee", variantTitle: "M", quantity: 1, currentQuantity: 1, variant: { id: V(222001), product: { id: P(222) } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "250.00" } } },
    ] },
  };
}

function harness(f, { orders = [shopifyOrder()] } = {}) {
  const mails = [];
  const graphql = async (q) => {
    if (q.includes("orders(")) return { orders: { nodes: orders, pageInfo: { hasNextPage: false } } };
    throw new Error(`unexpected ${q.slice(0, 40)}`);
  };
  const deps = {
    db: f.db, graphql, nowMs: async () => NOW, send: async (m) => { mails.push(m); }, increment,
    saDate: () => "2026-10-24", log: () => {}, courier: { getRates: async () => { throw new Error("no rates"); } }, courierLog: () => {},
  };
  return { mails, tick: (over = {}) => runOrdersPoll({ ...deps, ...over }) };
}

const order = (f) => f.read("online_orders/9001");
const line = (f, i) => order(f).lines[i];
const request = (f, rid = "r1") => f.read(`online_orders/9001/swapRequests/${rid}`);
async function ask(f, i, pid, size, extra = {}) {
  const l = line(f, i);
  await f.db.ref(`online_orders/9001/swapRequests/${extra.rid || "r1"}`).set({ lineIndex: i, pid, size, expectPid: l.pid, expectSizeKey: l.sizeKey, by: YASMIN, at: NOW, state: "pending", ...(extra.priceDecision ? { priceDecision: extra.priceDecision } : {}) });
}

async function ingested() {
  const f = fakeDb(world());
  const h = harness(f);
  await h.tick();
  // Line 0: the pair at Hub 1 on hub order C(0); line 1: the tee on PE's strip.
  expect(line(f, 0).source).toMatchObject({ locationId: "hub1", status: "pick", orderKeys: [C(0)] });
  expect(line(f, 1).source).toMatchObject({ locationId: "marathon-pe", status: "display", entryKey: "displayChecks_active/marathon-pe/online__9001__1" });
  return { f, h };
}

describe("swap before the pick (clothing)", () => {
  it("closes the old strip entry, raises the new one where the stock is, moves the hold, recalculates the parcel", async () => {
    const { f, h } = await ingested();
    const sigBefore = order(f).shipping?.estimate?.sig ?? null;
    await ask(f, 1, "POLO", "M");
    await h.tick();
    expect(request(f)).toMatchObject({ state: "applied", creditCents: 5000 });
    const l = line(f, 1);
    expect(l).toMatchObject({ pid: "POLO", size: "M", sizeKey: "M", title: "Club Polo", unitPriceCents: 20000, originalUnitPriceCents: 25000, routeGen: 1, barcode: "7001" });
    expect(l.source).toMatchObject({ locationId: "trophy", status: "display", entryKey: "displayChecks_active/trophy/online__9001__1_r1" });
    expect(l.swappedFrom).toMatchObject({ pid: "TEE", size: "M", title: "Club Tee", locationId: "marathon-pe", status: "display", by: YASMIN, via: "pos", at: NOW });
    // The old entry is a cancelled tombstone (never deleted); the new one is open at Trophy.
    expect(f.read("displayChecks_active/marathon-pe/online__9001__1")).toMatchObject({ status: "completed", result: "cancelled" });
    expect(f.read("displayChecks_active/trophy/online__9001__1_r1")).toMatchObject({ kind: "online_pick", productId: "POLO", status: "open" });
    // Holds: the tee's row is gone, the polo is held at Trophy; the pair untouched.
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    expect(f.read("online_reservations/POLO/M/9001")).toMatchObject({ qty: 1, locs: { trophy: 1 } });
    expect(f.read("online_reservations/SNK/8/9001")).toMatchObject({ qty: 1, locs: { hub1: 1 } });
    // No return: nothing was handed over.
    expect(order(f).returns).toBeUndefined();
    // Nothing deducted anywhere.
    expect(f.read("stock/marathon-pe/TEE/M/qty")).toBe(1);
    expect(f.read("stock/trophy/POLO/M/qty")).toBe(2);
    // The parcel estimate follows the lines.
    const sigAfter = order(f).shipping?.estimate?.sig ?? null;
    if (sigBefore) expect(sigAfter).not.toBe(sigBefore);
    if (sigAfter) expect(sigAfter).toContain("POLO|M|1");
  });

  it("cheaper: R50 owed to the customer — the agent's money slot (manual, no Shopify call) and Junid emailed", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "POLO", "M");
    await h.tick();
    expect(line(f, 1).resolution.money).toMatchObject({ kind: "credit", amountCents: 5000, state: "manual", via: "junid_email" });
    expect(line(f, 1).resolution.outcome).toMatchObject({ kind: "swap", pid: "POLO", creditCents: 5000, by: "Yasmin", via: "pos" });
    const m = h.mails.find((x) => /store credit R50/.test(x.subject));
    expect(m.subject).toMatch(/PLEASE DO THIS BY HAND/);
    expect(m.text).toMatch(/Swapped at the POS by Yasmin/);
  });

  it("a request is applied once — a second tick does nothing more", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "POLO", "M");
    await h.tick();
    const n = f.writes.length, mails = h.mails.length;
    await h.tick();
    expect(line(f, 1).routeGen).toBe(1);
    expect(h.mails.length).toBe(mails);
    expect(f.writes.slice(n).filter(([, p]) => p.includes("/lines/1/") && !p.includes("estimate"))).toEqual([]);
  });

  it("a crash after the swap landed (request still 'applying'): the next tick finishes THAT request — applied, owed once, never refused", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "POLO", "M");
    // The first run: claimed, swapped, then died before saying so.
    await f.db.ref("online_orders/9001/swapRequests/r1").update({ state: "applying", claimedAt: NOW - 10 * 60e3 });
    const first = await swapOnlineOrderLine({ db: f.db, orderKey: "9001", lineIndex: 1, newPid: "POLO", size: "M", by: YASMIN, via: "pos", requestId: "r1", expect: { pid: "TEE", sizeKey: "M" }, now: NOW, increment });
    expect(first.ok).toBe(true);
    await h.tick();
    expect(request(f)).toMatchObject({ state: "applied", creditCents: 5000 });
    expect(line(f, 1).routeGen).toBe(1); // swapped once, not twice
    expect(line(f, 1).resolution.money).toMatchObject({ kind: "credit", amountCents: 5000, state: "manual" });
    expect(h.mails.filter((m) => /store credit R50/.test(m.subject))).toHaveLength(1);
  });

  it("a stale request (the line changed since Yasmin looked) is refused, nothing written", async () => {
    const { f, h } = await ingested();
    await f.db.ref("online_orders/9001/swapRequests/r1").set({ lineIndex: 1, pid: "POLO", size: "M", expectPid: "SOMETHING-ELSE", expectSizeKey: "M", by: YASMIN, at: NOW, state: "pending" });
    await h.tick();
    expect(request(f)).toMatchObject({ state: "refused" });
    expect(request(f).why).toMatch(/changed since/);
    expect(line(f, 1).pid).toBe("TEE");
  });
});

describe("dearer", () => {
  it("is refused without the second tap, nothing changes", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "JKT", "M");
    await h.tick();
    expect(request(f)).toMatchObject({ state: "refused" });
    expect(request(f).why).toMatch(/R650 more/);
    expect(line(f, 1).pid).toBe("TEE");
  });
  it("customer pays: applied, recorded, Junid told to collect; we absorb: applied, recorded, no email", async () => {
    for (const decision of ["customer_pays", "we_absorb"]) {
      const { f, h } = await ingested();
      // The jacket is on PE's floor, where the tee was — same shop, new entry key.
      await ask(f, 1, "JKT", "M", { priceDecision: decision });
      await h.tick();
      expect(request(f)).toMatchObject({ state: "applied", extraCents: 65000 });
      expect(line(f, 1).resolution.outcome).toMatchObject({ extraCents: 65000, priceDecision: decision });
      expect(line(f, 1).resolution.money).toBeUndefined(); // nothing charged, nothing credited
      expect(line(f, 1).source).toMatchObject({ locationId: "marathon-pe", status: "display", entryKey: "displayChecks_active/marathon-pe/online__9001__1_r1" });
      const collect = h.mails.filter((m) => /collect it/.test(m.subject));
      expect(collect).toHaveLength(decision === "customer_pays" ? 1 : 0);
    }
  });
});

describe("footwear", () => {
  it("cancels the old three-letter hub order and issues a NEW code for the new pair", async () => {
    const { f, h } = await ingested();
    const old = C(0);
    expect(f.read(`orders/${old}`)).toMatchObject({ status: "incoming", productId: "SNK" });
    await ask(f, 0, "KAP", "8");
    await h.tick();
    expect(f.read(`orders/${old}`)).toBeNull(); // gone from Hub 1's queue (it was not sent)
    const fresh = C(0, 1);
    expect(fresh).not.toBe(old);
    expect(line(f, 0).source).toMatchObject({ locationId: "hub1", status: "pick", orderKeys: [fresh] });
    expect(f.read(`orders/${fresh}`)).toMatchObject({ status: "incoming", productId: "KAP", channel: "online", onlineOrderId: "9001", onlineLineIndex: 0 });
    expect(line(f, 0).swappedFrom).toMatchObject({ pid: "SNK", hubOrders: [old] });
    expect(f.read("online_reservations/SNK/8/9001")).toBeNull();
    expect(f.read("online_reservations/KAP/8/9001")).toMatchObject({ qty: 1, locs: { hub1: 1 } });
    expect(f.read("online_order_refs")[fresh]).toBeTruthy();
  });
});

describe("swap after the handover — RETURN TO SHELF", () => {
  it("a pair the hub already sent: the old hub order is stamped, the order lists the return, nothing deducted", async () => {
    const { f, h } = await ingested();
    const old = C(0);
    await f.db.ref(`orders/${old}/status`).set("ready");
    await h.tick(); // the poller copies "sent" → handed
    expect(line(f, 0).source.status).toBe("handed");
    // Yasmin had already confirmed the pair (its code) and the basket tick.
    await f.db.ref("online_orders/9001/codesIn").set({ [old]: true });
    await f.db.ref("online_orders/9001/basket").set({ 0: true });
    await ask(f, 0, "KAP", "8");
    await h.tick();
    expect(f.read(`orders/${old}`)).toMatchObject({ status: "ready", returnToShelf: { by: "Yasmin", swappedTo: "Kapri White 8" } });
    expect(Object.values(order(f).returns)).toEqual([expect.objectContaining({ lineIndex: 0, pid: "SNK", locationId: "hub1", hubOrders: [old], state: "open", by: "Yasmin" })]);
    expect(f.read("stock/hub1/SNK/8/qty")).toBe(1);
    expect(line(f, 0).source).toMatchObject({ status: "pick", orderKeys: [C(0, 1)] });
    // The replacement is NOT in the basket: the old pair's confirmations went with it.
    expect(order(f).basket?.[0]).toBeUndefined();
    expect(order(f).codesIn?.[old]).toBeUndefined();
  });

  it("a Trophy item already handed over: a Put back row on Trophy's strip", async () => {
    const f = fakeDb(world({ stock: { hub1: { SNK: { 8: { qty: 1 } } }, "marathon-pe": {}, trophy: { TEE: { M: { qty: 1 } }, POLO: { M: { qty: 2 } } } } }));
    const h = harness(f);
    await h.tick();
    expect(line(f, 1).source).toMatchObject({ locationId: "trophy", status: "display" });
    // Trophy answered "Handed over" (the callable's tombstone + line flip).
    await f.db.ref("displayChecks_active/trophy/online__9001__1").update({ status: "completed", result: "handed", completedAt: NOW });
    await f.db.ref("online_orders/9001/lines/1/source/status").set("handed");
    await ask(f, 1, "POLO", "M");
    await h.tick();
    const ret = order(f).returns["1_1"];
    expect(ret).toMatchObject({ pid: "TEE", locationId: "trophy", state: "open", entryKey: "displayChecks_active/trophy/online__9001__1_r1__return" });
    expect(f.read(ret.entryKey)).toMatchObject({ kind: "online_return", status: "open", productId: "TEE", returnId: "1_1", orderId: "9001", lineIndex: 1 });
    // The handed tombstone is left as it was (the hand-over happened).
    expect(f.read("displayChecks_active/trophy/online__9001__1")).toMatchObject({ result: "handed" });
    expect(f.read("stock/trophy/TEE/M/qty")).toBe(1);
  });
});

describe("one swap, two callers: the customer agent and the POS leave the same line record", () => {
  it("same fields, same swappedFrom shape, same outcome shape (only who/how differ)", async () => {
    const base = { lineId: "l1", shopifyLineItemId: "gid://shopify/LineItem/2", pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee", unitPriceCents: 25000, isFootwear: false, photoUrl: "https://x/tee.jpg" };
    // The agent: an unavailable line, the customer picks the polo.
    const fa = fakeDb({
      ...world(),
      online_orders: { 9001: { orderNumber: 1801, shopifyGid: "gid://shopify/Order/9001", status: "picking", customer: { name: "Thandi M", email: "t@example.com" }, totals: { currency: "ZAR" },
        lines: [{ ...base, source: { status: "unavailable" }, escalation: { phase: "unavailable" }, resolution: { conversation: { state: "offering", email: "t@example.com", tag: "[#1801 item l1]", startedAt: NOW - 1000, outbound: 1, sends: { a: { kind: "offer", sentAt: NOW - 1000 } }, offers: { 0: { pid: "POLO", size: "M", sizeKey: "M", title: "Club Polo", priceCents: 20000, locationId: "trophy", status: "display", photoUrl: "https://x/polo.jpg", category: "Clothing" } } } } }] } },
      online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, phase: "unavailable", agent: { state: "offering" } } },
    });
    await runCustomerAgent({
      db: fa.db, nowMs: async () => NOW, increment, log: () => {}, mailer: async () => {}, notifyJunid: async () => {}, whatsapp: null,
      model: { words: async () => ({ opening: "Sorry.", closing: "Thanks." }), classify: async () => ({ intent: "pick", n: 1 }) },
      inbox: { replies: async () => [{ id: "<m1@x>", key: "m1", text: "1", date: NOW }] },
      findAlternatives: async () => [], listingTitle: async () => "Cotton tee", scopes: async () => new Set(), graphql: async () => { throw new Error("no"); },
    });
    const agentLine = fa.read("online_orders/9001/lines/0");
    expect(agentLine.pid).toBe("POLO");
    // The POS: the same line on the strip, swapped through THE swap.
    const fm = fakeDb({ ...world(), online_orders: { 9001: { orderNumber: 1801, status: "picking", lines: [{ ...base, source: { locationId: "marathon-pe", status: "display" } }] } } });
    const out = await swapOnlineOrderLine({ db: fm.db, orderKey: "9001", lineIndex: 0, newPid: "POLO", size: "M", by: YASMIN, via: "pos", now: NOW, increment });
    expect(out.ok).toBe(true);
    const posLine = fm.read("online_orders/9001/lines/0");
    const shape = (l) => ({ keys: Object.keys(l).filter((k) => !["barcode", "isFootwear", "category", "resolution"].includes(k)).sort(), from: Object.keys(l.swappedFrom).filter((k) => k !== "hubOrders" && k !== "locationId").sort(), outcome: Object.keys(l.resolution.outcome).filter((k) => !["extraCents", "priceDecision"].includes(k)).sort() });
    // (An unavailable line has no place, so the agent's swappedFrom carries no
    // locationId — RTDB drops a null; the POS line's says where it was.)
    expect(shape(posLine)).toEqual(shape(agentLine));
    expect(posLine.swappedFrom.locationId).toBe("marathon-pe");
    const same = (l) => ({ pid: l.pid, size: l.size, sizeKey: l.sizeKey, title: l.title, unitPriceCents: l.unitPriceCents, originalUnitPriceCents: l.originalUnitPriceCents, routeGen: l.routeGen, source: { locationId: l.source.locationId, status: l.source.status }, from: { pid: l.swappedFrom.pid, title: l.swappedFrom.title, unitPriceCents: l.swappedFrom.unitPriceCents }, credit: l.resolution.outcome.creditCents });
    expect(same(posLine)).toEqual(same(agentLine));
    expect(agentLine.swappedFrom).toMatchObject({ via: "agent", by: "customer agent" });
    expect(posLine.swappedFrom).toMatchObject({ via: "pos", by: YASMIN });
  });

  it("swappedLine is the builder both use: escalation goes, routeGen moves on, what was paid stays", () => {
    const cur = { pid: "A", size: "M", sizeKey: "M", unitPriceCents: 100, routeGen: 2, escalation: { phase: "x" }, source: { locationId: "hub2", status: "pick", orderKeys: ["ABC"] } };
    const from = swapFromRecord(cur, { at: 1, by: "x", via: "pos" });
    const out = swappedLine(cur, { pid: "B", size: "L", title: "B", priceCents: 80, locationId: "trophy", status: "display" }, { swappedFrom: from, outcome: { kind: "swap" } });
    expect(out).toMatchObject({ pid: "B", sizeKey: "L", unitPriceCents: 80, originalUnitPriceCents: 100, routeGen: 3, source: { locationId: "trophy", status: "display" } });
    expect(out.escalation).toBeUndefined();
    expect(out.source.orderKeys).toBeUndefined();
  });
});

describe("the reconciler after a swap (the Shopify order is never edited)", () => {
  // planProduct is THE comparison every push uses. App truth: TEE M = 1 at PE
  // (never deducted — the tee stayed on the shelf); Shopify's unfulfilled order
  // still commits the tee's line item until the pack's fulfilment.
  // → the on_hand the push would SET for size M.
  const plan = (pid, totals, reserved, committed) => planProduct({
    map: { variants: { M: { shopifyInventoryItemId: `inv-${pid}` } } }, variants: [],
    baseline: new Map([[`inv-${pid}`, 0]]), totals, reserved, committed: new Map([[`inv-${pid}`, committed]]),
  }).known.find((x) => x.sizeKey === "M").quantity;

  it("the original tee is pushed back to its full app count once the order is fulfilled; the polo carries its hold until the pack", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "POLO", "M");
    await h.tick();
    const holds = holdRowsFor(order(f));
    // Before the pack: the tee has NO hold (the swap released it). Shopify still
    // commits 1 for the unfulfilled tee line → on_hand 1, available 0 until fulfilled.
    expect(holds["TEE/M"]).toBeUndefined();
    expect(plan("TEE", { M: 1 }, { M: holds["TEE/M"]?.qty ?? 0 }, 1)).toBe(1);
    // The polo: held (Shopify has no order on it) → pushed as 2 − 1 = 1.
    expect(plan("POLO", { M: 2 }, { M: holds["POLO/M"].qty }, 0)).toBe(1);
    // After the pack (polo deducted at Trophy, holds gone) and the fulfilment
    // (Shopify took the tee off on_hand): the tee is pushed back to 1 — NOT left
    // sold out — and the polo to its new app count.
    expect(plan("TEE", { M: 1 }, { M: 0 }, 0)).toBe(1);
    expect(plan("POLO", { M: 1 }, { M: 0 }, 0)).toBe(1);
  });

  it("the fulfilment marks BOTH products dirty, so the push happens on that same tick", async () => {
    const { f, h } = await ingested();
    await ask(f, 1, "POLO", "M");
    await h.tick();
    // The pack (the POS's atomic write), simplified: the order is packed, fulfil pending.
    await f.db.ref("online_orders/9001").update({ status: "packed", fulfilState: "pending", pack: { saleId: "s1", at: NOW } });
    const before = { TEE: f.read("shopify_inventory_dirty/TEE") || 0, POLO: f.read("shopify_inventory_dirty/POLO") || 0 };
    const fulfilGraphql = async (q, v) => {
      if (q.includes("orders(")) return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
      if (q.includes("fulfillmentOrders(")) return { order: { id: v.id, cancelledAt: null, fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/1", status: "OPEN", lineItems: { nodes: [{ id: "fol1", remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/1" } }, { id: "fol2", remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/2" } }] } }] } } };
      if (q.includes("fulfillmentCreate")) return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS" }, userErrors: [] } };
      throw new Error(`unexpected ${q.slice(0, 40)}`);
    };
    await h.tick({ graphql: fulfilGraphql, courier: { getRates: async () => { throw new Error("x"); }, createShipment: async () => { throw new Error("x"); } } });
    expect(order(f).fulfilState).toBe("done");
    expect(f.read("shopify_inventory_dirty/TEE")).toBeGreaterThan(before.TEE);
    expect(f.read("shopify_inventory_dirty/POLO")).toBeGreaterThan(before.POLO);
  });
});
