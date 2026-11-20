// ─── BLACK FRIDAY — APPROVE = PUBLISH ON THE WEBSITE (Junid, 20 Nov 2026) ────
// Every approval on the card — any tab, one tap or a bulk approve, a New
// Arrivals tap mirrored in, an Undo that approves again — ends as a write to
// picks/{pid}. This trigger turns each NEW approval into a queue entry the
// Mac mini's website runner works through (marathon-group-poster bin/bf-web.mjs
// → marathon-store-app scripts/blackFriday/webPublishCore.mjs, the existing
// Shopify publisher's own steps). An approval taken back takes the entry away.
//   bf_campaign_2026/webQueue/{pid}  { approvedAt, at }
//   bf_campaign_2026/web/{pid}       (the card's status, written by the runner)
// Nothing here talks to Shopify, changes a price, a caption or the schedule.
// Deploy BY NAME: firebase deploy --only functions:bfWebQueue
"use strict";

const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const core = require("./core.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const QUEUE = `${core.ROOT}/webQueue`;
const WEB = `${core.ROOT}/web`;
const approvedState = (p) => !!p && p.state === "approved";

/**
 * What one pick write means for the website queue. Pure.
 * → { queue: { approvedAt } } (a new approval) | { remove: true } (no longer approved) | null (nothing to do)
 */
function webQueueChange(before, after) {
  if (approvedState(after)) {
    // A new approval, or the same product approved again (a new photo, an Undo): queue it.
    if (!approvedState(before) || Number(before.at) !== Number(after.at) || before.sig !== after.sig || before.shown !== after.shown) {
      return { queue: { approvedAt: Number(after.at) || null } };
    }
    return null;
  }
  return approvedState(before) ? { remove: true } : null;
}

const bfWebQueue = onValueWritten(
  // retry: both writes are idempotent and re-checked against the pick as it is NOW, so a retried (or
  // late, out-of-order) event can never queue a withdrawn approval or clear a newer one.
  { ref: `/${core.ROOT}/picks/{pid}`, instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "256MiB", maxInstances: 5, timeoutSeconds: 60, retry: true },
  async (event) => {
    const pid = event.params.pid;
    if (!core.PID_RE.test(String(pid))) return;
    const ch = webQueueChange(event.data.before.val(), event.data.after.val());
    if (!ch) return;
    const db = admin.database();
    // Only what the pick says now counts (events can arrive late or out of order).
    const now = (await db.ref(`${core.ROOT}/picks/${pid}`).once("value")).val();
    const act = settle(ch, now);
    if (!act) return;
    // Functions run on Google's clock (Date.now() here is server time).
    if (act.queue) {
      await db.ref(core.ROOT).update({
        [`webQueue/${pid}/approvedAt`]: act.queue.approvedAt, [`webQueue/${pid}/at`]: Date.now(),
        [`webQueue/${pid}/tryAt`]: null, [`webQueue/${pid}/tries`]: 0,
      });
    } else {
      // Taken back: no work left, and no website status on a product that is not approved.
      // (A product already on the website stays there: an un-approve is not a take-down.)
      await db.ref(core.ROOT).update({ [`webQueue/${pid}`]: null, [`web/${pid}`]: null });
    }
  },
);

/** The change, checked against the pick as it is now (an event that is no longer true does nothing). Pure. */
function settle(ch, current) {
  if (ch.queue) return approvedState(current) ? { queue: { approvedAt: Number(current.at) || ch.queue.approvedAt } } : null;
  if (ch.remove) return approvedState(current) ? null : ch;
  return null;
}

module.exports = { bfWebQueue, _internals: { webQueueChange, settle, QUEUE, WEB } };
