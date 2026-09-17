// ─── firstBatchLeg — the Hub 2-presence guard at creation (incident → Phase 3) ─
// The REAL trigger core (live default: path ON) and the REAL computeRefillPlan.
// THE INCIDENT REPRODUCED, both halves:
//   1. a product with Hub 2 presence NEVER produces a shop-from-Central request
//      that stands — created by a client, it is withdrawn here at creation;
//   2. a product whose first batch DID go to the shop still sources from Hub 2
//      on its next refill (Hub 2 seeded at Solve time, the engine's route).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest, FIRST_BATCH_PATH_ENABLED, HUB2_PRESENT_REASON } = require("../lib/first-batch.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");

const T1 = "2026-09-17T10:00:00.000Z";
const NOW = Date.parse(T1);
const CONFIG = {
  enabled: true, mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: { hub2: { M: 3, L: 3 }, trophy: { M: 2, L: 2 }, "marathon-pe": { M: 2, L: 2 } },
};
const PRODUCTS = { p1: { id: "p1", name: "Essentials Tee", productType: "clothing", sizes: ["M", "L"] } };
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
// the Solve's own seed shape (updatedBy a uid) — what buildFirstBatchSolveUpdate writes
const solveSeed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: T1, updatedBy: "u1" });
const shopReq = (over = {}) => ({
  productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T1,
  createdFrom: { firstBatch: true, solveId: "fb_p1_abc", source: "central", store: "trophy", hub: "hub2", hub2Seeded: ["M", "L"] },
  ...over,
});
// The world the NEW Solve writes: Central holds units; Hub 2 AND the shop
// carry the Solve's own qty-0 seeds; the shop's request is open.
function solvedWorld({ hub2 = { M: solveSeed(), L: solveSeed() }, refill = {}, open = null, targets = null, hooks } = {}) {
  return makeFakeDb({
    config: { refillEngine: CONFIG }, products: PRODUCTS,
    stock: { central: { p1: { M: cell(4), L: cell(3) } }, trophy: { p1: { M: solveSeed(), L: solveSeed() } }, ...(hub2 ? { hub2: { p1: hub2 } } : {}) },
    refill_requests: { r1: shopReq(), ...refill },
    ...(open ? { refill_engine: { open } } : {}),
    ...(targets ? { stock_targets: targets } : {}),
  }, hooks);
}
const run = (db, id = "r1", nowIso = T1) => processFirstBatchRequest({ db, requestId: id, nowIso });   // LIVE default
const snapshot = (db) => ({ nowMs: NOW, config: CONFIG, products: PRODUCTS, targets: db.state.root.stock_targets || {}, stock: db.state.root.stock || {}, openIndex: db.state.root.refill_engine?.open || {}, refillRequests: db.state.root.refill_requests || {}, orders: {}, movements: [] });
const shopIntents = (plan, store = "trophy") => plan.intents.filter((i) => i.productId === "p1" && i.dest === store);

test("the live default is ON", () => { assert.equal(FIRST_BATCH_PATH_ENABLED, true); });

test("the Solve's OWN Hub 2 seeds (hub2Seeded) are not presence: the request stands and the shop lock is claimed, source central", async () => {
  const db = solvedWorld();
  const res = await run(db);
  assert.deepEqual(res, { skipped: "open_untouched", lock: { claimed: true } });
  assert.equal(db.state.root.refill_requests.r1.status, "open");
  assert.equal(db.state.root.refill_engine.open.trophy.p1.M.source, "central");
});

test("INCIDENT HALF 1 — a qty-0 Hub 2 cell that is NOT this Solve's (an earlier Solve's seed): withdrawn with first_batch_hub2_present, no shop lock, and the REAL engine serves the shop from Hub 2 once Hub 2 has units", async () => {
  const db = solvedWorld({ hub2: { M: { ...solveSeed(), updatedAt: "2026-09-10T08:00:00.000Z" }, L: solveSeed() } });
  db.state.root.refill_requests.r1.createdFrom.hub2Seeded = ["L"];   // this Solve seeded L only; M was already there
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "hub2_present", withdrawn: true, signals: ["stock_cell"] });
  const r1 = db.state.root.refill_requests.r1;
  assert.equal(r1.status, "cancelled");
  assert.equal(r1.cancelReason, HUB2_PRESENT_REASON);
  assert.equal(db.state.root.refill_engine, undefined, "no shop lock, ever");
  // no shop←central anywhere in the engine's plan; hub2←central is the normal route
  const plan = computeRefillPlan(snapshot(db));
  assert.equal(shopIntents(plan).length, 0, "Hub 2 has no units yet — the shop waits for Hub 2, not Central");
  assert.ok(plan.intents.some((i) => i.dest === "hub2" && i.productId === "p1" && i.source === "central"));
  db.state.root.stock.hub2.p1.M = cell(3);   // Hub 2 receives
  const later = shopIntents(computeRefillPlan(snapshot(db)));
  assert.equal(later.length, 1);
  assert.equal(later[0].source, "hub2");
});

test("a Hub 2 cell WITH units, an engine lock at Hub 2, an array-coerced Hub 2 row: each is presence → withdrawn; nothing else changes", async () => {
  for (const [label, w] of [
    ["units", solvedWorld({ hub2: { M: cell(2), L: solveSeed() } })],
    ["engine lock", solvedWorld({ open: { hub2: { p1: { M: { qty: 3, source: "central", createdAt: "2026-09-17T09:45:00.000Z", runId: "scan-1", refillId: "eng1" } } } }, refill: { eng1: { productId: "p1", size: "M", qty: 3, requestingLocation: "hub2", status: "open", createdAt: "2026-09-17T09:45:00.000Z", createdFrom: { engine: true, source: "central" } } } })],
    ["array row", solvedWorld({ hub2: [null, null, cell(1)] })],
  ]) {
    const res = await run(w);
    assert.equal(res.none, "hub2_present", label);
    assert.equal(res.withdrawn, true, label);
    assert.equal(w.state.root.refill_requests.r1.cancelReason, HUB2_PRESENT_REASON, label);
    assert.equal(w.state.root.refill_engine?.open?.trophy, undefined, `${label}: shop lock claimed`);
  }
});

test("a Hub 2 lock claimed AT or AFTER the request's own createdAt (the scan ran in the trigger's gap) is NOT prior presence: the request stands and the shop lock is claimed", async () => {
  for (const at of [T1, "2026-09-17T10:00:03.000Z"]) {
    const db = solvedWorld({ open: { hub2: { p1: { M: { qty: 2, source: "central", createdAt: at, runId: "scan-gap", refillId: "engg" } } } }, refill: { engg: { productId: "p1", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: at, createdFrom: { engine: true, source: "central" } } } });
    const res = await run(db);
    assert.deepEqual(res, { skipped: "open_untouched", lock: { claimed: true } }, at);
    assert.equal(db.state.root.refill_requests.r1.status, "open", at);
  }
});

test("a HELD LINE in the hold lane (Central's fulfil parked at in_transit, Hub 2 not yet credited, the engine's lock already closed) is presence: withdrawn", async () => {
  const db = solvedWorld();
  db.state.root.settings = { stockHold: { held: { hub2: { "rrf_old1": { productId: "p1", productName: "Essentials Tee", size: "M", sizeKey: "M", qty: 3, dest: "hub2", refillId: "old1", movementId: "rrf_old1", heldAt: "2026-09-17T09:00:00.000Z" } } } } };
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "hub2_present", withdrawn: true, signals: ["held_inbound"] });
  const db2 = solvedWorld();
  db2.state.root.settings = { stockHold: { held: { hub2: { "rrf_x": { productId: "p9", dest: "hub2", qty: 1 } } } } };
  assert.equal((await run(db2)).skipped, "open_untouched");   // another product's line is nothing
});

test("'already judged' is the SERVER-OWNED shop lock, never a field on the row: a row created with firstBatch.lock / hub2Leg pre-set is still judged — and withdrawn when Hub 2 is present", async () => {
  for (const pre of [{ lock: { claimedAt: T1 } }, { hub2Leg: { refillId: "fake" } }]) {
    const db = solvedWorld({ hub2: { M: cell(2) } });
    db.state.root.refill_requests.r1.firstBatch = pre;
    const res = await run(db);
    assert.equal(res.none, "hub2_present", JSON.stringify(pre));
    assert.equal(db.state.root.refill_requests.r1.status, "cancelled", JSON.stringify(pre));
  }
  // …and with no presence, a lying claimedAt does not skip the real claim
  const db3 = solvedWorld();
  db3.state.root.refill_requests.r1.firstBatch = { lock: { claimedAt: T1 } };
  const res3 = await run(db3);
  assert.deepEqual(res3, { skipped: "open_untouched", lock: { claimed: true } });
  assert.equal(db3.state.root.refill_engine.open.trophy.p1.M.refillId, "r1");
});

test("hub2Seeded cannot hide a real cell: a listed key over a cell with units, a non-seed cell, or a seed not stamped at this request's createdAt is presence", async () => {
  for (const c of [cell(2), { ...solveSeed(), mv: "m" }, { ...solveSeed(), updatedAt: "2026-09-01T00:00:00.000Z" }]) {
    const db = solvedWorld({ hub2: { M: c, L: solveSeed() } });
    db.state.root.refill_requests.r1.createdFrom.hub2Seeded = ["M", "L", "S", "XL"];   // over-listed
    assert.equal((await run(db)).none, "hub2_present", JSON.stringify(c));
  }
});

test("judged ONCE: after the shop lock is claimed, the engine's own Hub 2 lock (its hub2←central leg from the remainder) never withdraws the committed request", async () => {
  const db = solvedWorld();
  await run(db);                                                                                  // claim
  db.state.root.refill_engine.open.hub2 = { p1: { M: { qty: 2, source: "central", createdAt: T1, runId: "scan-2", refillId: "eng2" } } };
  db.state.root.refill_requests.eng2 = { productId: "p1", size: "M", qty: 2, requestingLocation: "hub2", status: "open", createdAt: T1, createdFrom: { engine: true, source: "central" } };
  const res = await run(db, "r1", "2026-09-17T10:05:00.000Z");
  assert.equal(res.skipped, "open_untouched");
  assert.equal(db.state.root.refill_requests.r1.status, "open");
});

test("the re-fire the withdrawal causes is a no-op, and a withdrawn row never gets a Hub 2 leg later", async () => {
  const db = solvedWorld({ hub2: { M: cell(2) } });
  await run(db);
  const snap = JSON.stringify(db.state.root);
  assert.equal((await run(db, "r1", "2026-09-17T10:05:00.000Z")).skipped, "hub2_leg_done");
  assert.equal(JSON.stringify(db.state.root), snap);
});

test("a product gone from the catalogue with Hub 2 presence: withdrawn, and NO seed is written for it", async () => {
  const db = solvedWorld({ hub2: { M: cell(2) } });
  delete db.state.root.products.p1;
  const res = await run(db);
  assert.equal(res.none, "hub2_present");
  assert.equal(db.state.root.stock.hub2.p1.L, undefined);
});

test("INCIDENT HALF 2 — a product whose first batch went to the shop: after Central's fulfil the deferred leg defers to / raises Hub 2's own request, and the NEXT shop refill is sourced from Hub 2 by the real engine — never from Central", async () => {
  const db = solvedWorld();
  await run(db);                                                                                  // creation: lock claimed
  // Central fulfils the shop's 2 (the Source tab's applyMovement + status write)
  db.state.root.stock.central.p1.M = cell(2);
  db.state.root.stock.trophy.p1.M = cell(2);
  db.state.root.refill_requests.r1 = { ...db.state.root.refill_requests.r1, status: "fulfilled", sentQty: 2, resolvedAt: "2026-09-17T11:00:00.000Z" };
  const res = await run(db, "r1", "2026-09-17T11:00:01.000Z");
  assert.equal(res.raised, true, "Hub 2's own leg raised from Central's remainder");
  const hub = Object.values(db.state.root.refill_requests).find((r) => r.requestingLocation === "hub2");
  assert.equal(hub.qty, 2);                                                                       // min(target 3 − 0, Central 2, cap)
  assert.equal(hub.createdFrom.source, "central");
  // Hub 2 receives its batch; the shop sells out; the engine's next scan:
  db.state.root.stock.hub2.p1.M = cell(2);
  db.state.root.stock.central.p1.M = cell(0);
  db.state.root.refill_requests[res.refillId].status = "fulfilled";
  delete db.state.root.refill_engine.open.hub2;
  delete db.state.root.refill_engine.open.trophy;
  db.state.root.stock.trophy.p1.M = cell(0);
  const plan = computeRefillPlan(snapshot(db));
  const next = shopIntents(plan);
  assert.equal(next.length, 1, "the shop's next refill exists");
  assert.equal(next[0].source, "hub2", "…and it is sourced from Hub 2");
  assert.ok(!plan.intents.some((i) => i.dest === "trophy" && i.source === "central"), "never from Central");
});

test("property: 300 random creations — Hub 2 presence at creation ⇒ withdrawn + no shop lock; no presence ⇒ the lock claimed; own seeds never count; no stock quantity ever changes", async () => {
  let s = 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let withdrawn = 0, claimed = 0;
  for (let n = 0; n < 300; n++) {
    const own = rnd() < 0.5 ? ["M", "L"] : ["M"];
    const foreign = rnd() < 0.4;                       // a cell this Solve did not write
    const units = rnd() < 0.3;
    const lock = rnd() < 0.25;
    const hub2 = {};
    for (const k of own) hub2[k] = solveSeed();
    if (foreign) hub2.L = { ...solveSeed(), updatedAt: "2026-09-01T00:00:00.000Z" };   // an OLD seed: presence whether or not "L" is listed (a listed key must carry the Solve's own stamp)
    const foreignReally = foreign;
    if (units) hub2.M = cell(1 + Math.floor(rnd() * 3));
    const db = solvedWorld({ hub2, ...(lock ? { open: { hub2: { p1: { M: { qty: 1, source: "central", createdAt: "2026-09-17T09:30:00.000Z", runId: "scan-x", refillId: "engx" } } } } } : {}) });
    db.state.root.refill_requests.r1.createdFrom.hub2Seeded = own;
    const qtyBefore = JSON.stringify(Object.fromEntries(Object.entries(db.state.root.stock).map(([l, byPid]) => [l, Object.fromEntries(Object.entries(byPid).map(([pid, row]) => [pid, Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c.qty]))]))])));
    const res = await run(db);
    await run(db, "r1", "2026-09-17T10:05:00.000Z");
    const present = foreignReally || units || lock;
    const ctx = `n=${n} own=${own} foreign=${foreignReally} units=${units} lock=${lock}`;
    if (present) {
      withdrawn++;
      assert.equal(res.none, "hub2_present", ctx);
      assert.equal(db.state.root.refill_requests.r1.status, "cancelled", ctx);
      assert.equal(db.state.root.refill_engine?.open?.trophy, undefined, ctx);
    } else {
      claimed++;
      assert.equal(db.state.root.refill_requests.r1.status, "open", ctx);
      assert.equal(db.state.root.refill_engine.open.trophy.p1.M.source, "central", ctx);
    }
    const after = db.state.root.stock;
    for (const [l, byPid] of Object.entries(JSON.parse(qtyBefore))) for (const [pid, row] of Object.entries(byPid)) for (const [k, q] of Object.entries(row)) assert.equal(after[l][pid][k].qty, q, `${ctx}: ${l}/${pid}/${k}`);
  }
  assert.ok(withdrawn > 60 && claimed > 60, `coverage withdrawn=${withdrawn} claimed=${claimed}`);
});
