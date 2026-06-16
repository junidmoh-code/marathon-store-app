// Tests for the Phase 3 demand-driven reorder reasoner (lib/reorder-demand.cjs).
// These lock the contract the function now reasons over: rows partition into
// active/dormant/ignored, OOS is carried into per-size true demand, the catalog
// is analysed uncapped (chunk + merge), totalSuggested is recomputed (never
// trusted from the model), and the deterministic plan fields are derived from the
// supplied aggregates — not re-aggregated.
//
// Pure module, no Firebase / no Anthropic, so it runs under `node --test`.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const R = require("../lib/reorder-demand.cjs");

// A demand row shaped exactly like buildReorderPayload(computeDemand(...)).rows[i].
function row(over = {}) {
  return {
    id: "p1700000000000",
    name: "Air Max 90",
    sold: 30, oos: 12, placed: 40, trueDemand: 42,
    velocityPerWeek: 6, trueDemandPerWeek: 8.4,
    recentSold: 9, recentOos: 4,
    bySize: {
      "9":  { sold: 12, oos: 6, placed: 15, trueDemand: 18 },
      "10": { sold: 18, oos: 6, placed: 25, trueDemand: 24 },
    },
    ageDays: 35, sizes: ["8", "9", "10"], stores: ["central"],
    lastSaleDate: "2026-06-05", depleted: false, retailPrice: 2000,
    firstSaleMs: 0,
    ...over,
  };
}

test("classifyDemandRow: active when sold or oos > 0", () => {
  assert.equal(R.classifyDemandRow(row({ sold: 1, oos: 0 })), "active");
  assert.equal(R.classifyDemandRow(row({ sold: 0, oos: 3 })), "active");
});

test("classifyDemandRow: dormant when no demand but listed sizes", () => {
  assert.equal(R.classifyDemandRow(row({ sold: 0, oos: 0, sizes: ["9"] })), "dormant");
});

test("classifyDemandRow: ignored when no demand and no sizes", () => {
  assert.equal(R.classifyDemandRow(row({ sold: 0, oos: 0, sizes: [] })), "ignored");
  assert.equal(R.classifyDemandRow(null), "ignored");
});

test("partitionDemandRows splits the catalog into three buckets", () => {
  const { active, dormant, ignored } = R.partitionDemandRows([
    row({ id: "a", sold: 5, oos: 0 }),
    row({ id: "b", sold: 0, oos: 0, sizes: ["S", "M"] }),
    row({ id: "c", sold: 0, oos: 0, sizes: [] }),
    row({ id: "d", sold: 0, oos: 7 }),
  ]);
  assert.deepEqual(active.map(r => r.id), ["a", "d"]);
  assert.deepEqual(dormant.map(r => r.id), ["b"]);
  assert.deepEqual(ignored.map(r => r.id), ["c"]);
});

test("slimActiveRow carries OOS at product and per-size level (true demand = sold + oos)", () => {
  const s = R.slimActiveRow(row());
  assert.equal(s.type, "active");
  assert.equal(s.oos, 12);
  assert.equal(s.trueDemand, 42);
  assert.equal(s.bySize["9"].oos, 6);
  assert.equal(s.bySize["9"].trueDemand, 18); // 12 sold + 6 oos
  assert.equal(s.bySize["10"].trueDemand, 24);
});

test("slimBySize derives trueDemand when the row omits it", () => {
  const out = R.slimBySize({ "9": { sold: 4, oos: 3 } });
  assert.equal(out["9"].trueDemand, 7);
});

test("chunk splits without dropping the tail", () => {
  assert.deepEqual(R.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(R.chunk([], 2), []);
});

test("mapWithConcurrency preserves order and respects the limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await R.mapWithConcurrency(items, 3, async (x) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    return x * 2;
  });
  assert.deepEqual(out, items.map(x => x * 2));
  assert.ok(maxInFlight <= 3, `maxInFlight ${maxInFlight} should be <= 3`);
});

test("buildTopSellers ranks by sold, desc", () => {
  const top = R.buildTopSellers([
    row({ name: "A", sold: 5 }),
    row({ name: "B", sold: 50 }),
    row({ name: "C", sold: 20 }),
  ], 2);
  assert.deepEqual(top, [
    { productName: "B", totalSales: 50 },
    { productName: "C", totalSales: 20 },
  ]);
});

test("buildSleepers surfaces sold-but-quiet products only", () => {
  const sleepers = R.buildSleepers([
    row({ name: "Quiet", sold: 30, recentSold: 0, lastSaleDate: "2026-01-01" }),
    row({ name: "Active", sold: 30, recentSold: 9 }),
    row({ name: "NeverSold", sold: 0, recentSold: 0 }),
  ], 30);
  assert.equal(sleepers.length, 1);
  assert.equal(sleepers[0].productName, "Quiet");
  assert.equal(sleepers[0].totalSales, 30);
  assert.match(sleepers[0].note, /last 30d/);
});

test("buildSummary reports true demand = sold + oos and the cycle", () => {
  const s = R.buildSummary({
    totals: { sold: 3200, oos: 1800, trueDemand: 5000 },
    coverage: { coveragePct: 57 },
    cycleDays: 35, activeCount: 700, dormantCount: 534,
  });
  assert.match(s, /5000 units/);
  assert.match(s, /3200 sold \+ 1800/);
  assert.match(s, /35-day cycle/);
  assert.match(s, /57%/);
});

test("buildDataQualityNotes records coverage, ignored, and unanalysed (no silent truncation)", () => {
  const notes = R.buildDataQualityNotes({
    coverage: { coveragePct: 57, matchedProducts: 700, catalogTotal: 1234, unmatchedEvents: 1665, nameCollisions: 8 },
    ignoredCount: 12,
    unanalyzedProductIds: ["x", "y"],
    window: "all",
  });
  const joined = notes.join(" | ");
  assert.match(joined, /did NOT re-aggregate/);
  assert.match(joined, /coverage 57%/);
  assert.match(joined, /collisions/);
  assert.match(joined, /12 catalog products/);
  assert.match(joined, /2 products could not be analysed/);
});

test("normalizeRecommendation recomputes totalSuggested and clamps enums", () => {
  const rec = R.normalizeRecommendation({
    productId: "p1", productName: "X",
    action: "buy_more",          // invalid -> skip
    priority: "urgent",          // invalid -> low
    suggestedQuantity: { "9": 6, "10": "4", "11": 0, "12": -3 },
    totalSuggested: 999,         // wrong -> recomputed to 10
    reasoning: "because",
  });
  assert.equal(rec.action, "skip");
  assert.equal(rec.priority, "low");
  assert.deepEqual(rec.suggestedQuantity, { "9": 6, "10": 4 }); // 0 and negatives dropped
  assert.equal(rec.totalSuggested, 10);
});

test("normalizeRecommendation rejects entries without a productId", () => {
  assert.equal(R.normalizeRecommendation({ action: "reorder" }), null);
  assert.equal(R.normalizeRecommendation(null), null);
});

test("mergeRecommendations normalises, flattens, and de-dupes by productId", () => {
  const merged = R.mergeRecommendations([
    { recommendations: [
      { productId: "p1", action: "reorder", priority: "high", suggestedQuantity: { "9": 3 } },
      { productId: "p2", action: "skip" },
    ] },
    null,
    { recommendations: [
      { productId: "p1", action: "review" },   // dup -> dropped
      { productId: "p3", action: "slow_mover", priority: "low" },
    ] },
  ]);
  assert.deepEqual(merged.map(r => r.productId), ["p1", "p2", "p3"]);
  assert.equal(merged[0].action, "reorder");   // first occurrence wins
  assert.equal(merged[0].totalSuggested, 3);
});

test("demandSystemPrompt states the cycle, true-demand rule, and per-size sourcing", () => {
  const p = R.demandSystemPrompt({ businessContext: null, cycleDays: 35, recentDays: 30, window: "all" });
  assert.match(p, /35-day cycle/);
  assert.match(p, /TRUE DEMAND = sold \+ oos/);
  assert.match(p, /bySize\[size\]\.trueDemand/);
  assert.match(p, /DO NOT RE-DERIVE/);
});

test("buildBatchUserPayload is valid JSON carrying the cycle and rows", () => {
  const json = R.buildBatchUserPayload({
    cycleDays: 35, recentDays: 30, window: "all",
    batchIndex: 0, batchCount: 2, rows: [R.slimActiveRow(row())],
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.cycleDays, 35);
  assert.equal(parsed.productCount, 1);
  assert.equal(parsed.products[0].productId, "p1700000000000");
});

test("schema version is exported and an integer", () => {
  assert.ok(Number.isInteger(R.REORDER_DEMAND_SCHEMA_VERSION));
});
