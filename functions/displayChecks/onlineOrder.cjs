// ─── DISPLAY CHECKS — a completed online_pick tells its WEBSITE ORDER ─────────
// The IO half of lib.cjs onlineOrderOutcomeUpdates: read the order once, apply
// the pure update as ONE root multi-path write. Used by completeDisplayCheck on
// the committed flip AND on every heal of an already-completed tombstone, and
// by wakeHeldChecks before it reaps one — so a completion whose flip landed but
// whose order write did not is re-applied by the next attempt, never stranded
// (the same reasoning as archiveAndLog: reproducible from the record alone).
//
// Returns TRUE when there is nothing left to do (written, nothing to write, or
// the order has moved on and must not be touched); FALSE only when a write or
// read failed and a retry could still land it. A non-online record is TRUE at
// once, with no read.

"use strict";

const { isOnlinePickRecord, isOnlineReturnRecord, onlineOrderOutcomeUpdates } = require("./lib.cjs");

// A shelf hold changes what the website may sell of that product, so every
// store's pusher is told now (the same two counters the stock trigger bumps);
// each pusher ignores a product that is not live in its store. Best-effort: the
// hold itself has landed, and the nightly stock sweep re-checks every listing.
const { DIRTY_PATH, CONCRETE_DIRTY_PATH } = require("../lib/shopify-inventory-dirty.cjs");
async function markWebsiteDirty(db, pid) {
  for (const node of [DIRTY_PATH, CONCRETE_DIRTY_PATH]) {
    try { await db.ref(`${node}/${pid}`).set({ ".sv": { increment: 1 } }); }
    catch (err) { console.warn(`online_pick: ${node}/${pid} not marked (${err && err.message})`); }
  }
}

// NOT FOUND ON A SHELF SHOWING ONE PIECE writes that shelf to zero (Junid, 24
// Nov 2026 — functions/lib/web-writedown.cjs has the rule and the reversal).
// Idempotent by its movement id, so a heal re-applies nothing. Best-effort: the
// shelf hold in the write above already keeps the piece off the website.
// Kill switch: /config/onlineOrders/writeDown/off = true.
const { writeDownSingle, restoreFound } = require("../lib/web-writedown.cjs");

// A DISPLAY CHECK ANSWERED "it is on display" (result "confirmed") is a person
// saying that size is on that shop's floor. If that shelf was written to zero
// after a website not-found, the piece is put back (web_found) and the
// write-down is closed. Best-effort and idempotent; one exact read when there
// is nothing to undo.
async function applyFoundOnCheck(db, store, record) {
  try {
    if (!record || isOnlinePickRecord(record) || isOnlineReturnRecord(record) || record.status !== "completed" || record.result !== "confirmed") return;
    const sizeKey = record.sizeKey != null && record.sizeKey !== "" ? String(record.sizeKey) : null;
    if (!record.productId || !sizeKey || /[.#$[\]/]/.test(`${record.productId}${sizeKey}${store}`)) return;
    const res = await restoreFound(db, { pid: record.productId, sizeKey, loc: store, why: "found_on_check", by: (record.completedBy && record.completedBy.uid) || null }, { nowIso: new Date().toISOString() });
    if (res.ok && res.restored) await markWebsiteDirty(db, record.productId);
  } catch (err) {
    console.warn(`display check: found-after-write-down not applied (${err && err.message})`);
  }
}
async function applyWriteDown(db, w) {
  try {
    if ((await db.ref("config/onlineOrders/writeDown/off").get()).val() === true) return;
    const res = await writeDownSingle(db, w, { nowIso: new Date().toISOString() });
    if (!res.ok) console.warn(`online_pick: write-down ${w.pid}/${w.sizeKey} at ${w.loc} refused (${res.reason})`);
  } catch (err) {
    console.warn(`online_pick: write-down ${w.pid}/${w.sizeKey} at ${w.loc} failed (${err && err.message})`);
  }
}

async function applyOnlineOrderOutcome(db, store, record, { storeName } = {}) {
  if (!isOnlinePickRecord(record) && !isOnlineReturnRecord(record)) return true;
  const orderId = record.orderId;
  if (typeof orderId !== "string" || !orderId || /[.#$[\]/]/.test(orderId)) {
    console.error("online_pick: record has no usable orderId; the order cannot be told", record.checkId);
    return true; // nothing a retry could fix
  }
  for (let i = 0; i < 3; i++) {
    try {
      const order = (await db.ref(`online_orders/${orderId}`).get()).val();
      const out = onlineOrderOutcomeUpdates({ record, store, storeName, order });
      if (out.skip) {
        if (out.skip !== "order-closed") console.warn(`online_pick ${record.checkId}: order not updated (${out.skip})`);
        return true;
      }
      if (Object.keys(out.updates).length) await db.ref().update(out.updates);
      if (out.writeDown) await applyWriteDown(db, out.writeDown);
      if (out.held) await markWebsiteDirty(db, out.held);
      return true;
    } catch (err) {
      if (i === 2) { console.error("online_pick: order write failed after retries:", err && err.message); return false; }
    }
  }
  return false;
}

module.exports = { applyOnlineOrderOutcome, applyFoundOnCheck };
