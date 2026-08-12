// ─── HELD central→hub credits count as INBOUND (count-integrity hold lane) ───
// The hold lane (owner spec 2026-08-12) parks a fulfil's destination credit at
// stock/in_transit until the owner releases the physical box, and CLOSES the
// request as fulfilled. Without the heldLines walk in computeRefillPlan the
// engine would see: destination still short, lock released (fulfilled close),
// inbound zero → a brand-new request in that very scan — double-ordering every
// held cell. These tests pin the guard. Run: cd functions && node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-12T10:00:00.000Z");

const CONFIG = {
  enabled: true,
  mode: { hub2: "live", "marathon-pe": "live" },
  routes: { "marathon-pe": "hub2", hub2: "central" },
  defaultRunRecentSaleDays: 14,
  staleIntentHours: 48,
  maxUnitsPerIntent: 20,
  maxIntentsPerRun: 200,
  ruleBasedTargets: true,
};

const PRODUCTS = { p1: { name: "Runner", productType: "clothing", sizes: ["M"] } };
const cell = (qty) => ({ qty, v: 1 });

// hub2 explicitly targeted at 5, holds 1 → deficit 4 with nothing inbound.
function base(over = {}) {
  return {
    nowMs: NOW, config: CONFIG, products: PRODUCTS,
    targets: { hub2: { p1: { M: { target: 5, minQty: 2 } } } },
    stock: { hub2: { p1: { M: cell(1) } }, central: { p1: { M: cell(50) } }, "marathon-pe": {} },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    ...over,
  };
}

test("BASELINE: short hub with no inbound raises the central→hub intent", () => {
  const plan = computeRefillPlan(base());
  const i = plan.intents.find((x) => x.dest === "hub2" && x.sizeKey === "M");
  assert.ok(i, "the deficit is real — this test exists so the next two mean something");
  assert.equal(i.qty, 4);
});

test("a HELD line fully covering the deficit suppresses the re-ask entirely", () => {
  const plan = computeRefillPlan(base({
    heldLines: { hub2: { rrf_r1: { productId: "p1", size: "M", sizeKey: "M", qty: 4, shipmentId: "2026-08-12_1400", refillId: "r1" } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "M").length, 0,
    "held units are inbound — the engine must NOT re-order a held cell");
});

test("a PARTIAL hold still suppresses (any inbound on the cell blocks a new ask)", () => {
  const plan = computeRefillPlan(base({
    heldLines: { hub2: { rrf_r1: { productId: "p1", size: "M", sizeKey: "M", qty: 1, shipmentId: "2026-08-12_1400", refillId: "r1" } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "M").length, 0,
    "the existing inb>0 suppressor covers partially-held cells too");
});

test("held lines key by ENCODED size — a 5.5 hold covers the 5_5 cell", () => {
  const plan = computeRefillPlan(base({
    targets: { hub2: { p1: { "5_5": { target: 3, minQty: 1 } } } },
    stock: { hub2: { p1: { "5_5": cell(0) } }, central: { p1: { "5_5": cell(9) } }, "marathon-pe": {} },
    products: { p1: { name: "Runner", productType: "clothing", sizes: ["5.5"] } },
    heldLines: { hub2: { rrf_r2: { productId: "p1", size: "5.5", qty: 3, shipmentId: "2026-08-12_1400" } } }, // no sizeKey → derived
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "5_5").length, 0);
});

test("a held line for ANOTHER cell suppresses nothing", () => {
  const plan = computeRefillPlan(base({
    heldLines: { hub2: { rrf_r3: { productId: "p1", size: "L", sizeKey: "L", qty: 4, shipmentId: "2026-08-12_1400" } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "M").length, 1,
    "an unrelated held line must not hide a real deficit");
});

test("malformed held lines are skipped, never crash the plan", () => {
  const plan = computeRefillPlan(base({
    heldLines: { hub2: { junk1: null, junk2: {}, junk3: { qty: 2 } } },
  }));
  assert.equal(plan.intents.filter((x) => x.dest === "hub2" && x.sizeKey === "M").length, 1);
});

test("held lines do NOT reserve source stock — the units already left central", () => {
  // marathon-pe needs M from hub2; hub2 has just enough. A held line at hub2
  // must not shrink what the store leg may pick from hub2 (holds park units
  // that ALREADY left their source — reserving would double-count).
  const plan = computeRefillPlan(base({
    targets: {
      "marathon-pe": { p1: { M: { target: 2, minQty: 1 } } },
      hub2: { p1: { M: { target: 5, minQty: 2 } } },
    },
    stock: { "marathon-pe": { p1: { M: cell(0) } }, hub2: { p1: { M: cell(2) } }, central: { p1: { M: cell(50) } } },
    heldLines: { hub2: { rrf_r4: { productId: "p1", size: "M", sizeKey: "M", qty: 3, shipmentId: "2026-08-12_1400" } } },
  }));
  const storeLeg = plan.intents.find((x) => x.dest === "marathon-pe" && x.sizeKey === "M");
  assert.ok(storeLeg, "the store leg exists");
  assert.equal(storeLeg.qty, 2, "hub2's on-hand is fully pickable — held lines reserve nothing at the source");
});
