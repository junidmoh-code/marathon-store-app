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
// ── WHY THE CLAIM TRANSACTION IS THE WHOLE DEDUPE ────────────────────────────
// The Firestore transaction claims a doc ONLY while status === "pending" and
// flips it to "sending" in the same commit. Firestore serialises transactions
// on the doc, so of any number of concurrent claimers — the instant trigger,
// a trigger re-fire (Firestore delivers create events at-least-once), the
// sweep, an overlapping sweep run — exactly ONE wins; every loser sees a
// non-pending status and walks away without sending. Speeding delivery up by
// racing the sweep therefore cannot mint a duplicate: the mutex does not know
// or care who is asking. DO NOT add a send path that skips this claim.
//
// The producer-side 90-second dedupe (enqueueWhatsApp) is a SEPARATE guard on
// doc creation and is untouched by anything in this file.
//
// ── FAILURE SEMANTICS (unchanged from the sweep era) ─────────────────────────
// Send failed and attempts < maxAttempts  → revert to "pending" (provider
// cleared) so a LATER sweep retries — the create trigger never re-fires on an
// update, so the sweep owns every retry. Send failed at attempts >= maxAttempts
// → "failed", terminal. Doc deleted mid-flight → quiet no-op. The function
// never throws for send errors, so one bad doc can't abort a sweep loop.
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
//   log             — console-like (log / warn / error)
async function deliverOutboxDoc({
  db, docRef, docId, sendTemplate, maxAttempts, serverTimestamp, maskPhone,
  log = console,
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
    log.error("outbox deliver claim failed:", JSON.stringify({ docId, error: err.message }));
    return;
  }
  if (!claimed) return;  // no longer pending — someone else won the race

  const to             = claimed.to;
  const templateName   = claimed.templateName;
  const templateParams = claimed.variables || claimed.templateParams || [];

  const result = await sendTemplate(to, templateName, templateParams);

  if (result.ok) {
    await docRef.update({
      status:    "sent",
      provider:  "meta",
      sentAt:    serverTimestamp(),
      messageId: result.messageId,
    });
    log.log("outbox deliver meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "sent", messageId: result.messageId,
    }));
    return;
  }

  // Meta send failed. This is the last-resort path, so it's the only one that
  // ever sets "failed" — but only once we've exhausted maxAttempts.
  if (claimed.attempts >= maxAttempts) {
    await docRef.update({
      status:    "failed",
      lastError: result.error || "Meta send failed",
    });
    log.error("outbox deliver meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "failed",
      attempts: claimed.attempts, error: result.error,
    }));
  } else {
    // Revert to pending so a later sweep retries. Clearing provider hands it
    // back to whoever claims next.
    await docRef.update({
      status:    "pending",
      provider:  null,
      lastError: result.error || "Meta send failed",
    });
    log.warn("outbox deliver meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "retry",
      attempts: claimed.attempts, error: result.error,
    }));
  }
}

module.exports = { deliverOutboxDoc };
