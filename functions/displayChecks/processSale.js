// ─── DISPLAY CHECKS — ONE SALE LINE INTO ONE CHECK (shared) ──────────────────
// The create / bump / repeat / held logic, lifted VERBATIM out of
// onClothingSale.js so two triggers share it:
//   • onClothingSale — a `sold` /stock_movements row (every deducting store);
//   • onDisplaySale  — a /pos/sales line that wrote NO movement (a store whose
//     shelf does not deduct yet: Concrete, Pine — onDisplaySale.js).
// `movementId` is the idempotency key: the movement id, or a synthetic
// "sale_<saleId>_<lineId>" for a sale line. It keys the processed lease, the
// log event ids and the check's movement fence exactly as before.
"use strict";

const {
  stockSizeKey, saDateStringFromMs, saMonthOfDate, dedupeKey, resolveSale, resolveAssignment,
  buildNewCheck, processedClaimDecision, bumpTxn,
} = require("./lib.cjs");
const { guardedMutate, guardedCreate } = require("./guardedTransaction.cjs");

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


// m: { productId, size, qty, ts, saleId }  store: the /stock location
// product: the /products record (already read by the caller's gate)
async function processDisplaySale(db, { store, movementId, m, product, nowMs: nowMsIn = null }) {
    const nowMs = nowMsIn ?? Date.now();
    const qty = Math.max(1, Number(m.qty) || 1);
    const key = dedupeKey(m.productId, m.size);
    const saleId = m.saleId || null;
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

module.exports = { processDisplaySale, bumpCheck, logEvent, activePath, dayArchivePath };
