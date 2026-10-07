// ─── FIRST BATCH — the random-world builder the property fuzz (and a seed replay) share ──
// The Kimi substitute (reference_kimi_second_reviewer): random worlds, the REAL
// trigger core, the REAL computeRefillPlan, and invariants that must hold on
// every one of them. Seeded PRNG so a failure is replayable by its seed.
// Run: cd functions && node --test test/first-batch-fuzz.test.cjs
"use strict";

const { makeFakeDb } = require("./fake-rtdb.cjs");
const { processFirstBatchRequest, FIRST_BATCH_RUN_PREFIX } = require("../../lib/first-batch.cjs");
const { computeRefillPlan, encodeSizeKey } = require("../../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const T1 = "2026-09-17T10:00:00.000Z";
const SIZES = ["S", "M", "L", "XL", "5.5", "_"];
const STORES = ["trophy", "marathon-pe"];

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });

// One random world around ONE shop request for (p1, size) at `store`.
// Since 2026-09-17 a third of the worlds are MAPPED categories — the class
// #607 left out: a one-size bag (map legs at hub2 and the shop, "_" only) or a
// perSize belt (map legs for every declared letter; a size with zero units
// anywhere resolves a dead 0). The engine manages Hub 2 for these with NO
// cell, so the "engine got there first" branch is exercised for real.
function makeWorld(r) {
  const mapped = r() < 0.35 ? pick(r, ["bags", "belts"]) : null;
  const size = mapped === "bags" ? "_" : mapped === "belts" ? pick(r, SIZES.filter((s) => s !== "_")) : pick(r, SIZES);
  const sk = encodeSizeKey(size);
  const store = pick(r, STORES);
  const hubTarget = int(r, 0, 6);
  const storeTarget = int(r, 1, 4);
  // Garbage caps the engine itself tolerates ("x", null → its default 20). A
  // NEGATIVE cap is the engine's own known weakness (it would propose qty −2)
  // and is not what this fuzz measures; production holds 20.
  const cap = pick(r, [20, 1, 3, "x", null]);
  const config = {
    enabled: true, mode: { hub2: "live", trophy: "live", "marathon-pe": "live" },
    routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
    ruleBasedTargets: true, maxUnitsPerIntent: cap, maxIntentsPerRun: 200, staleIntentHours: 48,
    defaultRunByStore: { hub2: { [size]: hubTarget }, trophy: { [size]: storeTarget }, "marathon-pe": { [size]: storeTarget } },
  };
  if (mapped === "bags") {
    // the live shape: hub2 + ONE shop; sometimes the other shop too
    const legs = { hub2: { target: hubTarget, minQty: 1 }, [store]: { target: storeTarget, minQty: 1 } };
    if (r() < 0.3) legs[store === "trophy" ? "marathon-pe" : "trophy"] = { target: int(r, 1, 3), minQty: 1 };
    config.categoryPolicy = { bags: legs };
  } else if (mapped === "belts") {
    config.categoryPolicy = { belts: { perSize: true, hub2: { target: hubTarget, minQty: 1 }, [store]: { target: storeTarget, minQty: 1 } } };
  }
  const product = mapped
    ? { id: "p1", name: "Gym Bag", productType: "clothing", categoryKey: mapped, sizes: mapped === "bags" ? ["_"] : [size] }
    : { id: "p1", name: "Tee", productType: "clothing", sizes: [size] };
  // "_" gets its target through an explicit row only (the run refuses it) —
  // sometimes give it one, sometimes not. (For a mapped product the row
  // OUTRANKS the map, exactly as live.)
  const targets = {};
  if (r() < 0.4) targets.hub2 = { p1: { [sk]: { target: int(r, 0, 5), minQty: 1 } } };
  const centralHave = int(r, -1, 6);              // -1: a negative counted cell
  const hub2Have = pick(r, [null, 0, int(r, 0, 4), "array", "empty"]);
  const status = pick(r, ["open", "open", "fulfilled", "cancelled"]);
  const sent = status === "open" ? pick(r, [0, 0, 1, 2]) : 0;
  const askedQty = int(r, 1, storeTarget);
  const rr = {
    productId: "p1", size, qty: Math.max(askedQty - sent, 0) || askedQty, requestingLocation: store, status,
    createdAt: "2026-09-17T09:00:00.000Z",
    createdFrom: { firstBatch: true, solveId: `fb_p1_${int(r, 1, 999)}`, source: "central", store, hub: "hub2" },
    ...(sent ? { sentQty: sent } : {}),
    ...(status === "cancelled" && r() < 0.5 ? { cancelReason: pick(r, ["awaiting_upstream", "no_longer_needed", "solve_undone", "already_in_stock"]) } : {}),
  };
  // Sometimes the engine already holds Hub 2's lock, or a sibling shop's lock reserves Central.
  const open = {};
  // the engine's lock at Hub 2: sometimes claimed BEFORE the shop's request (prior presence), sometimes after (the scan in the trigger's gap)
  if (r() < 0.25) open.hub2 = { p1: { [sk]: { qty: int(r, 1, 3), source: "central", createdAt: r() < 0.5 ? "2026-09-17T08:30:00.000Z" : T1, runId: "scan-1", refillId: "eng1" } } };
  if (r() < 0.25) {
    const other = store === "trophy" ? "marathon-pe" : "trophy";
    open[other] = { p1: { [sk]: { qty: int(r, 1, 3), source: "central", createdAt: T1, runId: "first_batch:fb_p1_zzz", refillId: "sib" } } };
  }
  const stock = {
    central: { p1: { [sk]: cell(centralHave) } },
    [store]: { p1: { [sk]: sent || status !== "open" ? cell(int(r, 0, 3)) : seed() } },
  };
  if (hub2Have === "array") stock.hub2 = { p1: [null, null, { qty: 1 }] };   // array-coerced row, holes
  else if (hub2Have === "empty") stock.hub2 = { p1: [] };
  else if (hub2Have !== null) stock.hub2 = { p1: { [sk]: cell(hub2Have) } };
  const refill_requests = { r1: rr };
  if (open.hub2) refill_requests.eng1 = { productId: "p1", size, qty: open.hub2.p1[sk].qty, requestingLocation: "hub2", status: "open", createdAt: T1, createdFrom: { engine: true, source: "central" } };
  if (open.trophy || open["marathon-pe"]) refill_requests.sib = { productId: "p1", size, qty: 1, requestingLocation: store === "trophy" ? "marathon-pe" : "trophy", status: "open", createdAt: T1, createdFrom: { firstBatch: true, solveId: "fb_p1_zzz", source: "central" } };
  const db = makeFakeDb({
    config: { refillEngine: config },
    products: { p1: product },
    stock_targets: targets, stock, refill_requests,
    ...(Object.keys(open).length ? { refill_engine: { open } } : {}),
  });
  return { db, size, sk, store, config, targets, rr, centralHave, mapped, product };
}

const hubRequests = (db) => Object.entries(db.state.root.refill_requests || {}).filter(([, r]) => r.requestingLocation === "hub2");
const snapshot = (db, config, targets) => ({
  nowMs: NOW, config, products: db.state.root.products,
  targets: db.state.root.stock_targets || targets || {},
  stock: db.state.root.stock || {},
  openIndex: db.state.root.refill_engine?.open || {},
  refillRequests: db.state.root.refill_requests || {},
  orders: {}, movements: [],
});


async function replay(seedNo) {
  const w = makeWorld(prng(seedNo));
  console.log("rr", JSON.stringify(w.db.state.root.refill_requests.r1));
  console.log("targets", JSON.stringify(w.db.state.root.stock_targets), "run", JSON.stringify(w.config.defaultRunByStore));
  console.log("open before", JSON.stringify(w.db.state.root.refill_engine));
  console.log("stock before", JSON.stringify(w.db.state.root.stock));
  const res = await processFirstBatchRequest({ db: w.db, requestId: "r1", nowIso: T1, pathEnabled: true });
  console.log("res", JSON.stringify(res));
  console.log("open after", JSON.stringify(w.db.state.root.refill_engine));
  console.log("stock after", JSON.stringify(w.db.state.root.stock));
  const plan = computeRefillPlan(snapshot(w.db, w.config, w.targets));
  console.log("intents", JSON.stringify(plan.intents), "closes", JSON.stringify(plan.closes));
}
module.exports = { replay, makeWorld, snapshot, prng, hubRequests, NOW, T1, FIRST_BATCH_RUN_PREFIX };
