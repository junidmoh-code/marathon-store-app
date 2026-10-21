import { describe, it, expect } from "vitest";
import { mintOrderRef } from "./orderRefs.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";
import {
  ORDER_REF_ALPHABET, ORDER_REF_REUSE_AFTER_MS, isOrderRefCode, randomOrderRef, foldOrderRef,
} from "../../../src/utils/onlineOrders.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const seq = (codes) => {
  const draws = codes.flatMap((c) => [...c].map((ch) => (ORDER_REF_ALPHABET.indexOf(ch) + 0.5) / ORDER_REF_ALPHABET.length));
  let i = 0;
  return () => draws[i++ % draws.length];
};

describe("the code alphabet", () => {
  it("is 24 upper-case letters with no I and no O, no digits", () => {
    expect(ORDER_REF_ALPHABET).toHaveLength(24);
    expect(ORDER_REF_ALPHABET).not.toMatch(/[IO0-9]/);
    expect(ORDER_REF_ALPHABET).toMatch(/^[A-Z]+$/);
  });
  it("random codes are always 3 letters and never contain I or O (10,000 draws)", () => {
    for (let i = 0; i < 10_000; i++) {
      const c = randomOrderRef();
      expect(c).toMatch(/^[A-HJ-NP-Z]{3}$/);
    }
  });
  it("covers the edges of the range (rand → 0 and → just under 1)", () => {
    expect(randomOrderRef(() => 0)).toBe("AAA");
    expect(randomOrderRef(() => 0.999999)).toBe("ZZZ");
  });
  it.each([["KQZ", true], ["ABC", true], ["KIZ", false], ["KOZ", false], ["kqz", false], ["KQ", false], ["KQZA", false], ["K1Z", false], ["WEB-1768", false], [null, false]])(
    "isOrderRefCode(%j) → %s", (v, ok) => expect(isOrderRefCode(v)).toBe(ok));
  it("foldOrderRef reads a scan or typing in any case", () => {
    expect(foldOrderRef(" kqz\n")).toBe("KQZ");
    expect(foldOrderRef("k-q-z")).toBe("KQZ");
  });
});

describe("mintOrderRef — unique against the last 180 days, by exact-path claim", () => {
  it("claims a free code and records who has it", async () => {
    const f = fakeDb({});
    expect(await mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ"]) })).toBe("KQZ");
    expect(f.read("online_order_refs/KQZ")).toEqual({ orderId: "9001", at: NOW });
  });

  it("skips a code another order holds within 180 days", async () => {
    const f = fakeDb({ online_order_refs: { KQZ: { orderId: "8000", at: NOW - 1000 } } });
    expect(await mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ", "BCD"]) })).toBe("BCD");
    expect(f.read("online_order_refs/KQZ")).toEqual({ orderId: "8000", at: NOW - 1000 }); // untouched
  });

  it("reuses a code whose claim is older than 180 days", async () => {
    const f = fakeDb({ online_order_refs: { KQZ: { orderId: "8000", at: NOW - ORDER_REF_REUSE_AFTER_MS - 1 } } });
    expect(await mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ"]) })).toBe("KQZ");
    expect(f.read("online_order_refs/KQZ").orderId).toBe("9001");
  });

  it("exactly at 180 days the old claim still holds", async () => {
    const f = fakeDb({ online_order_refs: { KQZ: { orderId: "8000", at: NOW - ORDER_REF_REUSE_AFTER_MS + 1 } } });
    expect(await mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ", "BCD"]) })).toBe("BCD");
  });

  it("is idempotent for the same order (a re-run keeps its code)", async () => {
    const f = fakeDb({ online_order_refs: { KQZ: { orderId: "9001", at: NOW - 5 } } });
    expect(await mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ"]) })).toBe("KQZ");
  });

  it("gives up loudly (the order retries next tick) when every draw collides", async () => {
    const f = fakeDb({ online_order_refs: { KQZ: { orderId: "8000", at: NOW } } });
    await expect(mintOrderRef(f.db, "9001", NOW, { rand: seq(["KQZ"]) })).rejects.toThrow(/could not mint/);
  });

  it("never reads /online_orders (the registry is the lookup)", async () => {
    const f = fakeDb({});
    const touched = [];
    const db = { ref: (p) => { touched.push(p); return f.db.ref(p); } };
    await mintOrderRef(db, "9001", NOW, { rand: seq(["KQZ"]) });
    expect(touched).toEqual(["online_order_refs/KQZ"]);
  });
});
