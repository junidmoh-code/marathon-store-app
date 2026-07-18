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
// units. Two-source proof against /pos/sales (PE + Trophy, 2026-07-16, zero
// unit residual): docs/display-checks-sale-source.md.
//
// WRITE SURFACE — displayChecks* ONLY:
//   /displayChecks/{store}/{saDate}/{checkId}                the check
//   /displayChecks_log/{store}/{YYYY-MM}/{eventId}           append-only audit
//   /displayChecks_meta/{store}/processed/{movementId}       idempotency lease
//   /displayChecks_meta/{store}/{saDate}/active/{dedupeKey}  create-mutex (TTL)
// Reads existing data only (/products, /stock, /displayChecks_settings).
// NOTHING in POS / warehouse / refill / inventory logic changes.
//
// IDEMPOTENCY — LEASED STATE RECORD (movement-global, date-independent):
// RTDB triggers are at-least-once, and a redelivery can arrive AFTER SA
// midnight — so the claim path must not embed the day. The record at
// …processed/{movementId} = { at, saDate, done }:
//   • claimed with done:false before any write (transaction; the movement id
//     is the idempotency key — applyMovement.js:21,87 pattern),
//   • saDate is FROZEN on first claim, so a cross-midnight retry writes into
//     the day node the first attempt targeted,
//   • marked done:true only after every write lands — a crash mid-processing
//     leaves done:false, and after PROCESS_LEASE_MS (10 min, matching
//     refill-scan's LOCK_STEAL_MS precedent) the lease is stealable, so the
//     movement is retried instead of silently dropped. Honest trade-off,
//     documented in lib.cjs: a steal after a mid-write crash can re-apply a
//     bump (rare over-count) — chosen over dropping a sale.
// All counter bumps are transactions on the WHOLE check node (lib.cjs
// bumpTxn): status re-validated atomically (a completed check aborts the bump
// — completed checks are immutable), lastSoldAt monotonic, partial nodes
// abort. Never read-then-write.
//
// CREATE-MUTEX — TTL, SELF-EXPIRING (no external release, no PR-7 obligation):
// …/meta/{saDate}/active/{dedupeKey} closes only the concurrent-create window
// (two tills, same SKU, same seconds). Entries expire by CREATE_MUTEX_TTL_MS
// (120s) inside the claim transaction; nothing anywhere has to clear them. A
// mutex LOSER does not bump blindly: it waits (bounded) for the winner's check
// to materialize, then bumps via the same status-validating transaction — the
// log type comes from the LIVE status (a held check logs held_resale, never
// sale_bumped). If the winner died before publishing, the loser logs a visible
// `orphaned_sale` event and exits — bounded and observable, never a silent
// partial write.
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
  processedClaimDecision,
  mutexClaimDecision,
  completedIdsOf,
  bumpTxn,
} = require("./lib.cjs");

// index.js initialises admin at module scope; guard for standalone imports
// (tests, emulator) exactly like the other function modules.
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// One audit event under the SA month of the day node (§4.2). Written
// server-side only; `actor` marks the machine. The event key is DETERMINISTIC
// per (movement, type) — a lease-reclaimed replay overwrites the same event
// instead of appending a duplicate, which is what keeps the append-only log
// honest under at-least-once delivery. (Keys therefore sort by movement id,
// not strictly by time; consumers order by the `at` field.)
function logEvent(updates, db, store, saDate, { checkId, type, at, payload, movementId }) {
  const eventId = movementId ? `${movementId}_${type}` : db.ref(`displayChecks_log/${store}`).push().key;
  updates[`displayChecks_log/${store}/${saMonthOfDate(saDate)}/${eventId}`] = {
    checkId: checkId || null,
    type,
    at,
    actor: { uid: "system:onClothingSale", name: "onClothingSale" },
    ...(payload ? { payload } : {}),
  };
}

// Bump an existing check via the status-validating node transaction (lib.cjs
// bumpTxn). On commit, the log type is derived from the check's LIVE status —
// held → held_resale (LOUD: the till just sold something inventory says isn't
// there; stockQty is fetched as evidence), open → sale_bumped. On abort the
// caller decides (re-resolve or orphan): { ok:false, status } tells it why.
async function bumpCheck(db, { store, saDate, checkId, qty, movementId, movementTs, nowMs }) {
  const ref = db.ref(`displayChecks/${store}/${saDate}/${checkId}`);
  // COLD-CACHE SAFETY (the live undercount fix): in a Cloud Function the
  // transaction's update fn runs FIRST against a cold local cache (cur === null,
  // and .get() does NOT warm it), so `bumpTxn(null)` returned undefined and the
  // SDK aborted BEFORE the server CAS — the 2nd+ sale of a SKU/day was silently
  // dropped (saleCount stuck at 1). Feeding the pre-read check on the null run
  // makes bumpTxn return a value, forcing the server round-trip; the real
  // decision always runs against the authoritative server value on the re-run.
  // Same idiom as wakeHeldChecks (`cur ?? preRead`).
  const preRead = (await ref.get()).val();
  const res = await ref.transaction((c) => bumpTxn(c === null ? preRead : c, { qty, movementTs, movementId }));
  if (!res.committed) {
    const v = res.snapshot && res.snapshot.val();
    return { ok: false, status: (v && v.status) || null };
  }
  const bumped = res.snapshot.val();
  const logType = bumped.status === "held" ? "held_resale" : "sale_bumped";
  let stockQty = null;
  if (logType === "held_resale") {
    const q = await db
      .ref(`stock/${store}/${bumped.productId}/${bumped.sizeKey || stockSizeKey(bumped.size)}/qty`)
      .get();
    stockQty = q.val();
  }
  const updates = {};
  logEvent(updates, db, store, saDate, {
    checkId,
    type: logType,
    at: nowMs,
    movementId,
    payload: {
      movementId,
      qty,
      // held_resale is never silenced, never "fixed" here, never a new check —
      // stockQty is the evidence a human needs to chase the stock bug.
      ...(logType === "held_resale" ? { stockQty } : {}),
    },
  });
  await db.ref().update(updates);
  return { ok: true, logType };
}

// Bounded wait for a mutex winner's check to publish (status is the marker —
// it is written in the winner's atomic field update). ~1.2s worst case.
async function checkMaterialized(db, path, attempts = 3, delayMs = 400) {
  for (let i = 0; i < attempts; i++) {
    const s = await db.ref(`${path}/status`).get();
    if (s.exists()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Exported for the cold-cache regression test (test/display-checks-bump-coldsafe).
exports.bumpCheck = bumpCheck;

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
    const qty = Math.max(1, Number(m.qty) || 1);
    const key = dedupeKey(m.productId, m.size);
    const saleId = (m.link && m.link.saleId) || null;
    const movementTs = m.ts || null;

    // ── Idempotency lease (movement-global path — survives midnight) ──
    const processedRef = db.ref(`displayChecks_meta/${store}/processed/${movementId}`);
    const claim = await processedRef.transaction((cur) =>
      processedClaimDecision({ cur, nowMs, saDate: saDateStringFromMs(nowMs) })
    );
    if (!claim.committed) return; // done, or another execution holds a fresh lease
    // Day node anchored on the FIRST claim's server-received SA date — stable
    // across lease-steal retries, and server-time (not till-clock ts) per the
    // order-counter TZ incident precedent (#236/#237). The movement ts still
    // lands on the check verbatim as firstSoldAt/lastSoldAt.
    const saDate = (claim.snapshot.val() && claim.snapshot.val().saDate) || saDateStringFromMs(nowMs);

    // ── Resolve against the day node (≤ ~25KB, §4.1 sizing) ──
    // One re-resolution retry: if a bump aborts (check completed between the
    // snapshot and the transaction), the fresh snapshot decides again — that
    // sale then correctly becomes the repeat/contradiction check.
    for (let attempt = 0; attempt < 2; attempt++) {
      const daySnap = await db.ref(`displayChecks/${store}/${saDate}`).get();
      const dayNode = daySnap.val();
      const resolution = resolveSale(dayNode, key, nowMs);

      if (resolution.kind === "bump") {
        const bumped = await bumpCheck(db, {
          store, saDate, checkId: resolution.checkId, qty, movementId, movementTs, nowMs,
        });
        if (bumped.ok) { await processedRef.update({ done: true, doneAt: nowMs }); return; }
        continue; // status changed under us — re-resolve once with fresh data
      }

      // ── Create path: claim the per-key create-mutex (TTL, self-expiring) ──
      const newCheckId = db.ref(`displayChecks/${store}/${saDate}`).push().key;
      const completedIds = completedIdsOf(dayNode);
      const mutex = await db
        .ref(`displayChecks_meta/${store}/${saDate}/active/${key}`)
        .transaction((cur) => mutexClaimDecision({ cur, nowMs, newCheckId, completedIds }));

      if (!mutex.committed) {
        // Mutex loser: a concurrent winner is creating this SKU's check. Wait
        // for it to PUBLISH (status present), then bump through the validating
        // transaction — the live status picks the correct log type. If the
        // winner died before publishing, log a visible orphaned_sale and stop:
        // bounded and observable beats a blind bump onto a half-written node.
        const winner = mutex.snapshot.val();
        const winnerId = winner && winner.checkId;
        if (winnerId && (await checkMaterialized(db, `displayChecks/${store}/${saDate}/${winnerId}`))) {
          const bumped = await bumpCheck(db, {
            store, saDate, checkId: winnerId, qty, movementId, movementTs, nowMs,
          });
          if (bumped.ok) { await processedRef.update({ done: true, doneAt: nowMs }); return; }
          continue; // winner completed already (ultra-rare) — re-resolve
        }
        const updates = {};
        logEvent(updates, db, store, saDate, {
          checkId: winnerId || null,
          type: "orphaned_sale",
          at: nowMs,
          movementId,
          payload: { movementId, qty, dedupeKey: key, reason: "create_winner_never_published" },
        });
        await db.ref().update(updates);
        await processedRef.update({ done: true, doneAt: nowMs });
        return;
      }

      // ── Winner: open vs held via ONE stock-cell get (Phase-0-proven path) ──
      const qtySnap = await db.ref(`stock/${store}/${m.productId}/${stockSizeKey(m.size)}/qty`).get();
      const stockQty = Number(qtySnap.val());
      const status = stockQty > 0 ? "open" : "held";

      // Assignment (open only): cover → LOCKED roster → null. Resolved NOW,
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
        movementId, saleId, movementTs, qty,
        status, assignedTo, repeat: resolution.repeat, nowMs,
      });

      // Check + its audit events land in ONE multi-path update (§13: state
      // change and log event in the same operation). saleCount and the
      // movement fence PUBLISH ATOMICALLY with status: a mutex loser only
      // bumps after `status` exists, and status arrives in this very update —
      // so nothing can have bumped this node yet, and the initial count can't
      // clobber anything. No follow-up transaction, no visible
      // saleCount-less window. (Per-field paths remain deliberate: defensive
      // against any future writer touching the node concurrently.)
      const updates = {};
      for (const [field, value] of Object.entries(check)) {
        updates[`displayChecks/${store}/${saDate}/${newCheckId}/${field}`] = value;
      }
      logEvent(updates, db, store, saDate, {
        checkId: newCheckId,
        type: status === "held" ? "held" : "suggested",
        at: nowMs,
        movementId,
        payload: { movementId, qty, stockQty: Number.isFinite(stockQty) ? stockQty : null },
      });
      if (resolution.repeat) {
        logEvent(updates, db, store, saDate, {
          checkId: newCheckId,
          type: resolution.repeat.logType, // repeat_detected | contradiction_detected
          at: nowMs,
          movementId,
          payload: {
            repeatOf: resolution.repeat.repeatOf,
            followedResult: resolution.repeat.followedResult,
            repeatWithinMinutes: resolution.repeat.repeatWithinMinutes,
          },
        });
      }
      await db.ref().update(updates);
      await processedRef.update({ done: true, doneAt: nowMs });
      return;
    }

    // Both resolution attempts aborted (statuses kept shifting under us) —
    // visible, bounded exit; the movement is marked handled so the lease
    // doesn't retry into the same contention forever. Logged against the
    // FROZEN saDate — a cross-midnight lease retry must audit into the day
    // it was processing, not the current one.
    const updates = {};
    logEvent(updates, db, store, saDate, {
      checkId: null,
      type: "orphaned_sale",
      at: nowMs,
      movementId,
      payload: { movementId, qty, dedupeKey: key, reason: "resolution_contention" },
    });
    await db.ref().update(updates);
    await processedRef.update({ done: true, doneAt: nowMs });
  }
);
