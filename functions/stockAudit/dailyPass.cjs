// ─── STOCK AUDIT — the once-a-day I/O pass ───────────────────────────────────
//
// refillHealthScan runs every 15 minutes and already snapshots /orders, /stock,
// /products and 45 days of movements. This pass rides on that snapshot: once
// per SA day, on the first run at or after 07:00, it hands the data the run
// ALREADY HOLDS to lib/stock-audit.cjs and writes small render caches — one
// per hub for the sneaker out-of-stock checks, one per shop for the clothing
// rotation. Nothing here re-reads anything the scan read.
//
// WHAT IT COSTS, exactly (measured on live data 2026-09-08):
//
//   EVERY RUN (48/day)   settings/stockAudit/config      ~250 B   the kill switch
//   THE DAILY PASS ONLY  settings/stockAudit/state       ~200 B   the date guard
//                        settings/stockAudit/rotation/*  ~90 KB   the check stamps
//                        settings/stockAudit/*/results (SHALLOW)  ~2 KB  prune
//
// That is the whole bill: roughly 90 KB a day against the scan's existing
// ~1.5 GB a month. There is no read of /displayChecks_active any more — the
// display signal it fed is gone with the clothing half of Tab A, and with it
// the only expensive read this feature ever proposed.
//
// KILL SWITCH: /settings/stockAudit/config/enabled. Absent or false is today's
// behaviour exactly — one tiny read, no writes, no computation, and no deploy
// needed to switch the feature off.
//
// EVERY WRITE IS RECOMPUTED FROM LIVE STATE ON THE NEXT PASS, so a failure here
// must never take the refill scan down: the caller wraps this in a try/catch
// and the scan continues. Same resilience contract safeUpdate has.

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
  db, app, nowMs, stock, products, orders, movements,
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

  // ── the hubs: sneaker lines a customer was turned away from ───────────────
  // Pure from the snapshot — /orders, /stock and /products are all in memory,
  // so a hub list costs one write and no read at all.
  for (const hub of audit.AUDIT_HUBS) {
    try {
      const snapshot = audit.buildHubSnapshot({ hub, nowMs, cfg, saDate, stock, products, orders });
      if (await setFn(db, `settings/stockAudit/hub/${hub}/latest`, snapshot, `stock-audit ${hub} snapshot`)) {
        written.push(hub);
      }
      const resultDays = await shallowKeys(app, `settings/stockAudit/hub/${hub}/results`).catch((e) => {
        log.error(`[stock-audit] ${hub}: results prune skipped — ${e && e.message ? e.message : e}`);
        return [];
      });
      const upd = {};
      for (const day of prunableResultDays(resultDays, saDate, RESULTS_KEEP_DAYS)) {
        upd[`settings/stockAudit/hub/${hub}/results/${day}`] = null;
      }
      if (Object.keys(upd).length) await updFn(db, upd, `stock-audit ${hub} prune`);
    } catch (e) {
      // One hub's failure must not cost the others, and none of them may cost
      // the refill scan.
      log.error(`[stock-audit] ${hub}: pass failed —`, e && e.message ? e.message : e);
    }
  }

  // ── the shops: the clothing rotation ──────────────────────────────────────
  for (const store of audit.AUDIT_STORES) {
    try {
      const [rotationState, resultDays] = await Promise.all([
        db.ref(`settings/stockAudit/rotation/${store}`).once("value").then((s) => s.val() || {}),
        shallowKeys(app, `settings/stockAudit/${store}/results`).catch((e) => {
          // Pruning is the only thing bounding the results node, so a read
          // failing in silence means it grows for years and nobody is told.
          log.error(`[stock-audit] ${store}: results prune skipped — ${e && e.message ? e.message : e}`);
          return [];
        }),
      ]);

      const snapshot = audit.buildStoreSnapshot({
        store, nowMs, cfg, saDate, stock, products, movements,
        rotationState,
        prevBatchPids: state.batch?.[store]?.pids || null,
        // When the standing batch was minted. A product stamped at or after
        // this has been walked FOR THIS BATCH and drops off the list — the
        // per-day results node cannot say that, because a carried batch
        // outlives the day it was checked on.
        prevBatchAt: state.batch?.[store]?.at || 0,
      });

      // The batch identity is the PASS's state, not the card's. Lifted off the
      // snapshot before the write so /latest stays exactly what the screen
      // renders and nothing else.
      const { batchPids, batchAt, ...rendered } = snapshot;

      if (await setFn(db, `settings/stockAudit/${store}/latest`, rendered, `stock-audit ${store} snapshot`)) {
        written.push(store);
      }

      const upd = {
        [`${STATE_PATH}/batch/${store}`]: { date: rendered.rotation.batchDate, at: batchAt, pids: batchPids },
      };
      for (const day of prunableResultDays(resultDays, saDate, RESULTS_KEEP_DAYS)) {
        upd[`settings/stockAudit/${store}/results/${day}`] = null;
      }
      await updFn(db, upd, `stock-audit ${store} state`);
    } catch (e) {
      log.error(`[stock-audit] ${store}: pass failed —`, e && e.message ? e.message : e);
    }
  }

  return { saDate, wrote: written };
}

module.exports = { runStockAuditPass, prunableResultDays, restShallowKeys, CONFIG_PATH, STATE_PATH, RESULTS_KEEP_DAYS, SHALLOW_TIMEOUT_MS };
