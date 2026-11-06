// ── Price sync: the app's retail price is what Shopify shows ────────────────
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fakeDb } from "./fakeRtdb.testutil.mjs";
import {
  shopifyPriceFor, planPriceFix, driftPattern, parsePriceSnapshot,
  syncProductPrice, sweepPriceDirty, sweepPriceBackstop, PRICE_DIRTY_PATH, PRICE_LOG_PATH,
} from "./priceSync.mjs";

// A Shopify fake: products by gid → variants [{ id, price }]; records writes.
function fakeShop(products) {
  const writes = [];
  const graphql = async (query, vars) => {
    if (query.includes("productVariantsBulkUpdate")) {
      writes.push(vars);
      for (const v of vars.variants) {
        const row = products[vars.productId].find((x) => x.id === v.id);
        row.price = v.price;
      }
      return { productVariantsBulkUpdate: { userErrors: [] } };
    }
    if (query.includes("product(id:")) {
      const p = products[vars.id];
      return { product: p ? { id: vars.id, variants: { pageInfo: { hasNextPage: false }, nodes: p.map((v) => ({ ...v })) } } : null };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  return { graphql, writes, products };
}

const GID = "gid://shopify/Product/15463764066453";
const travis = () => ({
  products: { p1778140291773: { name: "Air Jordan 1 Low Travis Scott Brown Pink", retailPrice: 700, stockPrice: 600 } },
  shopify_sync: { p1778140291773: { shopifyProductId: GID } },
  shopify_publish: { p1778140291773: { state: "live", liveState: "on" } },
});

describe("shopifyPriceFor — retail, never trade", () => {
  it("returns retailPrice as Shopify's decimal string", () => {
    expect(shopifyPriceFor({ retailPrice: 700, stockPrice: 600 })).toBe("700.00");
  });
  it("NEVER returns the trade price, whatever the two values are", () => {
    for (const [retail, trade] of [[700, 600], [450, 450], [500, 450], [200, 250]]) {
      const got = shopifyPriceFor({ retailPrice: retail, stockPrice: trade });
      expect(Number(got)).toBe(retail);
    }
    // No retail at all: falls back to NOTHING, not to the trade price.
    expect(shopifyPriceFor({ stockPrice: 600 })).toBeNull();
  });
  it("refuses blank, zero, negative and non-numeric retail (no R0.00 listing)", () => {
    for (const v of [undefined, null, "", 0, -5, "abc"]) expect(shopifyPriceFor({ retailPrice: v, stockPrice: 100 })).toBeNull();
  });
  it("refuses an internal price-carrier record", () => {
    expect(shopifyPriceFor({ category: "Price Products", retailPrice: 50 })).toBeNull();
  });
  it("every price reconcile.mjs sends Shopify comes from shopifyPriceFor — no stockPrice anywhere in it", () => {
    const src = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/stockPrice/);
    expect(src).not.toMatch(/Number\(product\.retailPrice\)/);
    expect(src.match(/= shopifyPriceFor\(product\)/g)?.length).toBe(2); // create + switch-on
  });
});

describe("planPriceFix", () => {
  it("compares in cents: '700' and '700.00' agree", () => {
    expect(planPriceFix("700.00", [{ id: "v1", price: "700" }])).toEqual([]);
  });
  it("lists only the variants that disagree", () => {
    expect(planPriceFix("700.00", [{ id: "v1", price: "450.00" }, { id: "v2", price: "700.00" }]))
      .toEqual([{ id: "v1", from: "450.00", to: "700.00" }]);
  });
  it("no app price → nothing to do", () => {
    expect(planPriceFix(null, [{ id: "v1", price: "450.00" }])).toEqual([]);
  });
});

describe("driftPattern", () => {
  it("names the three cases", () => {
    expect(driftPattern({ retail: 700, trade: 600, shopify: "700.00" })).toBe("in step");
    expect(driftPattern({ retail: 700, trade: 600, shopify: "600.00" })).toMatch(/^1:/);
    expect(driftPattern({ retail: 700, trade: 600, shopify: "450.00" })).toMatch(/^2\/3:/);
  });
});

describe("parsePriceSnapshot", () => {
  it("groups bulk JSONL variants under their product", () => {
    const jsonl = [
      JSON.stringify({ id: GID }),
      JSON.stringify({ id: "gid://shopify/ProductVariant/1", price: "450.00", __parentId: GID }),
      JSON.stringify({ id: "gid://shopify/ProductVariant/2", price: "450.00", __parentId: GID }),
    ].join("\n");
    expect(parsePriceSnapshot(jsonl).get(GID)).toEqual([
      { id: "gid://shopify/ProductVariant/1", price: "450.00" },
      { id: "gid://shopify/ProductVariant/2", price: "450.00" },
    ]);
  });
});

describe("syncProductPrice", () => {
  it("Travis Scott: Shopify R450 → R700, every variant, logged", async () => {
    const { db, store } = fakeDb(travis());
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }, { id: "v7", price: "450.00" }] });
    const r = await syncProductPrice(db, shop.graphql, "p1778140291773", { commit: true, source: "test", now: async () => 1234 });
    expect(r).toMatchObject({ ok: true, changed: true, from: "450.00", to: "700.00" });
    expect(shop.products[GID].map((v) => v.price)).toEqual(["700.00", "700.00"]);
    expect(store.shopify_sync._priceLog.p1778140291773).toMatchObject({ at: 1234, from: "450.00", to: "700.00", variants: 2, source: "test" });
  });
  it("in step → no Shopify write", async () => {
    const { db, store } = fakeDb(travis());
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "700.00" }] });
    const r = await syncProductPrice(db, shop.graphql, "p1778140291773", { commit: true });
    expect(r.changed).toBe(false);
    expect(shop.writes).toEqual([]);
  });
  it("no retail on the record → Shopify is left alone (never pushes trade or zero)", async () => {
    const s = travis(); delete s.products.p1778140291773.retailPrice;
    const { db, store } = fakeDb(s);
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }] });
    const r = await syncProductPrice(db, shop.graphql, "p1778140291773", { commit: true });
    expect(r.ok).toBe(false);
    expect(shop.writes).toEqual([]);
  });
  it("dry run plans but writes nothing", async () => {
    const { db, store } = fakeDb(travis());
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }] });
    const r = await syncProductPrice(db, shop.graphql, "p1778140291773", { commit: false });
    expect(r.wouldChange).toBe(true);
    expect(shop.writes).toEqual([]);
  });
});

describe("sweepPriceDirty — the next-tick leg", () => {
  it("pushes a marked live product and clears its marker", async () => {
    const s = travis(); s[PRICE_DIRTY_PATH] = { p1778140291773: 3 };
    const { db, store } = fakeDb(s);
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }] });
    const out = await sweepPriceDirty(db, shop.graphql, { commit: true, isLive: async () => true, now: async () => 1 });
    expect(out).toMatchObject({ seen: 1, pushed: 1, cleared: 1 });
    expect(shop.products[GID][0].price).toBe("700.00");
    expect(store[PRICE_DIRTY_PATH]?.p1778140291773 ?? null).toBeNull();
  });
  it("a product no longer listed: marker cleared, Shopify untouched", async () => {
    const s = travis(); s[PRICE_DIRTY_PATH] = { p1778140291773: 1 };
    const { db, store } = fakeDb(s);
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }] });
    const out = await sweepPriceDirty(db, shop.graphql, { commit: true, isLive: async () => false });
    expect(out.cleared).toBe(1);
    expect(shop.writes).toEqual([]);
  });
  it("a Shopify failure keeps the marker for the next tick", async () => {
    const s = travis(); s[PRICE_DIRTY_PATH] = { p1778140291773: 1 };
    const { db, store } = fakeDb(s);
    const out = await sweepPriceDirty(db, async () => { throw new Error("HTTP 503"); }, { commit: true, isLive: async () => true });
    expect(out.kept).toBe(1);
    expect(store[PRICE_DIRTY_PATH].p1778140291773).toBe(1);
  });
});

describe("sweepPriceBackstop — catches an admin edit or a lost marker", () => {
  const snapFor = (price) => [JSON.stringify({ id: GID }), JSON.stringify({ id: "v6", price, __parentId: GID })].join("\n");
  const bulkShop = (price) => {
    const shop = fakeShop({ [GID]: [{ id: "v6", price }] });
    const inner = shop.graphql;
    shop.graphql = async (q, v, o) => {
      if (q.includes("bulkOperationRunQuery")) return { bulkOperationRunQuery: { bulkOperation: { id: "b1" }, userErrors: [] } };
      if (q.includes("BulkOperation")) return { node: { status: "COMPLETED", url: "x" } };
      return inner(q, v, o);
    };
    return shop;
  };
  it("a price typed in Shopify admin (R450) is overwritten with the app's R700", async () => {
    const { db, store } = fakeDb(travis());
    const shop = bulkShop("450.00");
    globalThis.fetch = async () => ({ ok: true, text: async () => snapFor("450.00") });
    const out = await sweepPriceBackstop(db, shop.graphql, { livePids: ["p1778140291773"], commit: true, now: async () => 9 });
    expect(out).toMatchObject({ checked: 1, drifted: 1, fixed: 1 });
    expect(shop.products[GID][0].price).toBe("700.00");
    expect(store.shopify_sync._priceLog.p1778140291773.source).toBe("backstop");
  });
  it("more disagreements than the cap → writes nothing and says so", async () => {
    const { db, store } = fakeDb(travis());
    const shop = bulkShop("450.00");
    globalThis.fetch = async () => ({ ok: true, text: async () => snapFor("450.00") });
    const out = await sweepPriceBackstop(db, shop.graphql, { livePids: ["p1778140291773"], commit: true, maxFixes: 0 });
    expect(out.refused).toBe(true);
    expect(shop.writes).toEqual([]);
  });
});

describe("review fixes", () => {
  it("a merge loser's listing is never priced", async () => {
    const s = travis(); s.products.p1778140291773.mergedInto = "pSurvivor";
    const { db } = fakeDb(s);
    const shop = fakeShop({ [GID]: [{ id: "v6", price: "450.00" }] });
    const r = await syncProductPrice(db, shop.graphql, "p1778140291773", { commit: true });
    expect(r.changed).toBe(false);
    expect(shop.writes).toEqual([]);
  });
  it(">100 variants: reported once, marker cleared (not retried every tick)", async () => {
    const s = travis(); s[PRICE_DIRTY_PATH] = { p1778140291773: 1 };
    const { db, store } = fakeDb(s);
    const graphql = async () => ({ product: { id: GID, variants: { pageInfo: { hasNextPage: true }, nodes: [] } } });
    const out = await sweepPriceDirty(db, graphql, { commit: true, isLive: async () => true });
    expect(out.results[0]).toMatchObject({ ok: false });
    expect(out.cleared).toBe(1);
    expect(store[PRICE_DIRTY_PATH]?.p1778140291773 ?? null).toBeNull();
  });
  it("more markers than the cap: every marker is eventually reached", async () => {
    const s = travis(); s[PRICE_DIRTY_PATH] = {};
    for (let i = 0; i < 10; i++) s[PRICE_DIRTY_PATH][`p${i}`] = 1;
    const seen = new Set();
    for (let k = 0; k < 60; k++) {
      const { db } = fakeDb(structuredClone(s));
      await sweepPriceDirty(db, async () => { throw new Error("down"); }, { commit: true, max: 2, isLive: async (pid) => { seen.add(pid); return true; } });
    }
    expect(seen.size).toBe(10);
  });
  it("reconcile.mjs drains price markers and runs the backstop, both committing and both skipped on --pids", () => {
    const src = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/if \(!ONLY\) try \{\n  const pr = await sweepPriceDirty\(db, graphql, \{\n    commit: true,/);
    expect(src).toMatch(/if \(!ONLY && liveNow && [^\n]*PRICE_BACKSTOP_INTERVAL_MS\) \{\n  try \{\n    const pb = await sweepPriceBackstop\(db, graphql, \{\n      livePids: liveNow,\n      commit: true,/);
  });
});
