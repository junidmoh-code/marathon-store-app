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
    const windowStart = new Date(nowMs - MOVEMENTS_WINDOW_DAYS * 864e5).toISOString();
    const [targetDecisions, targets, products, openIndex, refillRequests, orders, movementsSnap, ...stockSnaps] = await Promise.all([
      db.ref("stock_targets_decisions").once("value").then((s) => s.val() || {}),
      db.ref("stock_targets").once("value").then((s) => s.val() || {}),
      db.ref("products").once("value").then((s) => s.val() || {}),
      db.ref("refill_engine/open").once("value").then((s) => s.val() || {}),
      db.ref("refill_requests").once("value").then((s) => s.val() || {}),
      db.ref("orders").once("value").then((s) => s.val() || {}),
      db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value"),
      ...locs.map((l) => db.ref(`stock/${l}`).once("value").then((s) => [l, s.val() || {}])),
    ]);
    const stock = Object.fromEntries(stockSnaps);
    const movements = Object.values(movementsSnap.val() || {});

    const plan = engine.computeRefillPlan({
      nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements, targetDecisions,
    });
    counts.errors.push(...plan.errors);

    // ── apply closes (lock removal + refill_request status) in one update ────
    if (plan.closes.length) {
      const upd = {};
      for (const c of plan.closes) {
        upd[`refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}`] = null;
        if (c.refillId && c.rrStatus) {
          upd[`refill_requests/${c.refillId}/status`] = c.rrStatus;
          upd[`refill_requests/${c.refillId}/resolvedAt`] = startedAt;
        }
      }
      await db.ref().update(upd);
      counts.closes = plan.closes.length;
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

    for (const [dest, intents] of liveByDest) {
      const isStoreLeg = UNIVERSE_BY_SHOP[dest] != null;
      // ONE R-number per destination per run (mirrors "one R### per cart"), and
      // ONE shared createdAt per destination — the warehouse Clothing tab groups
      // cards by (product, destShop, createdAt), so a shared stamp makes all of
      // one product's sizes land on a single per-store card.
      const refillNum = isStoreLeg && intents.length ? await drawRefillNumber(db, nowMs) : null;
      const destCreatedAt = new Date().toISOString();
      let lineIdx = 0;
      for (const intent of intents) {
        const { productId: pid, sizeKey, size, qty, source } = intent;
        // Idempotency lock FIRST — create-if-absent; a concurrent/manual intent wins.
        const lockPath = `refill_engine/open/${dest}/${pid}/${sizeKey}`;
        const claim = await db.ref(lockPath).transaction((cur) => (cur ? undefined : {
          qty, source, createdAt: startedAt, runId, pending: true,
        }));
        if (!claim.committed || claim.snapshot.val()?.runId !== runId) continue;

        const rrRef = db.ref("refill_requests").push();
        const rr = {
          productId: pid, size, qty, requestingLocation: dest, status: "open",
          createdFrom: { engine: true, runId, source }, createdAt: startedAt,
        };
        let orderId = null, orderCreatedAt = null;
        if (isStoreLeg) {
          lineIdx += 1;
          orderId = `${refillNum}-${lineIdx}`;
          orderCreatedAt = destCreatedAt;
          const p = products[pid] || {};
          // EXACT shape of placeRefillRequests' order node (App.jsx) + autoRefill
          // marker so the engine's inbound math can tell its own orders apart.
          const order = {
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
          await db.ref(`orders/${orderId}`).set(order);
          await db.ref("insights_log").push({
            timestamp: orderCreatedAt, productId: pid, productName: p.name || "Unknown",
            productCategory: p.category || "", productType: "clothing", size, qty,
            customerName: "Shop Refill", customerPhone: null, orderNumber: orderId,
            action: "placed", placedAtHub: source,
          });
        }
        await rrRef.set(rr);
        await db.ref(lockPath).update({ refillId: rrRef.key, orderId, orderCreatedAt, pending: null });
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
