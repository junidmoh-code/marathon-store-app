// ─── STOCK AUDIT — the once-a-day I/O pass ───────────────────────────────────
//
// refillHealthScan runs every 15 minutes and already snapshots stock, products,
// refill_requests and 45 days of movements. This pass rides on that snapshot:
// once per SA day, on the first run at or after 07:00, it hands the data the
// run ALREADY HOLDS to lib/stock-audit.cjs and writes two small render caches.
// Nothing here re-reads anything the scan read.
//
// WHAT IT DOES COST, exactly and by design (measured on live data 2026-09-08):
//
//   EVERY RUN (48/day)   settings/stockAudit/config      ~250 B   the kill switch
//   THE DAILY PASS ONLY  settings/stockAudit/state       ~200 B   the date guard
//                        settings/stockAudit/rotation/*  ~120 KB  the check stamps
//                        displayChecks_active/* (SHALLOW)  58 KB  keys only
//                        settings/stockAudit/*/results (SHALLOW)  ~1 KB  prune
//
// The two shallow reads are REST `?shallow=true` calls, the same discipline as
// scripts/lib/rtdbPaged.mjs: displayChecks_active is ~1.8 MB of photo URLs and
// applied-movement maps across the two stores, and the only question this
// feature asks of it is "is a display registered for this product/size", which
// the KEY answers on its own. Reading the bodies would cost 30x for nothing.
//
// KILL SWITCH: /settings/stockAudit/config/enabled. Absent or false is today's
// behaviour exactly — one tiny read, no writes, no computation, and no deploy
// needed to switch the feature off.
//
// EVERY WRITE IS RECOMPUTED FROM LIVE STATE ON THE NEXT PASS, so a failure here
// must never take the refill scan down: the caller wraps this in a try/catch
// and the scan continues. That is the same resilience contract safeUpdate has.

"use strict";

const audit = require("../lib/stock-audit.cjs");

const CONFIG_PATH = "settings/stockAudit/config";
const STATE_PATH = "settings/stockAudit/state";
// How many days of completed check results to keep under
// /settings/stockAudit/{store}/results. The real audit trail is
// /stock_movements (adjustments) — these day nodes are the card's memory of
// which rows were already actioned, and they are worthless once the day is
// long past. Pruned on the pass so the node cannot grow without bound.
const RESULTS_KEEP_DAYS = 60;

// REST shallow key read. The Admin SDK has no shallow mode, and a key list must
// not cost the node's full weight. The OAuth token travels in the header, never
// the query string (query strings leak into logs) — the rule scripts/lib
// established and the reason that helper exists.
// BOUNDED, because this is the only call in the pass that is not the Admin SDK.
// `fetch` has no default timeout: a stalled connection hangs forever, and this
// runs INSIDE refillHealthScan while it holds the engine's exclusive run lock.
// A hang would burn the function's whole invocation, let the 10-minute lock
// steal fire, and let a second run start against state the first still thinks
// it owns — the audit's cheapest read taking down the thing that restocks the
// shops. The timeout lands on the per-store failure path like any other error:
// the list is still built, the display signal reads "unavailable", and the
// screen says so. (CodeRabbit, PR #580.)
const SHALLOW_TIMEOUT_MS = 15e3;

async function restShallowKeys(app, path) {
  const token = await app.options.credential.getAccessToken();
  const res = await fetch(`${app.options.databaseURL}/${path}.json?shallow=true`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    // Covers the response body too, not just the connection: a server that
    // sends headers and then stalls mid-body is the same hang.
    signal: AbortSignal.timeout(SHALLOW_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`shallow read of /${path} failed: ${res.status}`);
  const val = await res.json();
  return val ? Object.keys(val) : [];
}

// Day keys older than the cutoff, from a shallow key list. Pure so the cutoff
// arithmetic is testable without a database.
function prunableResultDays(keys, saDate, keepDays) {
  const cutoff = new Date(`${saDate}T00:00:00.000Z`).getTime() - keepDays * 864e5;
  return (keys || []).filter((k) => {
    const t = Date.parse(`${k}T00:00:00.000Z`);
    return Number.isFinite(t) && t < cutoff;
  });
}

// ── the pass ─────────────────────────────────────────────────────────────────
// Injected: `db` (Admin RTDB), `app` (for the shallow token), the scan's live
// snapshot, and the scan's own `setFn`/`updFn` writers so every write here goes
// through the same sanitizer that two live outages bought.
//
// Returns a small record for the run log — never throws for a data problem, and
// never returns without saying what it decided.
async function runStockAuditPass({
  db, app, nowMs, stock, products, refillRequests, movements, routes,
  setFn, updFn, shallowKeys = restShallowKeys, log = console,
}) {
  // 1. The kill switch. One tiny read on every run — the price of being able to
  //    switch the whole feature off from the console without a deploy.
  const cfg = audit.auditConfig((await db.ref(CONFIG_PATH).once("value")).val());
  if (!cfg.enabled) return { skipped: "disabled" };

  // 2. The hour gate is free (a clock read), so it comes before the date read.
  if (audit.saHour(nowMs) < cfg.passHour) return { skipped: "before_pass_hour" };

  const state = (await db.ref(STATE_PATH).once("value")).val() || {};
  const gate = audit.shouldRunDailyPass({ nowMs, lastPassDate: state.lastPassDate, passHour: cfg.passHour });
  if (!gate.run) return { skipped: gate.why };
  const { saDate } = gate;

  // 3. CLAIM THE DAY BEFORE DOING THE WORK. The scan holds an exclusive run
  //    lock, so two passes cannot overlap today — but a run that crashes AFTER
  //    the snapshot writes and BEFORE the stamp would recompute the whole pass
  //    every 15 minutes for the rest of the day. Stamping first makes the pass
  //    at-most-once: a crash costs one day's lists, not a loop. The lists are
  //    a render cache, so a lost day is recoverable and a loop is not.
  //
  //    A transaction, not a set: null-tolerant (the first pass against a cold
  //    cache sees null) and it refuses to overwrite a stamp another writer just
  //    made, which is the only way two writers could both think they own today.
  const claim = await db.ref(`${STATE_PATH}/lastPassDate`).transaction((cur) => {
    if (cur === saDate) return;                 // someone else owns today — abort
    return saDate;
  });
  if (!claim.committed) return { skipped: "claimed_elsewhere" };

  const written = [];
  for (const store of audit.AUDIT_STORES) {
    try {
      // The feature's own state, and the display keys. Scoped to this store,
      // and only reached on a day the pass actually runs.
      const [rotationState, displayKeys, resultDays] = await Promise.all([
        db.ref(`settings/stockAudit/rotation/${store}`).once("value").then((s) => s.val() || {}),
        shallowKeys(app, `displayChecks_active/${store}`).catch((e) => {
          // A display signal that cannot be read must not cost the whole list.
          // The rows still carry the sold signal and the quantities; `disp`
          // simply reads false, which the card labels honestly rather than
          // presenting as "no display registered".
          log.error(`[stock-audit] ${store}: display keys unavailable — ${e && e.message ? e.message : e}`);
          return null;
        }),
        // Swallowing this one entirely was wrong: pruning is the only thing
        // that bounds the results node, so a read failing in silence means it
        // grows for years and nobody is told. It still must not cost the list.
        shallowKeys(app, `settings/stockAudit/${store}/results`).catch((e) => {
          log.error(`[stock-audit] ${store}: results prune skipped — ${e && e.message ? e.message : e}`);
          return [];
        }),
      ]);

      const snapshot = audit.buildStoreSnapshot({
        store, nowMs, cfg, saDate,
        stock, products, refillRequests, movements, routes,
        rotationState,
        displayKeys: displayKeys || [],
        // The batch that is currently up. buildRotation keeps it on a
        // non-rotation day and mints a fresh one on Mon/Wed/Fri.
        prevBatchPids: state.batch?.[store]?.pids || null,
        // When the standing batch was minted. A product stamped at or after
        // this has been walked FOR THIS BATCH and drops off the list — the
        // per-day results node cannot say that, because a carried batch
        // outlives the day it was checked on.
        prevBatchAt: state.batch?.[store]?.at || 0,
      });
      // Say so on the record rather than letting a false read as a fact.
      snapshot.displaySignal = displayKeys ? "ok" : "unavailable";

      // The batch identity is the PASS's state, not the card's. Lifted off the
      // snapshot before the write so /latest stays exactly what the screen
      // renders and nothing else.
      const { batchPids, batchAt, ...rendered } = snapshot;

      const ok = await setFn(db, `settings/stockAudit/${store}/latest`, rendered, `stock-audit ${store} snapshot`);
      if (ok) written.push(store);

      const upd = {
        [`${STATE_PATH}/batch/${store}`]: { date: rendered.rotation.batchDate, at: batchAt, pids: batchPids },
      };
      for (const day of prunableResultDays(resultDays, saDate, RESULTS_KEEP_DAYS)) {
        upd[`settings/stockAudit/${store}/results/${day}`] = null;
      }
      await updFn(db, upd, `stock-audit ${store} state`);
    } catch (e) {
      // One store's failure must not cost the other's list, and neither may
      // cost the refill scan.
      log.error(`[stock-audit] ${store}: pass failed —`, e && e.message ? e.message : e);
    }
  }
  return { saDate, stores: written };
}

module.exports = { runStockAuditPass, prunableResultDays, restShallowKeys, CONFIG_PATH, STATE_PATH, RESULTS_KEEP_DAYS, SHALLOW_TIMEOUT_MS };
