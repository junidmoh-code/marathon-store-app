// The New-tab backfill: in-stock, not-yet-queued uploads after the start; idempotent.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { run, sinceKey, notCandidate } from "./backfillNew.mjs";

const { makeFakeDb } = createRequire(import.meta.url)("../../functions/test/helpers/fake-rtdb.cjs");
const P = (n) => `p17950000000${String(n).padStart(2, "0")}`;
const world = () => makeFakeDb({
  locations: { central: { name: "Central" }, in_transit: { name: "Transit" } },
  products: {
    [P(1)]: { name: "queued, the last that reached the card", categoryKey: "sneakers", sizes: ["7"] },
    [P(2)]: { name: "missed sneaker", categoryKey: "sneakers", sizes: ["7", "8"] },
    [P(3)]: { name: "missed hoodie, no price", categoryKey: "hoodies", sizes: ["M"] },
    [P(4)]: { name: "missed, sold out", categoryKey: "sneakers", sizes: ["7"] },
    [P(5)]: { name: "missed, only in transit", categoryKey: "sneakers", sizes: ["7"] },
    [P(6)]: { name: "already Done", categoryKey: "sneakers", sizes: ["7"] },
    [P(7)]: { name: "merged", categoryKey: "sneakers", sizes: ["7"], mergedInto: P(2) },
    [P(8)]: { name: "price record", category: "Price Products", sizes: ["7"] },
    p1700000000000: { name: "older than the start", categoryKey: "sneakers", sizes: ["7"] },
  },
  stock: {
    central: { [P(2)]: { 7: { qty: 1 } }, [P(3)]: { M: 2 }, [P(4)]: { 7: { qty: 0 } }, [P(6)]: { 7: 3 }, [P(7)]: { 7: 1 }, [P(8)]: { 7: 1 }, p1700000000000: { 7: 1 } },
    in_transit: { [P(5)]: { 7: 4 } },
  },
  new_arrivals: {
    items: { [P(1)]: { pid: P(1), status: "new", enqueuedAt: 1 }, [P(6)]: { pid: P(6), status: "done", enqueuedAt: 1 } },
    by_status: { new: { [P(1)]: 1 }, done: { [P(6)]: 1 } },
  },
});
const read = async (db, p) => (await db.ref(p).once()).val();

describe("backfillNew", () => {
  it("adds only in-stock, unqueued uploads after the start; split by group", async () => {
    const db = world();
    // Default start = the newest queued key (P6, Done) — so only P7, P8 follow, neither a candidate.
    expect((await run(db, { nowMs: 5 })).added).toEqual([]);
    const out = await run(db, { since: P(1), nowMs: 5 });
    expect(out.added).toEqual([P(2), P(3)]);
    expect(out.counts).toEqual({ sneakers: 1, clothing: 1 });
    expect(out.outOfStock).toBe(2);
    expect(await read(db, `new_arrivals/items/${P(2)}/status`)).toBe("new");
    expect(await read(db, `new_arrivals/items/${P(2)}/backfilled`)).toBe(true);
    expect(await read(db, `new_arrivals/by_status/new/${P(3)}`)).toBe(5);
    expect(await read(db, `new_arrivals/items/${P(6)}/status`)).toBe("done");
    expect(await read(db, "new_arrivals/items/p1700000000000")).toBe(null);
    expect(Object.keys((await read(db, "new_arrivals/backfills/bf-5")).added)).toEqual([P(2), P(3)]);
  });
  it("is idempotent, and a dry run writes nothing", async () => {
    const db = world();
    const dry = await run(db, { since: P(1), dryRun: true, nowMs: 5 });
    expect(dry.added).toEqual([P(2), P(3)]);
    expect(await read(db, `new_arrivals/items/${P(2)}`)).toBe(null);
    expect(await read(db, "new_arrivals/backfills")).toBe(null);
    await run(db, { since: P(1), nowMs: 5 });
    const again = await run(db, { since: P(1), nowMs: 6 });
    expect(again.added).toEqual([]);
    expect(again.alreadyQueued).toBe(3);
    expect(await read(db, "new_arrivals/backfills/bf-6")).toBe(null);
  });
  it("parses --since and names non-candidates", () => {
    expect(sinceKey("2026-10-02T00:00:00Z")).toBe(`p${Date.parse("2026-10-02T00:00:00Z")}`);
    expect(sinceKey(P(3))).toBe(P(3));
    expect(sinceKey("soon")).toBe(null);
    expect(notCandidate("-Nabc", {})).toMatch(/not an uploaded/);
    expect(notCandidate(P(1), { mergedInto: "x" })).toMatch(/merged/);
    expect(notCandidate(P(1), { name: "ok" })).toBe(null);
  });
});

describe("backfillNew — rerun repair", () => {
  it("re-asserts a missing index entry for an item an earlier run stored", async () => {
    const db = world();
    await db.ref(`new_arrivals/items/${P(2)}`).set({ pid: P(2), status: "new", enqueuedAt: 7 });
    const out = await run(db, { since: P(1), nowMs: 9 });
    expect(out.reindexed).toBe(1);
    expect(await read(db, `new_arrivals/by_status/new/${P(2)}`)).toBe(7);
  });
});
