// ─── FIRST BATCH DIRECT TO SHOP — the deferred Hub 2 leg (server) ───────────
// Owner spec 2026-09-17. The Missing Products Solve (src/components/stock/
// firstBatchCore.js) can raise a SHOP's own request from Central for a
// Central-stranded product whose shop is routed via Hub 2 — every category
// except sneakers and slides since 2026-09-17 (mapped categories and
// explicit-row products included; the Hub 2 target is whatever the real
// resolveTarget answers, map or row or run). That row is
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
// ── THE PATH IS OFF (incident 2026-09-17 evening) ────────────────────────────
// Owner order: the #607 behaviour is reverted until the first batch is rebuilt
// with the Hub 2-presence guard. The client no longer creates first-batch shop
// requests (firstBatchCore.FIRST_BATCH_ENABLED, pinned equal by test), but a
// browser still running the old bundle can — so the trigger is the backstop:
// an OPEN, UNTOUCHED first-batch shop request found while the path is off is
// turned back into the old Solve: Hub 2 is seeded for that size (the seed the
// old Solve always wrote) and the request is WITHDRAWN by CAS with
// `cancelReason: first_batch_path_off` (a reason, so the engine reads a
// withdrawal — no cooldown, no rejection learned at the shop's cell). The
// engine then runs the normal route: hub2←central, hub2→shop. A row Central
// has already started on (sentQty > 0) is real stock in motion and keeps the
// existing follow-through. A parameter, like the client flag, so the path's
// tests still drive it with `pathEnabled: true`.
const FIRST_BATCH_PATH_ENABLED = true;   // ON again with the Hub 2-presence guard (Phase 3 of the incident plan)
const PATH_OFF_REASON = "first_batch_path_off";
// ── HUB 2 PRESENCE — the hard precondition, re-checked at creation ──────────
// Owner rule after the incident: a product that exists at Hub 2 by ANY means
// — a stock cell (qty 0 included; cells are never deleted), an engine lock at
// Hub 2 (a pending inbound / an open Hub 2 request), an open Hub 2 request —
// is served from Hub 2, never from Central. The client checks this at Solve
// time; the trigger checks it AGAIN here, on the request's creation (before
// the shop lock is claimed), from scoped reads: a request created for a
// product Hub 2 holds is withdrawn with `first_batch_hub2_present`, Hub 2
// seeded, and the normal route takes over. The Solve's own qty-0 Hub 2 seeds
// (createdFrom.hub2Seeded, written in the same update as the request) are
// not presence. JS twin: src/components/stock/firstBatchCore.js
// hub2PresenceSignals (pinned equal by test).
const HUB2_PRESENT_REASON = "first_batch_hub2_present";
function hub2PresenceSignals({ hub2Node, hub2Locks, hub2OpenRequestIds, ownSeedKeys, ownSeedAt, sinceIso, heldLines, pid } = {}) {
  const own = new Set((ownSeedKeys || []).map(String));
  // An "own" seed must LOOK like one: a qty-0 seed cell — and, when the
  // caller knows the Solve's write time (`ownSeedAt` = the request's
  // createdAt; the Solve stamps its seeds with the same `now`), stamped at
  // exactly that time. A listed key over any other cell is presence: a client
  // cannot make a real cell disappear by naming it. (Spec review, PR #610.)
  const ownSeed = (k, c) => own.has(String(k)) && !!c && c.mv === "seed" && !((Number(c.qty) || 0) > 0) && (!ownSeedAt || c.updatedAt === ownSeedAt);
  const cells = Array.isArray(hub2Node)
    ? hub2Node.map((c, i) => [String(i), c]).filter(([, c]) => c != null)
    : Object.entries(hub2Node || {}).filter(([, c]) => c != null);
  const signals = [];
  if (cells.some(([k, c]) => !ownSeed(k, c))) signals.push("stock_cell");
  // A lock claimed AT OR AFTER this request's own createdAt (`sinceIso`) cannot
  // be prior presence: the engine's scan may run in the seconds between the
  // Solve's write (which seeds Hub 2, making it managed) and the trigger's
  // first run, and claim hub2←central for the very product just solved. A
  // lock that predates the request is real. (Lock createdAt is the scan's
  // START time, so a scan spanning the write reads as "before" — that error
  // only withdraws to the normal route, never the reverse. Sonnet, PR #610.)
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const priorLock = (e) => !!e && typeof e === "object" && !(Number.isFinite(sinceMs) && e.createdAt && Date.parse(e.createdAt) >= sinceMs);
  if (hub2Locks && typeof hub2Locks === "object" && Object.values(hub2Locks).some(priorLock)) signals.push("engine_lock");
  if (Array.isArray(hub2OpenRequestIds) && hub2OpenRequestIds.length) signals.push("open_hub2_request");
  // A PENDING INBOUND in the hold lane: Central's fulfil of a Hub 2 request
  // parks the units at stock/in_transit and records a held line at
  // /settings/stockHold/held/hub2/{lineId} {productId, …} until the release
  // credits Hub 2 — no Hub 2 cell, and the engine closes the fulfilled
  // request's lock on its next scan. Units on the way to Hub 2 ARE Hub 2
  // presence. (Spec review, PR #610.)
  if (pid && heldLines && typeof heldLines === "object") {
    const lines = Array.isArray(heldLines) ? heldLines : Object.values(heldLines);
    if (lines.some((l) => l && typeof l === "object" && l.productId === pid)) signals.push("held_inbound");
  }
  return signals;
}

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
async function processFirstBatchRequest({ db, requestId, nowIso, pathEnabled = FIRST_BATCH_PATH_ENABLED }) {
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
  // "Untouched" must be CERTAIN before a row is withdrawn: a sentQty of an
  // unexpected shape (a string "1") reads as 0 to num() — treat any non-number
  // non-null value as touched, so the row keeps its follow-through instead of
  // being cancelled over stock that may have moved. (Adversarial review, PR #609.)
  const touched = (num(rr.sentQty) || 0) > 0 || (rr.sentQty != null && typeof rr.sentQty !== "number");
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
  // ── BACK TO THE OLD SOLVE — the withdrawal both guards share ─────────────
  // Used when the path is OFF and when Hub 2 presence is found at creation.
  const withdrawToOldSolve = async ({ reason, none, product }) => {
    // Seed FIRST (a seed with nothing after it is harmless; a withdrawn
    // request with no Hub 2 cell is a size the engine could never adopt),
    // then withdraw by CAS: a row Central got to in the gap (fulfilled, or
    // sentQty > 0) is left exactly as it is and takes the follow-through
    // below on its next write. The marker lands in the same write as the
    // cancel so the re-fire this cancel causes is a no-op (`hub2_leg_done`).
    // No resolvedBy: to Refill History a reasoned cancel with no actor IS an
    // engine withdrawal; a synthetic actor string would render as neither.
    if (product) await seedIfAbsent(db, `stock/${FIRST_BATCH_HUB}/${pid}/${sizeKey}`, now);
    // COLD-NULL TRAP (admin-movement.cjs): the first callback runs on null in
    // a Cloud Function; judge it against the row already read (`rr`) — the
    // proposal then CASes against the server value and re-runs on a mismatch.
    // (A row hard-deleted in the gap would be re-created as cancelled; nothing
    // in this codebase deletes a live /refill_requests row — accepted.)
    const res = await reqRef.transaction((raw) => {
      const cur = raw === null || raw === undefined ? rr : raw;
      // open-and-untouched is the whole CAS condition: our own earlier cancel
      // fails `status === "open"`, and a marker a CLIENT pre-set must not
      // shield the row (the server lock decides "judged", never a row field).
      if (cur.status !== "open" || (num(cur.sentQty) || 0) > 0 || (cur.sentQty != null && typeof cur.sentQty !== "number")) return undefined;
      return { ...cur, status: "cancelled", cancelReason: reason, resolvedAt: now,
        firstBatch: { ...(cur.firstBatch || {}), hub2Leg: { none, at: now } } };
    });
    // A #607-era row may already hold the SHOP's engine lock (claimShopLock
    // ran before this revert). Withdrawn, the row must not keep naming a live
    // Central-source lock until the engine's next stale-lock close: release
    // it by CAS on our own refillId — never a lock that names another row.
    let lockReleased = false;
    if (res.committed && rr.firstBatch && rr.firstBatch.lock && rr.firstBatch.lock.claimedAt) {
      const shopLockRef = db.ref(`refill_engine/open/${store}/${pid}/${sizeKey}`);
      const held = (await shopLockRef.once("value")).val();   // cold-null: judge the first callback against this read
      const rel = await shopLockRef.transaction((raw) => { const cur = raw === null || raw === undefined ? held : raw; return cur && cur.refillId === requestId ? null : undefined; });
      lockReleased = !!rel.committed;
    }
    return { raised: false, none, withdrawn: !!res.committed, ...(lockReleased ? { lockReleased } : {}) };
  };

  if (!resolved && !touched && pathEnabled !== true) {
    // ── PATH OFF (see FIRST_BATCH_PATH_ENABLED) ────────────────────────────
    // Only a SHOP routed via Hub 2 can have been given a first-batch row (the
    // client's own scope); a tagged row anywhere else is not this backstop's
    // to touch. A product gone from the catalogue is withdrawn WITHOUT a seed
    // — the #607 branch below refuses that seed too (a carriage cell for a
    // record that no longer exists is forever). (Adversarial review, PR #609.)
    const [offConfig, offProduct] = await Promise.all([
      db.ref("config/refillEngine").once("value").then((s) => s.val() || {}),
      db.ref(`products/${pid}`).once("value").then((s) => s.val()),
    ]);
    if (((offConfig.routes || {})[store]) !== FIRST_BATCH_HUB) return { skipped: "path_off_not_shop", store };
    return withdrawToOldSolve({ reason: PATH_OFF_REASON, none: offProduct ? "path_off" : "product_missing", product: offProduct });
  }
  // "Already judged" is decided by the SERVER-OWNED shop lock (client-
  // unwritable), never by a field on the row: a row created with
  // firstBatch.lock or firstBatch.hub2Leg pre-set must not skip the guard.
  // (Spec review, PR #610.)
  const shopLockPath = `refill_engine/open/${store}/${pid}/${sizeKey}`;
  const committed = !resolved && !touched
    ? (((await db.ref(shopLockPath).once("value")).val() || {}).refillId === requestId)
    : true;
  if (!resolved && !touched && !committed) {
    // ── THE HUB 2-PRESENCE GUARD, AT CREATION (before any lock is claimed) ──
    // Judged ONCE, on the row's first write: after the shop lock exists the
    // engine may legitimately raise Hub 2's own leg (hub2←central from the
    // remainder) and that lock must never read as "Hub 2 held it before".
    const [hub2Node, hub2Locks, product, heldLines] = await Promise.all([
      db.ref(`stock/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
      db.ref(`refill_engine/open/${FIRST_BATCH_HUB}/${pid}`).once("value").then((s) => s.val()),
      db.ref(`products/${pid}`).once("value").then((s) => s.val()),
      db.ref(`settings/stockHold/held/${FIRST_BATCH_HUB}`).once("value").then((s) => s.val()),
    ]);
    const signals = hub2PresenceSignals({ hub2Node, hub2Locks, ownSeedKeys: rr.createdFrom.hub2Seeded || [], ownSeedAt: rr.createdAt, sinceIso: rr.createdAt, heldLines, pid });
    if (signals.length) {
      const r = await withdrawToOldSolve({ reason: HUB2_PRESENT_REASON, none: "hub2_present", product });
      return { ...r, signals };
    }
  }
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
    if (committed) return { skipped: "open_untouched" };
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
  FIRST_BATCH_PATH_ENABLED, PATH_OFF_REASON, HUB2_PRESENT_REASON, hub2PresenceSignals,
};
