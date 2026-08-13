import { test } from "vitest";
import assert from "node:assert";
import { buildPriceBatch, buildRestoreBatch, computeRestoreDrift, normaliseLines } from "./priceBatch";

const STAMPS = { at: "2026-08-13T10:00:00.000Z", atMs: 1786615200000, by: "u1", byEmail: "junid@marathon.internal" };

const twoLine = () => ({
  p100: { name: "Nike Cap", from: { retailPrice: null }, to: { retailPrice: 250 } },
  p200: { name: "Puma Tee", from: { stockPrice: 90, retailPrice: 180 }, to: { stockPrice: 100, retailPrice: 200 } },
});

// ── buildPriceBatch ──────────────────────────────────────────────────────────

test("batch writes exactly the changed fields, the record and the index — nothing else", () => {
  const { updates, record, meta } = buildPriceBatch({ batchId: "pb_1_a", action: "bulk_fill", lines: twoLine(), label: "fill", ...STAMPS });
  assert.deepEqual(Object.keys(updates).sort(), [
    "price_history/pb_1_a",
    "price_history_index/pb_1_a",
    "products/p100/retailPrice",
    "products/p200/retailPrice",
    "products/p200/stockPrice",
  ]);
  assert.equal(updates["products/p100/retailPrice"], 250);
  assert.equal(updates["products/p200/stockPrice"], 100);
  assert.equal(record.count, 2);
  assert.equal(record.by, "u1");
  assert.equal(record.byEmail, "junid@marathon.internal");
  assert.equal(record.at, STAMPS.at);
  assert.deepEqual(record.lines.p200.from, { stockPrice: 90, retailPrice: 180 });
  assert.deepEqual(record.lines.p200.to, { stockPrice: 100, retailPrice: 200 });
  // The index twin is compact: no lines.
  assert.equal(meta.lines, undefined);
  assert.equal(meta.count, 2);
});

test("bulk actions may not clear a price; single_edit may", () => {
  const clearLine = { p1: { name: "X", from: { retailPrice: 100 }, to: { retailPrice: null } } };
  assert.throws(() => buildPriceBatch({ batchId: "pb_1_b", action: "bulk_change", lines: clearLine, ...STAMPS }), /may not clear/);
  const ok = buildPriceBatch({ batchId: "pb_1_c", action: "single_edit", lines: clearLine, ...STAMPS });
  assert.equal(ok.updates["products/p1/retailPrice"], null);
});

test("zero, negative, NaN and string prices are refused — the POS null-never-0 contract", () => {
  for (const bad of [0, -5, NaN, Infinity, "250", ""]) {
    assert.throws(
      () => buildPriceBatch({ batchId: "pb_1_d", action: "bulk_fill", lines: { p1: { name: "X", from: { retailPrice: null }, to: { retailPrice: bad } } }, ...STAMPS }),
      /positive number or null/,
      `expected refusal for ${JSON.stringify(bad)}`,
    );
  }
});

test("no-op lines are refused outside restore; empty batches always", () => {
  assert.throws(() => buildPriceBatch({ batchId: "pb_1_e", action: "bulk_change", lines: { p1: { name: "X", from: { retailPrice: 100 }, to: { retailPrice: 100 } } }, ...STAMPS }), /no-op/);
  assert.throws(() => buildPriceBatch({ batchId: "pb_1_f", action: "bulk_fill", lines: {}, ...STAMPS }), /at least one product/);
});

test("history must cover exactly what changes — mismatched from/to fields refused", () => {
  assert.throws(
    () => buildPriceBatch({ batchId: "pb_1_g", action: "bulk_fill", lines: { p1: { name: "X", from: {}, to: { retailPrice: 100 } } }, ...STAMPS }),
    /history must cover exactly/,
  );
});

test("unsafe batch ids, product ids, unknown fields and actions are refused", () => {
  const lines = { p1: { name: "X", from: { retailPrice: null }, to: { retailPrice: 9 } } };
  assert.throws(() => buildPriceBatch({ batchId: "pb/evil", action: "bulk_fill", lines, ...STAMPS }), /Unsafe batchId/);
  assert.throws(() => buildPriceBatch({ batchId: "pb_1", action: "hack", lines, ...STAMPS }), /Unknown action/);
  assert.throws(() => normaliseLines({ "p#1": { name: "X", from: { retailPrice: null }, to: { retailPrice: 9 } } }, "bulk_fill"), /Unsafe product id/);
  assert.throws(() => normaliseLines({ p1: { name: "X", from: { price: 1 }, to: { price: 2 } } }, "bulk_fill"), /unknown price field/);
});

test("aux paths ride the same atomic update; product paths are barred from aux", () => {
  const { updates } = buildPriceBatch({
    batchId: "pb_1_h", action: "special_start",
    lines: { p1: { name: "X", from: { retailPrice: 300 }, to: { retailPrice: 200 } } },
    aux: [{ path: "specials/p1", from: null, to: { price: 200, wasPrice: 300 } }],
    ...STAMPS,
  });
  assert.deepEqual(updates["specials/p1"], { price: 200, wasPrice: 300 });
  assert.throws(
    () => buildPriceBatch({
      batchId: "pb_1_i", action: "special_start",
      lines: { p1: { name: "X", from: { retailPrice: 300 }, to: { retailPrice: 200 } } },
      aux: [{ path: "products/p1/retailPrice", from: 300, to: 1 }],
      ...STAMPS,
    }),
    /belong in lines/,
  );
});

// ── buildRestoreBatch ────────────────────────────────────────────────────────

const RESTAMPS = { at: "2026-08-13T11:00:00.000Z", atMs: 1786618800000, by: "u2", byEmail: null };

test("restore returns every product to its exact prior values and touches nothing else", () => {
  const { record } = buildPriceBatch({ batchId: "pb_2_a", action: "bulk_change", lines: twoLine(), ...STAMPS });
  const { updates, record: rr } = buildRestoreBatch({
    record, batchId: "pb_2_a", restoreBatchId: "pb_2_b",
    currentById: { p100: { retailPrice: 250 }, p200: { stockPrice: 100, retailPrice: 200 } },
    ...RESTAMPS,
  });
  // Exact priors — p100's retail goes back to NOT SET (null), p200 to 90/180.
  assert.equal(updates["products/p100/retailPrice"], null);
  assert.equal(updates["products/p200/stockPrice"], 90);
  assert.equal(updates["products/p200/retailPrice"], 180);
  // Only batch members + the two history nodes + the restored-stamps.
  assert.deepEqual(Object.keys(updates).sort(), [
    "price_history/pb_2_a/restoredAt",
    "price_history/pb_2_a/restoredBy",
    "price_history/pb_2_a/restoredByBatchId",
    "price_history/pb_2_b",
    "price_history_index/pb_2_a/restoredAt",
    "price_history_index/pb_2_b",
    "products/p100/retailPrice",
    "products/p200/retailPrice",
    "products/p200/stockPrice",
  ]);
  assert.equal(updates["price_history/pb_2_a/restoredByBatchId"], "pb_2_b");
  assert.equal(rr.action, "restore");
  assert.equal(rr.restoresBatchId, "pb_2_a");
});

test("a restored batch refuses a second restore", () => {
  const { record } = buildPriceBatch({ batchId: "pb_2_c", action: "bulk_change", lines: twoLine(), ...STAMPS });
  const stamped = { ...record, restoredAt: "2026-08-13T10:30:00.000Z" };
  assert.throws(() => buildRestoreBatch({ record: stamped, batchId: "pb_2_c", restoreBatchId: "pb_2_d", ...RESTAMPS }), /already restored/);
});

test("restore survives a hand-edit back to the prior value (no-op line) and records live drift as its own from", () => {
  const { record } = buildPriceBatch({ batchId: "pb_2_e", action: "bulk_change",
    lines: { p1: { name: "X", from: { retailPrice: 100 }, to: { retailPrice: 120 } } }, ...STAMPS });
  // Someone hand-edited back to 100 already; restore still succeeds.
  const { updates, record: rr } = buildRestoreBatch({
    record, batchId: "pb_2_e", restoreBatchId: "pb_2_f",
    currentById: { p1: { retailPrice: 100 } }, ...RESTAMPS,
  });
  assert.equal(updates["products/p1/retailPrice"], 100);
  assert.equal(rr.lines.p1.from.retailPrice, 100); // live value, not the batch's to
});

test("restore reverses aux paths (to → from)", () => {
  const { record } = buildPriceBatch({
    batchId: "pb_2_g", action: "bulk_change",
    lines: { p1: { name: "X", from: { retailPrice: 100 }, to: { retailPrice: 120 } } },
    aux: [{ path: "some/side/path", from: "old", to: "new" }],
    ...STAMPS,
  });
  const { updates } = buildRestoreBatch({ record, batchId: "pb_2_g", restoreBatchId: "pb_2_h", currentById: { p1: { retailPrice: 120 } }, ...RESTAMPS });
  assert.equal(updates["some/side/path"], "old");
});

test("specials batches must be reversed on the Specials card, not by generic restore", () => {
  const { record } = buildPriceBatch({
    batchId: "pb_2_i", action: "special_start",
    lines: { p1: { name: "X", from: { retailPrice: 300 }, to: { retailPrice: 200 } } },
    aux: [{ path: "specials/p1", from: null, to: { price: 200 } }],
    ...STAMPS,
  });
  assert.throws(() => buildRestoreBatch({ record, batchId: "pb_2_i", restoreBatchId: "pb_2_j", ...RESTAMPS }), /Specials card/);
});

// ── computeRestoreDrift ──────────────────────────────────────────────────────

test("drift flags edited-since and missing products, and nothing else", () => {
  const { record } = buildPriceBatch({ batchId: "pb_3_a", action: "bulk_change", lines: twoLine(), ...STAMPS });
  const drift = computeRestoreDrift(record, {
    p100: { retailPrice: 999 },              // edited since the batch
    // p200 missing entirely
  });
  const byPid = Object.fromEntries(drift.map((d) => [`${d.pid}:${d.field}`, d]));
  assert.equal(byPid["p100:retailPrice"].current, 999);
  assert.equal(byPid["p100:retailPrice"].expected, 250);
  assert.equal(byPid["p200:stockPrice"].missing, true);
  // Clean state → no drift.
  assert.deepEqual(computeRestoreDrift(record, { p100: { retailPrice: 250 }, p200: { stockPrice: 100, retailPrice: 200 } }), []);
});
