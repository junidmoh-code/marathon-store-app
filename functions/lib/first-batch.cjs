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
const CENTRAL_DECLINED_REASON = "first_batch_central_declined";
const SOURCE = "central";
const firstBatchRunId = (solveId) => `${FIRST_BATCH_RUN_PREFIX}${solveId}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const avail = (q) => Math.max(num(q), 0);

// The seed cell — byte-for-byte the Solve's shape (NetworkTransfer.jsx solve()),
// so a later undo / count / audit reads it exactly like every other seed.
function seedCell(nowIso) {
  return { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: nowIso, updatedBy: "first_batch" };
}

// Seed-if-absent, as a TRANSACTION — never a blind set. The "is there a cell?"
// answer is taken from a read several awaits earlier; a real quantity can land
// in that cell in between (Hub 2 staff fulfilling another request for the same
// size, a count), and a blind set would overwrite it back to qty 0 — stock
// deleted. The same create-if-absent shape the lock claims use. (Senior-
// architect review, PR #607 — HIGH.)
async function seedIfAbsent(db, path, nowIso) {
  const res = await db.ref(path).transaction((cur) => (cur ? undefined : seedCell(nowIso)));
  return res.committed;
}

// Units already promised out of Central for this (pid, size) by OPEN engine
// locks at every routed destination — the engine's own sourceReserved idea,
// read one lock at a time. `excludeRefillId` leaves out the shop request whose
// leg is being raised; its live remainder is added back by the caller from the
// row itself (the lock's qty can lag a partial send by one scan).
// `excludeRunId` leaves out THIS solve's own locks — above all the Hub 2 lock a
// previous fire claimed (pending, no refillId) before crashing: counting it
// would read Central as fully reserved, record "central_empty", and strand the
// leg until the engine's orphaned-pending self-heal deleted the lock an hour
// later. (Found by the crash-recovery test, PR #607.)
async function centralReservations({ db, routes, pid, sizeKey, excludeRefillId, excludeRunId }) {
  let reserved = 0;
  for (const dest of Object.keys(routes || {})) {
    const entry = (await db.ref(`refill_engine/open/${dest}/${pid}/${sizeKey}`).once("value")).val();
    if (!entry) continue;
    if (entry.refillId && entry.refillId === excludeRefillId) continue;
    if (excludeRunId && entry.runId === excludeRunId) continue;
    const src = entry.source || routes[dest];
    if (src !== SOURCE) continue;
    reserved += Math.max(num(entry.qty) || 1, 1);
  }
  return reserved;
}

// Create-if-absent, exactly as refill-scan.cjs claims its intents. A lock that
// already exists and is not ours means another writer (the engine, or an
// earlier solve) is bookkeeping this cell — record it and leave it alone.
// The `firstBatch/lock` stamp is a SEPARATE write after the transaction (a
// transaction writes one path): a crash between the two leaves a lock with no
// stamp, which the next fire simply re-records (the claim is idempotent — its
// refillId is this request). The stamp is a note, not the idempotency record;
// only the Hub 2 leg's `firstBatch/hub2Leg` marker is that.
async function claimShopLock({ db, rr, requestId, pid, sizeKey, store, runId, now }) {
  const lockPath = `refill_engine/open/${store}/${pid}/${sizeKey}`;
  // A STALE first-batch lock is taken over. The Solve's undo cancels its
  // requests but cannot touch /refill_engine (client-unwritable), so after
  // Solve → undo → re-solve the old lock still names a cancelled request; the
  // engine closes it on its next scan, but until then the new request would
  // lose the claim and run unguarded. If the existing lock is a first-batch
  // lock whose request is no longer open, replace it — by CAS on that exact
  // refillId, so a lock that changed underneath is never overwritten. An
  // engine-held lock (runId of a scan) is never touched: the engine owns it.
  // (Adversarial review, PR #607.)
  const existing = (await db.ref(lockPath).once("value")).val();
  let staleId = null;
  if (existing && existing.refillId && existing.refillId !== requestId && String(existing.runId || "").startsWith(FIRST_BATCH_RUN_PREFIX)) {
    const theirs = (await db.ref(`refill_requests/${existing.refillId}`).once("value")).val();
    if (!theirs || theirs.status !== "open") staleId = existing.refillId;
  }
  const mine = { qty: Math.max(num(rr.qty) || 1, 1), source: SOURCE, createdAt: now, runId, refillId: requestId, orderId: null, orderCreatedAt: null };
  const claim = await db.ref(lockPath).transaction((cur) => {
    if (!cur) return mine;
    if (staleId && cur.refillId === staleId) return mine;
    return undefined;
  });
  const cur = claim.snapshot.val();
  const ours = !!cur && cur.runId === runId && cur.refillId === requestId;
  const mark = ours
    ? { claimedAt: now }
    : { heldBy: (cur && cur.runId) || "unknown", refillId: (cur && cur.refillId) || null, at: now };
  await db.ref(`refill_requests/${requestId}/firstBatch/lock`).set(mark);
  return ours ? { claimed: true } : { claimed: false, heldBy: mark.heldBy };
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
  // CENTRAL'S "OUT OF STOCK" ON THE SHOP'S FIRST BATCH IS NOT A SHOP-LEVEL "NO".
  // Source cancels a request WITHOUT a cancelReason, which the engine reads as
  // a human rejection at the requesting location's cell: a 24h retry cooldown
  // and a reject streak keyed (shop, pid, size) with denier Central, plus the
  // "shop level said no" half of confirmed-out. Every one of those would then
  // throttle the SHOP's ordinary hub2→shop refill for a "no" that was about
  // Central's shelf, not Hub 2's. So the trigger stamps the reason it knows,
  // in the same write as the leg it raises: the engine then treats the row as
  // a withdrawal (no cooldown, no learning), Hub 2's own leg carries the real
  // question to Central, and a "no" THERE learns at Hub 2's cell as always.
  // (Spec review, PR #607.)
  const centralDeclined = rr.status === "cancelled" && !rr.cancelReason;
  const declineStamp = centralDeclined ? { "cancelReason": CENTRAL_DECLINED_REASON } : {};
  if (!resolved && !touched) {
    // ── THE OPEN-REQUEST GUARD (investigation §4, Q2) ──────────────────────
    // Claim the SHOP request's engine lock, source Central. With it the row is
    // INBOUND to the engine: the shop's deficit reads 0, so no scan raises a
    // hub2→shop request for this product/size while the shop's Central
    // request is open — which matters the moment a partial send has raised
    // Hub 2's leg and Hub 2 holds stock. It also reserves Central for the shop
    // before the hub (sourceReserved), and hands the row to the engine's own
    // bookkeeping: withdraw when Central runs dry (awaiting_upstream), resize
    // to real demand, close on fulfil. The engine never CREATES a shop→Central
    // request — routes are untouched — it only bookkeeps this one.
    // Short-circuit only on a WON claim. A lost one (`heldBy`) is retried on
    // every later write to the row — a lost claim recorded as "done" would let
    // the shop run unguarded once the blocking lock is gone. (Adversarial
    // review, PR #607.)
    if (rr.firstBatch && rr.firstBatch.lock && rr.firstBatch.lock.claimedAt) return { skipped: "open_untouched" };
    const r = await claimShopLock({ db, rr, requestId, pid, sizeKey, store, runId, now });
    return { skipped: "open_untouched", lock: r };
  }
  if (rr.firstBatch && rr.firstBatch.hub2Leg) return { skipped: "hub2_leg_done", hub2Leg: rr.firstBatch.hub2Leg };

  const legRef = reqRef.child("firstBatch/hub2Leg");
  if (resolved && rr.cancelReason === SOLVE_UNDONE_REASON) {
    await legRef.set({ none: "solve_undone", at: now });
    return { raised: false, none: "solve_undone" };
  }

  // ── scoped reads ───────────────────────────────────────────────────────────
  const [config, product, hub2TargetRow, centralCell, hub2Cells, storeCells] = await Promise.all([
    db.ref("config/refillEngine").once("value").then((s) => s.val() || {}),
    db.ref(`products/${pid}`).once("value").then((s) => s.val()),
    db.ref(`stock_targets/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
    db.ref(`stock/${SOURCE}/${pid}/${sizeKey}`).once("value").then((s) => s.val()),
    db.ref(`stock/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
    db.ref(`stock/${store}/${pid}`).once("value").then((s) => s.val()),
  ]);
  if (!product) {
    await reqRef.update({ "firstBatch/hub2Leg": { none: "product_missing", at: now }, ...declineStamp });
    return { raised: false, none: "product_missing" };
  }

  const seedPath = `stock/${FIRST_BATCH_HUB}/${pid}/${sizeKey}`;
  // `== null`, never `=== undefined`: an array-coerced /stock row (dense numeric
  // size keys) comes back with NULL holes, and a hole is an absent cell.
  const seedNeeded = !hub2Cells || hub2Cells[sizeKey] == null;

  // THE ENGINE'S SWITCHES. With the engine disabled, or Hub 2 not in live
  // mode, a real lock and a real request would be written that nothing
  // reconciles (the scan returns before its reconcile when disabled, and a
  // shadow/off hub only ever gets shadow rows). Seed only: Hub 2 carries the
  // size from here, and the engine raises hub2←central itself the moment it
  // is live again. (Adversarial review, PR #607.)
  if (config.enabled !== true || (config.mode && config.mode[FIRST_BATCH_HUB] !== "live")) {
    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update({ "firstBatch/hub2Leg": { none: "engine_off", at: now }, ...declineStamp });
    return { raised: false, none: "engine_off", seeded: seedNeeded };
  }

  // Hub 2's target for this size, resolved by the REAL engine function over
  // the stock Hub 2 will hold once the seed lands (a clothing target exists
  // only where the location carries a cell — that is the whole reason the
  // seed is written here). No mirror: this is resolveTarget itself. The view
  // carries EVERY location the resolver reads — Central's cell and the shop's
  // row as well as Hub 2's — because the per-size category rule asks for
  // units ANYWHERE, and a Hub 2-only view answered 0 for a size Central held
  // nine of. (Adversarial review, PR #607.)
  const hub2CellsAfterSeed = { ...(hub2Cells || {}) };
  if (hub2CellsAfterSeed[sizeKey] == null) hub2CellsAfterSeed[sizeKey] = seedCell(now);
  const ctx = {
    config,
    products: { [pid]: product },
    targets: hub2TargetRow ? { [FIRST_BATCH_HUB]: { [pid]: hub2TargetRow } } : {},
    stock: {
      [FIRST_BATCH_HUB]: { [pid]: hub2CellsAfterSeed },
      [SOURCE]: { [pid]: centralCell ? { [sizeKey]: centralCell } : {} },
      [store]: { [pid]: storeCells || {} },
    },
  };
  const t = resolveTarget(ctx, FIRST_BATCH_HUB, pid, size);
  if (!t || !(t.target > 0)) {
    // No target at Hub 2 right now (kill switch off, policy withdrawn, a dead
    // size). Not a request — but the seed still lands, so Hub 2 carries the
    // size and the engine raises hub2←central itself when a target returns.
    // Without the seed the marker would be terminal with no way back.
    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update({ "firstBatch/hub2Leg": { none: "no_hub2_target", at: now }, ...declineStamp });
    return { raised: false, none: "no_hub2_target", seeded: seedNeeded };
  }
  const lockPath = `refill_engine/open/${FIRST_BATCH_HUB}/${pid}/${sizeKey}`;
  // Somebody already bookkeeps this Hub 2 cell (the engine, or an earlier
  // solve's leg) → ONE request stands; record where the demand went. Read
  // BEFORE sizing: an existing lock is an answer, not a reservation to
  // subtract from.
  const held = (await db.ref(lockPath).once("value")).val();
  if (held && held.runId !== runId) {
    const upd = {
      "firstBatch/hub2Leg": {
        deferredTo: String(held.runId || "").startsWith(FIRST_BATCH_RUN_PREFIX) ? "first_batch" : "engine",
        refillId: held.refillId || null, lockRunId: held.runId || null, at: now,
      },
      ...declineStamp,
    };
    // SEED FIRST, MARKER SECOND — in every branch. The marker is the "done"
    // record; once it exists nothing re-fires for this row. A crash between
    // the two therefore leaves a seed with no marker (the next fire finishes),
    // never a marker with no seed (an orphaned size). (Sonnet, PR #607 — HIGH.)
    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update(upd);
    return { raised: false, deferredTo: upd["firstBatch/hub2Leg"].deferredTo, refillId: held.refillId || null };
  }
  const hub2Have = avail(hub2Cells && hub2Cells[sizeKey] ? hub2Cells[sizeKey].qty : 0);
  const centralHave = avail(centralCell ? centralCell.qty : 0);
  const routes = config.routes || {};
  let reserved = await centralReservations({ db, routes, pid, sizeKey, excludeRefillId: requestId, excludeRunId: runId });
  // A partially-sent shop request still has its remainder to come from
  // Central — the shop is served first, always.
  if (!resolved) reserved += Math.max(num(rr.qty) || 0, 0);
  const cap = num(config.maxUnitsPerIntent) > 0 ? num(config.maxUnitsPerIntent) : 20;
  const deficit = t.target - hub2Have;
  const free = centralHave - reserved;
  const qty = Math.min(deficit, free, cap);

  if (qty <= 0) {
    const none = deficit <= 0 ? "hub2_covered" : "central_empty";
    const upd = { "firstBatch/hub2Leg": { none, at: now, target: t.target, hub2Have, centralHave, reserved }, ...declineStamp };
    // The seed still lands (first): from here the ENGINE manages Hub 2 for
    // this size and raises hub2←central itself the moment Central has units.
    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update(upd);
    return { raised: false, none, seeded: seedNeeded };
  }

  // ── the engine's own idempotency contract: the lock, create-if-absent ──────
  const claim = await db.ref(lockPath).transaction((cur) => (cur ? undefined : {
    qty, source: SOURCE, createdAt: now, runId, pending: true,
  }));
  const cur = claim.snapshot.val();
  const ours = !!cur && cur.runId === runId;
  if (!ours) {
    // Raced: a lock landed between the read above and the claim (a scan
    // between the seed and this write) — same answer, one request stands.
    const upd = {
      "firstBatch/hub2Leg": {
        deferredTo: cur && cur.runId && String(cur.runId).startsWith(FIRST_BATCH_RUN_PREFIX) ? "first_batch" : "engine",
        refillId: (cur && cur.refillId) || null, lockRunId: (cur && cur.runId) || null, at: now,
      },
      ...declineStamp,
    };
    if (seedNeeded) await seedIfAbsent(db, seedPath, now);
    await reqRef.update(upd);
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
  // The seed lands FIRST, by transaction (see seedIfAbsent): it is pure
  // carriage — exactly what the old Solve wrote — so a seed with nothing after
  // it is harmless, while a request whose Hub 2 cell never existed is a size
  // the engine would never adopt. Then ONE atomic update: request, finalised
  // lock and marker land together or not at all. A failure leaves our pending
  // lock, which the next fire (or the engine's orphaned-pending self-heal
  // after an hour) resolves.
  if (seedNeeded) await seedIfAbsent(db, seedPath, now);
  const upd = {
    [`refill_requests/${key}`]: hubRequest,
    [lockPath]: { qty, source: SOURCE, createdAt: now, runId, refillId: key, orderId: null, orderCreatedAt: null },
    [`refill_requests/${requestId}/firstBatch/hub2Leg`]: { refillId: key, qty, at: now, target: t.target, hub2Have, centralHave, reserved },
  };
  if (centralDeclined) upd[`refill_requests/${requestId}/cancelReason`] = CENTRAL_DECLINED_REASON;
  await db.ref().update(upd);
  return { raised: true, refillId: key, qty, seeded: seedNeeded };
}

module.exports = {
  processFirstBatchRequest,
  claimShopLock,
  seedIfAbsent,
  centralReservations,
  seedCell,
  FIRST_BATCH_HUB, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON, CENTRAL_DECLINED_REASON, firstBatchRunId,
};
