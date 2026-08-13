import { test } from "vitest";
import assert from "node:assert";
import { buildBulkFillPlan, buildBulkChangePlan, roundPrice } from "./bulkPricing";

const CATALOG = [
  { id: "p1", name: "Bare", stockPrice: null, retailPrice: null },
  { id: "p2", name: "RetailOnly", retailPrice: 300 },
  { id: "p3", name: "Priced", stockPrice: 100, retailPrice: 250 },
  { id: "p4", name: "JunkZero", stockPrice: 0, retailPrice: "" }, // legacy junk = not set
];

// ── buildBulkFillPlan ────────────────────────────────────────────────────────

test("fill: default SKIPS already-priced fields and says so; bare products get both", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1", "p2", "p3", "p4"], stockDraft: "120", retailDraft: "280" });
  assert.equal(plan.ok, true);
  // p1 and p4 (junk counts as unset) get both fields.
  assert.deepEqual(plan.lines.p1.to, { stockPrice: 120, retailPrice: 280 });
  assert.deepEqual(plan.lines.p4.to, { stockPrice: 120, retailPrice: 280 });
  assert.deepEqual(plan.lines.p4.from, { stockPrice: null, retailPrice: null }); // junk normalised
  // p2 keeps its retail, gains stock only.
  assert.deepEqual(plan.lines.p2.to, { stockPrice: 120 });
  // p3 fully priced → fully skipped, reported honestly.
  assert.equal(plan.lines.p3, undefined);
  assert.deepEqual(plan.skippedAlready.map((s) => s.pid), ["p3"]);
  assert.equal(plan.count, 3);
});

test("fill: overwrite writes entered values over existing ones", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p2", "p3"], stockDraft: "120", retailDraft: "280", overwrite: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.lines.p3.from, { stockPrice: 100, retailPrice: 250 });
  assert.deepEqual(plan.lines.p3.to, { stockPrice: 120, retailPrice: 280 });
  assert.deepEqual(plan.lines.p2.to, { stockPrice: 120, retailPrice: 280 });
  assert.equal(plan.skippedAlready.length, 0);
});

test("fill: a product already holding exactly the entered value is a no-op, not a write", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p3"], retailDraft: "250", overwrite: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.noop.map((s) => s.pid), ["p3"]);
});

test("fill: bad or empty input is refused with a message", () => {
  assert.equal(buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1"] }).ok, false);
  assert.match(buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1"], stockDraft: "0" }).error, /greater than 0/);
  assert.match(buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1"], stockDraft: "abc" }).error, /not a valid price/);
  assert.match(buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1"], stockDraft: "300", retailDraft: "200" }).error, /below stock/);
});

test("fill: unknown selected ids are ignored, not invented", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1", "ghost"], retailDraft: "99" });
  assert.equal(plan.count, 1);
  assert.equal(plan.lines.ghost, undefined);
});

// ── buildBulkChangePlan ──────────────────────────────────────────────────────

test("change absolute: entered fields replace, blank fields untouched", () => {
  const plan = buildBulkChangePlan({ products: CATALOG, selectedIds: ["p3"], mode: "absolute", retailDraft: "199" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.lines.p3.from, { retailPrice: 250 });
  assert.deepEqual(plan.lines.p3.to, { retailPrice: 199 });
  assert.equal(plan.rows[0].toStock, null); // stock untouched
});

test("change percent: -20% sale on retail rounds to whole rand and skips unpriced honestly", () => {
  const plan = buildBulkChangePlan({ products: CATALOG, selectedIds: ["p1", "p2", "p3"], mode: "percent", percentDraft: "-20", applyToRetail: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.lines.p2.to.retailPrice, 240); // 300 → 240
  assert.equal(plan.lines.p3.to.retailPrice, 200); // 250 → 200
  assert.equal(plan.lines.p1, undefined); // no retail price to change
  assert.deepEqual(plan.missingPrice.map((m) => m.pid), ["p1"]);
  assert.equal(plan.count, 2);
});

test("change percent: rounding is nearest whole rand with an R1 floor", () => {
  assert.equal(roundPrice(226.8), 227);
  assert.equal(roundPrice(0.4), 1);
  const plan = buildBulkChangePlan({ products: [{ id: "p9", name: "X", retailPrice: 252 }], selectedIds: ["p9"], mode: "percent", percentDraft: "-10", applyToRetail: true });
  assert.equal(plan.lines.p9.to.retailPrice, 227); // 226.8 → 227
});

test("change percent: refuses 0, -100 and worse, and no-field choices", () => {
  const base = { products: CATALOG, selectedIds: ["p3"], mode: "percent", applyToRetail: true };
  assert.equal(buildBulkChangePlan({ ...base, percentDraft: "0" }).ok, false);
  assert.match(buildBulkChangePlan({ ...base, percentDraft: "-100" }).error, /free or negative/);
  assert.equal(buildBulkChangePlan({ ...base, percentDraft: "-20", applyToRetail: false }).ok, false);
});

test("change: a percent that rounds back to the current price is a no-op, not a write", () => {
  const plan = buildBulkChangePlan({ products: [{ id: "p9", name: "X", retailPrice: 2 }], selectedIds: ["p9"], mode: "percent", percentDraft: "10", applyToRetail: true });
  // 2 * 1.1 = 2.2 → rounds to 2 → unchanged.
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.noop.map((n) => n.pid), ["p9"]);
});

test("SCALE: the whole catalogue in one batch stays a single atomic update within RTDB limits", async () => {
  // Live catalogue is 4,166 products (measured 2026-08-13, shallow keys-only
  // read); 5,000 gives headroom. Both price fields on every product — the
  // worst plausible bulk change.
  const { buildPriceBatch } = await import("./priceBatch");
  const N = 5000;
  const products = Array.from({ length: N }, (_, i) => ({
    id: `p17860000${String(i).padStart(5, "0")}`,
    name: `Product with a fairly long realistic name ${i}`,
    stockPrice: 100 + (i % 400), retailPrice: 250 + (i % 900),
  }));
  const plan = buildBulkChangePlan({ products, selectedIds: products.map((p) => p.id), mode: "percent", percentDraft: "-15", applyToStock: true, applyToRetail: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, N);
  const { updates } = buildPriceBatch({
    batchId: "pb_1786615200000_scale", action: "bulk_change", lines: plan.lines,
    at: "2026-08-13T10:00:00.000Z", atMs: 1786615200000, by: "u1", byEmail: "junid@marathon.internal",
  });
  // ONE update object: 2 price paths per product + the record + the index.
  assert.equal(Object.keys(updates).length, N * 2 + 2);
  // Well inside the 16 MB RTDB write ceiling (history record included).
  const bytes = Buffer.byteLength(JSON.stringify(updates));
  assert.ok(bytes < 16 * 1024 * 1024, `payload ${bytes} bytes exceeds RTDB write limit`);
  assert.ok(bytes < 4 * 1024 * 1024, `payload ${bytes} bytes — unexpectedly large, investigate`);
});

test("plans and batch guards agree: a confirmed plan's lines apply cleanly", async () => {
  const { normaliseLines } = await import("./priceBatch");
  const fill = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1", "p2", "p3"], stockDraft: "120", retailDraft: "280" });
  assert.doesNotThrow(() => normaliseLines(fill.lines, "bulk_fill"));
  const change = buildBulkChangePlan({ products: CATALOG, selectedIds: ["p2", "p3"], mode: "percent", percentDraft: "-15", applyToRetail: true });
  assert.doesNotThrow(() => normaliseLines(change.lines, "bulk_change"));
});
