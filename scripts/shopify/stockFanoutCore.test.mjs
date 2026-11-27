import { describe, it, expect } from "vitest";
import { pendingLinesFor, pendingForeignFor, makeResolver, makeIngestedCheck, readPendingForeign, PENDING_MAX_AGE_MS, INGEST_SETTLE_MS } from "./stockFanoutCore.mjs";

const order = (lines, extra = {}) => ({ legacyResourceId: 1, createdAt: "2026-11-15T10:00:00Z", lineItems: { nodes: lines }, ...extra });
const li = (v, p, q = 1, cur = q) => ({ quantity: q, currentQuantity: cur, variant: { id: v, product: { id: p } } });

describe("pendingLinesFor", () => {
  const resolve = async (p, v) => ({ "P1|V1": { pid: "p1", sizeKey: "9" }, "P2|V2": { pid: "p2", sizeKey: "M" } })[`${p}|${v}`] || null;
  it("keeps only dual-listed products, sums sizes, honours current quantity", async () => {
    const out = await pendingLinesFor(order([li("V1", "P1", 2), li("V1", "P1", 1), li("V2", "P2"), li("V9", "P9")]), { dualPids: new Set(["p1"]), resolve });
    expect(out).toEqual({ p1: { 9: 3 } });
    expect(await pendingLinesFor(order([li("V1", "P1", 2, 0)]), { dualPids: new Set(["p1"]), resolve })).toEqual({});
  });
  it("a cancelled order holds nothing", async () => {
    expect(await pendingLinesFor(order([li("V1", "P1")], { cancelledAt: "x" }), { dualPids: new Set(["p1"]), resolve })).toEqual({});
  });
});

describe("pendingForeignFor", () => {
  const NOW = 10_000_000;
  const node = {
    marathon: { o1: { at: NOW - 1000, lines: { p1: { 9: 1 } } }, o2: { at: NOW - 1000, lines: { p1: { 9: 2, 10: 1 } } }, old: { at: NOW - PENDING_MAX_AGE_MS - 1, lines: { p1: { 9: 5 } } } },
    concrete: { c1: { at: NOW, lines: { p1: { 9: 7 } } } },
  };
  it("sums OTHER stores' un-ingested, fresh sales only", async () => {
    const out = await pendingForeignFor(node, "p1", "concrete", async (id) => id === "o2", NOW);
    expect(out).toEqual({ 9: 1 });
    // per size: o2 held in size 9 only — its size-10 unit still counts
    const perSize = await pendingForeignFor(node, "p1", "concrete", async (id, size) => id === "o2" && size === "9", NOW);
    expect(perSize).toEqual({ 9: 1, 10: 1 });
  });
  it("never counts its own store's sales; null when nothing", async () => {
    expect(await pendingForeignFor(node, "p1", "marathon", async () => true, NOW)).toBe(null);
    expect(await pendingForeignFor(node, "p9", "concrete", async () => false, NOW)).toBe(null);
  });
});

describe("makeResolver", () => {
  it("claims → variants, cached", async () => {
    let reads = 0;
    const data = { "s/_claims/11": "p1", "s/p1/variants": { 9: { shopifyVariantId: "gid://shopify/ProductVariant/5" } } };
    const r = makeResolver(async (p) => { reads++; return data[p] ?? null; }, "s");
    expect(await r("gid://shopify/Product/11", "gid://shopify/ProductVariant/5")).toEqual({ pid: "p1", sizeKey: "9" });
    await r("gid://shopify/Product/11", "gid://shopify/ProductVariant/5");
    expect(reads).toBe(2);
    expect(await r("gid://shopify/Product/12", "x")).toBe(null);
  });
});

describe("ingested = a hold exists for that size, or the app has had it a while", () => {
  it("per size, then by settle time", async () => {
    const NOW = 50_000_000;
    const data = { "online_reservations/p1": { 9: { o1: { qty: 1 } } }, "online_orders/o2/ingestedAt": NOW - INGEST_SETTLE_MS - 1, "online_orders/o3/ingestedAt": NOW - 1000 };
    const check = makeIngestedCheck(async (p) => data[p] ?? null, "p1", NOW);
    expect(await check("o1", "9")).toBe(true);
    expect(await check("o1", "10")).toBe(false);
    expect(await check("o2", "10")).toBe(true);
    expect(await check("o3", "10")).toBe(false);
  });
  it("readPendingForeign is a no-op with no pending node", async () => {
    expect(await readPendingForeign(async () => null, "p1", "marathon", 1)).toBe(null);
  });
});
