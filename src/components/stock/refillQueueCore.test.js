// ─── UNIFIED QUEUE CORE — the sale-cell → request-row bridge, pinned ─────────
// Run: npx vitest run src/components/stock/refillQueueCore.test.js
import { describe, it, expect } from "vitest";
import { earliestSaleTs, pendingSaleRows, queueStatusLine, sortQueueRows } from "./refillQueueCore.js";
import { sourceMovementIdSeed } from "./sourceMovementDedupe.js";
import { encodeSizeKey } from "../../utils/sizeKey.js";

describe("earliestSaleTs — dates a sale cell by its FIRST sale", () => {
  it("keeps the earliest timestamp per (product, size), keyed like the counts builder", () => {
    const out = earliestSaleTs([
      { productId: "p1", productName: "Boot", size: "7", timestamp: "2026-08-08T10:00:00.000Z" },
      { productId: "p1", productName: "Boot", size: "7", timestamp: "2026-08-08T08:00:00.000Z" },
      { productId: "p1", productName: "Boot", size: "8", timestamp: "2026-08-08T09:00:00.000Z" },
    ]);
    expect(out.p1["7"]).toBe(Date.parse("2026-08-08T08:00:00.000Z"));
    expect(out.p1["8"]).toBe(Date.parse("2026-08-08T09:00:00.000Z"));
  });

  it("ignores rows with no size or no parseable timestamp — they can never hide work", () => {
    const out = earliestSaleTs([
      { productId: "p1", productName: "Boot", size: "", timestamp: "2026-08-08T08:00:00.000Z" },
      { productId: "p1", productName: "Boot", size: "7", timestamp: "not-a-time" },
    ]);
    expect(out).toEqual({});
  });
});

describe("pendingSaleRows — sale cells as gate-compatible request rows", () => {
  const counts = {
    p1: { productName: "Boot", productId: "p1", nameKey: "boot", photo: "", photoUrl: null,
          sizes: { 7: 2, 8: 1 } },
  };

  it("one row per size, qty = count, createdAt derived from the sale time", () => {
    const rows = pendingSaleRows({
      counts, responses: {}, progress: {}, date: "2026-08-08",
      tsBySize: { p1: { 7: Date.parse("2026-08-08T05:00:00.000Z") } },
      fallbackMs: Date.parse("2026-08-08T00:00:00.000Z"),
    });
    expect(rows).toHaveLength(2);
    const r7 = rows.find((r) => r.size === "7");
    expect(r7.qty).toBe(2);
    expect(r7.origin).toBe("sale");
    expect(r7.createdAt).toBe("2026-08-08T05:00:00.000Z");
    // no sale time recorded for size 8 → the fallback (SA day start) dates it
    expect(rows.find((r) => r.size === "8").createdAt).toBe("2026-08-08T00:00:00.000Z");
  });

  it("a responded cell drops out — under the pid key AND the legacy name key", () => {
    const base = { counts, progress: {}, date: "2026-08-08", tsBySize: null, fallbackMs: 0 };
    expect(pendingSaleRows({ ...base, responses: { p1: { 7: { response: "available" } } } })
      .map((r) => r.size)).toEqual(["8"]);
    expect(pendingSaleRows({ ...base, responses: { boot: { 8: { response: "out_of_stock" } } } })
      .map((r) => r.size)).toEqual(["7"]);
  });

  it("partial progress carries over as `sent`, reading BOTH keys and taking the larger", () => {
    const rows = pendingSaleRows({
      counts, responses: {}, date: "2026-08-08", tsBySize: null, fallbackMs: 0,
      progress: { p1: { 7: { fulfilledQty: 1 } }, boot: { 7: { fulfilledQty: 2 } } },
    });
    expect(rows.find((r) => r.size === "7").sent).toBe(2);
  });

  it("movement-id seeds are EXACTLY the Source fulfil panel's — a partial send survives the redesign", () => {
    const rows = pendingSaleRows({ counts, responses: {}, progress: {}, date: "2026-08-08", tsBySize: null, fallbackMs: 0 });
    const r7 = rows.find((r) => r.size === "7");
    expect(r7.movementIdSeed).toBe(sourceMovementIdSeed("2026-08-08", "p1", "7"));
    expect(r7.legacyMovementIdSeed).toBe(sourceMovementIdSeed("2026-08-08", "boot", "7"));
  });

  it("a half size is encoded before seeding — '.' is illegal in an RTDB key (CodeRabbit, PR #337)", () => {
    const half = { p1: { ...counts.p1, sizes: { "5.5": 1 } } };
    const [row] = pendingSaleRows({ counts: half, responses: {}, progress: {}, date: "2026-08-08", tsBySize: null, fallbackMs: 0 });
    expect(row.movementIdSeed).toBe(sourceMovementIdSeed("2026-08-08", "p1", encodeSizeKey("5.5")));
    expect(row.movementIdSeed).not.toContain(".");
  });

  it("the cellFilter (SNEAKERS / CLOTHING toggle) applies per cell", () => {
    const rows = pendingSaleRows({
      counts, responses: {}, progress: {}, date: "2026-08-08", tsBySize: null, fallbackMs: 0,
      cellFilter: (key, product, size) => size === "7",
    });
    expect(rows.map((r) => r.size)).toEqual(["7"]);
  });
});

describe("queueStatusLine — the ONE line the quiet page shows", () => {
  it("work to pick: count + next batch + waiting + covered", () => {
    expect(queueStatusLine({ pickCount: 4, waitingCount: 2, coveredCount: 1, windowsDisabled: false, nextLabel: "14:00" }))
      .toBe("4 to pick · next batch 14:00 · 2 waiting · 1 already covered by stock");
  });
  it("empty between windows: says when the next batch lands", () => {
    expect(queueStatusLine({ pickCount: 0, waitingCount: 3, coveredCount: 0, windowsDisabled: false, nextLabel: "06:00" }))
      .toBe("Nothing to pick — next batch lands 06:00 · 3 waiting");
  });
  it("batching off: no window talk at all", () => {
    expect(queueStatusLine({ pickCount: 2, waitingCount: 0, coveredCount: 0, windowsDisabled: true, nextLabel: "" }))
      .toBe("2 to pick");
    expect(queueStatusLine({ pickCount: 0, waitingCount: 0, coveredCount: 0, windowsDisabled: true, nextLabel: "" }))
      .toBe("Nothing to pick");
  });
});

describe("sortQueueRows — longest-waiting first, whatever the origin", () => {
  it("interleaves request and sale rows by age", () => {
    const rows = sortQueueRows([
      { origin: "sale", rowKey: "s1", createdMs: 300 },
      { origin: "request", rowKey: "r1", createdMs: 100 },
      { origin: "sale", rowKey: "s2", createdMs: 200 },
    ]);
    expect(rows.map((r) => r.rowKey)).toEqual(["r1", "s2", "s1"]);
  });
});
