// Per-store order numbers: the key shapes, the counter paths, the TV ranges.
// The contract: Marathon PE / Trophy are untouched; a prefixed store's keys can
// never collide with, or appear on the board of, the shared sequence.
import { describe, it, expect } from "vitest";
import {
  orderPrefixFor, orderCounterPath, refillCounterPath, nextCounterValue,
  formatOrderKey, formatRefillNumber, parseOrderKey, isSharedSequenceOrderKey,
  orderKeyFromInput, tvOrderKeyRanges, keyInOrderRanges, tvSectionFromSearch,
} from "./orderNumbering";
import { SEED_REGISTRY, normalizeNetwork } from "./networkRegistry";
import { TV_ORDER_KEY_START, TV_ORDER_KEY_END, keyInTvOrdersRange } from "./tvOrdersRange";

const NET = SEED_REGISTRY;

describe("Section 2 — exactly the counters and keys it has always had", () => {
  it.each(["marathon-pe", "trophy", null, undefined, "", "nowhere"])("%s draws from the shared counters", (shop) => {
    expect(orderPrefixFor(NET, shop)).toBe(null);
    expect(orderCounterPath(NET, shop)).toBe("orderCounter");
    expect(refillCounterPath(NET, shop)).toBe("refillCounter");
  });
  it("the key formats are the old ones", () => {
    expect(formatOrderKey(null, 1)).toBe("001");
    expect(formatOrderKey(null, 999)).toBe("999");
    expect(formatRefillNumber(null, 7)).toBe("R007");
  });
  it("the counter rule is the old one: new SA day → 1, 999 wraps to 1", () => {
    expect(nextCounterValue(null, "2026-9-2")).toEqual({ day: "2026-9-2", counter: 1 });
    expect(nextCounterValue({ day: "2026-9-1", counter: 40 }, "2026-9-2")).toEqual({ day: "2026-9-2", counter: 1 });
    expect(nextCounterValue({ day: "2026-9-2", counter: 40 }, "2026-9-2")).toEqual({ day: "2026-9-2", counter: 41 });
    expect(nextCounterValue({ day: "2026-9-2", counter: 999 }, "2026-9-2")).toEqual({ day: "2026-9-2", counter: 1 });
  });
  it("the TV board with no section, and Section 2's, read the ONE imported range", () => {
    for (const section of [null, undefined, 2, "2"]) {
      expect(tvOrderKeyRanges(NET, section)).toEqual([{ start: TV_ORDER_KEY_START, end: TV_ORDER_KEY_END }]);
    }
  });
});

describe("Section 1 — a store's own sequence", () => {
  it("Pine and Concrete get their own counter paths and prefixed keys", () => {
    expect(orderPrefixFor(NET, "marathon-pine")).toBe("P");
    expect(orderPrefixFor(NET, "pine")).toBe("P");               // the POS spelling resolves too
    expect(orderCounterPath(NET, "marathon-pine")).toBe("orderCounter_byStore/marathon-pine");
    expect(orderCounterPath(NET, "pine")).toBe("orderCounter_byStore/marathon-pine");
    expect(refillCounterPath(NET, "concrete")).toBe("refillCounter_byStore/concrete");
    expect(formatOrderKey("P", 1)).toBe("P001");
    expect(formatOrderKey("C", 42)).toBe("C042");
    expect(formatRefillNumber("P", 1)).toBe("RP001");
  });

  it("no prefixed key can collide with a shared key, or reach Section 2's board", () => {
    const shared = new Set();
    for (let n = 1; n <= 999; n++) shared.add(formatOrderKey(null, n));
    for (const prefix of ["P", "C"]) {
      for (let n = 1; n <= 999; n++) {
        const k = formatOrderKey(prefix, n);
        expect(shared.has(k)).toBe(false);
        expect(keyInTvOrdersRange(k)).toBe(false);
        expect(keyInOrderRanges(k, tvOrderKeyRanges(NET, null))).toBe(false);
      }
    }
  });

  it("a Section 1 board reads its own stores' customer orders and nothing else", () => {
    const ranges = tvOrderKeyRanges(NET, 1);
    expect(ranges).toHaveLength(2);
    for (const k of ["P001", "P999", "C001", "C120"]) expect(keyInOrderRanges(k, ranges)).toBe(true);
    // not Section 2's orders, not refill carts of anyone, not legacy keys
    for (const k of ["001", "999", "R001-1", "RP001-1", "RC014-2", "items", "-Nabc"]) {
      expect(keyInOrderRanges(k, ranges)).toBe(false);
    }
    // built from the imported bounds, sentinel included
    expect(ranges[0].end.endsWith(TV_ORDER_KEY_END)).toBe(true);
  });

  it("refill keys of a prefixed store never reach ANY board", () => {
    for (const k of ["RP001-1", "RC999-30"]) {
      expect(keyInTvOrdersRange(k)).toBe(false);
      expect(keyInOrderRanges(k, tvOrderKeyRanges(NET, 1))).toBe(false);
    }
  });

  it("a prefix starting with R is refused loudly — it would sit inside the refill key space", () => {
    const net = normalizeNetwork({ locations: { concrete: { numberPrefix: "RC" } } });
    expect(() => orderPrefixFor(net, "concrete")).toThrow(/reserved for refill/);
    expect(() => formatOrderKey("R", 1)).toThrow();
  });
});

describe("reading a key back", () => {
  it("parses every shape", () => {
    expect(parseOrderKey("001")).toEqual({ kind: "order", prefix: "", number: 1 });
    expect(parseOrderKey("P012")).toEqual({ kind: "order", prefix: "P", number: 12 });
    expect(parseOrderKey("R001-3")).toEqual({ kind: "refill", prefix: "", number: 1, line: "3" });
    expect(parseOrderKey("RP001-3")).toEqual({ kind: "refill", prefix: "P", number: 1, line: "3" });
    expect(parseOrderKey("R001-1015").kind).toBe("refill");
    for (const k of ["items", "-Nabc123", "~C123", "", null]) expect(parseOrderKey(k).kind).toBe(null);
  });
  it("round-trips what it formats", () => {
    expect(parseOrderKey(formatOrderKey("C", 7))).toEqual({ kind: "order", prefix: "C", number: 7 });
    expect(parseOrderKey(`${formatRefillNumber("C", 7)}-2`)).toEqual({ kind: "refill", prefix: "C", number: 7, line: "2" });
  });
  it("the gap audit counts the SHARED sequence only", () => {
    expect(isSharedSequenceOrderKey("001")).toBe(true);
    expect(isSharedSequenceOrderKey("P001")).toBe(false);   // would digit-strip to a fake duplicate of 001
    expect(isSharedSequenceOrderKey("R001-1")).toBe(false);
  });
  it("what a customer types", () => {
    expect(orderKeyFromInput("7")).toBe("007");
    expect(orderKeyFromInput("#012")).toBe("012");
    expect(orderKeyFromInput(" p7 ")).toBe("P007");
    expect(orderKeyFromInput("C120")).toBe("C120");
    expect(orderKeyFromInput("hello")).toBe("hello");
  });
  it("the kiosk URL's section", () => {
    expect(tvSectionFromSearch("?section=1")).toBe(1);
    expect(tvSectionFromSearch("?section=2")).toBe(2);
    expect(tvSectionFromSearch("")).toBe(null);
    expect(tvSectionFromSearch("?section=9")).toBe(null);
  });
});
