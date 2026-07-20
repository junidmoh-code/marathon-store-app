// ─── DISPLAY CHECKS — onClothingSale TRIGGER (writes only, no UI) ─────────────
// Gen-2 RTDB onCreate on /stock_movements/{movementId}. A clothing `sold`
// movement at an enabled store becomes (or bumps) a display check. DORMANT:
// nothing staff-facing reads these namespaces yet.
//
// SALE SOURCE — PROVEN: /stock_movements `type === "sold"`, one movement per
// (sale, product, size) cell, `from` = selling shop, `qty` = units
// (docs/display-checks-sale-source.md).
//
// ── ACTIVE INDEX (the never-null model) ──────────────────────────────────────
// A check lives at ONE address for its whole active life:
//   /displayChecks_active/{store}/{dedupeKey}   held → open → completed(tombstone)
// One record per SKU. It NEVER moves and is NEVER deleted while active — the
// next sale OVERWRITES a completed tombstone, the sweep flips held→open IN
// PLACE. Because the record is never null during active life, a sale bump's
// cold-safe `cur ?? preRead` transaction can never resurrect a deleted ghost
// (the class that bit this module repeatedly), and the bumpTxn checkId fence
// stops a stale bump from crediting an overwritten slot.
//   /displayChecks/{store}/{saDate}/{checkId}   COMPLETED archive (day node,
//                                               keyed by checkId; written by
//                                               PR-7 completion + the overwrite)
//   /displayChecks_log/{store}/{YYYY-MM}/{eventId}   append-only audit
//   /displayChecks_meta/{store}/processed/{movementId}   idempotency lease
// Reads existing data only (/products, /stock, /displayChecks_settings).
// NOTHING in POS / warehouse / refill / inventory changes.
//
// IDEMPOTENCY — leased state record (movement-global, survives midnight):
// …processed/{movementId} = { at, saDate, done }. Claimed done:false before any
// write; saDate FROZEN on first claim; done:true only after every write lands; a
// stale (PROCESS_LEASE_MS) lease is stealable so a crash retries. Bumps are
// transactions (bumpTxn): status re-validated, checkId fenced, movement fenced,
// lastSoldAt monotonic.
//
// CREATE serialization is the active-record transaction itself (create-if-empty-
// or-completed) — no separate mutex needed: one record per dedupeKey, so a
// concurrent create loses the CAS and re-resolves into a bump.
//
// DEPLOY (Junid only; scoped): firebase deploy --only functions:onClothingSale

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
  bumpTxn,
} = require("./lib.cjs");
const { guardedMutate, guardedCreate } = require("./guardedTransaction.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// One audit event under the SA month (§4.2). Deterministic per (movement, type)
// key so a lease-reclaimed replay overwrites the same event, keeping the
// append-only log honest under at-least-once delivery.
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

const activePath = (store, key) => `displayChecks_active/${store}/${key}`;
const dayArchivePath = (store, saDate, checkId) => `displayChecks/${store}/${saDate}/${checkId}`;

// Bump the SKU's active record. The cold-cache latch + authoritative-null abort
// (the resurrection guard) live ONCE in guardedMutate (guardedTransaction.cjs) —
// this call site just supplies preRead + the bumpTxn mutation and never sees the
// null case. bumpTxn's checkId fence still rejects a stale bump on an overwritten
// slot (→ { ok:false } → the caller re-resolves). On commit the log type comes
// from the LIVE status (held → held_resale with the stock qty as evidence).
async function bumpCheck(db, { store, saDate, key, expectedCheckId, qty, movementId, movementTs, nowMs }) {
  const ref = db.ref(activePath(store, key));
  const preRead = (await ref.get()).val();
  // guardedMutate owns the cold-cache latch + authoritative-null abort (the
  // resurrection guard); bumpTxn only ever sees a non-null current record.
  const res = await guardedMutate(ref, preRead, (c) =>
    bumpTxn(c, { qty, movementTs, movementId, expectedCheckId })
  );
  if (!res.committed) {
    const v = res.snapshot && res.snapshot.val();
    return { ok: false, status: (v && v.status) || null };
  }
  const bumped = res.snapshot.val();
  const logType = bumped.status === "held" ? "held_resale" : "sale_bumped";
  let stockQty = null;
  if (logType === "held_resale") {
    const q = await db.ref(`stock/${store}/${bumped.productId}/${bumped.sizeKey || stockSizeKey(bumped.size)}/qty`).get();
    stockQty = q.val();
  }
  const updates = {};
  logEvent(updates, db, store, saDate, {
    checkId: expectedCheckId, type: logType, at: nowMs, movementId,
    payload: { movementId, qty, ...(logType === "held_resale" ? { stockQty } : {}) },
  });
  await db.ref().update(updates);
  return { ok: true, logType };
}

// Exported for the cold-cache / checkId-fence regression tests.
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

    // ── Early returns, cheapest first (fires on EVERY stock movement) ──
    const store = m.from;
    if (!isTriggerStoreEnabled(store)) return;      // store flag (also drops hubs)
    if (m.type !== "sold") return;                  // sale-type only
    if (!m.productId) return;
    const product = (await admin.database().ref(`products/${m.productId}`).get()).val();
    if (!isClothingSale(product, m.size)) return;   // clothing only (one product get)

    const db = admin.database();
    const movementId = event.params.movementId;
    const nowMs = Date.now();
    const qty = Math.max(1, Number(m.qty) || 1);
    const key = dedupeKey(m.productId, m.size);
    const saleId = (m.link && m.link.saleId) || null;
    const movementTs = m.ts || null;

    // ── Idempotency lease (movement-global; frozen saDate survives midnight) ──
    const processedRef = db.ref(`displayChecks_meta/${store}/processed/${movementId}`);
    // guardedCREATE: claiming the lease WRITES on an absent record by design (a
    // null cur = first claim) — not a resurrection, so it must not abort on null.
    const claim = await guardedCreate(processedRef, (cur) =>
      processedClaimDecision({ cur, nowMs, saDate: saDateStringFromMs(nowMs) })
    );
    if (!claim.committed) return; // done, or another execution holds a fresh lease
    const saDate = (claim.snapshot.val() && claim.snapshot.val().saDate) || saDateStringFromMs(nowMs);

    // ── Resolve against the ONE active record for this SKU (O(1) keyed get) ──
    // No day-node read: the latest completed check for a SKU is its own active
    // tombstone (until the next sale overwrites it), so repeat/contradiction is
    // derived from the active record. Two attempts: a bump/create that aborts
    // (the slot changed under us) re-resolves once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = (await db.ref(activePath(store, key)).get()).val();
      const resolution = resolveSale(active, key, nowMs);

      if (resolution.kind === "bump") {
        const bumped = await bumpCheck(db, {
          store, saDate, key, expectedCheckId: resolution.checkId, qty, movementId, movementTs, nowMs,
        });
        if (bumped.ok) { await processedRef.update({ done: true, doneAt: nowMs }); return; }
        continue; // slot overwritten/changed under us — re-resolve
      }

      // Overwriting a completed tombstone? ARCHIVE it to the day node first
      // (idempotent, deterministic checkId key), so the completed check is never
      // lost when the fresh check takes its dedupeKey slot. Archived under the
      // SA day it completed (PR-7 completion archives it there too — same key).
      if (resolution.overwrite && active && active.status === "completed" && active.checkId === resolution.archiveCheckId) {
        const archDate = saDateStringFromMs(Number(active.completedAt) || nowMs);
        const arch = {};
        for (const [f, v] of Object.entries(active)) arch[`${dayArchivePath(store, archDate, active.checkId)}/${f}`] = v;
        await db.ref().update(arch);
      }

      // ── Create / overwrite ──
      const newCheckId = db.ref(`displayChecks_active/${store}`).push().key;
      const stockQty = Number((await db.ref(`stock/${store}/${m.productId}/${stockSizeKey(m.size)}/qty`).get()).val());
      const status = stockQty > 0 ? "open" : "held";

      // Assignment + opening SA day (open only): cover → LOCKED roster → null.
      // Frozen onto the check, never recomputed (design §3.3). Nodes absent
      // until PR 11 — the resolver order is already real.
      let assignedTo = null, activatedSaDate = null;
      if (status === "open") {
        const [coverSnap, rosterSnap] = await Promise.all([
          db.ref(`displayChecks_settings/${store}/cover/${saDate}`).get(),
          db.ref(`displayChecks_settings/${store}/roster`).get(),
        ]);
        assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
        activatedSaDate = saDate; // window #3: freeze the opening day for PR-12 marks
      }

      const check = buildNewCheck({
        productId: m.productId, product, rawSize: m.size, key, checkId: newCheckId,
        movementId, saleId, movementTs, qty, status, assignedTo, activatedSaDate,
        repeat: resolution.repeat, nowMs,
      });

      // The create serialization: create if the slot is EMPTY or a COMPLETED
      // tombstone; abort if an active (held/open) check already exists (a
      // concurrent sale won → re-resolve → bump). guardedCREATE: writes `check`
      // on the null slot BY DESIGN (a fresh checkId, not a resurrection) — this is
      // the create shape, deliberately not the abort-on-null guardedMutate shape.
      const created = await guardedCreate(db.ref(activePath(store, key)), (cur) =>
        cur === null || cur.status === "completed" ? check : undefined
      );
      if (!created.committed) continue; // lost the slot — re-resolve → bump

      const updates = {};
      logEvent(updates, db, store, saDate, {
        checkId: newCheckId, type: status === "held" ? "held" : "suggested", at: nowMs, movementId,
        payload: { movementId, qty, stockQty: Number.isFinite(stockQty) ? stockQty : null },
      });
      if (resolution.repeat) {
        logEvent(updates, db, store, saDate, {
          checkId: newCheckId, type: resolution.repeat.logType, at: nowMs, movementId,
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

    // Both attempts aborted (the slot kept shifting) — bounded, visible exit.
    const updates = {};
    logEvent(updates, db, store, saDate, {
      checkId: null, type: "orphaned_sale", at: nowMs, movementId,
      payload: { movementId, qty, dedupeKey: key, reason: "resolution_contention" },
    });
    await db.ref().update(updates);
    await processedRef.update({ done: true, doneAt: nowMs });
  }
);
