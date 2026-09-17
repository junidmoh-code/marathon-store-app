// ─── firstBatchLeg with the path OFF (incident 2026-09-17) ───────────────────
// The REAL trigger core under its LIVE default (FIRST_BATCH_PATH_ENABLED false,
// no `pathEnabled` passed). The claim: a first-batch SHOP request a stale
// bundle still creates is turned back into the old Solve — Hub 2 seeded,
// request withdrawn with a reason — and nothing is ever requested from
// Central for a shop; stock already in motion keeps its follow-through.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { processFirstBatchRequest, FIRST_BATCH_PATH_ENABLED, PATH_OFF_REASON } = require("../lib/first-batch.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const { makeWorld, prng, snapshot, NOW } = require("./helpers/first-batch-world.cjs");

const T1 = "2026-09-17T10:00:00.000Z";
const CONFIG = {
  enabled: true, mode: { hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 200, staleIntentHours: 48,
  defaultRunByStore: { hub2: { M: 3 }, trophy: { M: 2 }, "marathon-pe": { M: 2 } },
};
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const seed = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" });
const shopRow = (over = {}) => ({
  productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: "2026-09-17T09:00:00.000Z",
  createdFrom: { firstBatch: true, solveId: "fb_p1_1", source: "central", store: "trophy", hub: "hub2" }, ...over,
});
const world = (rr = shopRow(), extra = {}, hooks = {}) => makeFakeDb({
  config: { refillEngine: CONFIG },
  products: { p1: { id: "p1", name: "Tee", productType: "clothing", sizes: ["M"] } },
  stock: { central: { p1: { M: cell(5) } }, trophy: { p1: { M: seed() } } },
  refill_requests: { r1: rr },
  ...extra,
}, hooks);
const run = (db, id = "r1", nowIso = T1) => processFirstBatchRequest({ db, requestId: id, nowIso });   // LIVE default

test("the live default is OFF", () => { assert.equal(FIRST_BATCH_PATH_ENABLED, false); });

test("an open, untouched first-batch shop request is withdrawn with a reason, Hub 2 seeded, NO lock claimed — the old Solve's end state", async () => {
  const db = world();
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "path_off", withdrawn: true });
  const r = db.state.root.refill_requests.r1;
  assert.equal(r.status, "cancelled");
  assert.equal(r.cancelReason, PATH_OFF_REASON);
  assert.equal(r.resolvedAt, T1);
  assert.deepEqual(r.firstBatch.hub2Leg, { none: "path_off", at: T1 });
  assert.deepEqual(db.state.root.stock.hub2.p1.M, { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: T1, updatedBy: "first_batch" });
  assert.equal(db.state.root.stock.trophy.p1.M.qty, 0);            // the shop's seed stands
  assert.equal(db.state.root.stock.central.p1.M.qty, 5);           // nothing moved
  assert.equal(db.state.root.refill_engine, undefined);            // no shop lock, no hub2 lock
  assert.equal(Object.keys(db.state.root.refill_requests).length, 1);   // no Hub 2 request either
});

test("the engine then runs the NORMAL route on that world: hub2←central is proposed, and no shop←central exists", async () => {
  const db = world();
  await run(db);
  const plan = computeRefillPlan(snapshot(db, CONFIG, {}));
  const intents = plan.intents || [];
  assert.ok(intents.some((i) => i.dest === "hub2" && i.productId === "p1" && i.source === "central"), `expected a hub2 intent, got ${JSON.stringify(intents)}`);
  assert.ok(!intents.some((i) => i.dest === "trophy" && (i.source === "central")), "a shop never sources from Central");
  // the withdrawal carried a reason: no rejection learned at the shop's cell
  assert.ok(!(plan.retryOps || []).some((o) => o.dest === "trophy"), "a reasoned withdrawal is not a rejection");
});

test("the re-fire the cancel itself causes is a no-op: hub2_leg_done, nothing else written", async () => {
  const db = world();
  await run(db);
  const before = JSON.stringify(db.state.root);
  const res = await run(db);
  assert.equal(res.skipped, "hub2_leg_done");
  assert.equal(JSON.stringify(db.state.root), before);
});

test("a row Central already started on (sentQty > 0) is real stock in motion: it keeps the follow-through and raises Hub 2's leg", async () => {
  const db = world(shopRow({ qty: 1, sentQty: 1 }));
  const res = await run(db);
  assert.equal(res.raised, true);
  const r = db.state.root.refill_requests.r1;
  assert.equal(r.status, "open");                                  // never withdrawn
  assert.equal(r.cancelReason, undefined);
  const hub = Object.values(db.state.root.refill_requests).find((x) => x.requestingLocation === "hub2");
  assert.ok(hub, "Hub 2's leg raised");
  assert.equal(db.state.root.stock.hub2.p1.M.qty, 0);              // seeded
});

test("a fulfilled row keeps the follow-through too", async () => {
  const db = world(shopRow({ status: "fulfilled", resolvedAt: T1 }));
  const res = await run(db);
  assert.equal(res.raised, true);
});

test("the CAS refuses when Central fulfils in the gap between the read and the write: the row is left exactly as Central wrote it", async () => {
  // Central's fulfil lands after the trigger's read of the row: model it as a
  // write that happens on the first read of the seed path (the await before the CAS).
  let fired = false;
  const db = world(shopRow(), {}, { beforeRead: async (path, state) => {
    if (!fired && path === "stock/hub2/p1/M") {
      fired = true;
      state.root.refill_requests.r1 = { ...state.root.refill_requests.r1, status: "fulfilled", sentQty: 2, resolvedAt: T1 };
    }
  } });
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "path_off", withdrawn: false });
  assert.equal(db.state.root.refill_requests.r1.status, "fulfilled");
  assert.equal(db.state.root.refill_requests.r1.cancelReason, undefined);
});

test("an existing Hub 2 cell is never overwritten by the seed", async () => {
  const db = world(shopRow(), { stock: { central: { p1: { M: cell(5) } }, trophy: { p1: { M: seed() } }, hub2: { p1: { M: cell(3) } } } });
  await run(db);
  assert.equal(db.state.root.stock.hub2.p1.M.qty, 3);
});

test("rows that are not first-batch shop legs are untouched: an engine hub2→shop row, Hub 2's own leg, a legacy row", async () => {
  for (const rr of [
    { productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T1, createdFrom: { engine: true, source: "hub2" } },
    { productId: "p1", size: "M", qty: 2, requestingLocation: "trophy", status: "open", createdAt: T1 },
    shopRow({ requestingLocation: "hub2" }),
  ]) {
    const db = world(rr);
    const before = JSON.stringify(db.state.root);
    const res = await run(db);
    assert.ok(res.skipped === "not_first_batch" || res.skipped === "hub_leg", JSON.stringify(res));
    assert.equal(JSON.stringify(db.state.root), before);
  }
});

test("the undo's own cancel (solve_undone) still raises nothing and seeds nothing", async () => {
  const db = world(shopRow({ status: "cancelled", cancelReason: "solve_undone" }));
  const res = await run(db);
  assert.deepEqual(res, { raised: false, none: "solve_undone" });
  assert.equal(db.state.root.stock.hub2, undefined);
});

test("property: over 300 random worlds under the live default, NO open first-batch shop request survives, and no stock quantity changes", async () => {
  for (let s = 1; s <= 300; s++) {
    const w = makeWorld(prng(s));
    const qtyBefore = JSON.stringify(Object.fromEntries(Object.entries(w.db.state.root.stock).map(([l, byPid]) => [l, Object.fromEntries(Object.entries(byPid).map(([pid, row]) => [pid, Array.isArray(row) ? row.map((c) => c && c.qty) : Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c && c.qty]))]))])));
    await processFirstBatchRequest({ db: w.db, requestId: "r1", nowIso: T1 });
    await processFirstBatchRequest({ db: w.db, requestId: "r1", nowIso: T1 });   // the re-fire
    const r1 = w.db.state.root.refill_requests.r1;
    const untouchedOpen = r1.status === "open" && !(Number(r1.sentQty) > 0);
    assert.equal(untouchedOpen, false, `seed ${s}: open untouched first-batch shop request survived: ${JSON.stringify(r1)}`);
    if (r1.cancelReason === PATH_OFF_REASON) {
      assert.ok(w.db.state.root.stock.hub2 && w.db.state.root.stock.hub2.p1, `seed ${s}: Hub 2 not seeded`);
      assert.equal(w.db.state.root.refill_engine?.open?.[w.store]?.p1?.[w.sk], undefined, `seed ${s}: shop lock claimed while off`);
    }
    const seededOnly = (l, pid, row) => Array.isArray(row) ? row.map((c) => c && c.qty) : Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c && c.qty]));
    const after = w.db.state.root.stock;
    const beforeObj = JSON.parse(qtyBefore);
    for (const [l, byPid] of Object.entries(after)) for (const [pid, row] of Object.entries(byPid)) {
      const a = seededOnly(l, pid, row);
      const b = beforeObj[l]?.[pid];
      if (b === undefined) { for (const q of Object.values(a)) assert.ok(q === 0 || q == null, `seed ${s}: a non-zero cell appeared at ${l}/${pid}`); continue; }
      for (const [k, q] of Object.entries(a)) if (b[k] !== undefined && b[k] !== null) assert.equal(q, b[k], `seed ${s}: qty changed at ${l}/${pid}/${k}`);
    }
  }
});
