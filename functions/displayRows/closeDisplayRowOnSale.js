// ─── closeDisplayRowOnSale — the display record closes itself at the till ────
//
// (Owner spec clause 3, 2026-09-08.)
//
// A display unit sells at Marathon PE or Trophy and the open display row for
// that product AND that captured size closes, server-side, from any till, with
// NO change to marathon-pos-app and no POS deploy. Also closes on a return to
// the hub. Cancellation is closed by the app that cancels (the refill undo).
//
// THE FAULT IT REMOVES, stated by the branch that could not fix it: "A plain
// sale of the display pair leaves the slot standing… Receive an ordinary size 9
// into Hub 1 later and the glyph returns, asserting a display that is not
// there. Reloading does not fix it." (DISPLAY-MARKER-INFORMATIONAL.md, KNOWN
// RESIDUAL 1.) It could not be fixed there because the app only learns about a
// sale when somebody opens the app. This trigger learns about it from the
// movement the till writes.
//
// SOURCE, proven and already relied on: marathon-pos-app writes one `sold`
// movement per (sale, product, size) cell with `from` = the selling shop
// (docs/display-checks-sale-source.md). onClothingSale has fired off exactly
// this node since it shipped. Nothing in the POS knows this function exists.
//
// EVERY DECISION IS IN lib.cjs and is pure — which movement counts, which rows
// it closes, what a close writes, and the lease. This file is the plumbing.
//
// COST: it fires on every /stock_movements create, like onClothingSale. The
// first two checks are field comparisons on the event payload (store, type) and
// return without a single read for everything else — which is the overwhelming
// majority of movements.
//
// DEPLOY (scoped — functions are SHARED with marathon-pos-app, never a bare
// --only functions):
//     firebase deploy --only functions:closeDisplayRowOnSale

"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const {
  classifyMovement, decideCloses, closeUpdates, leaseDecision,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const ROWS = "settings/displayRows";
const META = "settings/displayRows_meta";

const REASON = { sold: "sold", returned: "returned" };

exports.closeDisplayRowOnSale = onValueCreated(
  {
    ref: "/stock_movements/{movementId}",
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const m = event.data.val();
    const hit = classifyMovement(m);
    if (!hit) return;                       // not a sale or return at a display store

    const db = admin.database();
    const movementId = event.params.movementId;
    const { store, productId, sizeKey, qty, kind } = hit;

    // ── The rows for this (store, product). ONE keyed read, never the node. ──
    const byRow = (await db.ref(`${ROWS}/${store}/${productId}`).get()).val();
    const closes = decideCloses(byRow, sizeKey, qty);
    // Nothing on the wall to close — the overwhelmingly common case (an
    // ordinary shelf sale of a size no display is registered at). No lease is
    // claimed, so nothing is left behind for a product this trigger never
    // touched.
    if (!closes.length) return;

    // ── The lease. Claimed only once there is real work, and BEFORE the write.
    const leaseRef = db.ref(`${META}/${store}/processed/${movementId}`);
    const nowMs = Date.now();
    const claim = await leaseRef.transaction((cur) => leaseDecision({ cur, nowMs }));
    if (!claim.committed) return;           // already done, or another execution holds it

    const at = new Date(nowMs).toISOString();
    const updates = {};
    for (const { rowId } of closes) {
      Object.assign(updates, closeUpdates(`${ROWS}/${store}/${productId}/${rowId}`, {
        at, reason: REASON[kind], via: kind === "sold" ? "pos_sale" : "return_to_hub", movementId,
      }));
    }
    await db.ref().update(updates);

    // ── The MIRROR. /settings/displaySlots is what the count, the shop marker
    // and offShelf read, and it must follow the ledger rather than lead it: the
    // slot is only tombstoned when the LAST open row for this wall has gone.
    // Closing one of two duplicates leaves a pair genuinely on that wall, and
    // clearing the slot there would tell the next counter nothing is out and
    // hand them a discrepancy that is not real.
    const after = (await db.ref(`${ROWS}/${store}/${productId}`).get()).val() || {};
    const stillOpen = Object.values(after).filter(
      (r) => r && r.status === "open" && typeof r.sizeKey === "string" && r.sizeKey && r.sizeKey !== "_"
    );
    const slotRef = db.ref(`${ROWS.replace("displayRows", "displaySlots")}/${store}/${productId}`);
    if (stillOpen.length === 0) {
      // Tombstone, never delete — the same contract clearDisplaySlot keeps on
      // the client: sizeKey null, every other field retained, prevSize for the
      // audit. Written as a transaction so a slot write that landed AFTER this
      // instant (a registration racing the sale) is not erased by it — the same
      // staleness fence displaySlots.js carries, restated here because a
      // function cannot import it.
      await slotRef.transaction((cur) => {
        if (!cur || cur.sizeKey == null) return undefined;               // nothing out there
        if (typeof cur.at === "string" && cur.at > at) return undefined; // newer truth won
        return { ...cur, size: null, sizeKey: null, source: REASON[kind] === "sold" ? "display_sold" : "manual",
                 at, by: `system:closeDisplayRowOnSale`, orderId: null, prevSize: cur.size || null };
      });
    } else {
      const keep = stillOpen[stillOpen.length - 1];
      await slotRef.transaction((cur) => {
        if (cur && typeof cur.at === "string" && cur.at > at) return undefined;
        return {
          ...(cur || {}), productId, productName: keep.productName || (cur && cur.productName) || "",
          size: keep.size, sizeKey: keep.sizeKey, bookedHub: keep.bookedHub || null,
          source: "registration", at, by: `system:closeDisplayRowOnSale`, orderId: null, prevSize: null,
        };
      });
    }

    await leaseRef.update({ done: true, doneAt: Date.now(), closed: closes.map((c) => c.rowId) });
  }
);
