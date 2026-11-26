import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  lookupOrderByNumber, rankOrdersForNumber, parseTypedOrderNumber, orderMatchesNumber,
  orderWhenLabel, shortCustomerName, saDayOf,
} from "./orderNumberLookup";

// 26 Nov 2026 10:00 SAST
const NOW = Date.parse("2026-11-26T08:00:00Z");
const o = (id, createdAt, status, destShop, extra = {}) => ({ id, createdAt, status, destShop, customerName: "Jo Soap", productName: "Shoe", ...extra });

// /orders holds ONE record per key (set() overwrites), so two "007" keys never
// sit in the same live feed. Two records with the same number reach a screen
// only as different keys ("007" and "P007") or when a device still holds an
// old copy beside the live one — the shapes below. TODAY_007 is the live record
// of 26 Nov; OLD_007_PE is 23 Nov's, as a stale local copy would carry it.
const TODAY_007 = o("007", "2026-11-26T06:42:20.274Z", "out_of_stock", "trophy");
const OLD_007_PE = o("007", "2026-11-23T06:42:14.662Z", "ready", "marathon-pe");
const REFILL_LINE = o("R007-22", "2026-11-21T09:00:42.404Z", "incoming", "marathon-pe", { customerName: "Shop Refill" });

describe("parseTypedOrderNumber", () => {
  it("reads plain, padded and prefixed numbers; refuses refill numbers and words", () => {
    expect(parseTypedOrderNumber("7")).toEqual({ prefix: null, number: 7 });
    expect(parseTypedOrderNumber("#007")).toEqual({ prefix: null, number: 7 });
    expect(parseTypedOrderNumber("p7")).toEqual({ prefix: "P", number: 7 });
    expect(parseTypedOrderNumber("R007")).toBeNull();
    expect(parseTypedOrderNumber("john")).toBeNull();
    expect(parseTypedOrderNumber("")).toBeNull();
  });
});

describe("orderMatchesNumber", () => {
  it("customer order keys only — never a refill line, a website code or an online hub order", () => {
    const want = parseTypedOrderNumber("007");
    expect(orderMatchesNumber(TODAY_007, want)).toBe(true);
    expect(orderMatchesNumber(REFILL_LINE, want)).toBe(false);
    expect(orderMatchesNumber(o("FBQ", null, "incoming", "trophy"), want)).toBe(false);
    expect(orderMatchesNumber(o("007", null, "incoming", "trophy", { channel: "online" }), want)).toBe(false);
    expect(orderMatchesNumber(o("P007", null, "incoming", "marathon-pine"), want)).toBe(true);
    expect(orderMatchesNumber(o("P007", null, "incoming", "marathon-pine"), parseTypedOrderNumber("C7"))).toBe(false);
  });
});

describe("lookupOrderByNumber", () => {
  it("today's 007 wins over an older OPEN 007 at another shop when tracking from Trophy", () => {
    const r = lookupOrderByNumber([OLD_007_PE, REFILL_LINE, TODAY_007], "007", { shop: "trophy", nowMs: NOW });
    expect(r.kind).toBe("one");
    expect(r.scope).toBe("shop");
    expect(r.options[0].order).toBe(TODAY_007);
    expect(r.options[0].today).toBe(true);
  });

  it("the shop's own orders first; other shops only when nothing matches here", () => {
    const pine = o("P007", "2026-11-26T07:00:00Z", "incoming", "marathon-pine");
    const r = lookupOrderByNumber([TODAY_007, pine], "7", { shop: "marathon-pine", nowMs: NOW });
    expect(r.kind).toBe("one");
    expect(r.options[0].order).toBe(pine);
    const r2 = lookupOrderByNumber([TODAY_007], "7", { shop: "marathon-pine", nowMs: NOW });
    expect(r2.scope).toBe("all");
    expect(r2.options[0].order).toBe(TODAY_007);
    expect(r2.options[0].otherShop).toBe(true);
  });

  it("an open order beats a finished one, and today's open comes before an older open one", () => {
    const openToday = o("007", "2026-11-26T07:30:00Z", "incoming", "trophy");
    const r = lookupOrderByNumber([TODAY_007, openToday, OLD_007_PE], "007", { nowMs: NOW });
    expect(r.kind).toBe("pick");
    expect(r.options.map((x) => x.order)).toEqual([openToday, OLD_007_PE]);
    expect(r.options[1].earlier).toBe(true);
  });

  it("more than one open order → a picker, today's first, never a guess", () => {
    const a = o("007", "2026-11-26T06:00:00Z", "ready", "trophy");
    const b = o("007", "2026-11-26T07:00:00Z", "incoming", "trophy");
    const r = lookupOrderByNumber([a, b], "007", { shop: "trophy", nowMs: NOW });
    expect(r.kind).toBe("pick");
    expect(r.options.map((x) => x.order)).toEqual([b, a]);
  });

  it("today's finished orders before earlier finished ones; earlier ones only when nothing else, and dated", () => {
    const oldCollected = o("007", "2026-11-24T07:37:56Z", "collected", "marathon-pe");
    expect(lookupOrderByNumber([oldCollected, TODAY_007], "007", { nowMs: NOW }).options.map((x) => x.order)).toEqual([TODAY_007]);
    const r = lookupOrderByNumber([oldCollected], "007", { nowMs: NOW });
    expect(r.kind).toBe("one");
    expect(r.options[0].earlier).toBe(true);
    expect(r.options[0].day).toBe("2026-11-24");
  });

  it("an undated record is never taken for today's", () => {
    const undated = o("007", undefined, "collected", "trophy");
    const r = lookupOrderByNumber([undated], "007", { nowMs: NOW });
    expect(r.options[0].today).toBe(false);
    expect(r.options[0].earlier).toBe(true);
  });

  it("soft-deleted orders answer to nothing", () => {
    for (const flag of ["deleted", "removed", "archived"]) {
      expect(lookupOrderByNumber([o("007", "2026-11-26T07:00:00Z", "collected", "trophy", { [flag]: true })], "007", { nowMs: NOW }).kind).toBe("none");
    }
  });

  it("a typed prefix keeps to that sequence; a malformed createdAt is never today's", () => {
    const pine = o("P007", "2026-11-26T07:00:00Z", "incoming", "marathon-pine");
    expect(lookupOrderByNumber([TODAY_007, pine], "P7", { nowMs: NOW }).options.map((x) => x.order)).toEqual([pine]);
    const bad = o("007", "garbage", "collected", "trophy");
    expect(lookupOrderByNumber([bad], "007", { nowMs: NOW }).options[0].earlier).toBe(true);
  });

  it("this shop's old finished order wins over another shop's open one (shop first, as asked)", () => {
    const oldHere = o("007", "2026-11-23T07:00:00Z", "collected", "marathon-pe");
    const openThere = o("007", "2026-11-26T07:00:00Z", "incoming", "trophy");
    const r = lookupOrderByNumber([openThere, oldHere], "007", { shop: "marathon-pe", nowMs: NOW });
    expect(r.options.map((x) => x.order)).toEqual([oldHere]);
    expect(r.options[0].earlier).toBe(true);
  });

  it("nothing for a refill number, a word, or no match", () => {
    expect(lookupOrderByNumber([REFILL_LINE], "R007", { nowMs: NOW }).kind).toBe("none");
    expect(lookupOrderByNumber([REFILL_LINE], "007", { nowMs: NOW }).kind).toBe("none");
    expect(lookupOrderByNumber([TODAY_007], "jo", { nowMs: NOW }).kind).toBe("none");
  });
});

describe("rankOrdersForNumber", () => {
  it("lists every match: shop first, open first, today first; refill lines left out", () => {
    const openOtherShop = o("007", "2026-11-26T07:00:00Z", "incoming", "marathon-pe");
    const list = rankOrdersForNumber([REFILL_LINE, OLD_007_PE, TODAY_007, openOtherShop], "007", { shop: "trophy", nowMs: NOW });
    expect(list).toEqual([TODAY_007, openOtherShop, OLD_007_PE]);
  });
});

describe("labels", () => {
  it("date/time in SA time and a short customer name", () => {
    expect(orderWhenLabel(TODAY_007)).toBe("Thu 26 Nov · 08:42");
    expect(orderWhenLabel({})).toBe("date unknown");
    expect(shortCustomerName("Jo Anne Soap")).toBe("Jo S.");
    expect(shortCustomerName("")).toBe("—");
    expect(saDayOf(Date.parse("2026-11-25T22:30:00Z"))).toBe("2026-11-26");
  });
});

// The screens use the rule — the tracker and the Returns search never match a
// number as a substring of the key again.
describe("wiring", () => {
  const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const body = (start, end) => APP.slice(APP.indexOf(start), APP.indexOf(end, APP.indexOf(start)));
  it("the tracker resolves a typed number through lookupOrderByNumber, scoped to the person's shop", () => {
    const cv = body("function CustomerView(", "// ─── TV DISPLAY VIEW");
    expect(cv).toContain("lookupOrderByNumber(heldOrders, clean, { shop, nowMs: serverNowMs() })");
    expect(cv).toContain("rankOrdersForNumber(heldOrders, q, { shop, nowMs: serverNowMs() })");
    expect(cv).not.toMatch(/o\.id\.includes\(q\)/);
    expect(cv).toContain("o.id === prev.id && o.createdAt === prev.createdAt");
    expect(APP).toContain("<CustomerView  orders={sharedOrders} shop={myShop}");
  });
  it("the Returns search matches a number exactly", () => {
    const rv = body("function ReturnsView(", "// R1 (stock-integrity)");
    expect(rv).toContain("rankOrdersForNumber(last3DaysOrders, q");
    expect(rv).not.toMatch(/o\.id\.toLowerCase\(\)\.includes\(q\)/);
  });
});
