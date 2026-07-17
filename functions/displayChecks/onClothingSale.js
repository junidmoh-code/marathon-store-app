// ─── DISPLAY CHECKS — onClothingSale TRIGGER (PR 2: writes only, no UI) ───────
// Gen-2 RTDB onCreate on /stock_movements/{movementId}. A clothing `sold`
// movement at an enabled store becomes (or bumps) a display check in today's
// day node, with an append-only audit event per state change. DORMANT by
// design: nothing reads these namespaces yet (the PR-1 shell is dark) — the
// point of shipping the trigger first is to let its output run for a few days
// and compare it against the floor (design §15) before any staff-facing UI.
//
// SALE SOURCE — PROVEN, not assumed: /stock_movements `type === "sold"`,
// one movement per (sale, product, size) cell, `from` = selling shop, `qty` =
// units. Two-source proof against /pos/sales (PE, 2026-07-16: 106 = 106 units,
// zero unit residual): docs/display-checks-sale-source.md.
//
// WRITE SURFACE — displayChecks* ONLY:
//   /displayChecks/{store}/{saDate}/{checkId}            the check
//   /displayChecks_log/{store}/{YYYY-MM}/{eventId}       append-only audit
//   /displayChecks_meta/{store}/{saDate}/processed/{movementId}   idempotency
//   /displayChecks_meta/{store}/{saDate}/active/{dedupeKey}       create-mutex
// Reads existing data only (/products, /stock, /displayChecks_settings).
// NOTHING in POS / warehouse / refill / inventory logic changes.
//
// IDEMPOTENCY — RTDB triggers are at-least-once; a double-fire must not double-
// create or double-bump. Same pattern as applyMovement (src/components/stock/
// applyMovement.js:21,87 — "the movement id is the idempotency key; if it
// already exists, idempotent no-op", reused by transferDraft and the Hub2
// refill retry): the movementId is claimed in a TRANSACTION on
// …/processed/{movementId} before any write; a second fire loses the claim and
// exits. Counter bumps are transactions, never read-then-write.
//
// CREATE-MUTEX — TTL, SELF-EXPIRING (no external release, no PR-7 obligation):
// …/meta/active/{dedupeKey} closes only the concurrent-create window (two
// tills, same SKU, same seconds — both executions read an empty day node
// before either wrote). Entries expire by CREATE_MUTEX_TTL_MS (120s) inside
// the claim transaction itself; nothing anywhere has to clear them. A stuck
// entry can cost at most one TTL of mutex-level dedupe — it can never block a
// SKU permanently. The non-concurrent case never touches the mutex at all:
// the day-node scan finds the open/held check and bumps it. A fresh entry
// pointing at a COMPLETED check is also claimable (completed checks are
// immutable — a bump must never land on one). See mutexClaimDecision in
// lib.cjs, with tests.
//
// DEPLOY (Junid only; scoped — NEVER bare --only functions, POS shares this
// project):  firebase deploy --only functions:onClothingSale

"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const {
  isTriggerStoreEnabled,
  isClothingSale,
  stockSizeKey,
  saDateStringFromMs,
  saMonthOfDate,
  dedupeKey,
  resolveSale,
  resolveAssignment,
  buildNewCheck,
  mutexClaimDecision,
  completedIdsOf,
} = require("./lib.cjs");

// index.js initialises admin at module scope; guard for standalone imports
// (tests, emulator) exactly like the other function modules.
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// One audit event, appended under the SA month of the day node (§4.2). Written
// server-side only; `actor` marks the machine, mirroring the design's
// system-written event types.
function logEvent(updates, db, store, saDate, { checkId, type, at, payload }) {
  const eventId = db.ref(`displayChecks_log/${store}`).push().key;
  updates[`displayChecks_log/${store}/${saMonthOfDate(saDate)}/${eventId}`] = {
    checkId: checkId || null,
    type,
    at,
    actor: { uid: "system:onClothingSale", name: "onClothingSale" },
    ...(payload ? { payload } : {}),
  };
}

// Bump an existing check: saleCount += qty via TRANSACTION (at-least-once safe
// against concurrent bumps; the idempotency claim already blocked double-fires
// of the SAME movement), then lastSoldAt + the audit event. lastSoldAt is a
// plain update — latest write wins is correct for "when did it last sell".
async function bumpCheck(db, { store, saDate, checkId, qty, movementId, movementTs, logType, stockQty, nowMs }) {
  await db.ref(`displayChecks/${store}/${saDate}/${checkId}/saleCount`)
    .transaction((c) => (Number(c) || 0) + qty);
  const updates = {};
  updates[`displayChecks/${store}/${saDate}/${checkId}/lastSoldAt`] = movementTs || null;
  logEvent(updates, db, store, saDate, {
    checkId,
    type: logType,
    at: nowMs,
    payload: {
      movementId,
      qty,
      // held_resale is LOUD on purpose: the till just sold something inventory
      // says isn't there. stockQty captures what /stock said at that moment —
      // the evidence a human needs to chase the stock bug. Never silenced,
      // never "fixed" here, never a new check.
      ...(logType === "held_resale" ? { stockQty: stockQty ?? null } : {}),
    },
  });
  await db.ref().update(updates);
}

exports.onClothingSale = onValueCreated(
  {
    ref: "/stock_movements/{movementId}",
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const m = event.data.val();
    if (!m || typeof m !== "object") return;

    // ── Early returns, cheapest first (this fires on EVERY stock movement) ──
    // 1. per-store flag (also drops hub/central/non-shop `from` values)
    const store = m.from;
    if (!isTriggerStoreEnabled(store)) return;
    // 2. not a sale-type movement (transfers/receiving/adjustments/returns out)
    if (m.type !== "sold") return;
    // 3. not clothing — first read: ONE product get (also feeds denormalisation)
    if (!m.productId) return;
    const productSnap = await admin.database().ref(`products/${m.productId}`).get();
    const product = productSnap.val();
    if (!isClothingSale(product, m.size)) return;

    const db = admin.database();
    const movementId = event.params.movementId;
    const nowMs = Date.now();
    // Day node anchored on SERVER receipt time, not the till-clock ts — the
    // order-counter TZ incident (#236/#237, tills 24h behind) is the failure
    // mode this avoids. The movement ts still lands on the check verbatim.
    const saDate = saDateStringFromMs(nowMs);
    const qty = Math.max(1, Number(m.qty) || 1);
    const key = dedupeKey(m.productId, m.size);
    const saleId = (m.link && m.link.saleId) || null;

    // ── Idempotency claim (applyMovement pattern): movementId is the key ──
    const claim = await db
      .ref(`displayChecks_meta/${store}/${saDate}/processed/${movementId}`)
      .transaction((cur) => (cur === null ? nowMs : undefined));
    if (!claim.committed) return; // double-fire — already handled

    // ── Resolve against today's day node (≤ ~25KB, §4.1 sizing) ──
    const daySnap = await db.ref(`displayChecks/${store}/${saDate}`).get();
    const dayNode = daySnap.val();
    const resolution = resolveSale(dayNode, key, nowMs);

    if (resolution.kind === "bump") {
      // held_resale carries the stock cell's current qty as evidence.
      let stockQty = null;
      if (resolution.logType === "held_resale") {
        const q = await db.ref(`stock/${store}/${m.productId}/${stockSizeKey(m.size)}/qty`).get();
        stockQty = q.val();
      }
      await bumpCheck(db, {
        store, saDate, checkId: resolution.checkId, qty,
        movementId, movementTs: m.ts || null,
        logType: resolution.logType, stockQty, nowMs,
      });
      return;
    }

    // ── Create path: claim the per-key create-mutex (TTL, self-expiring) ──
    // Two concurrent movements of the same SKU race here; the transaction lets
    // exactly one create. The loser sees the winner's fresh entry and bumps
    // that checkId instead (its own idempotency claim already succeeded, so
    // this is its one and only handling of that movement). Entries expire by
    // TTL inside the claim itself and a fresh entry pointing at a completed
    // check is claimable — see mutexClaimDecision (lib.cjs) for the rules.
    const newCheckId = db.ref(`displayChecks/${store}/${saDate}`).push().key;
    const completedIds = completedIdsOf(dayNode);
    const mutex = await db
      .ref(`displayChecks_meta/${store}/${saDate}/active/${key}`)
      .transaction((cur) => mutexClaimDecision({ cur, nowMs, newCheckId, completedIds }));
    if (!mutex.committed) {
      const winner = mutex.snapshot.val();
      if (winner && winner.checkId) {
        await bumpCheck(db, {
          store, saDate, checkId: winner.checkId, qty,
          movementId, movementTs: m.ts || null,
          logType: "sale_bumped", stockQty: null, nowMs,
        });
      }
      return;
    }

    // ── open vs held: ONE stock-cell get (Phase 0-proven path) ──
    const qtySnap = await db.ref(`stock/${store}/${m.productId}/${stockSizeKey(m.size)}/qty`).get();
    const stockQty = Number(qtySnap.val());
    const status = stockQty > 0 ? "open" : "held";

    // Assignment (open only): cover → locked roster → null. Resolved NOW,
    // frozen onto the check, never recomputed (design §3.3). Both nodes are
    // absent until PR 11 seeds them — the resolver order is already real.
    let assignedTo = null;
    if (status === "open") {
      const [coverSnap, rosterSnap] = await Promise.all([
        db.ref(`displayChecks_settings/${store}/cover/${saDate}`).get(),
        db.ref(`displayChecks_settings/${store}/roster`).get(),
      ]);
      assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
    }

    const check = buildNewCheck({
      productId: m.productId, product, rawSize: m.size, key,
      movementId, saleId, movementTs: m.ts || null, qty,
      status, assignedTo, repeat: resolution.repeat, nowMs,
    });

    // Check + its audit events land in ONE multi-path update (§13: state change
    // and log event in the same operation). PER-FIELD paths, not a node set —
    // a mutex-losing concurrent sale may already have transaction-bumped
    // saleCount on this checkId, and a node-level set would clobber it. For
    // the same reason saleCount is EXCLUDED here and applied by transaction
    // below, exactly like the bump path.
    const { saleCount: initialCount, ...checkFields } = check;
    const updates = {};
    for (const [field, value] of Object.entries(checkFields)) {
      updates[`displayChecks/${store}/${saDate}/${newCheckId}/${field}`] = value;
    }
    logEvent(updates, db, store, saDate, {
      checkId: newCheckId,
      type: status === "held" ? "held" : "suggested",
      at: nowMs,
      payload: { movementId, qty, stockQty: Number.isFinite(stockQty) ? stockQty : null },
    });
    if (resolution.repeat) {
      logEvent(updates, db, store, saDate, {
        checkId: newCheckId,
        type: resolution.repeat.logType, // repeat_detected | contradiction_detected
        at: nowMs,
        payload: {
          repeatOf: resolution.repeat.repeatOf,
          followedResult: resolution.repeat.followedResult,
          repeatWithinMinutes: resolution.repeat.repeatWithinMinutes,
        },
      });
    }
    await db.ref().update(updates);
    // Initial units via the same transaction idiom as bumps — merges cleanly
    // with any concurrent loser's increment instead of racing it.
    await db.ref(`displayChecks/${store}/${saDate}/${newCheckId}/saleCount`)
      .transaction((c) => (Number(c) || 0) + initialCount);
  }
);
