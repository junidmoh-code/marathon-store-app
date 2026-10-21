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

const { isOnlinePickRecord, onlineOrderOutcomeUpdates } = require("./lib.cjs");

async function applyOnlineOrderOutcome(db, store, record, { storeName } = {}) {
  if (!isOnlinePickRecord(record)) return true;
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
      return true;
    } catch (err) {
      if (i === 2) { console.error("online_pick: order write failed after retries:", err && err.message); return false; }
    }
  }
  return false;
}

module.exports = { applyOnlineOrderOutcome };
