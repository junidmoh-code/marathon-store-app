// Core of dispatchHoldRevealSweep — moved VERBATIM from functions/index.js so
// the parity suite (functions/test/hold-reveal-sweep.test.cjs) can drive it
// without firebase-admin. Behaviour is byte-identical to the inline version
// shipped in PR #208: the onSchedule handler injects db (admin.database())
// and enqueueWhatsApp; `nowMs` is test-only — when absent, `now` is taken
// AFTER the query resolves, exactly where the inline code took it.
//
// Semantics being preserved (do not "improve" without a new review):
// - Query reads ONLY readyNotifyPending === true orders (COST FIX, 2026-07-13
//   audit): the loop always acted solely on that flag, and updateStatus (the
//   single writer) flips it atomically with every status transition, so the
//   filtered set is exactly the set the old full-node read acted on. Requires
//   /orders .indexOn "readyNotifyPending" (console-managed; the admin SDK
//   falls back to an unindexed scan rather than failing if it's missing).
// - Left READY (reverted / OOS / collected) → clear the flag, never send.
// - Not due yet (notifyReadyAt parses to a future time) → leave for a later
//   run. A MALFORMED notifyReadyAt fails OPEN (Date.parse → NaN, NaN > now is
//   false) → the customer still gets told.
// - CLAIM before sending: atomically flip readyNotifyPending true→false in a
//   transaction. Only the run that wins the flip sends, so (a) two overlapping
//   sweeps can't both send, and (b) a send whose later flag-clear write failed
//   can't re-send — the flag is already cleared as part of the claim, BEFORE
//   the enqueue. On enqueue failure we re-hold (set it back to true) so a
//   later run retries — at-least-once, never the double-send of a
//   send-then-clear-then-fail.
// - The transaction update fn MUST be null-tolerant: in a Cloud Function the
//   transaction first runs against a COLD local cache (cur === null, since the
//   earlier once() tears its listener down), and returning undefined there
//   aborts BEFORE the server is ever consulted — the claim would never commit
//   and no held WhatsApp would send. So only abort on a confirmed false
//   (already claimed); null/true both proceed, and the server CAS re-runs the
//   fn with the real value to resolve the race.

async function runHoldRevealSweep({ db, enqueueWhatsApp, nowMs }) {
  const orders = (await db.ref("orders").orderByChild("readyNotifyPending").equalTo(true).once("value")).val() || {};
  const now = nowMs ?? Date.now();
  let sent = 0, cleared = 0;
  for (const [id, o] of Object.entries(orders)) {
    if (!o || id === "items" || o.readyNotifyPending !== true) continue;
    // Left READY (reverted / OOS / collected) → clear, never send.
    if (o.status !== "ready") {
      await db.ref(`orders/${id}`).update({ readyNotifyPending: false }).catch(() => {});
      cleared++;
      continue;
    }
    // Not due yet — leave it for a later run.
    if (o.notifyReadyAt && Date.parse(o.notifyReadyAt) > now) continue;
    let claimed = false;
    try {
      const res = await db.ref(`orders/${id}/readyNotifyPending`).transaction(cur => (cur === false ? undefined : false));
      claimed = res.committed && res.snapshot.val() === false;
    } catch { claimed = false; }
    if (!claimed) continue;                          // another run got it, or it changed under us
    try {
      if (o.customerPhone) {
        await enqueueWhatsApp({
          templateName:   "order_ready",
          recipientPhone: o.customerPhone,
          templateParams: [o.customerName || "there", id],
        });
      }
      await db.ref(`orders/${id}/readyNotifiedAt`).set(new Date().toISOString()).catch(() => {});
      sent++;
    } catch (e) {
      // Enqueue failed AFTER we claimed — re-hold so a later sweep retries. If the
      // re-hold ALSO fails the message is lost (rare double-failure) — log loudly.
      await db.ref(`orders/${id}/readyNotifyPending`).set(true)
        .catch(err => console.error("dispatchHoldRevealSweep: re-hold FAILED, order_ready may be lost:", id, err.message));
      console.warn("dispatchHoldRevealSweep: enqueue failed, re-holding:", id, e.message);
    }
  }
  if (sent || cleared) console.log("dispatchHoldRevealSweep:", JSON.stringify({ sent, cleared, matched: Object.keys(orders).length }));
  return { sent, cleared, matched: Object.keys(orders).length };
}

module.exports = { runHoldRevealSweep };
