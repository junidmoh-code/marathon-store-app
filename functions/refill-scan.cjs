// ─── REFILL HEALTH SCAN (Cloud Function I/O wrapper) ──────────────────────────
// Every 15 minutes: snapshot the RTDB, ask lib/refill-engine.cjs (pure, tested)
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
const MOVEMENTS_WINDOW_DAYS = 45;      // covers confidence (30d) + default-run gate (14d)
const RUNS_KEEP_DAYS = 7;

// Universe → placedStore string the app writes on refill orders.
const UNIVERSE_BY_SHOP = { "marathon-pe": "central", trophy: "central", "marathon-pine": "pine" };

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
    const [targetDecisions, targets, products, openIndex, refillRequests, orders, rejectStreak, retryState, movementsSnap, ...stockSnaps] = await Promise.all([
      db.ref("stock_targets_decisions").once("value").then((s) => s.val() || {}),
      db.ref("stock_targets").once("value").then((s) => s.val() || {}),
      db.ref("products").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/open").once("value").then((s) => s.val() || {}),
      db.ref("refill_requests").once("value").then((s) => s.val() || {}),
      db.ref("orders").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/rejectStreak").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/retryState").once("value").then((s) => s.val() || {}),
      db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value"),
      ...locs.map((l) => db.ref(`stock/${l}`).once("value").then((s) => [l, s.val() || {}])),
    ]);
    const stock = Object.fromEntries(stockSnaps);
    const movements = Object.values(movementsSnap.val() || {});

    const plan = engine.computeRefillPlan({
      nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements, targetDecisions, rejectStreak, retryState,
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
        await db.ref().update(closeUpd).catch(() => {});
        applied++;
        if (c.cancelReason) withdrawn++;
      }
      counts.closes = applied;
      if (withdrawn) counts.withdrawn = withdrawn;
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
      if (Object.keys(upd).length) await db.ref().update(upd).catch(() => {});
      counts.streakOps = Object.keys(upd).length;
    }

    // ── apply resizes (owner approval 2026-07-13) ─────────────────────────────
    // Same identity, history preserved: the warehouse ORDER transaction decides
    // (bails on any touched/in-flight card — exactly the withdraw guard), then
    // the request and the lock follow. A bailed resize retries next scan.
    if (plan.resizes && plan.resizes.length) {
      let resized = 0;
      for (const rz of plan.resizes) {
        let proceed = true;
        if (rz.orderId) {
          try {
            const r = await db.ref(`orders/${rz.orderId}`).transaction((cur) => {
              if (cur === null) return null;                                 // cold-cache probe (null-tolerant)
              if (cur.clothingRefillStatus != null || cur.clothingPlanGen != null || !cur.autoRefill) return; // in-flight/touched
              return { ...cur, qty: rz.to, updatedAt: startedAt };
            });
            proceed = r.committed && r.snapshot.exists();                    // vanished order → let the close path own it
          } catch { proceed = false; }
        }
        if (!proceed) continue;
        // The rr transaction is the decider for its own node (review
        // 2026-07-13): if it bails — resolved concurrently, e.g. Hub 2 legs
        // fulfilled between plan and apply — the lock is NOT touched and the
        // resize does NOT count. resizedFrom comes from the authoritative
        // in-transaction value, never the planning snapshot.
        if (rz.refillId) {
          let ok = false;
          try {
            const r2 = await db.ref(`refill_requests/${rz.refillId}`).transaction((cur) => {
              if (cur === null) return null;                                 // probe
              if (cur.status !== "open") return;
              return { ...cur, qty: rz.to, resizedAt: startedAt, resizedFrom: cur.qty ?? rz.from };
            });
            ok = r2.committed && r2.snapshot.exists() && r2.snapshot.val()?.qty === rz.to;
          } catch { ok = false; }
          if (!ok) continue;
        }
        await db.ref(`refill_engine/open/${rz.dest}/${rz.pid}/${rz.sizeKey}/qty`).set(rz.to).catch(() => {});
        resized++;
      }
      if (resized) counts.resized = resized;
    }

    // ── apply retry ops (24h auto-retry) ──────────────────────────────────────
    // Retry state and history are recomputed from live state every scan, so a
    // lost write simply reappears on the next pass. Wrapped so a single bad op
    // can never abort the scan (C1 review finding).
    if (plan.retryOps && plan.retryOps.length) {
      let applied = 0;
      for (const op of plan.retryOps) {
        try {
          if (op.op === "reset") {
            await db.ref(`refill_engine/retryState/${op.dest}/${op.pid}/${op.sizeKey}`).set(null);
          } else if (op.op === "reject") {
            await db.ref(`refill_engine/retryState/${op.dest}/${op.pid}/${op.sizeKey}`).set({
              retryCount: op.retryCount,
              firstRejectedAt: op.firstRejectedAt || null,
              lastRejectedAt: op.lastRejectedAt || null,
              lastRetryAt: op.lastRetryAt || null,
              nextRetryAt: op.nextRetryAt,
              lastRejectionReason: op.lastRejectionReason,
              source: op.source || null,
            });
          } else if (op.op === "retry") {
            await db.ref(`refill_engine/retryState/${op.dest}/${op.pid}/${op.sizeKey}`).set({
              retryCount: op.retryCount,
              firstRejectedAt: op.firstRejectedAt || null,
              lastRejectedAt: op.lastRejectedAt || null,
              lastRetryAt: op.lastRetryAt,
              nextRetryAt: op.nextRetryAt,
              lastRejectionReason: op.lastRejectionReason,
              source: op.source || null,
            });
          } else if (op.op === "history") {
            // Sanitize: RTDB keys can't contain . # $ / [ ] — use a push key.
            const histRef = db.ref(`refill_engine/retryHistory/${op.dest}/${op.pid}/${op.sizeKey}`).push();
            await histRef.set({
              type: op.type,
              timestamp: op.timestamp,
              rejectionReason: op.rejectionReason,
              retryAttempt: op.retryAttempt,
              source: op.source,
              destination: op.destination,
              qty: op.qty,
            });
          }
          applied++;
        } catch (e) {
          console.error(`retryOp ${op.op} failed for ${op.dest}/${op.pid}/${op.sizeKey}:`, e);
        }
      }
      counts.retryOps = applied;
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
    await db.ref("refill_engine/shadow").set(Object.keys(shadowNode).length ? shadowNode : null);

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
      const upd = {};
      const wantOrders = new Set();
      const wantRrs = new Set();
      for (const [dest, byPid] of Object.entries(shadowNode)) {
        for (const [pid, bySize] of Object.entries(byPid)) {
          for (const [sizeKey, s] of Object.entries(bySize)) {
            const p = products[pid] || {};
            if (dest === "hub2") {
              const key = `SHDWrr-${pid}-${sizeKey}`;
              wantRrs.add(key);
              const existing = refillRequests[key];
              upd[`refill_requests/${key}`] = {
                productId: pid, size: sizeKey === "_" ? "" : sizeKey, qty: s.qty,
                requestingLocation: "hub2", status: "open", shadow: true,
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
                size: sizeKey === "_" ? "" : sizeKey, sentSize: null, qty: s.qty,
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
      if (Object.keys(upd).length) await db.ref().update(upd);
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
        await db.ref().update(upd);
        counts.intents++;
      }
    }

    // ── exceptions snapshot + hourly confidence ──────────────────────────────
    counts.exceptions = Object.values(plan.exceptions).reduce((t, e) => t + e.count, 0);
    await db.ref("stock_exceptions/latest").set({ computedAt: startedAt, runId, stats: plan.stats, ...plan.exceptions });
    if (new Date(nowMs).getUTCMinutes() < 15) {
      const confidence = engine.computeConfidence({ nowMs, stock, movements, openIndex, products });
      await db.ref("stock_confidence").set({ computedAt: startedAt, byLocation: confidence });
    }

    // ── run record + prune old runs (keys are time-sortable) ─────────────────
    await db.ref(`refill_engine/runs/${runId}`).set({
      startedAt, finishedAt: new Date().toISOString(),
      mode: config.mode || {}, counts: { ...counts, errors: counts.errors.length ? counts.errors : null },
    });
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

exports.refillHealthScan = onSchedule(
  { schedule: "every 15 minutes", region: "europe-west1", timeoutSeconds: 300, memory: "512MiB" },
  runScan
);
exports._runScan = runScan; // exported for one-off manual invocation in tests/smoke
