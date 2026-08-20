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
// the claim commit, total live sends per doc stay bounded by maxAttempts no
// matter how many claimers exist. Speeding delivery up by racing the sweep
// therefore cannot mint a duplicate: the mutex does not know or care who is
// asking. DO NOT add a send path that skips this claim.
//
// The producer-side 90-second dedupe (enqueueWhatsApp) is a SEPARATE guard on
// doc creation and is untouched by anything in this file.
//
// ── FAILURE SEMANTICS (unchanged from the sweep era) ─────────────────────────
// Send failed and attempts < maxAttempts  → revert to "pending" (provider
// cleared) so a LATER sweep retries — the create trigger never re-fires on an
// update, so the sweep owns every retry. Send failed at attempts >= maxAttempts
// → "failed", terminal. Doc deleted mid-flight → quiet no-op. The function
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
//   sendTemplate    — async (to, templateName, params) => { ok, messageId?, error? }
//   maxAttempts     — attempts before a failing doc goes terminal ("failed")
//   serverTimestamp — () => sentinel for claimedAt / sentAt
//   maskPhone       — PII masker for logs
//   logPrefix       — lane label for every log line ("metaFallbackSweep" | "outboxInstantSend")
//   log             — console-like (log / warn / error)
async function deliverOutboxDoc({
  db, docRef, docId, sendTemplate, maxAttempts, serverTimestamp, maskPhone,
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
    result = { ok: false, error: `sendTemplate threw: ${err.message}` };
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

  // Meta send failed. This is the last-resort path, so it's the only one that
  // ever sets "failed" — but only once we've exhausted maxAttempts, and NEVER
  // for a failure the sender marked retryable:true. Retryable means an INFRA
  // fault (e.g. the secret binding is missing after a fresh deploy), not a
  // fault with the message: terminal-failing a customer's message over a
  // condition an operator will fix would silently drop it, so those revert to
  // "pending" indefinitely and the every-minute sweep keeps them alive until
  // the infra recovers. Meta-side rejections stay subject to the cap.
  if (claimed.attempts >= maxAttempts && !result.retryable) {
    await recordOutcome({
      status:    "failed",
      lastError: result.error || "Meta send failed",
    }, "record-failed");
    log.error(`${logPrefix} meta-send:`, JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "failed",
      attempts: claimed.attempts, error: result.error,
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
