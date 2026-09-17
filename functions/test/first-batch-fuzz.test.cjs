// ─── FIRST BATCH — property fuzz of the deferred leg against the real engine ──
// The Kimi substitute (reference_kimi_second_reviewer): random worlds, the REAL
// trigger core, the REAL computeRefillPlan, and invariants that must hold on
// every one of them. Seeded PRNG so a failure is replayable by its seed:
//   cd functions && node -e 'require("./test/helpers/first-batch-world.cjs").replay(<seed>)'
// Run: cd functions && node --test test/first-batch-fuzz.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { processFirstBatchRequest } = require("../lib/first-batch.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const { makeWorld, snapshot, prng, hubRequests, T1, FIRST_BATCH_RUN_PREFIX } = require("./helpers/first-batch-world.cjs");

test("property fuzz: 600 random worlds, every invariant holds on each", async () => {
  const seeds = [];
  for (let i = 1; i <= 600; i++) seeds.push(i * 7919);
  let raised = 0, none = 0, deferred = 0, guarded = 0, mappedRaised = 0, mappedDeferred = 0, withdrawnPresent = 0;
  for (const s of seeds) {
    const r = prng(s);
    const w = makeWorld(r);
    const { db, sk, store, config, targets, rr } = w;
    const ctx = `seed ${s} size=${w.size} store=${store} status=${rr.status} sent=${rr.sentQty || 0} central=${w.centralHave} mapped=${w.mapped || "-"}`;
    const before = JSON.stringify(db.state.root);
    const hadHub2Cell = db.state.root.stock?.hub2?.p1?.[sk] !== undefined;
    // Never throws on any world (a throw would make the trigger retry forever).
    const res1 = await processFirstBatchRequest({ db, requestId: "r1", nowIso: T1, pathEnabled: true });
    const after1 = JSON.stringify(db.state.root);
    // Idempotent: a second and third fire change NOTHING.
    await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-09-17T10:30:00.000Z", pathEnabled: true });
    await processFirstBatchRequest({ db, requestId: "r1", nowIso: "2026-09-17T11:00:00.000Z", pathEnabled: true });
    assert.equal(JSON.stringify(db.state.root), after1, `${ctx}: re-fire changed state`);
    // No undefined ever reached the tree (the fake throws; belt and braces).
    assert.ok(!after1.includes("undefined"), ctx);

    const hubs = hubRequests(db).filter(([id]) => id !== "eng1");
    const hubLock = db.state.root.refill_engine?.open?.hub2?.p1?.[sk];
    // A lock of OURS on Hub 2's cell — the engine's pre-existing eng1 lock is not ours.
    const ourLock = hubLock && hubLock.refillId !== "eng1" ? hubLock : undefined;
    const resolvedOrTouched = rr.status !== "open" || (rr.sentQty || 0) > 0;
    // THE INCIDENT'S RULE at creation: Hub 2 present by any means (a cell of
    // any qty, an array-coerced row with a present index, an engine lock) →
    // the shop's Central request is withdrawn with a reason, Hub 2 keeps
    // its cells, no shop lock, and the engine may serve the shop from Hub 2.
    const hub2Row = JSON.parse(before).stock?.hub2?.p1;
    const presentAtCreation = (Array.isArray(hub2Row) ? hub2Row.some((c) => c != null) : !!hub2Row && Object.keys(hub2Row).length > 0)
      || !!JSON.parse(before).refill_engine?.open?.hub2?.p1?.[sk];
    if (!resolvedOrTouched && presentAtCreation) {
      withdrawnPresent++;
      const r1 = db.state.root.refill_requests.r1;
      assert.equal(r1.status, "cancelled", `${ctx}: Hub 2 present at creation but the shop's Central request stands`);
      assert.equal(r1.cancelReason, "first_batch_hub2_present", ctx);
      assert.equal(hubs.length, 0, `${ctx}: a Hub 2 leg raised on a withdrawn request`);
      assert.equal(db.state.root.refill_engine?.open?.[store]?.p1?.[sk], undefined, `${ctx}: shop lock claimed although withdrawn`);
      assert.equal(JSON.stringify(db.state.root.stock.hub2.p1[sk]?.qty ?? null), JSON.stringify((Array.isArray(hub2Row) ? hub2Row[Number(sk)] : hub2Row?.[sk])?.qty ?? (hub2Row && (Array.isArray(hub2Row) ? hub2Row[Number(sk)] : hub2Row[sk]) ? null : 0)), `${ctx}: Hub 2's cell changed`);
      const plan = computeRefillPlan(snapshot(db, config, targets));
      for (const i of plan.intents) if (i.productId === "p1" && i.dest === store) assert.equal(i.source, "hub2", `${ctx}: shop sourced from ${i.source}`);
      continue;
    }
    if (!resolvedOrTouched) {
      // open + untouched: no Hub 2 leg, no Hub 2 seed; the SHOP lock claimed (or held by a sibling)
      assert.equal(hubs.length, 0, `${ctx}: leg raised on an open untouched request`);
      assert.equal(after1 === before || !!db.state.root.refill_requests.r1.firstBatch?.lock, true, ctx);
      guarded++;
      // THE OPEN-REQUEST GUARD, stated honestly: the engine never has the
      // shop's Central request AND a hub2→shop request live at once. While
      // Central can still supply, the lock is inbound and no hub2→shop intent
      // exists. When Central has run dry the engine WITHDRAWS the shop's
      // Central request (awaiting_upstream) in the same plan, and only then —
      // with the lock closed — may it serve the shop from Hub 2: the normal
      // route taking over, which is what the owner asked for.
      const plan = computeRefillPlan(snapshot(db, config, targets));
      const shopIntents = plan.intents.filter((i) => i.dest === store && i.productId === "p1");
      const shopLockClosed = plan.closes.some((c) => c.dest === store && c.pid === "p1" && c.refillId === "r1");
      if (shopIntents.length) {
        assert.equal(shopLockClosed, true, `${ctx}: engine raised hub2→shop while the shop's Central request stays open`);
        assert.ok(w.centralHave <= 0, `${ctx}: withdrawn although Central still holds ${w.centralHave}`);
        assert.equal(shopIntents[0].source, "hub2", ctx);
        assert.ok(shopIntents[0].qty >= 1, `${ctx}: engine proposed qty ${shopIntents[0].qty}`);
      }
      continue;
    }
    // resolved or partial: at most ONE Hub 2 request of ours, and a marker on the shop request.
    assert.ok(hubs.length <= 1, `${ctx}: ${hubs.length} Hub 2 requests`);
    const marker = db.state.root.refill_requests.r1.firstBatch?.hub2Leg;
    assert.ok(marker, `${ctx}: no hub2Leg marker after resolution`);
    if (res1.raised) {
      raised++;
      if (w.mapped) mappedRaised++;
      const [key, hr] = hubs[0];
      assert.equal(marker.refillId, key, ctx);
      assert.ok(Number.isInteger(hr.qty) && hr.qty >= 1, `${ctx}: qty ${hr.qty}`);
      assert.ok(hr.qty <= Math.max(w.centralHave, 0), `${ctx}: qty ${hr.qty} > Central ${w.centralHave}`);
      const cap = Number(config.maxUnitsPerIntent) > 0 ? Number(config.maxUnitsPerIntent) : 20;
      assert.ok(hr.qty <= cap, `${ctx}: qty ${hr.qty} > cap ${cap}`);
      assert.equal(hr.requestingLocation, "hub2", ctx);
      assert.equal(hr.createdFrom.source, "central", ctx);
      assert.equal(ourLock?.refillId, key, `${ctx}: lock not finalised`);
      assert.ok(String(ourLock.runId).startsWith(FIRST_BATCH_RUN_PREFIX), ctx);
      assert.equal(db.state.root.stock.hub2.p1[sk] !== undefined, true, `${ctx}: Hub 2 not seeded`);
      // The REAL engine: our lock covers the deficit — no second hub2 intent, no close of our lock.
      const plan = computeRefillPlan(snapshot(db, config, targets));
      assert.equal(plan.intents.filter((i) => i.dest === "hub2" && i.productId === "p1").length, 0, `${ctx}: engine proposed a duplicate hub2 intent`);
      assert.equal(plan.closes.filter((c) => c.dest === "hub2" && c.pid === "p1" && c.reason === "orphaned_pending").length, 0, ctx);
    } else if (marker.none) {
      none++;
      assert.equal(hubs.length, 0, `${ctx}: request created despite none=${marker.none}`);
      assert.equal(ourLock, undefined, `${ctx}: lock left behind with none=${marker.none}`);
      if (marker.none === "solve_undone" && !hadHub2Cell) assert.equal(db.state.root.stock.hub2?.p1?.[sk], undefined, `${ctx}: undone solve seeded Hub 2`);
    } else if (marker.deferredTo) {
      deferred++;
      if (w.mapped) mappedDeferred++;
      assert.equal(hubs.length, 0, `${ctx}: request created beside the engine's`);
      assert.equal(db.state.root.refill_engine?.open?.hub2?.p1?.[sk]?.refillId, "eng1", ctx);
    } else {
      assert.fail(`${ctx}: marker in no known state ${JSON.stringify(marker)}`);
    }
  }
  // The fuzz must have exercised every branch or it proves nothing.
  assert.ok(raised > 50 && none > 50 && deferred > 20 && guarded > 20 && withdrawnPresent > 50, `coverage raised=${raised} none=${none} deferred=${deferred} guarded=${guarded} withdrawnPresent=${withdrawnPresent}`);
  // The mapped worlds must have exercised both "we raised" and "the engine got there first".
  assert.ok(mappedRaised > 15 && mappedDeferred > 5, `mapped coverage raised=${mappedRaised} deferred=${mappedDeferred}`);
});
