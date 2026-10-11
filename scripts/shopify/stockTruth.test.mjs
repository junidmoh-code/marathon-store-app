// ── Stock truth: the app's inventory is the only source of Shopify quantities ─
//
// The cases Junid's brief of 2026-10-11 asked for (docs/SHOPIFY-STOCK-TRUTH.md),
// driven end to end through the real movement path → syncProduct → the
// Shopify write, against a fake RTDB and a fake Shopify that both behave like
// the real ones where it matters:
//
//   · RTDB stores no empty object or array: writing one deletes the key, and
//     removing the last child removes the parent.
//   · RTDB answers an orderByChild range query with only the matching rows —
//     and every read is LOGGED, so a whole-node read is a test failure.
//   · Shopify ignores quantities on an untracked variant, and its compare-and-
//     set write fails when the quantity moved since the baseline read.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { syncProduct, zeroUnmanagedListing, isListedOnShopify } from "./inventorySync.mjs";
import { ONLINE_EXCLUDED_LOCATIONS } from "./inventory.mjs";
import {
  sweepMovements, planMovementPass, nextCursorState, CURSOR_PATH, LOOKBACK_MS, MAX_HOLD_MS,
} from "./movementSync.mjs";
import { summarize, oversell, exceedsZeroGuard, rollbackEntries, keysNeedingGidLookup } from "./stockTruth.mjs";

const require = createRequire(import.meta.url);

// ── Fake RTDB ────────────────────────────────────────────────────────────────
function fakeRtdb(store) {
  const reads = [];
  const parts = (p) => p.split("/").filter(Boolean);
  const at = (p) => {
    let n = store;
    for (const k of parts(p)) { n = n?.[k]; if (n === undefined) return null; }
    return n ?? null;
  };
  const isEmpty = (v) => v !== null && typeof v === "object" && Object.keys(v).length === 0;
  const prune = (ps) => {
    for (let i = ps.length - 1; i >= 1; i--) {
      const parent = at(ps.slice(0, i - 1).join("/")) ?? store;
      const holder = i - 1 === 0 ? store : parent;
      const key = ps[i - 1];
      if (isEmpty(holder?.[key])) delete holder[key];
    }
  };
  const setAt = (p, v) => {
    const ps = parts(p);
    // An empty object or array is a delete on the real server.
    if (v === null || v === undefined || isEmpty(v)) {
      const parent = at(ps.slice(0, -1).join("/"));
      if (parent && typeof parent === "object") delete parent[ps.at(-1)];
      prune(ps);
      return;
    }
    let n = store;
    for (const k of ps.slice(0, -1)) { if (typeof n[k] !== "object" || n[k] === null) n[k] = {}; n = n[k]; }
    n[ps.at(-1)] = JSON.parse(JSON.stringify(v));
    // Nested empties and nulls inside the value are dropped too — RTDB never stores either.
    const strip = (o) => { for (const [k, x] of Object.entries(o)) { if (x === null) delete o[k]; else if (typeof x === "object") { strip(x); if (isEmpty(x)) delete o[k]; } } };
    if (typeof n[ps.at(-1)] === "object") {
      strip(n[ps.at(-1)]);
      // A value that was nothing but empties is itself a delete.
      if (isEmpty(n[ps.at(-1)])) { delete n[ps.at(-1)]; prune([...ps, "x"]); }
    }
  };
  const ref = (path) => {
    const node = {
      get: async () => { reads.push({ path, query: null }); const v = at(path); return { val: () => (v === null ? null : JSON.parse(JSON.stringify(v))) }; },
      set: async (v) => setAt(path, v),
      update: async (o) => { for (const [k, v] of Object.entries(o)) setAt(`${path}/${k}`, v); },
      orderByChild: (child) => ({
        startAt: (from) => ({
          get: async () => {
            reads.push({ path, query: { orderByChild: child, startAt: from } });
            const all = at(path) || {};
            const out = {};
            for (const [k, row] of Object.entries(all)) if (row?.[child] != null && row[child] >= from) out[k] = row;
            return { val: () => (Object.keys(out).length ? JSON.parse(JSON.stringify(out)) : null) };
          },
        }),
      }),
    };
    return node;
  };
  return { db: { ref }, reads, store };
}

// ── Fake Shopify ─────────────────────────────────────────────────────────────
// products: { gid: [{ variantId, title, itemId, tracked, policy, qty }] }
function fakeShopify(products, { failSetFor = new Set(), pageSize = 100 } = {}) {
  const items = () => Object.values(products).flat();
  const calls = [];
  const graphql = async (query, vars = {}) => {
    calls.push(query.replace(/\s+/g, " ").slice(0, 60));
    if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Shop" }] } };
    if (query.includes("inventorySetQuantities")) {
      // The app's count is written to ON_HAND; a test that sees "available"
      // here has found the re-opened-web-order bug.
      if (vars.input.name !== "on_hand") throw new Error(`fake Shopify: push wrote ${vars.input.name}, not on_hand`);
      for (const q of vars.input.quantities) {
        const it = items().find((i) => i.itemId === q.inventoryItemId);
        if (failSetFor.has(q.inventoryItemId)) throw new Error("Shopify unavailable");
        if (it.qty !== q.changeFromQuantity) return { inventorySetQuantities: { userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", message: "stale" }] } };
      }
      for (const q of vars.input.quantities) items().find((i) => i.itemId === q.inventoryItemId).qty = q.quantity;
      return { inventorySetQuantities: { userErrors: [] } };
    }
    if (query.includes("productVariantsBulkUpdate")) {
      const out = [];
      for (const v of vars.variants) {
        const it = items().find((i) => i.variantId === v.id);
        it.tracked = v.inventoryItem.tracked; it.policy = v.inventoryPolicy;
        out.push({ id: it.variantId, inventoryPolicy: it.policy, inventoryItem: { tracked: it.tracked } });
      }
      return { productVariantsBulkUpdate: { productVariants: out, userErrors: [] } };
    }
    if (query.includes("variants(first: 100")) {
      const vs = products[vars.id];
      if (!vs) return { product: null };
      // Pages of `pageSize` (100 on the real shop), so paging is exercised.
      const from = vars.after ? Number(vars.after) : 0;
      const page = vs.slice(from, from + pageSize);
      return { product: { id: vars.id, variants: {
        pageInfo: { hasNextPage: from + pageSize < vs.length, endCursor: String(from + pageSize) },
        nodes: page.map((v) => ({ id: v.variantId, title: v.title, inventoryPolicy: v.policy, inventoryItem: { id: v.itemId, tracked: v.tracked } })),
      } } };
    }
    if (query.includes("product(id: $id) { id }")) return { product: products[vars.id] ? { id: vars.id } : null };
    if (query.includes("nodes(ids: $ids)")) {
      return { nodes: vars.ids.map((id) => { const it = items().find((i) => i.itemId === id); return it ? { id, inventoryLevel: { quantities: [{ name: "available", quantity: it.qty - (it.committed || 0) }, { name: "on_hand", quantity: it.qty }] } } : null; }) };
    }
    throw new Error(`fake Shopify: unexpected query ${query.slice(0, 80)}`);
  };
  // What a customer can buy of one item: unlimited when Shopify is not counting.
  // `qty` is on_hand; `committed` is web orders taken and not yet fulfilled.
  const buyable = (itemId) => { const it = items().find((i) => i.itemId === itemId); return !it.tracked || it.policy !== "DENY" ? Infinity : Math.max(0, it.qty - (it.committed || 0)); };
  return { graphql, calls, buyable, products };
}

const GID = "gid://shopify/Product/1";
const LOCS = { central: { active: true }, hub1: { active: true }, hub2: { active: true }, "marathon-pe": { active: true }, trophy: { active: true }, "marathon-pine": { active: true }, hub3: { active: true }, in_transit: { active: true }, concrete: { active: true } };
const variant = (size, qty, { tracked = true, policy = "DENY" } = {}) => ({ variantId: `gid://shopify/ProductVariant/${size}`, title: size, itemId: `gid://shopify/InventoryItem/${size}`, tracked, policy, qty });

function world({ stock, shop, movements = {}, cursor = null, publish = { state: "live", liveState: "on" } }) {
  const store = {
    locations: LOCS,
    stock,
    stock_movements: movements,
    shopify_publish: { p1: publish },
    shopify_sync: {
      p1: { shopifyProductId: GID, variants: Object.fromEntries(["6", "7"].map((s) => [s, { shopifyInventoryItemId: `gid://shopify/InventoryItem/${s}` }])) },
      ...(cursor ? { _movementCursor: cursor } : {}),
    },
  };
  const rtdb = fakeRtdb(store);
  const shopify = fakeShopify({ [GID]: shop });
  const pass = (opts = {}) => sweepMovements(rtdb.db, {
    commit: true,
    nowMs: Date.parse("2026-10-11T10:00:00Z"),
    isListed: async (pid) => isListedOnShopify((await rtdb.db.ref(`shopify_publish/${pid}`).get()).val()),
    push: (pid) => syncProduct(rtdb.db, shopify.graphql, pid, { commit: true }),
    ...opts,
  });
  return { rtdb, shopify, pass };
}

const mv = (key, row) => ({ [key]: { productId: "p1", qty: 1, ...row } });

describe("a sale in a shop reaches Shopify on the next tick", () => {
  it("drops Shopify to 0 when the shop sold its last unit", async () => {
    const { rtdb, shopify, pass } = world({
      // After the sale: PE holds none of size 6, nowhere else does either.
      stock: { "marathon-pe": { p1: { 6: { qty: 0 }, 7: { qty: 2 } } } },
      shop: [variant("6", 1), variant("7", 2)],
      movements: mv("sold:s1:marathon-pe:p1:6", { type: "sold", size: "6", from: "marathon-pe", ts: "2026-10-11T09:58:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    const r = await pass();
    expect(r.failed).toBe(0);
    expect(r.pushed).toBe(1);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/7")).toBe(2);
    // The cursor moved to the sale and the row is remembered, so it is not pushed twice.
    expect(rtdb.store.shopify_sync._movementCursor.cursorMs).toBe(Date.parse("2026-10-11T09:58:00Z"));
    expect(Object.keys(rtdb.store.shopify_sync._movementCursor.seen)).toEqual(["sold:s1:marathon-pe:p1:6"]);
    const again = await pass();
    expect(again.products).toBe(0);
  });

  it("switches tracking ON where Shopify was ignoring the number — Junid's John Richmond case", async () => {
    const { shopify, pass } = world({
      stock: { "marathon-pe": { p1: { 6: { qty: 0 } } } },
      // The app pushed 0 long ago; Shopify ignored it because tracking was off.
      shop: [variant("6", 0, { tracked: false }), variant("7", 0, { tracked: false })],
      movements: mv("sold:s2:marathon-pe:p1:6", { type: "sold", size: "6", from: "marathon-pe", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(Infinity);
    const r = await pass();
    expect(r.failed).toBe(0);
    expect(r.results[0].trackingFixed).toBe(2);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/7")).toBe(0);
  });

  it("zeroes a variant on the listing that the id map does not name", async () => {
    const extra = { ...variant("8", 3), title: "8" };
    const { shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shop: [variant("6", 1), variant("7", 0), extra],
      movements: mv("adjustment:a1", { type: "adjustment", size: "6", to: "hub1", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    expect(shopify.buyable("gid://shopify/InventoryItem/8")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(1);
  });
});

describe("a transfer between locations leaves the total unchanged", () => {
  it("sends no Shopify write when hub → shop moves a unit inside the pool", async () => {
    const { shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } }, "marathon-pe": { p1: { 6: { qty: 1 }, 7: { qty: 1 } } } },
      shop: [variant("6", 2), variant("7", 1)],
      movements: {
        ...mv("transfer_out:t1", { type: "transfer_out", size: "6", from: "hub1", to: "marathon-pe", ts: "2026-10-11T09:59:00.000Z" }),
      },
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    const r = await pass();
    expect(r.failed).toBe(0);
    // The product WAS visited and judged — not skipped by a missing path.
    expect(r.products).toBe(1);
    expect(r.notListed).toBe(0);
    expect(r.results[0]).toMatchObject({ pid: "p1", ok: true, changed: 0 });
    expect(r.pushed).toBe(0);
    expect(shopify.calls.some((c) => c.includes("inventorySetQuantities"))).toBe(false);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(2);
  });

  it("a unit leaving the pool for In Transit IS taken off sale until it lands", async () => {
    const { shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 0 } } }, in_transit: { p1: { 6: { qty: 1 } } } },
      shop: [variant("6", 1), variant("7", 0)],
      movements: mv("transfer_out:t2", { type: "transfer_out", size: "6", from: "hub1", to: "in_transit", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
  });
});

describe("the agreed online pool: Pine, Concrete and Hub 3 do not sell online", () => {
  // Owner decision 2026-09-08 (inventory.mjs UNTRUSTED_LOCATIONS): their counts
  // are not accurate enough to promise a web customer. A size held ONLY there is
  // therefore NOT sellable online — the test pins the agreed definition rather
  // than the brief's "if the definition includes them".
  for (const loc of ["marathon-pine", "concrete", "hub3"]) {
    it(`a size with stock only at ${loc} is set to 0 on Shopify`, async () => {
      const { shopify, pass } = world({
        stock: { [loc]: { p1: { 6: { qty: 4 } } } },
        shop: [variant("6", 4), variant("7", 0)],
        movements: mv(`received:r-${loc}`, { type: "received", size: "6", to: loc, ts: "2026-10-11T09:59:00.000Z" }),
        cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
      });
      await pass();
      expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
    });
  }

  it("the push, the trigger and the social generator exclude exactly the same locations", () => {
    const trigger = require("../../functions/lib/shopify-inventory-dirty.cjs");
    const social = require("../../functions/lib/social-select.cjs");
    const push = [...ONLINE_EXCLUDED_LOCATIONS].sort();
    expect([...trigger.ONLINE_EXCLUDED_LOCATIONS].sort()).toEqual(push);
    expect([...social.ONLINE_EXCLUDED_LOCATIONS].sort()).toEqual(push);
    expect(push).toEqual(expect.arrayContaining(["in_transit", "marathon-pine", "hub3", "concrete"]));
  });
});

describe("the cursor does not advance on failure", () => {
  it("holds the cursor at the failed product's row and pushes it again next tick", async () => {
    const store = {
      locations: LOCS,
      stock: { "marathon-pe": { p1: { 6: { qty: 0 } } } },
      stock_movements: mv("sold:s3:marathon-pe:p1:6", { type: "sold", size: "6", from: "marathon-pe", ts: "2026-10-11T09:58:00.000Z" }),
      shopify_publish: { p1: { state: "live", liveState: "on" } },
      shopify_sync: {
        p1: { shopifyProductId: GID, variants: { 6: { shopifyInventoryItemId: "gid://shopify/InventoryItem/6" } } },
        _movementCursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
      },
    };
    const rtdb = fakeRtdb(store);
    const failing = fakeShopify({ [GID]: [variant("6", 1)] }, { failSetFor: new Set(["gid://shopify/InventoryItem/6"]) });
    const opts = (g) => ({
      commit: true, nowMs: Date.parse("2026-10-11T10:00:00Z"),
      isListed: async () => true,
      push: (pid) => syncProduct(rtdb.db, g.graphql, pid, { commit: true }),
    });
    const r = await sweepMovements(rtdb.db, opts(failing));
    expect(r.failed).toBe(1);
    expect(r.advanced).toBe(false);
    expect(store.shopify_sync._movementCursor.cursorMs).toBe(Date.parse("2026-10-11T09:50:00Z"));
    // Nothing remembered as seen: the row is read and pushed again.
    expect(store.shopify_sync._movementCursor.seen).toBeUndefined();
    expect(failing.buyable("gid://shopify/InventoryItem/6")).toBe(1);

    const healthy = fakeShopify({ [GID]: [variant("6", 1)] });
    const r2 = await sweepMovements(rtdb.db, opts(healthy));
    expect(r2.failed).toBe(0);
    expect(r2.pushed).toBe(1);
    expect(healthy.buyable("gid://shopify/InventoryItem/6")).toBe(0);
  });

  it("a failure holds the cursor; a late failed row pulls it back; deferred work advances it only to itself", () => {
    const failed = [{ pid: "a", keys: [["k1", 100]], earliest: 100, latest: 100 }];
    const done = [{ pid: "b", keys: [["k2", 500]], earliest: 500, latest: 500 }];
    expect(nextCursorState({ cursorMs: 50 }, { done, failed }).cursorMs).toBe(50);
    expect(nextCursorState({ cursorMs: 300 }, { done, failed }).cursorMs).toBe(100);
    expect(nextCursorState({ cursorMs: 50 }, { done, failed }).seen).toEqual({ k2: 500 });
    expect(nextCursorState({ cursorMs: 50 }, { done, deferred: failed }).cursorMs).toBe(100);
  });

  it("a product failing for longer than the hold limit — timed from its FIRST failure — stops holding the cursor", () => {
    const now = 10 * 3600e3;
    const failed = [{ pid: "a", keys: [["k1", now - 2000]], earliest: now - 2000, latest: now - 2000 }];
    const done = [{ pid: "b", keys: [["k2", now - 1000]], earliest: now - 1000, latest: now - 1000 }];
    const streak = (since) => ({ a: { since, last: now - 120000 } });
    const held = nextCursorState({ cursorMs: now - 5000, failing: streak(now - MAX_HOLD_MS + 1) }, { done, failed, nowMs: now });
    expect(held.cursorMs).toBe(now - 5000);
    expect(held.abandoned).toEqual([]);
    const gone = nextCursorState({ cursorMs: now - 5000, failing: streak(now - MAX_HOLD_MS) }, { done, failed, nowMs: now });
    expect(gone.abandoned).toEqual(["a"]);
    expect(gone.cursorMs).toBe(now - 1000);
    // Abandoned rows are marked seen, so they are not pushed again every tick.
    expect(gone.seen).toEqual({ k1: now - 2000, k2: now - 1000 });
    expect(gone.failing).toEqual({});
  });

  it("an old failure that went quiet starts a NEW streak — one fresh failure is never abandoned on it", () => {
    const now = 10 * 3600e3;
    const failed = [{ pid: "a", keys: [["k1", now - 2000]], earliest: now - 2000, latest: now - 2000 }];
    const s = nextCursorState({ cursorMs: now - 5000, failing: { a: { since: now - 8 * 3600e3, last: now - 2 * 3600e3 } } }, { failed, nowMs: now });
    expect(s.abandoned).toEqual([]);
    expect(s.failing).toEqual({ a: { since: now, last: now } });
  });

  it("an OLD row's first failure still gets its full retries (the mini was off for hours)", () => {
    const now = 20 * 3600e3;
    const failed = [{ pid: "a", keys: [["k1", now - 10 * 3600e3]], earliest: now - 10 * 3600e3, latest: now - 10 * 3600e3 }];
    const s = nextCursorState({ cursorMs: now - 11 * 3600e3 }, { failed, nowMs: now });
    expect(s.abandoned).toEqual([]);
    expect(s.failing).toEqual({ a: { since: now, last: now } });
  });

  it("a cursor is never carried ahead of the server clock by a fast till", () => {
    const done = [{ pid: "b", keys: [["k", 10_000]], earliest: 10_000, latest: 10_000 }];
    expect(nextCursorState({ cursorMs: 0 }, { done, nowMs: 5_000 }).cursorMs).toBe(5_000);
  });

  it("a PERMANENT answer (deleted from Shopify) is reported, not retried, and does not hold the cursor", async () => {
    const { rtdb, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shop: [variant("6", 1), variant("7", 0)],
      movements: mv("received:x", { type: "received", size: "6", to: "hub1", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    const r = await pass({ push: async (pid) => ({ pid, ok: false, productGone: true, permanent: true, why: "DELETED FROM SHOPIFY" }) });
    expect(r.failed).toBe(0);
    expect(r.permanent).toEqual([{ pid: "p1", why: "DELETED FROM SHOPIFY" }]);
    expect(rtdb.store.shopify_sync._movementCursor.cursorMs).toBe(Date.parse("2026-10-11T09:59:00Z"));
  });
});

describe("no whole-node reads", () => {
  it("a tick reads only the ts window, the id map, one cell set per location, and its own cursor", async () => {
    const { rtdb, pass } = world({
      stock: { "marathon-pe": { p1: { 6: { qty: 0 } } }, hub1: { p2: { M: { qty: 9 } } } },
      shop: [variant("6", 1), variant("7", 0)],
      movements: mv("sold:s4:marathon-pe:p1:6", { type: "sold", size: "6", from: "marathon-pe", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    const BIG = ["stock", "products", "stock_movements", "shopify_publish", "shopify_sync", "orders"];
    for (const r of rtdb.reads) {
      const segs = r.path.split("/").filter(Boolean);
      if (r.query) {
        // The only query: the ledger, by ts, from the cursor minus the lookback.
        expect(r.path).toBe("stock_movements");
        expect(r.query.orderByChild).toBe("ts");
        expect(r.query.startAt).toBe(new Date(Date.parse("2026-10-11T09:50:00Z") - LOOKBACK_MS).toISOString());
        continue;
      }
      expect(BIG.includes(r.path), `whole-node read of /${r.path}`).toBe(false);
      if (segs[0] === "stock") expect(segs.length, `/${r.path} is wider than one product`).toBe(3);
      if (segs[0] === "shopify_publish" || segs[0] === "shopify_sync") expect(segs.length).toBeGreaterThanOrEqual(2);
    }
    expect(rtdb.reads.some((r) => r.path === CURSOR_PATH)).toBe(true);
  });

  it("a quiet tick costs the cursor and an empty window — nothing else", async () => {
    const { rtdb, shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shop: [variant("6", 1), variant("7", 0)],
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    expect(rtdb.reads.map((r) => r.path)).toEqual([CURSOR_PATH, "stock_movements"]);
    expect(shopify.calls).toEqual([]);
  });
});

describe("RTDB's empty-node behaviour is modelled", () => {
  it("an empty seen-set is a deleted key, not an empty object", async () => {
    const { rtdb, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shop: [variant("6", 1), variant("7", 0)],
    });
    await pass();
    expect(rtdb.store.shopify_sync._movementCursor).toBeDefined();
    expect("seen" in rtdb.store.shopify_sync._movementCursor).toBe(false);
  });
});

describe("planMovementPass", () => {
  it("groups rows by product, skips seen and unusable rows, oldest first", () => {
    const plan = planMovementPass({
      a: { productId: "p2", ts: "2026-10-11T09:00:00Z" },
      b: { productId: "p1", ts: "2026-10-11T08:00:00Z" },
      c: { productId: "p1", ts: "2026-10-11T09:30:00Z" },
      d: { productId: "p3", ts: "2026-10-11T07:00:00Z" },
      e: { ts: "2026-10-11T07:00:00Z" },
      f: { productId: "p4", ts: "not a time" },
    }, { seen: { d: 1 } });
    expect(plan.map((p) => p.pid)).toEqual(["p1", "p2"]);
    expect(plan[0].keys.map(([k]) => k)).toEqual(["b", "c"]);
  });
});

describe("the sweep's arithmetic", () => {
  const r = (over) => ({ ok: true, pid: "p", shopifyUnits: 10, appUnits: 8, drift: [], untracked: [], ...over });
  it("counts tracked oversell units and unlimited sizes separately", () => {
    const s = summarize([
      r({ drift: [{ inventoryItemId: "i1", sizeKey: "6", shopify: 3, quantity: 1 }] }),
      r({ untracked: [{ inventoryItemId: "i2", sizeKey: "7", app: 0, shopify: 0 }] }),
      { pid: "gone", ok: false, productGone: true },
    ]);
    expect(s.oversellableUnits).toBe(2);
    expect(s.unlimitedVariants).toBe(1);
    expect(s.gone).toBe(1);
    expect(s.worst[0].unlimitedVariants).toBe(1);
  });
  it("Junid's 25% guard trips when a correction would take most of the shop off sale", () => {
    const s = summarize([r({ shopifyUnits: 100, drift: [{ inventoryItemId: "i", sizeKey: "6", shopify: 30, quantity: 0 }] })]);
    expect(s.zeroShare).toBeCloseTo(0.3);
    expect(exceedsZeroGuard(s)).toBe(true);
    expect(exceedsZeroGuard(summarize([r({ shopifyUnits: 100, drift: [{ inventoryItemId: "i", sizeKey: "6", shopify: 25, quantity: 0 }] })]))).toBe(false);
  });
  it("an under-offered size is drift but not oversell", () => {
    expect(oversell(r({ drift: [{ inventoryItemId: "i", shopify: 0, quantity: 4 }] }))).toEqual({ units: 0, unlimitedVariants: 0, removedUnits: 0 });
  });
  it("the rollback file carries the before-state of every quantity and tracking flag it changes", () => {
    const e = rollbackEntries([r({
      gid: "g", drift: [{ inventoryItemId: "i1", sizeKey: "6", shopify: 3, quantity: 1 }],
      untracked: [{ inventoryItemId: "i1", variantId: "v1", sizeKey: "6", shopify: 3, tracked: false, inventoryPolicy: "DENY" }],
    })]);
    expect(e).toEqual([{ pid: "p", gid: "g", sizeKey: "6", inventoryItemId: "i1", before: 3, after: 1, variantId: "v1", trackedBefore: false, policyBefore: "DENY" }]);
  });
});

describe("a listing the app does not know", () => {
  it("is set to 0 in every size, tracked and DENY", async () => {
    const shopify = fakeShopify({ "gid://shopify/Product/9": [variant("M", 1), variant("L", 2, { tracked: false })] });
    const r = await zeroUnmanagedListing(shopify.graphql, "gid://shopify/Product/9", { commit: true });
    expect(r.ok).toBe(true);
    expect(shopify.buyable("gid://shopify/InventoryItem/M")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/L")).toBe(0);
  });
});

describe("a switched-off product is still a listing", () => {
  it("is kept true — it may still be published to Facebook & Instagram", async () => {
    const { shopify, pass } = world({
      publish: { state: "live", liveState: "off" },
      stock: { hub1: { p1: { 6: { qty: 0 } } } },
      shop: [variant("6", 3), variant("7", 0)],
      movements: mv("sold:s5:hub1:p1:6", { type: "sold", size: "6", from: "hub1", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
  });
});

describe("a web order taken but not yet rung through the POS stays reserved", () => {
  it("the push writes ON HAND, so Shopify's committed unit is not offered again", async () => {
    // The app still holds 2 (the POS has not rung the web sale yet); Shopify
    // has 2 on hand with 1 committed, i.e. 1 available. A push of "available 2"
    // would offer two pairs while one is left.
    const v6 = { ...variant("6", 2), committed: 1 };
    const { shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 2 } } } },
      shop: [v6, variant("7", 0)],
      movements: mv("adjustment:w1", { type: "adjustment", size: "7", to: "hub1", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(1);
  });

  it("…and once the POS rings it, the app's count and Shopify meet", async () => {
    const v6 = { ...variant("6", 2), committed: 1 };
    const { shopify, pass } = world({
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shop: [v6, variant("7", 0)],
      movements: mv("sold:pos1:hub1:p1:6", { type: "sold", size: "6", from: "hub1", ts: "2026-10-11T09:59:00.000Z" }),
      cursor: { cursorMs: Date.parse("2026-10-11T09:50:00Z") },
    });
    await pass();
    // on hand 1, committed 1 until it ships: nothing more for sale.
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
  });
});

describe("a stale id map on a product that is still listed", () => {
  it("holds every variant at 0 and reports a PERMANENT refusal", async () => {
    const store = {
      locations: LOCS,
      stock: { hub1: { p1: { 6: { qty: 3 } } } },
      shopify_sync: { p1: { shopifyProductId: GID, variants: { 6: { shopifyInventoryItemId: "gid://shopify/InventoryItem/OLD" } } } },
    };
    const rtdb = fakeRtdb(store);
    const shopify = fakeShopify({ [GID]: [variant("6", 2), variant("7", 1, { tracked: false })] });
    const r = await syncProduct(rtdb.db, shopify.graphql, "p1", { commit: true });
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.why).toMatch(/id map is stale/);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/7")).toBe(0);
  });
});

describe("the RTDB fake deletes empty arrays like the real server", () => {
  it("removing the last element of an array child removes the parent key", async () => {
    const rtdb = fakeRtdb({});
    await rtdb.db.ref("a/list").set(["x"]);
    expect(rtdb.store.a.list).toEqual(["x"]);
    await rtdb.db.ref("a/list/0").set(null);
    expect(rtdb.store.a).toBeUndefined();
    await rtdb.db.ref("b").set({ list: [] });
    expect(rtdb.store.b).toBeUndefined();
  });
});

describe("the nightly sweep's bulk snapshot", async () => {
  const { parseSnapshot } = await import("./bulkSnapshot.mjs");
  const { planProduct } = await import("./inventorySync.mjs");
  it("parses Shopify's JSONL into planProduct's inputs — on_hand is the baseline", () => {
    const jsonl = [
      { id: "gid://shopify/Product/1" },
      { id: "gid://shopify/ProductVariant/6", title: "6", inventoryPolicy: "DENY", inventoryItem: { id: "I6", tracked: false, inventoryLevel: { quantities: [{ name: "available", quantity: 0 }, { name: "on_hand", quantity: 1 }] } }, __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/ProductVariant/7", title: "7", inventoryPolicy: "DENY", inventoryItem: { id: "I7", tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: 2 }, { name: "on_hand", quantity: 2 }] } }, __parentId: "gid://shopify/Product/1" },
    ].map((o) => JSON.stringify(o)).join("\n");
    const snap = parseSnapshot(jsonl);
    const p = snap.get("gid://shopify/Product/1");
    expect(p.baseline.get("I6")).toBe(1);
    expect(p.variants.map((v) => v.tracked)).toEqual([false, true]);
    const plan = planProduct({
      map: { shopifyProductId: "gid://shopify/Product/1", variants: { 6: { shopifyInventoryItemId: "I6" }, 7: { shopifyInventoryItemId: "I7" } } },
      variants: p.variants, baseline: p.baseline, totals: { 6: 0, 7: 2 },
    });
    expect(plan.untracked.map((u) => u.sizeKey)).toEqual(["6"]);
    expect(plan.drift.map((d) => [d.sizeKey, d.shopify, d.quantity])).toEqual([["6", 1, 0]]);
  });
});

describe("an ACTIVE listing on no sales channel cannot be bought", () => {
  it("is corrected but never counted as oversell", () => {
    const s = summarize([{ ok: true, pid: "p", published: false, shopifyUnits: 5, appUnits: 0, drift: [{ inventoryItemId: "i", sizeKey: "6", shopify: 5, quantity: 0 }], untracked: [] }]);
    expect(s.oversellableUnits).toBe(0);
    expect(s.hiddenDrifted).toBe(1);
    expect(s.removedUnits).toBe(5);
  });
});

describe("a listing with more variants than one page", () => {
  it("every page is read — a variant on page two is still tracked and zeroed", async () => {
    const store = {
      locations: LOCS,
      stock: { hub1: { p1: { 6: { qty: 1 } } } },
      shopify_sync: { p1: { shopifyProductId: GID, variants: { 6: { shopifyInventoryItemId: "gid://shopify/InventoryItem/6" } } } },
    };
    const rtdb = fakeRtdb(store);
    const shopify = fakeShopify({ [GID]: [variant("6", 1), variant("7", 0), variant("8", 4, { tracked: false })] }, { pageSize: 2 });
    const r = await syncProduct(rtdb.db, shopify.graphql, "p1", { commit: true });
    expect(r.ok).toBe(true);
    expect(shopify.buyable("gid://shopify/InventoryItem/8")).toBe(0);
    expect(shopify.buyable("gid://shopify/InventoryItem/6")).toBe(1);
  });
});

describe("a listing is only 'no app product' when no id map anywhere names it", () => {
  it("re-reads the gid of a LISTED product whose judgement threw — its listing must not be zeroed", () => {
    const results = [
      { pid: "p1", gid: "g1", ok: true },
      { pid: "p2", gid: null, ok: false, why: "RTDB blip" },   // listed, threw
    ];
    expect(keysNeedingGidLookup(["p1", "p2", "p3", "_movementCursor"], results)).toEqual(["p2", "p3"]);
  });
});

describe("readAvailable: an item not stocked at the location is unknown, never 0", async () => {
  const { readAvailable } = await import("./inventory.mjs");
  it("leaves it out of the baseline, as the bulk snapshot does", async () => {
    const g = async () => ({ nodes: [
      { id: "A", inventoryLevel: { quantities: [{ name: "on_hand", quantity: 3 }, { name: "available", quantity: 2 }] } },
      { id: "B", inventoryLevel: null },
    ] });
    const m = await readAvailable(g, "L", ["A", "B"]);
    expect(m.get("A")).toBe(3);
    expect(m.has("B")).toBe(false);
  });
});

describe("the nightly runner", async () => {
  const { sweepDue, MAX_ATTEMPTS_PER_DAY } = await import("./stock-truth-runner.mjs");
  const at0300 = Date.parse("2026-10-12T01:00:00Z");
  it("is due from 02:30 SAST once a day", () => {
    expect(sweepDue(Date.parse("2026-10-12T00:20:00Z"), {}).due).toBe(false);
    expect(sweepDue(at0300, {}).due).toBe(true);
    expect(sweepDue(at0300, { lastRunDate: "2026-10-12" }).due).toBe(false);
  });
  it("stops after a few attempts that died before reporting", () => {
    expect(sweepDue(at0300, { attemptDate: "2026-10-12", attempts: MAX_ATTEMPTS_PER_DAY - 1 }).due).toBe(true);
    expect(sweepDue(at0300, { attemptDate: "2026-10-12", attempts: MAX_ATTEMPTS_PER_DAY }).due).toBe(false);
    expect(sweepDue(at0300, { attemptDate: "2026-10-11", attempts: 9 }).due).toBe(true);
  });
});
