// ─── ORDER TOMORROW NOTIFY — the core (owner restoration 2026-08-19) ─────────
// Run: cd functions && node --test test/order-tomorrow-notify.test.cjs
//
// The FOURTH order-status message. The order notification system tells a
// customer, against their ORDER NUMBER, what has happened to their order:
//
//   order_placed       at checkout                    (App.jsx, client)
//   order_ready        at STATUS.READY                (App.jsx, client)
//   rder_out_of_stock  at STATUS.OUT_OF_STOCK         (App.jsx, client)
//   order_tomorrow     at STATUS.COMING_TOMORROW      ← THIS MODULE
//
// The fourth one stopped on 2026-08-08. e115cde ("Refill unification") deleted
//
//     if (status === STATUS.COMING_TOMORROW)
//       sendWhatsAppTemplate(order.customerPhone, "order_tomorrow", [order.id]);
//
// from WarehouseView's updateStatus, and 892 messages a month went to zero.
// The owner has restored it (2026-08-19): when staff mark an order as coming
// tomorrow, the customer is told immediately, exactly as before.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// It is NOT the hold-availability message that PR #385 built, and the two are
// not duplicates of each other. They fire on different events and say different
// things — this one at hold-PLACED time ("scheduled for tomorrow, we will
// notify you when it is ready"), #385's at FULFIL time ("ready to collect").
// The first promises the second. Nothing here reads, writes or waits on
// holdLink, holdAvailabilityNotify or /refill_requests; that path is untouched.
//
// ── WHY THIS LIVES ON THE SERVER, WHEN THE OLD ONE DID NOT ───────────────────
// The deleted call was a client-side fire-and-forget with no double-tap guard.
// That shape is how the SAME message reached real customers 2-5 times and got
// the gateway number banned (see hold-availability-notify.cjs). The owner's
// restoration keeps the trigger, the template and the timing identical but not
// the delivery mechanism: the send now hangs off the WRITE the staff action
// already makes (/orders/{orderId}/status → "coming_tomorrow"), so a tablet
// that sleeps, drops its connection or is closed mid-tap can neither lose the
// message nor repeat it.
//
// ── NO NEW SEND PATH ─────────────────────────────────────────────────────────
// enqueueWhatsApp is injected — the SAME producer the app's sendWhatsApp
// callable uses, writing the same whatsapp_outbox doc, behind the same
// server-side dedupe (PR #52: identical to + templateName + renderedText within
// 90s is reused, never re-created). The template is the existing, approved
// order_tomorrow, with its existing single {{1}} = order number param.
//
// ── ONE CUSTOMER, ONE MESSAGE, EVER ──────────────────────────────────────────
// Four guards, innermost last — the create-once claim pattern proven in #385:
//   1. TRANSITION ONLY — before === "coming_tomorrow" is a replay, not a move.
//   2. LIVE RE-READ — the order must STILL be coming_tomorrow and still carry a
//      phone, so a flip-and-revert can never message anybody.
//   3. DURABLE CLAIM — tomorrowNotifyClaimedAt is a create-once transaction.
//      Only the invocation that wins it may enqueue, and it is NEVER taken over
//      (the reasoning is #385's, quoted at the claim). This outlives the 90s
//      dedupe window and survives at-least-once trigger redelivery.
//   4. The producer's own 90s dedupe, underneath everything.
//
// The three re-send routes the owner named, and what stops each:
//   • RE-ENTERING the state (tomorrow → ready → tomorrow) passes guard 1, and
//     is stopped by the tomorrowNotifiedAt stamp read in guard 2.
//   • A RE-QUEUE to a later day rewrites comingTomorrowAt but not `status`, so
//     the status leaf never changes and this trigger does not fire at all.
//   • A RETRY / trigger redelivery is stopped by guard 1, then by guard 3.
//
// COLD-CACHE NOTE (the lesson from hold-reveal-sweep.cjs, opposite polarity):
// in a Cloud Function the transaction body first runs against an EMPTY local
// cache, so `cur` is null on the first pass. Here null is exactly the proceed
// case, so the body returns a value, the CAS re-runs against the real server
// value, and an already-claimed record aborts on that second pass. The
// dangerous direction — aborting on the cold null and never reaching the
// server — cannot happen with this polarity.
//
// ── THE DAILY ORDER-NUMBER RESET ─────────────────────────────────────────────
// Order numbers are daily-scoped and /orders/{id} is reused. No stale stamp can
// suppress a real message: writeOrder uses set() on /orders/{id}, which
// REPLACES the whole node, so tomorrow's order 042 starts with no claim and no
// notifiedAt. Nothing here needs to date-qualify the stamp.
//
// ── FAILURE HANDLING ─────────────────────────────────────────────────────────
// Terminal (the producer refuses the number outright — details.unusableRecipient):
// stamp tomorrowNotifyFailedAt + tomorrowNotifyError, KEEP the claim. Retrying
// can never succeed and an un-kept claim would re-fire on every redelivery.
// Matched on the specific detail, NOT on invalid-argument broadly: a
// template-contract failure (a deploy changing param arity) must stay
// retryable, or one bad deploy silently drops every tomorrow notification.
// Transient: RELEASE the claim, stamp the error, and rethrow so the failure is
// red in Cloud Logging and the trigger's retry re-drives it.

const TEMPLATE = "order_tomorrow";   // approved, 1 param: the order number
const STATE    = "coming_tomorrow";  // STATUS.COMING_TOMORROW in src/App.jsx


/**
 * @param db               admin.database()
 * @param enqueueWhatsApp  the outbox producer (functions/index.js)
 * @param orderId          /orders key whose status just changed
 * @param before           the status value before the write (null on create)
 * @param after            the status value after the write
 * @param nowIso           injectable clock; defaults to now
 * @returns { sent, skipped } — `skipped` names the guard that stopped it
 */
async function notifyOrderTomorrow({ db, enqueueWhatsApp, orderId, before, after, nowIso }) {
  // 1. TRANSITION ONLY.
  if (after !== STATE) return { sent: false, skipped: "not_coming_tomorrow" };
  if (before === STATE) return { sent: false, skipped: "no_transition" };

  const now = nowIso || new Date().toISOString();
  const orderRef = db.ref(`orders/${orderId}`);
  const rec = (await orderRef.get()).val();

  // 2. LIVE RE-READ — the write we are reacting to must still be the truth.
  if (!rec) return { sent: false, skipped: "order_gone" };
  if (rec.status !== STATE) return { sent: false, skipped: "status_moved" };
  if (!rec.customerPhone) return { sent: false, skipped: "no_phone" };
  if (rec.tomorrowNotifiedAt || rec.tomorrowNotifyFailedAt) {
    return { sent: false, skipped: "already_handled" };
  }

  // 3. DURABLE CLAIM — create-once, and the only door to the producer.
  //
  // AN UNRESOLVED CLAIM IS NEVER TAKEN OVER. This is #385's ruling, and it
  // applies here for the same reason: tomorrowNotifyClaimedAt with no
  // notifiedAt and no failedAt means some earlier invocation claimed and never
  // recorded what happened next. Letting a later delivery resume it cannot be
  // made safe — the producer's dedupe is query-then-add and NOT atomic, so two
  // resumers both observe an empty window, both .add(), and the gateway
  // delivers both; and a `cur === observedClaim` fence proves only that the
  // taker replaced what it saw, never that the original claimant is dead.
  // Distinguishing a dead claimant from a slow one needs a lease longer than
  // the function's maximum lifetime, which would consume most of the 90s window
  // inside which re-enqueuing is provably harmless. So: no takeover, at any age.
  // The claim is instead STAMPED (tomorrowNotifyUnresolvedAt) and left for a
  // human. The standing bias, unchanged: a missed notification is recoverable
  // by a person; the gateway number being banned for duplicates is not.
  if (rec.tomorrowNotifyClaimedAt) {
    console.error("orderTomorrowNotify: unresolved claim from an earlier run, NOT sending:", orderId);
    await orderRef.update({ tomorrowNotifyUnresolvedAt: now })
      .catch((e) => console.error("orderTomorrowNotify: could not stamp unresolved claim:", orderId, e.message));
    return { sent: false, skipped: "claim_unresolved" };
  }

  // Create-once. NOTHING in this module calls the producer without having won
  // this transaction. Cold-cache polarity: `cur` is null on the first pass,
  // which is a proceed, so the body always reaches the server CAS re-run.
  const claimRef = db.ref(`orders/${orderId}/tomorrowNotifyClaimedAt`);
  let claimed = false;
  try {
    const res = await claimRef.transaction((cur) => (cur == null ? now : undefined));
    claimed = res.committed && res.snapshot.val() === now;
  } catch (err) {
    console.error("orderTomorrowNotify: claim failed:", orderId, err.message);
    return { sent: false, skipped: "claim_failed" };
  }
  if (!claimed) return { sent: false, skipped: "already_claimed" };

  // 4. THE SEND — the existing producer, the existing outbox, the existing 90s
  //    dedupe. One param: the order number, which is what the customer knows
  //    the order by and what the deleted call passed.
  //
  // ONCE THIS RESOLVES, THE CLAIM IS NEVER RELEASED (#385's lesson). The
  // enqueue and the bookkeeping that records it are separate awaits; a failure
  // of the SECOND must not fall into the same catch as a failure of the first,
  // or the retry re-sends a message that was already enqueued once the 90s
  // window lapses. That is the exact 2-5 copies incident. Only a failure of the
  // enqueue itself may release the claim.
  //
  // AND THAT IS NOT A PROOF THAT NOTHING WAS ENQUEUED (Kimi review, #386). A
  // throw is not evidence the producer did nothing: enqueueWhatsApp's
  // Firestore .add() sits inside its own try, so an ambiguous commit — the
  // write lands, the response is lost to a deadline — surfaces here as an
  // ordinary error, and we release the claim and rethrow. The retry then
  // enqueues a second time, and if the trigger's backoff has pushed it past the
  // producer's 90s dedupe window the customer is messaged twice.
  //
  // This is left as-is, deliberately. The window is narrow (ambiguous Firestore
  // commits are rare and the retry usually lands well inside 90s, where the
  // dedupe does catch it), and closing it properly means giving the outbox doc
  // a deterministic id so the producer's write is idempotent — a change to
  // enqueueWhatsApp, which is SHARED with holdAvailabilityNotify, the client
  // callable and the POS repo's reminders. That is a producer-level fix and it
  // belongs in its own PR, not in a restoration that claims to touch nothing.
  // Recorded here so the next reader does not mistake the comment above for a
  // guarantee the code can actually make.
  let result;
  try {
    result = await enqueueWhatsApp({
      templateName:   TEMPLATE,
      recipientPhone: rec.customerPhone,
      templateParams: [orderId],
    });
  } catch (err) {
    const terminal = !!(err && err.code === "invalid-argument" && err.details && err.details.unusableRecipient);
    await orderRef.update({
      tomorrowNotifyError: String((err && err.message) || err).slice(0, 300),
      ...(terminal
        ? { tomorrowNotifyFailedAt: now }
        : { tomorrowNotifyClaimedAt: null }),   // nothing was enqueued — release for a retry
    }).catch((e) => console.error("orderTomorrowNotify: could not stamp failure:", orderId, e.message));
    if (terminal) {
      console.error("orderTomorrowNotify: unusable phone, NOT sent (terminal):", orderId, err.message);
      return { sent: false, skipped: "unusable_recipient" };
    }
    console.error("orderTomorrowNotify: enqueue failed, claim released:", orderId, err.message);
    throw err;   // retry: true on the trigger re-drives this with backoff
  }

  // The producer has answered: a doc exists. From here a failure may only be
  // logged, never compensated by releasing the claim.
  await orderRef.update({
    tomorrowNotifiedAt:     now,
    tomorrowNotifyOutboxId: (result && result.outboxId) || null,
  }).catch((e) => console.error(
    "orderTomorrowNotify: ENQUEUED but could not stamp tomorrowNotifiedAt (claim kept, will not resend):",
    orderId, e.message,
  ));
  console.log("orderTomorrowNotify: enqueued", JSON.stringify({
    orderId, outboxId: (result && result.outboxId) || null,
    deduped: !!(result && result.deduped),
  }));
  return { sent: true, skipped: null };
}

module.exports = { notifyOrderTomorrow, TEMPLATE, STATE };
