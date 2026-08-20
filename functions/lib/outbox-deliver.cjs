// ─── OUTBOX DELIVERY — claim one doc and send it via Meta ────────────────────
// The single shared "claim then send" path for the whatsapp_outbox. Moved
// VERBATIM out of index.js's processFallbackDoc so BOTH consumers run the
// exact same code, and so the duplicate-safety tests
// (test/outbox-deliver.test.cjs) can drive it without firebase-admin:
//
//   1. outboxInstantSend  — Firestore onDocumentCreated trigger; fires the
//      moment a doc is enqueued (the event-driven path).
//   2. metaFallbackSweep  — the every-minute scheduled sweep; now purely the
//      backstop that retries reverted docs and catches any doc the trigger
//      missed (trigger outage, deploy gap).
//
// Each caller passes its own logPrefix so Cloud Logging can tell the lanes
// apart — and so the sweep's historical log strings ("metaFallbackSweep
// claim failed:", "metaFallbackSweep meta-send:") stay byte-identical for any
// saved queries or log-based alerts that predate this file.
//
// ── WHY THE CLAIM TRANSACTION IS THE WHOLE DEDUPE ────────────────────────────
// The Firestore transaction claims a doc ONLY while status === "pending" and
// flips it to "sending" in the same commit. Firestore transactions are
// optimistic with automatic retry: when claimers contend on one doc, exactly
// ONE commit lands, and every other attempt is re-run against the committed
// state, re-reads a non-pending status, and walks away without sending. So of
// any number of concurrent claimers — the instant trigger, a trigger re-fire
// (Firestore delivers create events at-least-once), the sweep, an overlapping
// sweep run — exactly one sends. And because `attempts` is incremented INSIDE
// the claim commit, attempts that can REACH META stay bounded by maxAttempts
// no matter how many claimers exist. (A preflight failure — provably nothing
// sent — refunds that attempt and burns the separate, also-capped infra
// budget instead; the bound on Meta-reaching sends only holds while
// `preflight` keeps its contract: NEVER set after a request has gone out.)
// Speeding delivery up by racing the sweep therefore cannot mint a duplicate:
// the mutex does not know or care who is asking. DO NOT add a send path that
// skips this claim.
//
// The producer-side 90-second dedupe (enqueueWhatsApp) is a SEPARATE guard on
// doc creation and is untouched by anything in this file.
//
// ── FAILURE SEMANTICS ────────────────────────────────────────────────────────
// Send failed (Meta-reaching) and attempts < maxAttempts → revert to
// "pending" (provider cleared) so a LATER sweep retries — the create trigger
// never re-fires on an update, so the sweep owns every retry; at
// attempts >= maxAttempts → "failed", terminal. Preflight (infra) failure →
// revert with the Meta attempt refunded, until maxInfraAttempts is exhausted,
// then terminal. Doc deleted mid-flight → quiet no-op. The function
// never throws — send errors are values, and the post-send status writes are
// each caught and logged — so one bad doc can't abort a sweep loop. A doc
// whose post-send write failed is left in "sending": stuck and needing manual
// discovery, but never re-sent (nothing claims a non-pending doc).
"use strict";

// Deliver one outbox doc: claim it (transactional mutex against every other
// claimer), send via `sendTemplate`, then record the outcome. All effects are
// injected so tests can fake them:
//   db              — Firestore-like: runTransaction(fn)
//   docRef          — doc handle with update(); tx.get(docRef) must resolve it
//   docId           — for logs only
//   sendTemplate    — async (to, templateName, params)
//                     => { ok, messageId?, error?, preflight? }
//                     ⚠ preflight:true may ONLY be set by a failure that
//                     provably happened BEFORE any bytes reached Meta (e.g.
//                     the secret is unavailable). It exempts the doc from the
//                     Meta-attempt cap and refunds the attempt, so a failure
//                     AFTER a request went out (429, socket timeout — Meta
//                     may have accepted!) must NEVER carry it: that would
//                     turn the refund loop into unbounded duplicate sends.
//   maxAttempts     — Meta attempts before a failing doc goes terminal ("failed")
//   maxInfraAttempts— preflight (infra) reverts before the doc goes terminal;
//                     bounds how long a doc can cycle pending↔sending during
//                     an infra outage, so the sweep's stable limit(50) window
//                     can't be saturated forever by a stuck pool
//   serverTimestamp — () => sentinel for claimedAt / sentAt
//   maskPhone       — PII masker for logs
//   logPrefix       — lane label for every log line ("metaFallbackSweep" | "outboxInstantSend")
//   log             — console-like (log / warn / error)
async function deliverOutboxDoc({
  db, docRef, docId, sendTemplate, maxAttempts, maxInfraAttempts, serverTimestamp, maskPhone,
  logPrefix, log = console,
}) {
  let claimed;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.status !== "pending") return null;   // another claimer got it (or it failed) — skip
      const attempts = (data.attempts || 0) + 1;
      tx.update(docRef, {
        status:    "sending",
        provider:  "meta",
        attempts,
        claimedAt: serverTimestamp(),
      });
      return { ...data, attempts };
    });
  } catch (err) {
    log.error(`${logPrefix} claim failed:`, JSON.stringify({ docId, error: err.message }));
    return;
  }
  if (!claimed) return;  // no longer pending — someone else won the race

  const to             = claimed.to;
  const templateName   = claimed.templateName;
  const templateParams = claimed.variables || claimed.templateParams || [];

  // Guarded so a rejecting sender can't break the no-throw contract: a
  // rejection becomes the same failure value the ladder below already
  // handles. (The production sender returns errors as values; this covers
  // injected/future senders.)
  let result;
  try {
    result = await sendTemplate(to, templateName, templateParams);
  } catch (err) {
    // err?.message so a bare Promise.reject() / thrown non-object can't make
    // the catch block itself throw — that rejection would escape, strand the
    // claimed doc in "sending" and abort a sweep batch.
    result = { ok: false, error: `sendTemplate threw: ${err?.message || String(err)}` };
  }

  // Every post-send status write is guarded: docRef.update() can throw (doc
  // deleted mid-flight, transient Firestore error), and an escaped rejection
  // here would abort the sweep's remaining batch. A failed write leaves the
  // doc in "sending" — stuck, logged loudly below, but never double-sent.
  const recordOutcome = async (fields, context) => {
    try {
      await docRef.update(fields);
      return true;
    } catch (err) {
      log.error(`${logPrefix} outcome write failed (doc left in "sending"):`, JSON.stringify({
        docId, recipient: maskPhone(to), templateName, context, error: err.message,
      }));
      return false;
    }
  };

  if (result.ok) {
    await recordOutcome({
      status:    "sent",
      provider:  "meta",
      sentAt:    serverTimestamp(),
      messageId: result.messageId,
    }, "record-sent");
    log.log(`${logPrefix} meta-send:`, JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "sent", messageId: result.messageId,
    }));
    return;
  }

  // The send failed. Two SEPARATE budgets decide what happens next:
  //
  //   Meta budget (`attempts`, cap maxAttempts) — burned only by attempts
  //   that actually reached (or could have reached) Meta. Exhausting it means
  //   Meta keeps refusing this message → terminal "failed".
  //
  //   Infra budget (`infraAttempts`, cap maxInfraAttempts) — burned only by
  //   preflight failures, which provably sent nothing (see the sendTemplate
  //   contract above). A preflight revert REFUNDS the Meta attempt the claim
  //   charged (safe: the doc is exclusively claimed here, and no send
  //   happened), so surviving an infra outage can't spend the message's real
  //   retry budget. The infra cap exists so a permanently broken binding
  //   still terminates: without it the pending pool grows without bound and
  //   the sweep's stable limit(50) window starves newer docs forever.
  //
  // Terminal "failed" is this path's only producer, and every revert/failure
  // here logs which budget burned — an infra revert logs at ERROR level
  // (outcome "retry-infra"), because it is always operator-actionable.
  const infraAttempts = (claimed.infraAttempts || 0) + (result.preflight ? 1 : 0);
  const metaExhausted  = !result.preflight && claimed.attempts >= maxAttempts;
  const infraExhausted = result.preflight && infraAttempts >= maxInfraAttempts;
  if (metaExhausted || infraExhausted) {
    await recordOutcome({
      status:    "failed",
      lastError: (infraExhausted ? "infra budget exhausted: " : "") + (result.error || "Meta send failed"),
    }, "record-failed");
    log.error(`${logPrefix} meta-send:`, JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "failed",
      attempts: claimed.attempts, infraAttempts, error: result.error,
    }));
  } else if (result.preflight) {
    // Infra revert: refund the Meta attempt, burn an infra attempt, hand the
    // doc back to the sweep (an update never re-fires the create trigger).
    await recordOutcome({
      status:        "pending",
      provider:      null,
      attempts:      claimed.attempts - 1,
      infraAttempts,
      lastError:     result.error,
    }, "record-infra-retry");
    log.error(`${logPrefix} meta-send:`, JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "retry-infra",
      infraAttempts, error: result.error,
    }));
  } else {
    // Revert to pending so a later sweep retries. Clearing provider hands it
    // back to whoever claims next.
    await recordOutcome({
      status:    "pending",
      provider:  null,
      lastError: result.error || "Meta send failed",
    }, "record-retry");
    log.warn(`${logPrefix} meta-send:`, JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "retry",
      attempts: claimed.attempts, error: result.error,
    }));
  }
}

module.exports = { deliverOutboxDoc };
