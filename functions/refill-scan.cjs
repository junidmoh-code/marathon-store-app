// ─── REFILL HEALTH SCAN (Cloud Function I/O wrapper) ──────────────────────────
// Every 15 minutes during trading hours (07:00-19:00 SAST): snapshot the RTDB,
// ask lib/refill-engine.cjs (pure, tested)
// what should happen, then apply it:
//   • close finished/cancelled refill locks
//   • create refill intents — per destination MODE from /config/refillEngine:
//       off    → compute exceptions only
//       shadow → record what WOULD be ordered in /refill_engine/shadow
//       live   → create /refill_requests + a real R### "Shop Refill" order for
//                store legs (the warehouse Clothing tab flow is UNCHANGED — the
//                battle-tested fulfillCRBatch split-lock does the actual move);
//                hub2 legs get /refill_requests only, fulfilled via the
//                Transfer screen's "Open refill requests" prefill.
//   • write /stock_exceptions/latest (dashboard) and /stock_confidence (hourly)
//
// SAFETY: the engine NEVER writes /stock. Claim-before-act lock so overlapping
// runs can't double-create. Idempotency = one open lock per (dest,product,size)
// in /refill_engine/open; R-numbers are daily-recycled and never used as
// identity. Kill switch: /config/refillEngine/enabled = false.
//
// DEPLOY (scoped — NEVER bare --only functions, POS shares this project):
//   firebase deploy --only functions:refillHealthScan

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const engine = require("./lib/refill-engine.cjs");

const LOCK_STEAL_MS = 10 * 60e3;
// The ledger slice every run reads. HELD AT 45 — the reduction to 31 was
// implemented, reviewed, and reverted.
//
// The obvious lookbacks are the 30-day confidence score and the confirmed-out
// gate (config.confirmedOutDays, default 14), so 31 looked like the smallest
// safe window. It is not: `ledgerTouched()` (lib/refill-engine.cjs:540) has NO
// time bound of its own. It protects an OPEN refill request whose pick is
// physically recorded in the ledger — `inFlight` — and that flag is what stops
// the request being withdrawn as "awaiting_upstream" when the source reads
// empty, and what skips the auto-resize. Its evidence is whatever movements the
// slice happens to contain.
//
// Nothing closes an open intent for age: the staleIntentHours branch only
// REPORTS (stuckRefills), it never withdraws. So an intent can outlive any
// window, and the moment its pick falls outside the slice it silently loses its
// in-flight guard and can be cancelled or resized while a warehouse pick is in
// progress. Found by adversarial review (Codex, PR review 2026-08-04).
//
// Live check the same day: 188 open intents, oldest 11 days — so 45 carries
// roughly 4x headroom and the hazard is not active. Narrowing to 31 would save
// ~1.5 MB/run (~$4/month); the cadence change in this PR saves ~$65/month. That
// is not a trade worth making against a silent withdrawal of an in-flight order.
//
// To narrow it safely, bound intent age first (close or escalate a stuck intent
// rather than only reporting it), then the window can follow that bound.
const MOVEMENTS_WINDOW_DAYS = 45;      // confidence (30d) + confirmed-out gate + in-flight ledger evidence
const RUNS_KEEP_DAYS = 7;

// Universe → placedStore string the app writes on refill orders.
const UNIVERSE_BY_SHOP = { "marathon-pe": "central", trophy: "central", "marathon-pine": "pine" };

// ── the ONE way this file writes a multi-path update ──────────────────────────
// Every `db.ref().update(...)` goes through here. Two live outages (2026-07-22
// #269, 2026-07-24) came from malformed payloads reaching .update(), which
// validates its argument SYNCHRONOUSLY and throws — so the old
// `.update(x).catch(() => {})` never caught them (the catch is never attached)
// while silently swallowing every genuine write failure. Both problems, one fix:
//   • sanitizeUpdate() strips undefined values / forbidden keys BEFORE the call
//   • anything stripped, or any real write failure, is LOGGED not swallowed
//   • the scan CONTINUES (these writes are recomputed from live state every run,
//     so a lost one reappears next pass — that resilience is deliberate and is
//     why this returns false instead of rethrowing)
// opts.strict — for ALL-OR-NOTHING writes (the intent-creation update, where a
// half-written request/order/lock is worse than none). In strict mode anything
// stripped aborts the whole write instead of persisting a partial record.
//
// RETURN VALUE = "did this write LAND?", not "was it clean?". Callers use it for
// the run-record counts, so a degraded-but-persisted write must report TRUE:
// returning false for it made counts.closes / streakOps / retryOps UNDER-report
// writes that actually happened — the exact opposite of the audit-trail intent.
// Sanitizer problems are surfaced by the log line above, never by this boolean.
// (CodeRabbit, PR #276.)
async function safeUpdate(db, upd, label, opts = {}) {
  const { safe, problems } = engine.sanitizeUpdate(upd);
  if (problems.length) {
    // A bug at the write site. Loud, but never fatal — see the block comment.
    console.error(`[refill-scan] ${label}: ${opts.strict ? "ABORTED write —" : "dropped"} ${problems.length} malformed entr${problems.length === 1 ? "y" : "ies"}:`, problems.slice(0, 20));
    if (opts.strict) return false;   // strict: nothing written, so nothing landed
  }
  if (!Object.keys(safe).length) return false;   // nothing left to write
  try {
    await db.ref().update(safe);
    return true;                                 // it landed (possibly degraded)
  } catch (e) {
    console.error(`[refill-scan] ${label}: update failed:`, e && e.message ? e.message : e);
    return false;
  }
}

// Same protection for single-node .set() writes. `.set()` validates its argument
// exactly like `.update()` does, so the snapshot writes below (stock_exceptions,
// stock_confidence, shadow) are the same outage class — and the riskiest of the
// lot, since plan.exceptions is a dozen freeform record arrays assembled across
// many branches: one future field without a default would take the scan down
// again on a code path the update-guard never sees. (CodeRabbit, PR #276.)
async function safeSet(db, path, value, label) {
  const { safe, problems } = engine.sanitizeUpdate({ [path]: value });
  if (problems.length) {
    console.error(`[refill-scan] ${label}: dropped ${problems.length} malformed entr${problems.length === 1 ? "y" : "ies"}:`, problems.slice(0, 20));
  }
  if (!(path in safe)) return false;
  try {
    await db.ref(path).set(safe[path]);
    return true;                                 // landed — see safeUpdate's note
  } catch (e) {
    console.error(`[refill-scan] ${label}: set failed:`, e && e.message ? e.message : e);
    return false;
  }
}

async function drawRefillNumber(db, nowMs) {
  // EXACT mirror of App.jsx getNextRefillNumber(): daily reset keyed by the
  // device-local SA date string (0-based month), 001–999 wrap, "R" prefix.
  const todayKey = engine.saTodayKey(nowMs);
  const res = await db.ref("refillCounter").transaction((current) => {
    if (!current || current.day !== todayKey) return { day: todayKey, counter: 1 };
    return { day: todayKey, counter: current.counter >= 999 ? 1 : current.counter + 1 };
  });
  return "R" + String(res.snapshot.val()?.counter ?? 1).padStart(3, "0");
}

// ─── resize drop classification (pure) ───────────────────────────────────────
// Turns a transaction outcome into a stable reason string for counts.resizeDropped.
// Pure and exported so the reasons are unit-testable without Firebase — the whole
// point is that a drop is nameable, and a name nobody can assert on drifts.
//
//   order_txn_error      — the order transaction threw (network / rules)
//   order_guard_bailed   — callback returned undefined: in-flight (clothingPlanGen),
//                          already actioned (clothingRefillStatus), or not autoRefill
//   order_vanished       — committed against a null node: the order is gone, so the
//                          close path owns this cell, not the resize path
//   request_txn_error    — the request transaction threw
//   request_not_open     — callback returned undefined: status !== "open"
//   request_vanished     — committed against a null node
//   request_qty_mismatch — DEFENSIVE ONLY, unreachable through the real API: RTDB
//                          RETRIES the handler against a concurrent write rather
//                          than committing a divergent value, so a committed
//                          snapshot always holds what the callback returned. Kept
//                          because the lock must never follow a qty we did not
//                          write, and a future SDK change must fail loudly rather
//                          than silently. (CodeRabbit, PR #286.)
//   lock_write_failed    — request+order moved but the lock write was rejected;
//                          the one drop that leaves state INCONSISTENT for a scan
function resizeDropReason(stage, { threw = false, committed = false, exists = false, qty, want } = {}) {
  if (threw) return `${stage}_txn_error`;
  if (!committed) return stage === "order" ? "order_guard_bailed" : "request_not_open";
  if (!exists) return `${stage}_vanished`;
  if (stage === "request" && qty !== want) return "request_qty_mismatch";
  return `${stage}_unknown`;
}

// ─── apply resizes (owner approval 2026-07-13) ───────────────────────────────
// Same identity, history preserved: the warehouse ORDER transaction decides
// (bails on any touched/in-flight card — exactly the withdraw guard), then the
// request and the lock follow. A bailed resize retries next scan.
//
// DROP ACCOUNTING (2026-07-28): all three `continue`/else paths below discard a
// resize the plan asked for. Until now they did it silently — no counter, no
// log, no exception row — so a planned resize that never landed was invisible in
// the run record. Live evidence of the cost: STORE legs (which have an order, so
// they run the order transaction) landed 186 resizes on 2026-07-13 and then fell
// to ~1/day, while HUB legs (no orderId, so that transaction is skipped
// entirely) kept flowing — 150 landed, most recently the same day this was
// written. Two weeks of one-directional under-delivery nobody could see, because
// `resized` only ever counts successes.
//
// This does NOT change behaviour: every drop still drops. It only names why.
//
// EXTRACTED FROM runScan so the accounting is testable: `db` and the safeSet
// writer are injected, so a fake ref can drive every branch without Firebase.
// (CodeRabbit, PR #286 — the first version tested only the classifier, which
// left `dropResize`, `counts.resizeDropped` and the lock-write branch unpinned.)
async function applyResizes({ db, resizes, startedAt, setFn }) {
  let resized = 0;
  const resizeDrops = {};
  const dropResize = (reason) => { resizeDrops[reason] = (resizeDrops[reason] || 0) + 1; };

  for (const rz of resizes) {
    let proceed = true;
    let dropReason = null;
    if (rz.orderId) {
      try {
        const r = await db.ref(`orders/${rz.orderId}`).transaction((cur) => {
          if (cur === null) return null;                                 // cold-cache probe (null-tolerant)
          if (cur.clothingRefillStatus != null || cur.clothingPlanGen != null || !cur.autoRefill) return; // in-flight/touched
          return { ...cur, qty: rz.to, updatedAt: startedAt };
        });
        proceed = r.committed && r.snapshot.exists();                    // vanished order → let the close path own it
        if (!proceed) dropReason = resizeDropReason("order", { committed: r.committed, exists: r.snapshot.exists() });
      } catch { proceed = false; dropReason = resizeDropReason("order", { threw: true }); }
    }
    if (!proceed) { dropResize(dropReason || "order_unknown"); continue; }

    // The rr transaction is the decider for its own node (review 2026-07-13): if
    // it bails — resolved concurrently, e.g. Hub 2 legs fulfilled between plan
    // and apply — the lock is NOT touched and the resize does NOT count.
    // resizedFrom comes from the authoritative in-transaction value, never the
    // planning snapshot.
    if (rz.refillId) {
      let ok = false;
      let rrDrop = null;
      try {
        const r2 = await db.ref(`refill_requests/${rz.refillId}`).transaction((cur) => {
          if (cur === null) return null;                                 // probe
          if (cur.status !== "open") return;
          return { ...cur, qty: rz.to, resizedAt: startedAt, resizedFrom: cur.qty ?? rz.from };
        });
        ok = r2.committed && r2.snapshot.exists() && r2.snapshot.val()?.qty === rz.to;
        if (!ok) rrDrop = resizeDropReason("request", {
          committed: r2.committed, exists: r2.snapshot.exists(),
          qty: r2.snapshot.val()?.qty, want: rz.to,
        });
      } catch { ok = false; rrDrop = resizeDropReason("request", { threw: true }); }
      if (!ok) { dropResize(rrDrop || "request_unknown"); continue; }
    }

    // Through safeSet like every other write: `.set()` AND `db.ref(path)` both
    // validate synchronously, so a bare `.set(x).catch()` here is the exact
    // anti-pattern PR #276 removed — the last write in the file whose path
    // components are data-derived.
    if (await setFn(db, `refill_engine/open/${rz.dest}/${rz.pid}/${rz.sizeKey}/qty`, rz.to, `resize ${rz.dest}/${rz.pid}/${rz.sizeKey}`)) resized++;
    else dropResize("lock_write_failed");   // order+request MOVED but the lock did not — inconsistent for one scan
  }
  return { resized, resizeDrops };
}

// ─── APPLY: SATISFIED-BY-STOCK WITHDRAWALS ───────────────────────────────────
// The lock-less half of reconciliation (see the long note above
// `satisfiedClosures` in refill-engine.cjs). Each closure writes exactly ONE
// node — the request's own status. It must never touch
// /refill_engine/open/{dest}/{pid}/{sizeKey}: some OTHER live lock may sit on
// the same cell, and nulling it would strand a request the engine is waiting on.
//
// LIVE CELL RE-CHECK. The transaction guards the STATUS, not the stock condition
// that justified the withdrawal, and the plan came from a snapshot that may be a
// minute old. If the covering units sold or moved in that gap, cancelling is
// wrong AND — for a Missing Sneakers request — unrecoverable: that screen only
// shows products with zero units at BOTH hubs, so nothing ever re-raises the
// ask. An engine-created request would self-heal on the next scan; these do not,
// so they get the extra read. Withdrawals are rare (10 on the day this shipped).
//
// ONE UNIT STILL SATISFIES ONE REQUEST — even here. The plan allocates a cell
// oldest-first across siblings, but this loop re-reads the LIVE cell
// independently per closure, and a naive `live >= s.qty` test would re-open the
// very hole the plan's allocation closes: two siblings each asking 2 against a
// cell the plan saw holding 4, with the live cell since dropped to 2, would BOTH
// pass, and the second would be cancelled against units the first already
// claimed. `consumed` carries the allocation into the apply pass. A closure that
// fails the check consumes nothing — being stale must not deprive a later
// sibling of stock that is genuinely there. (CodeRabbit, PR #332.)
//
// A closure consumes on passing the check, not on the transaction committing. An
// aborted transaction means the request was resolved by someone else in the gap;
// re-crediting its units would need a second pass for a case whose only cost is
// that one sibling stays visible as work for another 15 minutes — the safe
// direction, and self-healing.
//
// db is injected so the whole apply path is testable without firebase-admin.
// TIME-BOXED, like the intent loop. Two serial RTDB round trips per closure, and
// this pass runs BEFORE the intent apply — so an unbounded version could spend
// the whole function budget here and defer every refill of the day. The scenario
// is not hypothetical: it is precisely this PR's own subject. A bulk manual
// transfer covering hundreds of lock-less requests is exactly what produces a
// large satisfiedClosures list.
//
// Stopping early loses nothing — the plan is recomputed from scratch every scan,
// so an unprocessed withdrawal simply re-decides next run. The break is reported
// rather than silent, so the run record never implies the pass completed.
// (CodeRabbit, PR #332.)
async function applySatisfied({ db, closures, startedAt, deadlineMs = Infinity }) {
  let satisfied = 0, stale = 0, deferred = 0;
  const errors = [];
  const consumed = new Map();
  for (let i = 0; i < closures.length; i++) {
    const s = closures[i];
    if (Date.now() > deadlineMs) {
      // Count from the INDEX, not from satisfied+stale — a closure can also end
      // in neither (a transaction that threw is an error, not a stale skip), so
      // deriving the remainder arithmetically would under-report.
      deferred = closures.length - i;
      errors.push(`satisfied pass hit its time budget — ${deferred} withdrawal(s) defer to the next scan`);
      break;
    }
    // DEACTIVATED-PRODUCT withdrawals carry no stock condition — the request
    // is cancelled because the product is a finished line, not because units
    // arrived — so the live-cell proof below has nothing to verify and would
    // wrongly mark every one of them stale (the cell is empty by definition).
    // The status transaction still guards against a request resolved meanwhile.
    if (!s.deactivated) {
      const cellKey = `${s.dest}|${s.pid}|${s.sizeKey}`;
      const already = consumed.get(cellKey) || 0;
      try {
        const live = (await db.ref(`stock/${s.dest}/${s.pid}/${s.sizeKey}/qty`).once("value")).val();
        if (!(Math.max(Number(live) || 0, 0) >= already + s.qty)) { stale++; continue; }
      } catch {
        // Read failed — we cannot prove the units are still there, so we do not
        // cancel. The next scan re-decides from truth.
        stale++; continue;
      }
      consumed.set(cellKey, already + s.qty);
    }
    try {
      const res = await db.ref(`refill_requests/${s.refillId}`).transaction((cur) => {
        // NULL-TOLERANT (the #199 lesson): the first pass runs against the cold
        // local cache and sees null even when the node exists. Returning
        // undefined there ABORTS permanently — how 2,304 status writes were once
        // silently lost. Returning null re-probes; a missing node no-ops.
        if (cur === null) return null;
        if (cur.status && cur.status !== "open") return;      // resolved meanwhile — leave it
        return {
          ...cur,
          status: s.rrStatus,
          resolvedAt: startedAt,
          cancelReason: s.cancelReason,
          // The audit trail a human needs to believe the withdrawal: what the
          // cell held at the moment the engine decided the ask was met — or,
          // for a finished line, the fact that deactivation is the reason.
          ...(s.deactivated
            ? { deactivatedProduct: true }
            : { satisfiedBy: { location: s.dest, onHand: s.have, requested: s.qty } }),
        };
      });
      if (res?.committed && res.snapshot?.val()?.status === s.rrStatus) satisfied++;
    } catch (e) {
      errors.push(`satisfied ${s.refillId}: ${e?.message || e}`);
    }
  }
  return { satisfied, stale, deferred, errors };
}

function shadowSyncUpdates({ shadowNode, products, orders, refillRequests, runId, startedAt }) {
      const upd = {};
      const wantOrders = new Set();
      const wantRrs = new Set();
      for (const [dest, byPid] of Object.entries(shadowNode)) {
        for (const [pid, bySize] of Object.entries(byPid)) {
          for (const [sizeKey, s] of Object.entries(bySize)) {
            const p = products[pid] || {};
            if (!UNIVERSE_BY_SHOP[dest]) {
              // HUB legs (hub1 AND hub2) shadow as refill_requests rows in
              // their own queue tab — never as clothing-shaped store orders.
              // The pre-2026-08-25 predicate was `dest === "hub2"`, which sent
              // a hub1 shadow plan into the store Clothing queue as a bogus
              // order. hub2 keeps its historic key byte-for-byte; other hubs
              // get the dest in the key so two hubs can't collide on one
              // pid/size. The sweep's SHDWrr- prefix covers both formats.
              const key = dest === "hub2" ? `SHDWrr-${pid}-${sizeKey}` : `SHDWrr-${dest}-${pid}-${sizeKey}`;
              wantRrs.add(key);
              const existing = refillRequests[key];
              upd[`refill_requests/${key}`] = {
                // `size` is a raw-size FIELD, not a key — decode the half-size
                // ("5_5"→"5.5") so queue availability lookups and the UI match.
                productId: pid, size: sizeKey === "_" ? "" : String(sizeKey).replace(/(\d)_(\d)/g, "$1.$2"), qty: s.qty,
                requestingLocation: dest, status: "open", shadow: true,
                createdFrom: { engine: true, shadow: true, runId, source: s.source },
                createdAt: existing?.createdAt || startedAt,
              };
            } else {
              const key = `SHDW-${dest}-${pid}-${sizeKey}`;
              wantOrders.add(key);
              const existing = orders[key];
              const createdAt = existing?.createdAt || startedAt;
              upd[`orders/${key}`] = {
                id: key, productId: pid, productName: p.name || "Unknown",
                productPhoto: p.photo || null, productPhotoUrl: p.photoUrl ?? null,
                size: sizeKey === "_" ? "" : String(sizeKey).replace(/(\d)_(\d)/g, "$1.$2"), sentSize: null, qty: s.qty,
                customerName: "Shop Refill", customerPhone: null,
                hub: s.source, placedAtHub: s.source,
                placedStore: UNIVERSE_BY_SHOP[dest] || "central", destShop: dest,
                productType: "clothing", requestDisplay: false, requestDisplayPartner: false,
                status: "incoming", createdAt, updatedAt: startedAt,
                readyAt: null, outOfStockAt: null, comingTomorrowAt: null, collectedAt: null,
                displayRefillScheduledAt: null, displayRefillHub: null, displayRefillStatus: null,
                displayRefilledAt: null, displayRefillStockDepletedAt: null, displayRefilledBy: null,
                clothingRefillStatus: null, clothingRefilledAt: null, clothingOutOfStockAt: null,
                clothingRefilledBy: null,
                autoRefill: true, autoShadow: true, autoRefillPriority: s.priority, autoRefillRunId: runId,
              };
            }
          }
        }
      }
      // Delete stale shadow artifacts (fulfilled plans, live-flipped legs).
      for (const key of Object.keys(orders)) {
        if (key.startsWith("SHDW-") && !wantOrders.has(key)) upd[`orders/${key}`] = null;
      }
      for (const key of Object.keys(refillRequests)) {
        if (key.startsWith("SHDWrr-") && !wantRrs.has(key)) upd[`refill_requests/${key}`] = null;
      }
      return upd;
}

async function runScan() {
  const db = admin.database();
  const nowMs = Date.now();
  const runId = new Date(nowMs).toISOString().slice(0, 16).replace(/:/g, "-"); // 2026-07-12T10-15
  const startedAt = new Date(nowMs).toISOString();

  // ── claim (null-tolerant: cold-cache first pass sees null) ─────────────────
  const lockRef = db.ref("refill_engine/lock");
  const lockRes = await lockRef.transaction((cur) => {
    if (cur && nowMs - (cur.ts || 0) < LOCK_STEAL_MS) return; // held → abort
    return { ts: nowMs, runId };
  });
  if (!lockRes.committed || lockRes.snapshot.val()?.runId !== runId) return;

  const counts = { intents: 0, shadow: 0, closes: 0, exceptions: 0, errors: [] };
  try {
    const config = (await db.ref("config/refillEngine").once("value")).val();
    // ── scanIntervalMinutes IS NOT A DIAL ────────────────────────────────────
    // It has never been read by any code — cadence is owned by the schedule on
    // the exported function, which Cloud Scheduler enforces. Left in the
    // database it reads as the control for exactly the thing it cannot change,
    // which is how a 15-minute overnight cadence survived unquestioned.
    //
    // NOT wired up deliberately. Making it a live throttle would mean gating the
    // run on a persisted last-run time, and a misread there stops refill intents
    // being created at all — a silent outage of the thing that restocks shops,
    // traded for a dial whose job the schedule already does. The live control
    // that DOES exist and is honoured on every run is `enabled`.
    //
    // ACTION FOR THE OWNER: delete /config/refillEngine/scanIntervalMinutes in
    // the console. This warning exists so it cannot be forgotten quietly — a
    // code change cannot remove a database field.
    if (config && config.scanIntervalMinutes !== undefined) {
      console.warn(
        "refillHealthScan: /config/refillEngine/scanIntervalMinutes is DEAD and controls nothing " +
        `(value: ${JSON.stringify(config.scanIntervalMinutes)}). Cadence comes from the function's ` +
        "schedule (every 15 minutes from 07:00 to 19:00, Africa/Johannesburg). Delete the field."
      );
    }
    if (!config || config.enabled !== true) {
      await db.ref(`refill_engine/runs/${runId}`).set({ startedAt, skipped: "engine disabled" });
      return;
    }
    // RECEIVING SESSION (owner decision 2026-07-12 v6): while Central is
    // receiving/counting/distributing a supplier shipment, the engine stands
    // completely down — no requests, no shadow sync, no excess/exception
    // recalculation — so automation never interrupts the receiving process.
    // The first scan after the session closes recomputes everything fresh.
    const session = (await db.ref("receiving_session").once("value")).val();
    if (session?.active) {
      await db.ref(`refill_engine/runs/${runId}`).set({
        startedAt, skipped: `paused — receiving session open since ${session.openedAt || "?"}`,
      });
      return;
    }
    const locs = [...new Set([...Object.keys(config.routes || {}), ...Object.values(config.routes || {})])];
    // The ledger window must cover the LONGEST lookback that reads it — the
    // confidence score (30d) and the config-adjustable confirmed-out window —
    // else arrivals older than the window silently stop counting as lift
    // evidence and a size stays confirmed-out longer than configured.
    const windowDays = Math.max(MOVEMENTS_WINDOW_DAYS, (Number(config.confirmedOutDays) || 14) + 1);
    const windowStart = new Date(nowMs - windowDays * 864e5).toISOString();
    const [targetDecisions, targets, products, openIndex, refillRequests, orders, rejectStreak, retryState, heldLines, movementsSnap, ...stockSnaps] = await Promise.all([
      db.ref("stock_targets_decisions").once("value").then((s) => s.val() || {}),
      db.ref("stock_targets").once("value").then((s) => s.val() || {}),
      db.ref("products").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/open").once("value").then((s) => s.val() || {}),
      db.ref("refill_requests").once("value").then((s) => s.val() || {}),
      db.ref("orders").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/rejectStreak").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/retryState").once("value").then((s) => s.val() || {}),
      // Count-integrity hold lane: central→hub credits parked in transit until
      // the owner releases the box. computeRefillPlan counts them as INBOUND —
      // without this read every held cell double-orders (see refill-engine.cjs).
      db.ref("settings/stockHold/held").once("value").then((s) => s.val() || {}),
      db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value"),
      ...locs.map((l) => db.ref(`stock/${l}`).once("value").then((s) => [l, s.val() || {}])),
    ]);
    const stock = Object.fromEntries(stockSnaps);
    const movements = Object.values(movementsSnap.val() || {});

    const plan = engine.computeRefillPlan({
      nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements, targetDecisions, rejectStreak, retryState, heldLines,
    });
    counts.errors.push(...plan.errors);

    // ── apply closes ──────────────────────────────────────────────────────────
    // Lock removals are a plain bulk update, but refill_request statuses and
    // order deletions are CONDITIONAL transactions (review 2026-07-13): the
    // plan was computed from a snapshot that may be a minute old — a request
    // fulfilled or an order resolved in the meantime must never be clobbered
    // by a stale cancel/delete. A skipped conditional simply re-reconciles on
    // the next scan (stateless).
    if (plan.closes.length) {
      // ORDER OF OPERATIONS (Sonnet MEDIUM, 2026-07-13): for withdraw-type
      // closes the order transaction runs FIRST and is the decider — if it
      // bails (the card was touched by a fulfilment in the snapshot gap), the
      // request is NOT cancelled and the lock is NOT removed; the next scan
      // re-reconciles from truth. This keeps orders/{id} and
      // refill_requests/{id} from ever disagreeing about what happened.
      let applied = 0, withdrawn = 0;
      for (const c of plan.closes) {
        let proceed = true;
        if (c.removeOrderId) {
          try {
            const res = await db.ref(`orders/${c.removeOrderId}`).transaction((cur) => {
              if (!cur) return null;                                     // already gone — fine
              if (cur.clothingRefillStatus != null || cur.clothingPlanGen != null || !cur.autoRefill) return; // touched — abort
              return null;
            });
            proceed = res.committed;
          } catch { proceed = false; }
        }
        if (!proceed) continue;   // fulfilment won the race — leave rr + lock for the next scan
        if (c.refillId && c.rrStatus) {
          try {
            const res = await db.ref(`refill_requests/${c.refillId}`).transaction((cur) => {
              // NULL-TOLERANT (the #199 lesson, relearned 2026-07-13 the hard
              // way): the FIRST pass runs against the cold local cache and sees
              // null even when the node exists. Returning undefined there ABORTS
              // permanently — 2,304 statuses silently never wrote. Returning
              // null probes: a real node fails the compare and the callback
              // re-runs with true data; a genuinely-missing node no-ops.
              if (cur === null) return null;
              if (cur.status && cur.status !== "open") return;             // resolved meanwhile — leave it
              return { ...cur, status: c.rrStatus, resolvedAt: startedAt, ...(c.cancelReason ? { cancelReason: c.cancelReason } : {}) };
            });
            // The plan said "human reject", but the LIVE request resolved as
            // fulfilled in the snapshot gap (contradictory human actions in one
            // window): the fulfilment wins — never record a strike against a
            // request that was actually served; reset instead (fulfilment
            // resets, same as the fulfilled-close path).
            if (res && !res.committed && res.snapshot?.val()?.status === "fulfilled" && c.streakOp?.op === "inc") {
              c.streakOp = { op: "reset" };
            }
          } catch {
            // Transaction outcome unknown (network) — drop an inc rather than
            // risk a false strike; the reject, if real, recurs via the rr
            // branch on a later scan. Resets stay (benign either way).
            if (c.streakOp?.op === "inc") delete c.streakOp;
          }
        }
        // Lock removal + this close's streak op in ONE multi-path update: a
        // bailed close (proceed=false above) applies neither, and a lost
        // fulfilment-reset re-emerges with the close itself on the next scan
        // (the lock still exists) instead of being a one-shot event.
        const closeUpd = { [`refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}`]: null };
        if (c.streakOp) {
          closeUpd[`refill_engine/rejectStreak/${c.dest}/${c.pid}/${c.sizeKey}`] =
            c.streakOp.op === "inc" ? { count: c.streakOp.count, lastTs: c.streakOp.ts, by: c.streakOp.by || null } : null;
        }
        // Count what ACTUALLY landed. The run record is the audit trail read
        // during an incident — it must not assert closes that never happened.
        if (!(await safeUpdate(db, closeUpd, `close ${c.dest}/${c.pid}/${c.sizeKey}`))) continue;
        applied++;
        if (c.cancelReason) withdrawn++;
      }
      counts.closes = applied;
      if (withdrawn) counts.withdrawn = withdrawn;
    }

    // ── apply satisfied-by-stock withdrawals ─────────────────────────────────
    // The lock-less half of reconciliation (see the long note above
    // `satisfiedClosures` in refill-engine.cjs). These requests have NO entry in
    // /refill_engine/open, so this loop deliberately writes exactly ONE node
    // each — the request's own status. It must never touch
    // /refill_engine/open/{dest}/{pid}/{sizeKey}: some OTHER live lock may sit
    // on the same cell, and nulling it would strand a request the engine is
    // still waiting on.
    //
    // Same null-tolerant conditional transaction as the close path, and for the
    // same reason (#199): the first callback pass runs against a cold local
    // cache and sees null even when the node exists — returning `undefined`
    // there aborts permanently, which is how 2,304 status writes were once
    // silently lost. Returning null re-probes; a genuinely absent node no-ops.
    //
    // The `status === "open"` guard is the whole safety story for the race with
    // a picker: if Central fulfilled or rejected the request in the snapshot
    // gap, that write wins and this one stands down. The next scan re-decides
    // from truth, exactly like every other reconciliation here.
    if (plan.satisfiedClosures?.length) {
      // Half the function's apply budget, so a huge satisfied list can never
      // starve the intent loop that follows (which takes the other half).
      const r = await applySatisfied({
        db, closures: plan.satisfiedClosures, startedAt, deadlineMs: nowMs + 100e3,
      });
      if (r.satisfied) counts.satisfied = r.satisfied;
      // Reported so a run record never asserts a withdrawal that did not happen.
      if (r.stale) counts.satisfiedStale = r.stale;
      if (r.deferred) counts.satisfiedDeferred = r.deferred;
      counts.errors.push(...r.errors);
    }

    // ── apply the deficit-loop's self-heal streak resets ──────────────────────
    // (Close-derived ops ride inside each close's own update above.) These are
    // recomputed from live state every scan, so a lost write simply reappears.
    // Staff can also delete a streak from Health — "Recounted, ask again" —
    // via the delete-only rules carve-out on /refill_engine/rejectStreak.
    if (plan.streakOps && plan.streakOps.length) {
      // A cell whose close carried a streak op THIS scan must not also take a
      // snapshot-derived self-heal reset — the close's op (e.g. a fresh inc)
      // is newer truth and would be clobbered to null.
      const closedCells = new Set((plan.closes || []).filter((c) => c.streakOp).map((c) => `${c.dest}|${c.pid}|${c.sizeKey}`));
      const upd = {};
      for (const op of plan.streakOps) {
        if (closedCells.has(`${op.dest}|${op.pid}|${op.sizeKey}`)) continue;
        upd[`refill_engine/rejectStreak/${op.dest}/${op.pid}/${op.sizeKey}`] =
          op.op === "inc" ? { count: op.count, lastTs: op.ts, by: op.by || null } : null;
      }
      // Reported only when the write actually landed (see the close loop).
      const ok = Object.keys(upd).length ? await safeUpdate(db, upd, "streakOps") : true;
      counts.streakOps = ok ? Object.keys(upd).length : 0;
    }

    // ── apply resizes (owner approval 2026-07-13) ─────────────────────────────
    // Same identity, history preserved: the warehouse ORDER transaction decides
    // (bails on any touched/in-flight card — exactly the withdraw guard), then
    // the request and the lock follow. A bailed resize retries next scan.
    if (plan.resizes && plan.resizes.length) {
      const { resized, resizeDrops } = await applyResizes({
        db, resizes: plan.resizes, startedAt, setFn: safeSet,
      });
      if (resized) counts.resized = resized;
      // Same shape as `withdrawn` / `resized`: present only when non-zero, so a
      // clean run stays quiet and any value at all is a signal worth reading.
      if (Object.keys(resizeDrops).length) counts.resizeDropped = resizeDrops;
    }

    // ── apply retry ops (24h auto-retry) ──────────────────────────────────────
    // Retry state and history are recomputed from live state every scan, so a
    // lost write simply reappears on the next pass.
    if (plan.retryOps && plan.retryOps.length) {
      const upd = {};
      for (const op of plan.retryOps) {
        if (op.op === "reset") {
          upd[`refill_engine/retryState/${op.dest}/${op.pid}/${op.sizeKey}`] = null;
        } else if (op.op === "reject" || op.op === "retry") {
          // ONE shape for both ops — they write the SAME node, so drifting field
          // lists is exactly how the 2026-07-24 outage happened (the "retry"
          // branch omitted two fields the "reject" branch set). `?? null` keeps
          // every field defined even if a future op forgets one: RTDB accepts
          // null, and rejects undefined by throwing synchronously.
          upd[`refill_engine/retryState/${op.dest}/${op.pid}/${op.sizeKey}`] = {
            retryCount: op.retryCount ?? 0,
            firstRejectedAt: op.firstRejectedAt ?? null,
            lastRejectedAt: op.lastRejectedAt ?? null,
            lastRetryAt: op.lastRetryAt ?? null,
            nextRetryAt: op.nextRetryAt ?? null,
            lastRejectionReason: op.lastRejectionReason ?? null,
            source: op.source ?? null,
          };
        } else if (op.op === "history") {
          // epoch-ms in the key (NOT op.timestamp's ISO string — its "." is an
          // RTDB-forbidden key char that crashed every scan, 2026-07-22).
          const histKey = engine.retryHistoryKey(op.dest, op.pid, op.sizeKey, op.timestamp);
          upd[`refill_engine/retryHistory/${histKey}`] = {
            type: op.type ?? null,
            timestamp: op.timestamp ?? null,
            rejectionReason: op.rejectionReason ?? null,
            retryAttempt: op.retryAttempt ?? null,
            source: op.source ?? null,
            destination: op.destination ?? null,
            qty: op.qty ?? null,
          };
        }
      }
      const ok = Object.keys(upd).length ? await safeUpdate(db, upd, "retryOps") : true;
      counts.retryOps = ok ? plan.retryOps.length : 0;
    }

    // ── act on intents, by destination mode ──────────────────────────────────
    const shadowNode = {};
    const liveByDest = new Map();
    for (const intent of plan.intents) {
      const mode = config.mode?.[intent.dest] || "off";
      if (mode === "shadow") {
        ((shadowNode[intent.dest] ||= {})[intent.productId] ||= {})[intent.sizeKey] = {
          qty: intent.qty, source: intent.source, priority: intent.priority, runId, computedAt: startedAt,
        };
        counts.shadow++;
      } else if (mode === "live") {
        if (!liveByDest.has(intent.dest)) liveByDest.set(intent.dest, []);
        liveByDest.get(intent.dest).push(intent);
      }
    }
    // Shadow is a full replace each run, so satisfied plans disappear on their own.
    await safeSet(db, "refill_engine/shadow", Object.keys(shadowNode).length ? shadowNode : null, "shadow");

    // ── SHADOW COPIES in the REAL queues (owner decision 2026-07-12 v4) ───────
    // While a destination runs in shadow, its planned requests appear in the
    // actual operational surfaces — the warehouse Clothing queue and the Source
    // Hub 2 Refill queue — as read-only "AUTO (Shadow)" artifacts, so staff see
    // exactly how Live Mode will look. Deterministic keys make this a SYNC, not
    // an append: each scan upserts the current plan and deletes stale entries
    // (and any leg that flipped to live sheds its shadows automatically).
    //   store legs → /orders/SHDW-{dest}-{pid}-{sizeKey}   (autoShadow: true)
    //   hub2 legs  → /refill_requests/SHDWrr-{pid}-{sizeKey} (shadow: true)
    // Shadow orders carry NO insight events, take NO open locks, never touch
    // the refill counter, and the engine's inbound math ignores them
    // (autoRefill orders are excluded there). UI renders them read-only;
    // fulfillCRBatch refuses them outright as a second line of defence.
    {
      const upd = shadowSyncUpdates({ shadowNode, products, orders, refillRequests, runId, startedAt });
      if (Object.keys(upd).length) await safeUpdate(db, upd, "shadow sweep");
    }

    // TIME-BOXED apply (review 2026-07-13): creating intents is serial RTDB
    // I/O; an unbounded backlog (e.g. the first scan after a bulk target
    // migration computed 4,849 intents) would blow the 300s function timeout
    // mid-write. The engine is stateless — anything not applied this run is
    // simply re-proposed next scan — so stopping at a deadline loses nothing.
    const applyDeadlineMs = nowMs + 200e3;
    let applyDeferred = 0;
    applyLoop:
    for (const [dest, intents] of liveByDest) {
      const isStoreLeg = UNIVERSE_BY_SHOP[dest] != null;
      // ONE R-number per destination per run (mirrors "one R### per cart"), and
      // ONE shared createdAt per destination — the warehouse Clothing tab groups
      // cards by (product, destShop, createdAt), so a shared stamp makes all of
      // one product's sizes land on a single per-store card. Drawn LAZILY after
      // the first successful claim, so a run whose claims all lose never burns
      // a number (review 2026-07-13).
      let refillNum = null;
      const destCreatedAt = new Date().toISOString();
      let lineIdx = 0;
      for (const intent of intents) {
        if (Date.now() > applyDeadlineMs) {
          applyDeferred = plan.intents.length - counts.intents - counts.shadow;
          counts.errors.push(`apply time budget reached — ${applyDeferred} intents defer to the next scan`);
          break applyLoop;
        }
        const { productId: pid, sizeKey, size, qty, source } = intent;
        // Idempotency lock FIRST — create-if-absent; a concurrent/manual intent wins.
        const lockPath = `refill_engine/open/${dest}/${pid}/${sizeKey}`;
        const claim = await db.ref(lockPath).transaction((cur) => (cur ? undefined : {
          qty, source, createdAt: startedAt, runId, pending: true,
        }));
        if (!claim.committed || claim.snapshot.val()?.runId !== runId) continue;

        const rrKey = db.ref("refill_requests").push().key;
        const rr = {
          productId: pid, size, qty, requestingLocation: dest, status: "open",
          createdFrom: { engine: true, runId, source }, createdAt: startedAt,
        };
        let orderId = null, orderCreatedAt = null, order = null, insight = null;
        if (isStoreLeg) {
          if (!refillNum) refillNum = await drawRefillNumber(db, nowMs);
          lineIdx += 1;
          orderId = `${refillNum}-${lineIdx}`;
          orderCreatedAt = destCreatedAt;
          const p = products[pid] || {};
          // EXACT shape of placeRefillRequests' order node (App.jsx) + autoRefill
          // marker so the engine's inbound math can tell its own orders apart.
          order = {
            id: orderId, productId: pid, productName: p.name || "Unknown",
            productPhoto: p.photo || null, productPhotoUrl: p.photoUrl ?? null,
            size, sentSize: null, qty, customerName: "Shop Refill", customerPhone: null,
            hub: source, placedAtHub: source,
            placedStore: UNIVERSE_BY_SHOP[dest] || "central", destShop: dest,
            productType: "clothing", requestDisplay: false, requestDisplayPartner: false,
            status: "incoming", createdAt: orderCreatedAt, updatedAt: orderCreatedAt,
            readyAt: null, outOfStockAt: null, comingTomorrowAt: null, collectedAt: null,
            displayRefillScheduledAt: null, displayRefillHub: null, displayRefillStatus: null,
            displayRefilledAt: null, displayRefillStockDepletedAt: null, displayRefilledBy: null,
            clothingRefillStatus: null, clothingRefilledAt: null, clothingOutOfStockAt: null,
            clothingRefilledBy: null,
            autoRefill: true, autoRefillPriority: intent.priority, autoRefillRunId: runId,
          };
          insight = {
            timestamp: orderCreatedAt, productId: pid, productName: p.name || "Unknown",
            productCategory: p.category || "", productType: "clothing", size, qty,
            customerName: "Shop Refill", customerPhone: null, orderNumber: orderId,
            action: "placed", placedAtHub: source,
            // Engine-placed marker (review 2026-07-13): withdraw/recreate cycles
            // append new "placed" rows — analytics must be able to exclude
            // engine churn from human demand.
            autoRefill: true,
          };
        }
        // ONE atomic multi-path update per intent (review 2026-07-13): request,
        // order, insight and the finalized lock land together or not at all —
        // no window where a claimed lock points at nothing (the orphaned-
        // pending self-heal in the engine covers a crash before this line).
        const upd = {
          [`refill_requests/${rrKey}`]: rr,
          [lockPath]: { qty, source, createdAt: startedAt, runId, refillId: rrKey, orderId, orderCreatedAt },
        };
        if (order) {
          upd[`orders/${orderId}`] = order;
          upd[`insights_log/${db.ref("insights_log").push().key}`] = insight;
        }
        // strict: a malformed payload must NOT half-create an intent. Failing
        // here leaves the claimed lock pending-without-refillId, which the
        // engine's orphaned-pending self-heal reclaims after an hour, and the
        // deficit simply re-proposes — the stateless design absorbs it.
        if (await safeUpdate(db, upd, `intent ${intent.dest}/${intent.productId}/${intent.sizeKey}`, { strict: true })) {
          counts.intents++;
        }
      }
    }

    // ── exceptions snapshot + hourly confidence ──────────────────────────────
    counts.exceptions = Object.values(plan.exceptions).reduce((t, e) => t + e.count, 0);
    // Plan-side resize suppression (engine stats) — surfaced through the SAME
    // counts object as resizeDropped so both halves of the resize pipeline are
    // visible on one run record, present only when non-zero.
    if (plan.stats?.resizeSuppressed) counts.resizeSuppressed = plan.stats.resizeSuppressed;
    await safeSet(db, "stock_exceptions/latest", { computedAt: startedAt, runId, stats: plan.stats, ...plan.exceptions }, "exceptions snapshot");
    if (new Date(nowMs).getUTCMinutes() < 15) {
      const confidence = engine.computeConfidence({ nowMs, stock, movements, openIndex, products });
      await safeSet(db, "stock_confidence", { computedAt: startedAt, byLocation: confidence }, "confidence");
    }

    // ── run record + prune old runs (keys are time-sortable) ─────────────────
    await safeSet(db, `refill_engine/runs/${runId}`, {
      startedAt, finishedAt: new Date().toISOString(),
      mode: config.mode || {}, counts: { ...counts, errors: counts.errors.length ? counts.errors : null },
      policy: plan.policy || null,   // which switch/throttle state this run used
    }, "run record");
    const cutoffKey = new Date(nowMs - RUNS_KEEP_DAYS * 864e5).toISOString().slice(0, 16).replace(/:/g, "-");
    const oldRuns = await db.ref("refill_engine/runs").orderByKey().endAt(cutoffKey).limitToFirst(200).once("value");
    if (oldRuns.exists()) {
      const del = {};
      oldRuns.forEach((c) => { del[c.key] = null; });
      await db.ref("refill_engine/runs").update(del);
    }
    console.log("refillHealthScan:", JSON.stringify({ runId, ...counts, errors: counts.errors.length }));
  } catch (e) {
    console.error("refillHealthScan FAILED:", e);
    await db.ref(`refill_engine/runs/${runId}`).update({ startedAt, error: String(e.message || e) }).catch(() => {});
    throw e;
  } finally {
    // Release only our own lock — a stolen/newer lock stays.
    await lockRef.transaction((cur) => (cur && cur.runId === runId ? null : undefined)).catch(() => {});
  }
}

// ── CADENCE — trading hours only ─────────────────────────────────────────────
// Was "every 15 minutes", i.e. 96 runs/day. Each run snapshots the RTDB
// (stock_targets, products, refill_requests, orders, per-location stock, plus a
// 45-day stock_movements slice) — ~31 MB measured live on 2026-08-04, of which
// 14 MB is the ledger. Overnight that snapshot recomputes a picture that has not
// changed: movements between 19:00 and 07:00 SAST are 4.27% of all ledger
// activity, and once scripts and migrations are excluded, ~69 per night across
// 22 nights. Roughly a third of the daily cost bought nothing.
//
// 07:00 to 19:00 inclusive, every 15 minutes = 49 runs/day (was 96):
//   • 07:00      — morning sweep, before the 08:30 open, catches anything an
//                  evening transfer left behind
//   • 08:30–17:30 — trading; unchanged behaviour, still 15-minute cadence
//   • 17:30–19:00 — the catch-up window after close
//
// App Engine cron syntax ("every N minutes from HH:MM to HH:MM") is used rather
// than unix-cron because it is INCLUSIVE of the end time: `*/15 7-19 * * *`
// would also fire at 19:15/19:30/19:45, which is exactly the window we are
// closing. The previous value used the same syntax family ("every 15 minutes").
//
// timeZone is set EXPLICITLY: Cloud Scheduler defaults to UTC, which in SAST
// (UTC+2, no DST) would shift the whole window two hours and run the "morning
// sweep" at 09:00 local while leaving 05:00–07:00 uncovered.
//
// DEPLOY: scoped only — `firebase deploy --only functions:refillHealthScan`.
// A bare `--only functions` would touch the POS app's functions in this shared
// project (see the header note).
exports.refillHealthScan = onSchedule(
  {
    schedule: "every 15 minutes from 07:00 to 19:00",
    timeZone: "Africa/Johannesburg",
    region: "europe-west1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  runScan
);
exports._runScan = runScan; // exported for one-off manual invocation in tests/smoke
exports._resizeDropReason = resizeDropReason; // pure — unit-tested in test/resize-drop-observability.test.cjs
exports._applyResizes = applyResizes;      // db + writer injected — apply-path accounting is testable with a fake ref
exports._applySatisfied = applySatisfied;
exports._shadowSyncUpdates = shadowSyncUpdates; // pure — hub-leg vs store-leg shadow shape is testable without firebase-admin  // db injected — the satisfied-withdrawal apply path is testable without firebase-admin
