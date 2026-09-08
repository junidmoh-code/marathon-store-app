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
  classifyMovement, decideCloses, claimClose, resolveHubSale, hubSaleTooOld, leaseDecision, rowIsOpen,
  DISPLAY_STORES,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const ROWS = "settings/displayRows";
const META = "settings/displayRows_meta";

const REASON = { sold: "sold", sold_hub: "sold", returned: "returned" };

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
    const { productId, sizeKey, qty, kind } = hit;
    const nowMs = Date.now();
    let { store } = hit;
    let closes;
    let inferred = null;

    // ── THE LEASE IS CLAIMED BEFORE ANY ADJUDICATION ───────────────────────
    //
    // It used to be claimed only once there was work to do, which read as
    // frugal and was wrong: a refusal wrote nothing, so a redelivered movement
    // was re-adjudicated against a DIFFERENT world. The concrete failure —
    // a hub sale refused because two walls claimed the size; an operator then
    // closes one of them on the Duplicate tab as a correction; the same
    // movement is redelivered, now finds exactly one candidate, and closes it
    // on a premise that was explicitly rejected the first time.
    // (Independent second-brain review.)
    //
    // A movement is adjudicated ONCE. The cost is one small write per sale of
    // a real size at a display store or a gated hub — about 600 a day measured
    // against live traffic, which is nothing.
    //
    // KEYED ON THE BUCKET THE MOVEMENT ITSELF NAMES, not on the store the
    // inference resolves to: for a hub sale the store comes from the ledger,
    // and the ledger moves, so a store-keyed lease could be taken twice under
    // two different stores for one sale.
    const leaseBucket = hit.store || hit.hub;
    const leaseRef = db.ref(`${META}/${leaseBucket}/processed/${movementId}`);
    const claim = await leaseRef.transaction((cur) => leaseDecision({ cur, nowMs }));
    if (!claim.committed) return;           // already adjudicated, or another execution holds it
    const done = (closedIds, why) => leaseRef.update({
      done: true, doneAt: Date.now(), closed: closedIds, ...(why ? { refused: why } : {}),
    });

    if (kind === "sold_hub") {
      // ── A SALE OUT OF A HUB CELL — the store is not on the movement ────────
      // Sneakers sell from the hub, and a hub-sourced movement carries no shop
      // (verified live: its whole field set is actor / appliedAt / from /
      // link.saleId / productId / qty / size / ts / type, `/sales/{saleId}` is
      // empty for these ids, and the manager account that rings both PE and
      // Trophy is scoped to "central"). Two in five in-scope sized sales come
      // through here, so ignoring them would leave the residual open.
      //
      // The close has to be EARNED — see resolveHubSale for the two conditions
      // and for why a bare hub sale must never close anything. Reads are
      // ordered so the cheap one comes first: the two stores' row nodes, and
      // the stock cell only if a single candidate survives.
      // THE AGE GATE FIRST, so a stale movement costs no reads at all. It is
      // re-checked inside resolveHubSale (a helper must not depend on its
      // caller's discipline), and this is the cheap version of the same test.
      const tooOld = hubSaleTooOld(m.ts, nowMs);
      if (tooOld) {
        console.log(`closeDisplayRowOnSale: hub sale ${movementId} closed nothing — ${tooOld}`);
        await done([], tooOld);
        return;
      }
      const perStore = {};
      let candidates = 0;
      for (const s of DISPLAY_STORES) {
        // eslint-disable-next-line no-await-in-loop
        const rows = (await db.ref(`${ROWS}/${s}/${productId}`).get()).val();
        // `bookedHub === hub` OR NO HUB AT ALL. A row with a null bookedHub is
        // a real display that cannot name its hub (a seed row, or one written
        // before the eligibility gate); excluding it from the CANDIDATE list
        // also excluded it from the AMBIGUITY COUNT, so a wall whose row was
        // an equally good explanation for the empty cell was silently ignored
        // and the other wall's row was closed as "the only possibility".
        // Counting them is what makes "there is nothing else it could have
        // been" true rather than merely stated. (Independent second-brain
        // review.)
        const open = decideCloses(rows, sizeKey, Number.MAX_SAFE_INTEGER)
          .filter(({ row }) => !row.bookedHub || row.bookedHub === hit.hub);
        if (open.length) { perStore[s] = open; candidates += open.length; }
      }
      if (!candidates) { await done([], "no display record for this size at this hub"); return; }
      const cellQty = (await db.ref(`stock/${hit.hub}/${productId}/${sizeKey}/qty`).get()).val();
      const verdict = resolveHubSale({ openRowsByStore: perStore, cellQty, movementTs: m.ts, nowMs });
      if (!verdict.ok) {
        // A refusal is the CORRECT outcome, not a failure — but it is recorded
        // in both places a human might look: the log, and the lease itself, so
        // "why did this display record not close?" is answerable after the fact.
        console.log(`closeDisplayRowOnSale: hub sale ${movementId} closed nothing — ${verdict.why}`);
        await done([], verdict.why);
        return;
      }
      store = verdict.store;
      inferred = verdict.why || "the hub cell is empty and one wall claims this size";
      closes = (perStore[store] || []).filter((c) => c.rowId === verdict.rowId);
    } else {
      // ── The rows for this (store, product). ONE keyed read, never the node. ─
      const byRow = (await db.ref(`${ROWS}/${store}/${productId}`).get()).val();
      closes = decideCloses(byRow, sizeKey, qty);
    }
    // Nothing on the wall to close — the overwhelmingly common case: an
    // ordinary shelf sale of a size no display is registered at.
    if (!closes.length) { await done([], "no display record for this product at this size"); return; }

    // ── ONE CAS PER ROW, NOT ONE BLIND UPDATE ──────────────────────────────
    // The lease dedupes replays of THIS movement. It says nothing about a
    // SECOND movement: two tills selling the same shoe in the same size at the
    // same shop within a second get two movement ids, two leases, and — with a
    // plain read-then-update — both would read "2 open rows", both pick the
    // oldest, and both close the SAME one. The second real sale would then
    // close nothing and a row would stay open asserting a display that has
    // gone. (Senior-architect review. The property fuzz could not have found
    // this: it is a sequential walk, and this is a concurrency fault.)
    //
    // So each close is a transaction that commits only if the row is STILL
    // open. A loser aborts and we move to the next candidate — which is the
    // right answer, because there was another pair on that wall and it is the
    // one that just sold. `wanted` bounds it by the units that actually moved;
    // the candidate list is re-read once if the first pass runs out, because a
    // concurrent close may have been landing while we were reading.
    const at = new Date(nowMs).toISOString();
    const via = kind === "returned" ? "return_to_hub"
      : kind === "sold_hub" ? "pos_sale_hub" : "pos_sale";
    const closed = [];
    let wanted = qty;
    for (let pass = 0; pass < 2 && wanted > 0; pass++) {
      // The retry pass RE-READS and takes the next candidate — but only for a
      // close that was earned from the movement itself. An INFERRED hub close
      // earned exactly ONE row, under conditions checked once; re-reading and
      // taking "the next open row of that size" would walk straight past the
      // uniqueness test that made the inference safe in the first place.
      const candidates = pass === 0 ? closes
        : inferred ? []
        : decideCloses((await db.ref(`${ROWS}/${store}/${productId}`).get()).val(), sizeKey, wanted);
      if (!candidates.length) break;
      for (const { rowId } of candidates) {
        if (wanted <= 0) break;
        if (closed.includes(rowId)) continue;
        // eslint-disable-next-line no-await-in-loop
        const res = await db.ref(`${ROWS}/${store}/${productId}/${rowId}`).transaction(
          (cur) => claimClose(cur, { at, reason: REASON[kind], via, movementId, inferred })
        );
        if (res.committed) { closed.push(rowId); wanted--; continue; }
        // WHO BEAT US DECIDES WHETHER TO TRY THE NEXT ROW. The retry is right
        // when another SALE took this row — there was a second pair on that
        // wall and it is the one this sale is about. It is WRONG when a human
        // took it: the Duplicate tab's "corrected" or an undo's "cancelled" is
        // a person saying that record was never a pair leaving the wall, and
        // walking on to close another row would turn one sale into two closes.
        // (Independent second-brain review.)
        const beat = res.snapshot && res.snapshot.val();
        const bySale = beat && typeof beat.closedVia === "string"
          && (beat.closedVia.startsWith("pos_sale") || beat.closedVia === "return_to_hub");
        if (!bySale) {
          console.log(`closeDisplayRowOnSale: ${movementId} stopped at ${rowId} — closed by ${beat && beat.closedVia}, which is a human correction, not a sale`);
          wanted = 0;
          break;
        }
      }
    }
    // Every candidate was taken by a concurrent execution. Nothing to mirror,
    // and the lease is marked done so this movement is not retried forever.
    if (!closed.length) {
      await done([], "every candidate row was taken by a concurrent execution");
      return;
    }

    // ── The MIRROR. /settings/displaySlots is what the count, the shop marker
    // and offShelf read, and it must follow the ledger rather than lead it: the
    // slot is only tombstoned when the LAST open row for this wall has gone.
    // Closing one of two duplicates leaves a pair genuinely on that wall, and
    // clearing the slot there would tell the next counter nothing is out and
    // hand them a discrepancy that is not real.
    const after = (await db.ref(`${ROWS}/${store}/${productId}`).get()).val() || {};
    // Sorted the same way the client sorts (oldest first), so the survivor the
    // slot mirrors is the same row whichever side re-points it. It was
    // `Object.values(...)` in RTDB key order, and `seed…` ids sort after `r…` —
    // two writers would have picked different survivors. (Spec-conformance
    // review.)
    const stillOpen = Object.values(after).filter(rowIsOpen)
      .sort((a, b) => String(a.openedAt || "").localeCompare(String(b.openedAt || "")));
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
      const keep = stillOpen[stillOpen.length - 1];   // the NEWEST surviving row is what the wall shows now
      await slotRef.transaction((cur) => {
        if (cur && typeof cur.at === "string" && cur.at > at) return undefined;
        return {
          ...(cur || {}), productId, productName: keep.productName || (cur && cur.productName) || "",
          size: keep.size, sizeKey: keep.sizeKey, bookedHub: keep.bookedHub || null,
          source: "registration", at, by: `system:closeDisplayRowOnSale`, orderId: null, prevSize: null,
        };
      });
    }

    await done(closed, null);
  }
);
