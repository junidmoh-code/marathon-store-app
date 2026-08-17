// ─── storeCarries VIA THE PROVENANCE INDEX — THE PREDICATE ITSELF ─────────────
//
// Every fixture here states `provenance` and `provenanceMeta` LITERALLY. The
// withProvenance() helper is never used, because it maps cell-existence → carries
// and that mapping is the bug under test. A test that used it here would pass no
// matter what the predicate did.
//
// MUTATION-PROVED: each test names the edit that must break it. Nothing in this file
// re-implements storeCarries, resolveTarget or carriesByIndex — every expectation is
// an intent count or a target shape written out by hand.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { computeRefillPlan, resolveTarget } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-08-17T09:00:00.000Z");
const V = 1;
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_out", updatedAt: "2026-08-17T08:54:00.000Z" });
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-17T10:00:00.000Z", pairs: 1, version: V }]));

// The two real products, by pid — never by name. Eight live "Lacoste sweatshirt*"
// records exist and two are character-identical, so a name here would be a bug.
const NAVY = "p1786452575638";   // "Sweatshirt lacoste nevy blue"
const GREY = "p1786453234097";   // "Lacoste sweatshirt Grey"

const PRODUCTS = {
  [NAVY]: { name: "Sweatshirt lacoste nevy blue", productType: "clothing", categoryKey: "hoodies", sizes: ["M", "L", "XL", "XXL"] },
  [GREY]: { name: "Lacoste sweatshirt Grey", productType: "clothing", categoryKey: "hoodies", sizes: ["M", "L", "XL", "XXL"] },
};

// The live config as it stood on the day, trimmed to what these tests exercise.
const CONFIG = {
  routes: { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" },
  ruleBasedTargets: true,
  defaultRunByStore: {
    "marathon-pe": { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 },
    hub2: { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 },
  },
  maxIntentsPerRun: 75,
};

const snap = (over = {}) => ({
  nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {},
  stock: {}, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
  provenance: {}, provenanceMeta: {},
  ...over,
});

// ═══ THE INCIDENT, REPLAYED ══════════════════════════════════════════════════
// Built from the real 2026-08-17 ledger sequence at marathon-pe, movement by
// movement. Ordered exactly as it happened:
//
//   07:58:57/58  disp_017 / disp_018  transfer_out hub2→marathon-pe, link.orderId
//                only, reason clothing_order — a NAMED CUSTOMER's collection.
//                COLLECTION. This is what created PE's cell (0→1).
//   08:04:52/05:19  transfer_out marathon-pe→trophy, link.transferId — staff walk
//                the unit next door to the shop the buyer is actually in. PE 1→0,
//                cell object REMAINS.
//   08:19–08:20  cr_R004-*  transfer_out hub2→marathon-pe, link.orderId+refillId,
//                reason clothing_cr — the engine's own wrongly-armed fulfil.
//                STOCKING, 4 and 5 units.
//   08:54        crundo_R004-*  reason clothing_cr_undo — the fulfil undone.
//                UNSTOCK, the same 4 and 5 units.
//
// Net at marathon-pe: sold 0, stocked 4/5, unstocked 4/5, collected 1. The shop
// that actually trades them, trophy, sold 6 and 8.
const INCIDENT_PROVENANCE = {
  "marathon-pe": { [NAVY]: { k: 4, u: 4 }, [GREY]: { k: 5, u: 5 } },
  trophy: { [NAVY]: { s: 6, k: 10 }, [GREY]: { s: 8, k: 11 } },
  hub2: { [NAVY]: { k: 30 }, [GREY]: { k: 30 } },
};
// /stock as it actually stood at 09:00: PE holding husks at zero, trophy holding
// real units, hub2 holding the stock both shops pull from.
const INCIDENT_STOCK = {
  "marathon-pe": { [NAVY]: { M: cell(0), L: cell(0), XL: cell(0) }, [GREY]: { M: cell(0), L: cell(0), XL: cell(0) } },
  trophy: { [NAVY]: { M: cell(1), L: cell(1), XL: cell(1), XXL: cell(2) }, [GREY]: { M: cell(0), L: cell(1), XL: cell(1) } },
  hub2: { [NAVY]: { M: cell(1), L: cell(3), XL: cell(2) }, [GREY]: { M: cell(2), L: cell(3), XL: cell(2) } },
  central: {},
};

test("THE INCIDENT — a collection husk at marathon-pe arms nothing, trophy is untouched", () => {
  // MUTATION: revert storeCarries to cell-existence, or drop the net-of-undos, and
  // marathon-pe gets its M/L/XL run back — 9 units of demand for two products that
  // belong to Trophy. That is the exact live failure of 2026-08-17.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: INCIDENT_PROVENANCE,
    provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
  }));
  const pe = plan.intents.filter((i) => i.dest === "marathon-pe" && (i.productId === NAVY || i.productId === GREY));
  assert.deepEqual(pe, [], "marathon-pe must be armed for NEITHER sweatshirt");

  // …and the shop that trades them must be entirely unaffected: this change must
  // not buy its correctness by starving Trophy.
  const trophy = plan.intents.filter((i) => i.dest === "trophy" && i.productId === GREY);
  assert.ok(trophy.length >= 1, "trophy still refills the line it actually sells");
  assert.ok(trophy.every((i) => i.source === "hub2"), "and still pulls from hub2");
});

test("THE INCIDENT — one real sale at PE would legitimately arm it", () => {
  // The predicate is about trade, not about PE. If PE ever genuinely sells one,
  // it carries the line and should be replenished. Same stock, one counter changed.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: { ...INCIDENT_PROVENANCE, "marathon-pe": { [NAVY]: { s: 1, k: 4, u: 4 }, [GREY]: { k: 5, u: 5 } } },
    provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
  }));
  assert.ok(plan.intents.some((i) => i.dest === "marathon-pe" && i.productId === NAVY), "a sale at PE arms NAVY");
  assert.ok(!plan.intents.some((i) => i.dest === "marathon-pe" && i.productId === GREY), "GREY, unsold there, stays refused");
});

// ═══ FAIL CLOSED ═════════════════════════════════════════════════════════════

test("FAIL CLOSED: no readiness sentinel → the location arms nothing, loudly", () => {
  // MUTATION: delete the `if (!indexReady(...)) return false;` line, or make the
  // engine fall back to cell-existence on an unready index, and this fails.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: { "marathon-pe": { [NAVY]: { s: 5, k: 20 } } },   // rich provenance…
    provenanceMeta: {},                                            // …but NO sentinel
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0, "unready → nothing armed");
  // Loud, not silent: a permanently quiet engine is this direction's failure mode.
  assert.ok(plan.errors.some((e) => /PROVENANCE INDEX NOT READY at marathon-pe/.test(e)), "an error names the location");
  assert.ok(plan.policy || plan.stats, "plan still produced");
});

test("FAIL CLOSED: readiness is PER LOCATION — a half-backfilled estate is visible", () => {
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: INCIDENT_PROVENANCE,
    provenanceMeta: ready("trophy", "hub2", "central"),   // marathon-pe missing
  }));
  assert.deepEqual(plan.stats.provenanceIndex.unreadyDests, ["marathon-pe"]);
  assert.equal(plan.stats.provenanceIndex.ready.trophy, true);
  assert.equal(plan.stats.provenanceIndex.ready["marathon-pe"], false);
  assert.ok(plan.intents.some((i) => i.dest === "trophy"), "a ready location keeps working");
});

test("FAIL CLOSED: a stale index VERSION is not ready", () => {
  // MUTATION: remove the version check in indexReady and this arms against an index
  // written to a shape this code no longer understands.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: { "marathon-pe": { [NAVY]: { s: 5, k: 20 } } },
    provenanceMeta: { "marathon-pe": { at: "2026-08-17T10:00:00.000Z", pairs: 1, version: V + 1 } },
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0);
});

test("FAIL CLOSED: an omitted snapshot field is not a friendly default", () => {
  // A caller that forgets to read the index gets a quiet engine, never the old
  // cell-existence behaviour. MUTATION: default provenanceMeta to something that
  // reads as ready and this fails.
  const plan = computeRefillPlan({
    nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: {},
    stock: INCIDENT_STOCK, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    // provenance / provenanceMeta deliberately absent
  });
  assert.equal(plan.intents.length, 0, "no index read → nothing armed anywhere");
  assert.equal(plan.stats.provenanceIndex.unreadyDests.length, 3);
});

// ═══ THE introduce: true OPT-IN ══════════════════════════════════════════════

test("INTRODUCE via a target row: opts one product into one destination", () => {
  // MUTATION: delete introducedAt()'s /stock_targets branch and this fails — and
  // with it the ability to give a shop a line it has never held, which the
  // predicate would otherwise make permanently impossible (no provenance → no
  // target → no refill → no provenance).
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: INCIDENT_PROVENANCE,
    provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
    targets: { "marathon-pe": { [NAVY]: { M: { introduce: true } } } },
  }));
  const pe = plan.intents.filter((i) => i.dest === "marathon-pe");
  assert.ok(pe.some((i) => i.productId === NAVY), "the introduced product arms");
  assert.ok(!pe.some((i) => i.productId === GREY), "its neighbour does NOT — the opt-in is per product");
});

test("INTRODUCE is per (destination, product) — never a blanket", () => {
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: INCIDENT_PROVENANCE,
    provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
    targets: { trophy: { [NAVY]: { M: { introduce: true } } } },   // introduced at TROPHY
  }));
  assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe").length, 0, "introducing at trophy does nothing for PE");
});

test("INTRODUCE via a categoryPolicy destination entry", () => {
  // MUTATION: delete introducedAt()'s categoryPolicy branch → this fails.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: INCIDENT_PROVENANCE,
    provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
    config: { ...CONFIG, categoryPolicy: { hoodies: { "marathon-pe": { target: 2, introduce: true } } } },
  }));
  const pe = plan.intents.filter((i) => i.dest === "marathon-pe");
  assert.ok(pe.length >= 1, "a category introduced at a destination arms its products there");
});

test("INTRODUCE defaults OFF for every falsy, truthy-but-wrong and absent value", () => {
  // MUTATION: loosen `=== true` to a truthiness check and the string "false" —
  // which is what a hand-typed console edit produces — silently arms a shop.
  for (const value of [undefined, null, false, 0, "", "true", "false", "yes", 1, {}, []]) {
    const plan = computeRefillPlan(snap({
      stock: INCIDENT_STOCK,
      provenance: INCIDENT_PROVENANCE,
      provenanceMeta: ready("marathon-pe", "trophy", "hub2", "central"),
      targets: { "marathon-pe": { [NAVY]: { M: { introduce: value } } } },
    }));
    assert.equal(plan.intents.filter((i) => i.dest === "marathon-pe" && i.productId === NAVY).length, 0,
      `introduce: ${JSON.stringify(value)} must NOT arm — only the boolean true does`);
  }
});

test("INTRODUCE survives an unready index — it is owner intent, not derived data", () => {
  // Deliberate: the opt-in never consults the index, so it cannot be taken down by
  // the index being unavailable, and it stays bounded to the (dest, pid) it names.
  const plan = computeRefillPlan(snap({
    stock: INCIDENT_STOCK,
    provenance: {},
    provenanceMeta: {},                                            // nothing is ready
    targets: { "marathon-pe": { [NAVY]: { M: { introduce: true } } } },
  }));
  assert.ok(plan.intents.some((i) => i.dest === "marathon-pe" && i.productId === NAVY), "introduce still works");
  assert.equal(plan.intents.filter((i) => i.productId === GREY).length, 0, "and nothing else does");
});

test("an explicit target row still wins outright, introduce or not", () => {
  // resolveTarget's precedence is unchanged: explicit row > category policy >
  // footwear > kill switch > clothing. The carriage gate never sees an explicit row.
  const ctx = {
    targets: { "marathon-pe": { [NAVY]: { M: { target: 7, minQty: 3 } } } },
    config: CONFIG, products: PRODUCTS, stock: INCIDENT_STOCK,
    provenance: {}, provenanceMeta: {},                            // unready on purpose
  };
  const t = resolveTarget(ctx, "marathon-pe", NAVY, "M");
  assert.equal(t.source, "explicit");
  assert.equal(t.target, 7);
});

test("resolveTarget: the clothing rule consults the index, not the cell", () => {
  const base = { targets: {}, config: CONFIG, products: PRODUCTS, stock: INCIDENT_STOCK };
  const withProv = { ...base, provenance: { "marathon-pe": { [NAVY]: { s: 3 } } }, provenanceMeta: ready("marathon-pe") };
  const husk = { ...base, provenance: { "marathon-pe": { [NAVY]: { k: 4, u: 4 } } }, provenanceMeta: ready("marathon-pe") };
  assert.equal(resolveTarget(withProv, "marathon-pe", NAVY, "M").source, "default");
  assert.equal(resolveTarget(withProv, "marathon-pe", NAVY, "M").target, 2);
  assert.equal(resolveTarget(husk, "marathon-pe", NAVY, "M"), null, "the husk resolves NOTHING");
});
