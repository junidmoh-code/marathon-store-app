// ─── BF CANDIDATES — the store alerts (push) ─────────────────────────────────
// Junid, 23 Nov 2026: on sale start / extend / end, the staff of each location
// HOLDING the product get "Black Friday sale: <product> now R<price>, re-tag".
//
// The EXISTING push system and audiences, read exactly as the order alert reads
// them (functions/lib/order-push.cjs): the people Junid assigned to a location
// (push_hub_audience/{loc}, one shallow read), minus anyone who muted their own
// phone (push_mutes/{uid}/muted), to their own tokens (push_tokens/{uid}).
// Nobody assigned to a location = nobody is told there (no fallback audience);
// the card's per-store list is what staff read then. Data-only messages, like
// every other alert, so the service worker / the open page shows it once.
// An alert is never fatal: the sale is already saved when this runs.
"use strict";

const MAX_RECIPIENTS = 60;
const MULTICAST_MAX = 500;
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);
const okKey = (k) => typeof k === "string" && k.length > 0 && k.length < 80 && !/[.#$/[\]]/.test(k);

async function recipients(db, loc) {
  const v = (await db.ref(`push_hub_audience/${loc}`).get()).val();
  if (!v || typeof v !== "object") return [];
  const uids = Object.keys(v).slice(0, MAX_RECIPIENTS);
  const muted = await Promise.allSettled(uids.map((u) => db.ref(`push_mutes/${u}/muted`).get()));
  // Only a real boolean true mutes; a mute that cannot be read is audible (the order alert's rule).
  return uids.filter((_, i) => !(muted[i].status === "fulfilled" && muted[i].value.val() === true));
}
async function tokensOf(db, uids) {
  const rows = [];
  const snaps = await Promise.all(uids.map((u) => db.ref(`push_tokens/${u}`).get()));
  snaps.forEach((s, i) => {
    const v = s && s.val();
    if (!v || typeof v !== "object") return;
    for (const [tokenId, rec] of Object.entries(v)) if (rec && typeof rec.token === "string") rows.push({ uid: uids[i], tokenId, token: rec.token });
  });
  return rows;
}

/**
 * One notification per location. byLoc: { loc: { title, body } }. → { loc: { tokens, delivered } | { error } }
 * deps: { db, messaging, nowMs }
 */
async function sendStoreAlerts({ db, messaging, nowMs }, byLoc) {
  const out = {};
  for (const [loc, msg] of Object.entries(byLoc || {})) {
    if (!okKey(loc)) { out[loc] = { error: "bad location key" }; continue; }
    try {
      const uids = await recipients(db, loc);
      const rows = uids.length ? await tokensOf(db, uids) : [];
      if (!rows.length) { out[loc] = { tokens: 0, delivered: 0 }; continue; }
      const link = `/#bf-sale-list/${encodeURIComponent(loc)}`;
      const dead = {};
      let delivered = 0;
      // FCM takes at most 500 tokens a call.
      for (let at = 0; at < rows.length; at += MULTICAST_MAX) {
        const part = rows.slice(at, at + MULTICAST_MAX);
        const res = await messaging.sendEachForMulticast({
          tokens: part.map((r) => r.token),
          data: { kind: "bf_sale", hub: loc, title: msg.title, body: msg.body, link, tag: `bf-sale-${loc}`, sentAt: String(nowMs) },
          webpush: { fcmOptions: { link } },
        });
        delivered += (res && res.successCount) || 0;
        ((res && res.responses) || []).forEach((r, i) => {
          const code = r && !r.success && r.error && (r.error.code || (r.error.errorInfo && r.error.errorInfo.code));
          if (code && DEAD.has(code)) dead[`push_tokens/${part[i].uid}/${part[i].tokenId}`] = null;
        });
      }
      if (Object.keys(dead).length) await db.ref().update(dead).catch(() => {});
      out[loc] = { tokens: rows.length, delivered };
    } catch (e) {
      console.error(`BF_SALE_ALERT ${loc} failed:`, e && e.message);
      out[loc] = { error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  return out;
}

module.exports = { sendStoreAlerts, recipients, tokensOf, MAX_RECIPIENTS };
