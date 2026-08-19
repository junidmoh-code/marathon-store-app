// ─── HOLD AVAILABILITY NOTIFY — the core (owner reinstatement 2026-08-19) ────
// Run: cd functions && node --test test/hold-availability-notify.test.cjs
//
// A customer whose order went On Hold is told when the stock is PHYSICALLY
// THERE — the moment the hold's refill line is FULFILLED. Nothing is scheduled,
// nothing is predicted, and nothing fires at hold-placed time (the old
// "available tomorrow" message, deleted in e115cde, promised stock that did not
// exist yet — it stays deleted).
//
// ── WHY THIS LIVES ON THE SERVER ─────────────────────────────────────────────
// The refill queue is UNTOUCHABLE: a hold line is an ordinary request row, with
// no badge, no order number, no customer name and no second button. Putting the
// send in RefillQueue.jsx would put customer vocabulary into the one file two
// pinned gate suites keep empty of it — so the send hangs off the WRITE the
// Fulfil action already makes (/refill_requests/{id}/status → "fulfilled"),
// not off the button. Staff see nothing. A tablet that sleeps, drops its
// connection or is closed mid-action cannot lose the message or repeat it.
//
// ── NO NEW SEND PATH ─────────────────────────────────────────────────────────
// enqueueWhatsApp is injected — the SAME producer the app's sendWhatsApp
// callable uses, writing the same whatsapp_outbox doc, behind the same
// server-side dedupe (PR #52: identical to + templateName + renderedText within
// 90s is reused, never re-created). dispatchHoldRevealSweep already calls it
// exactly this way. The template is the approved order_ready — the
// now-available variant, unchanged copy, no new template approval.
//
// ── ONE CUSTOMER, ONE MESSAGE ────────────────────────────────────────────────
// A previous version of this notification sent 2-5 copies to real customers and
// got the gateway number banned. Four independent guards, innermost last:
//   1. TRANSITION ONLY — before === "fulfilled" is a replay, not a fulfil.
//   2. LIVE RE-READ — the record must still be fulfilled AND carry fulfilledBy
//      (the audit stamp both fulfil writers set atomically with the status), so
//      a bare status flip with no stock behind it can never message anybody.
//   3. DURABLE CLAIM — holdLink/notifyClaimedAt is a create-once transaction.
//      Only the invocation that wins it may enqueue. This outlives the 90s
//      dedupe window and survives at-least-once trigger redelivery.
//   4. The producer's own 90s dedupe, underneath everything.
//
// COLD-CACHE NOTE (the lesson from hold-reveal-sweep.cjs, opposite polarity):
// in a Cloud Function the transaction body first runs against an EMPTY local
// cache, so `cur` is null on the first pass. Here null is exactly the
// proceed case, so the body returns a value, the CAS re-runs against the real
// server value, and a already-claimed record aborts on that second pass. The
// dangerous direction — aborting on the cold null and never reaching the
// server — cannot happen with this polarity.
//
// ── THE MERGED-LINE RULE ─────────────────────────────────────────────────────
// "One line, 2 units, one from a sale and one from a hold": notify on the
// hold's OWN request line reaching `fulfilled`, and only then. Never on a
// tranche, never off a neighbouring row.
//
//   • Cannot notify a customer whose unit was not set aside. A hold's promise
//     lives on its own /refill_requests row (onhold_{saDate}_{orderId}) and
//     nothing merges into it — the engine's resize/withdraw path walks
//     /refill_engine/open (its own locks), and a hold row has no lock, so it is
//     never resized. Units picked against a sale cell or an engine request move
//     a DIFFERENT row and never mark this one fulfilled. And within this row,
//     a partial send keeps status "open" (only qty/sentQty move), so the status
//     leaf does not even change — we fire only once EVERY promised unit has
//     physically been sent. If a line ever did carry a sale unit and a hold
//     unit together, full fulfilment still guarantees the customer's unit is
//     among the delivered ones.
//   • Cannot leave a promised customer un-notified. `fulfilled` is the only
//     terminal state where stock reached the customer's hub, and it always
//     notifies. The other terminal state is `cancelled` — hold_released (the
//     order left coming_tomorrow, and its own status path already messages the
//     customer: order_ready or out_of_stock), a human Out of Stock, or an
//     engine withdrawal — and in none of those did a unit get set aside here.
//
// ── FAILURE HANDLING ─────────────────────────────────────────────────────────
// Terminal (the producer refuses the number outright — details.unusableRecipient):
// stamp notifyFailedAt + notifyError, KEEP the claim. Retrying can never
// succeed and an un-kept claim would re-fire on every redelivery. Matched on
// the specific detail, NOT on invalid-argument broadly: a template-contract
// failure (a deploy changing param arity) must stay retryable, or one bad
// deploy silently drops every hold notification.
// Transient: RELEASE the claim, stamp notifyError, and rethrow so the failure
// is red in Cloud Logging and the census in scripts/hold-notify-gap-census.mjs
// can find it. There is deliberately NO retry sweep — a scheduled second
// attempt is exactly the time-based send the owner ruled out.

const TEMPLATE = "order_ready";   // the now-available variant, approved copy, unchanged

/**
 * @param db               admin.database()
 * @param enqueueWhatsApp  the outbox producer (functions/index.js)
 * @param requestId        /refill_requests key whose status just changed
 * @param before           the status value before the write (null on create)
 * @param after            the status value after the write
 * @param nowIso           injectable clock; defaults to now
 * @returns { sent, skipped } — `skipped` names the guard that stopped it
 */
async function notifyHoldAvailability({ db, enqueueWhatsApp, requestId, before, after, nowIso }) {
  // 1. TRANSITION ONLY.
  if (after !== "fulfilled") return { sent: false, skipped: "not_fulfilled" };
  if (before === "fulfilled") return { sent: false, skipped: "no_transition" };

  const now = nowIso || new Date().toISOString();
  const reqRef = db.ref(`refill_requests/${requestId}`);
  const rec = (await reqRef.get()).val();

  // 2. LIVE RE-READ — the write we are reacting to must still be the truth, and
  //    real stock must sit behind it.
  if (!rec) return { sent: false, skipped: "request_gone" };
  if (rec.status !== "fulfilled") return { sent: false, skipped: "status_moved" };
  if (!rec.fulfilledBy || typeof rec.fulfilledBy !== "object") {
    // Both fulfil writers (RefillQueue.fulfilRequest, Transfer.jsx) stamp
    // fulfilledBy in the SAME multi-path update as the status. Its absence
    // means something flipped the status without moving stock.
    console.warn("holdAvailabilityNotify: fulfilled with no fulfilledBy, NOT sending:", requestId);
    return { sent: false, skipped: "no_fulfilment_record" };
  }

  const link = rec.holdLink;
  if (!link || link.notifyOnFulfil !== true) return { sent: false, skipped: "not_hold_origin" };
  if (!link.customerPhone) return { sent: false, skipped: "no_phone" };
  if (link.notifiedAt || link.notifyFailedAt || link.notifyClaimedAt) {
    return { sent: false, skipped: "already_handled" };
  }

  // 3. DURABLE CLAIM — create-once. See the cold-cache note in the header.
  const claimRef = db.ref(`refill_requests/${requestId}/holdLink/notifyClaimedAt`);
  let claimed = false;
  try {
    const res = await claimRef.transaction((cur) => (cur == null ? now : undefined));
    claimed = res.committed && res.snapshot.val() === now;
  } catch (err) {
    console.error("holdAvailabilityNotify: claim failed:", requestId, err.message);
    return { sent: false, skipped: "claim_failed" };
  }
  if (!claimed) return { sent: false, skipped: "already_claimed" };

  // 4. THE SEND — the existing producer, the existing outbox, the existing
  //    90s dedupe. orderId is what the customer knows the order by.
  try {
    const result = await enqueueWhatsApp({
      templateName:   TEMPLATE,
      recipientPhone: link.customerPhone,
      templateParams: [link.customerName || "there", link.orderId],
    });
    await reqRef.child("holdLink").update({
      notifiedAt:      now,
      notifyOutboxId:  (result && result.outboxId) || null,
      notifyTemplate:  TEMPLATE,
    });
    console.log("holdAvailabilityNotify: enqueued", JSON.stringify({
      requestId, orderId: link.orderId, outboxId: (result && result.outboxId) || null,
      deduped: !!(result && result.deduped),
    }));
    return { sent: true, skipped: null };
  } catch (err) {
    const terminal = !!(err && err.code === "invalid-argument" && err.details && err.details.unusableRecipient);
    await reqRef.child("holdLink").update({
      notifyError: String((err && err.message) || err).slice(0, 300),
      ...(terminal
        ? { notifyFailedAt: now }
        : { notifyClaimedAt: null }),   // release so a redelivery can retry
    }).catch((e) => console.error("holdAvailabilityNotify: could not stamp failure:", requestId, e.message));
    if (terminal) {
      console.error("holdAvailabilityNotify: unusable phone, NOT sent (terminal):", requestId, err.message);
      return { sent: false, skipped: "unusable_recipient" };
    }
    console.error("holdAvailabilityNotify: enqueue failed, claim released:", requestId, err.message);
    throw err;   // red in Cloud Logging; there is no retry sweep by design
  }
}

module.exports = { notifyHoldAvailability, TEMPLATE };
