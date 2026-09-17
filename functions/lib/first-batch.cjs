// ─── FIRST BATCH DIRECT TO SHOP — the deferred Hub 2 leg (server) ───────────
// Owner spec 2026-09-17. The Missing Products Solve (src/components/stock/
// firstBatchCore.js) can raise a SHOP's own request from Central for a
// Central-stranded clothing product whose shop is routed via Hub 2. That row is
// tagged `createdFrom.firstBatch` and carries `createdFrom.solveId`. This module
// is what happens NEXT, and it runs here — in a Cloud Function on an RTDB
// trigger — for two reasons that cannot be met in the browser:
//
//   1. Nothing may depend on one browser staying open. The moment the shop's
//      request is fulfilled (fully or partially) or cancelled — by the Source
//      tab, by the engine's own withdrawal, by anyone — Hub 2's request must be
//      raised. A trigger sees every writer.
//   2. The engine's lock table (/refill_engine/open) is `.write: false` to
//      clients. Hub 2's request must hold an engine lock or the very next scan
//      would raise a second hub2←central request beside it (the engine counts
//      inbound from locks alone). The Admin SDK can claim one; a browser cannot.
//
// WHAT IT DOES, per shop request:
//   • On any write while the row is still open and untouched: claims the SHOP
//     request's engine lock (see claimShopLock) — the open-request guard.
//   • Once `status !== "open"` OR `sentQty > 0`: raises Hub 2's leg EXACTLY
//     ONCE — a qty-0 seed cell at Hub 2 for that size (so the engine manages
//     Hub 2 for it from now on), an engine lock, and a /refill_requests row in
//     the engine's own shape, sized `min(hub2 target − hub2 on-hand, Central
//     on-hand − Central's open reservations, maxUnitsPerIntent)`, all in ONE
//     atomic update together with a marker on the shop request
//     (`firstBatch.hub2Leg`). The marker is the idempotency record: a re-fire,
//     a retry or a second writer finds it and stops.
//   • Central has nothing left → no request is created; the marker records
//     `none: "central_empty"`, the seed still lands, and the engine takes over
//     (it will raise hub2←central the moment Central restocks — normal route).
//   • The engine already holds a lock on (hub2, pid, size) → no second request;
//     the marker records `deferredTo` with the engine's refillId.
//   • Cancelled by the Solve's own undo (`cancelReason: "solve_undone"`) → no
//     Hub 2 leg, no seed: the Solve never happened.
//
// EVERY READ IS SCOPED (one product, one size, one location each). The trigger
// RE-READS the row instead of trusting the event payload (retry delivery can
// be stale). Nothing here writes /stock quantities — the seed is the same qty-0
// carriage cell the Solve has always written. Keys are productIds; size keys
// go through the engine's own encodeSizeKey.

"use strict";

const { resolveTarget, encodeSizeKey } = require("./refill-engine.cjs");

// CJS twins of the constants in src/components/stock/firstBatchCore.js — a
// test pins them equal.
const FIRST_BATCH_HUB = "hub2";
const FIRST_BATCH_RUN_PREFIX = "first_batch:";
const SOLVE_UNDONE_REASON = "solve_undone";
const SOURCE = "central";
const firstBatchRunId = (solveId) => `${FIRST_BATCH_RUN_PREFIX}${solveId}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const avail = (q) => Math.max(num(q), 0);

// The seed cell — byte-for-byte the Solve's shape (NetworkTransfer.jsx solve()),
// so a later undo / count / audit reads it exactly like every other seed.
function seedCell(nowIso) {
  return { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: nowIso, updatedBy: "first_batch" };
}

// Units already promised out of Central for this (pid, size) by OPEN engine
// locks at every routed destination — the engine's own sourceReserved idea,
// read one lock at a time. `excludeRefillId` leaves out the shop request whose
// leg is being raised; its live remainder is added back by the caller from the
// row itself (the lock's qty can lag a partial send by one scan).
async function centralReservations({ db, routes, pid, sizeKey, excludeRefillId }) {
  let reserved = 0;
  for (const dest of Object.keys(routes || {})) {
    const entry = (await db.ref(`refill_engine/open/${dest}/${pid}/${sizeKey}`).once("value")).val();
    if (!entry) continue;
    if (entry.refillId && entry.refillId === excludeRefillId) continue;
    const src = entry.source || routes[dest];
    if (src !== SOURCE) continue;
    reserved += Math.max(num(entry.qty) || 1, 1);
  }
  return reserved;
}

/**
 * The trigger core. Returns a small result object naming what it did — every
 * outcome that is not a transient I/O failure RETURNS (never throws), so a
 * retrying trigger re-drives only real failures.
 *
 * @param db        admin.database() (or the test fake)
 * @param requestId the /refill_requests key that was written
 * @param nowIso    injectable clock
 */
async function processFirstBatchRequest({ db, requestId, nowIso }) {
  const now = nowIso || new Date().toISOString();
  const reqRef = db.ref(`refill_requests/${requestId}`);
  const rr = (await reqRef.once("value")).val();
  if (!rr) return { skipped: "request_gone" };
  if (!rr.createdFrom || rr.createdFrom.firstBatch !== true) return { skipped: "not_first_batch" };
  // Hub 2's own leg is ALSO tagged firstBatch (for history) but must never
  // recurse into raising a leg of its own.
  if (rr.requestingLocation === FIRST_BATCH_HUB) return { skipped: "hub_leg" };
  if (!rr.productId || rr.size == null || !rr.requestingLocation || !rr.createdFrom.solveId) return { skipped: "malformed" };

  const pid = rr.productId;
  const size = String(rr.size);
  const sizeKey = encodeSizeKey(size);
  const store = rr.requestingLocation;
  const solveId = rr.createdFrom.solveId;
  const runId = firstBatchRunId(solveId);

  const resolved = rr.status !== "open";
  const touched = (num(rr.sentQty) || 0) > 0;
  if (!resolved && !touched) return { skipped: "open_untouched" };
  if (rr.firstBatch && rr.firstBatch.hub2Leg) return { skipped: "hub2_leg_done", hub2Leg: rr.firstBatch.hub2Leg };

  const legRef = reqRef.child("firstBatch/hub2Leg");
  if (resolved && rr.cancelReason === SOLVE_UNDONE_REASON) {
    await legRef.set({ none: "solve_undone", at: now });
    return { raised: false, none: "solve_undone" };
  }

  // ── scoped reads ───────────────────────────────────────────────────────────
  const [config, product, hub2TargetRow, centralCell, hub2Cells] = await Promise.all([
    db.ref("config/refillEngine").once("value").then((s) => s.val() || {}),
    db.ref(`products/${pid}`).once("value").then((s) => s.val()),
    db.ref(`stock_targets/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
    db.ref(`stock/${SOURCE}/${pid}/${sizeKey}`).once("value").then((s) => s.val()),
    db.ref(`stock/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
  ]);
  if (!product) {
    await legRef.set({ none: "product_missing", at: now });
    return { raised: false, none: "product_missing" };
  }

  // Hub 2's target for this size, resolved by the REAL engine function over
  // the stock Hub 2 will hold once the seed lands (a clothing target exists
  // only where the location carries a cell — that is the whole reason the
  // seed is written here). No mirror: this is resolveTarget itself.
  const hub2CellsAfterSeed = { ...(hub2Cells || {}) };
  if (hub2CellsAfterSeed[sizeKey] === undefined) hub2CellsAfterSeed[sizeKey] = seedCell(now);
  const ctx = {
    config,
    products: { [pid]: product },
    targets: hub2TargetRow ? { [FIRST_BATCH_HUB]: { [pid]: hub2TargetRow } } : {},
    stock: { [FIRST_BATCH_HUB]: { [pid]: hub2CellsAfterSeed } },
  };
  const t = resolveTarget(ctx, FIRST_BATCH_HUB, pid, size);
  if (!t || !(t.target > 0)) {
    await legRef.set({ none: "no_hub2_target", at: now });
    return { raised: false, none: "no_hub2_target" };
  }

  const seedPath = `stock/${FIRST_BATCH_HUB}/${pid}/${sizeKey}`;
  const seedNeeded = !hub2Cells || hub2Cells[sizeKey] === undefined;
  const hub2Have = avail(hub2Cells && hub2Cells[sizeKey] ? hub2Cells[sizeKey].qty : 0);
  const centralHave = avail(centralCell ? centralCell.qty : 0);
  const routes = config.routes || {};
  let reserved = await centralReservations({ db, routes, pid, sizeKey, excludeRefillId: requestId });
  // A partially-sent shop request still has its remainder to come from
  // Central — the shop is served first, always.
  if (!resolved) reserved += Math.max(num(rr.qty) || 0, 0);
  const cap = num(config.maxUnitsPerIntent) > 0 ? num(config.maxUnitsPerIntent) : 20;
  const deficit = t.target - hub2Have;
  const free = centralHave - reserved;
  const qty = Math.min(deficit, free, cap);

  if (qty <= 0) {
    const none = deficit <= 0 ? "hub2_covered" : "central_empty";
    const upd = { "firstBatch/hub2Leg": { none, at: now, target: t.target, hub2Have, centralHave, reserved } };
    // The seed still lands: from here the ENGINE manages Hub 2 for this size
    // and raises hub2←central itself the moment Central has units.
    await reqRef.update(upd);
    if (seedNeeded) await db.ref(seedPath).set(seedCell(now));
    return { raised: false, none, seeded: seedNeeded };
  }

  // ── the engine's own idempotency contract: the lock, create-if-absent ──────
  const lockPath = `refill_engine/open/${FIRST_BATCH_HUB}/${pid}/${sizeKey}`;
  const claim = await db.ref(lockPath).transaction((cur) => (cur ? undefined : {
    qty, source: SOURCE, createdAt: now, runId, pending: true,
  }));
  const cur = claim.snapshot.val();
  const ours = !!cur && cur.runId === runId;
  if (!ours) {
    // The engine (or a prior run of ours under another solve) already holds
    // this cell — ONE request stands. Record where the demand went.
    const upd = {
      "firstBatch/hub2Leg": {
        deferredTo: cur && cur.runId && String(cur.runId).startsWith(FIRST_BATCH_RUN_PREFIX) ? "first_batch" : "engine",
        refillId: (cur && cur.refillId) || null, lockRunId: (cur && cur.runId) || null, at: now,
      },
    };
    await reqRef.update(upd);
    if (seedNeeded) await db.ref(seedPath).set(seedCell(now));
    return { raised: false, deferredTo: upd["firstBatch/hub2Leg"].deferredTo, refillId: (cur && cur.refillId) || null };
  }
  // Ours and already finalised (a re-fire after the atomic update landed but
  // before this run re-read the marker — the marker write and the lock write
  // are one update, so the marker exists; be explicit anyway).
  if (cur.refillId) {
    await legRef.set({ refillId: cur.refillId, qty: num(cur.qty), at: now, target: t.target, centralHave, reserved });
    return { raised: false, skipped: "already_finalised", refillId: cur.refillId };
  }

  const key = db.ref("refill_requests").push().key;
  const hubRequest = {
    productId: pid, size, qty, requestingLocation: FIRST_BATCH_HUB, status: "open",
    createdAt: now,
    createdFrom: { firstBatch: true, solveId, source: SOURCE, store, shopRequestId: requestId, via: "first_batch_hub2_leg" },
  };
  const upd = {
    [`refill_requests/${key}`]: hubRequest,
    [lockPath]: { qty, source: SOURCE, createdAt: now, runId, refillId: key, orderId: null, orderCreatedAt: null },
    [`refill_requests/${requestId}/firstBatch/hub2Leg`]: { refillId: key, qty, at: now, target: t.target, hub2Have, centralHave, reserved },
  };
  if (seedNeeded) upd[seedPath] = seedCell(now);
  // ONE atomic update: request, finalised lock, marker and seed land together
  // or not at all. A failure leaves our pending lock, which the next fire
  // (or the engine's orphaned-pending self-heal after an hour) resolves.
  await db.ref().update(upd);
  return { raised: true, refillId: key, qty, seeded: seedNeeded };
}

module.exports = {
  processFirstBatchRequest,
  centralReservations,
  seedCell,
  FIRST_BATCH_HUB, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON, firstBatchRunId,
};
