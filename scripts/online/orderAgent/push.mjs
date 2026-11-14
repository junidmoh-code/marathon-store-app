// ── The 2-trading-hour nudge: a web push to the place's assigned staff ──────
// The same audience the store-order push uses (functions/lib/order-push.cjs): push_hub_audience/{place} (Junid
// assigns people per hub), each person's own mute as a veto (push_mutes/{uid}/muted, unreadable = audible), their
// tokens under push_tokens/{uid}. Exact reads only. Shops get their people from the Order Alerts card's "Website
// picks (shops)" group (after the push_assignments rule paste, docs/ORDER-AGENT-RULES.md); until then a shop nudge
// says "no push audience", is tried again the next day, and the 4-hour escalation to Junid says so.
export const MAX_RECIPIENTS = 50;
export function makeHubPush({ db, messaging }) {
  return async function push({ hub, title, body, tag }) {
    // Relative, as the order push links: the service worker opens it on the store app's own origin.
    // Hubs open their own queue; a shop opens the app plainly (the deep link accepts warehouse hubs only and would
    // switch a shop account into the warehouse role).
    const link = /^hub\d+$/.test(String(hub)) ? `/?push=order&hub=${encodeURIComponent(hub)}&tab=queue` : "/";
    const aud = (await db.ref(`push_hub_audience/${hub}`).get()).val();
    const uids = aud && typeof aud === "object" ? Object.keys(aud).slice(0, MAX_RECIPIENTS) : [];
    if (!uids.length) return { sent: false, why: `no push audience for ${hub}` };
    const muted = await Promise.allSettled(uids.map((u) => db.ref(`push_mutes/${u}/muted`).get()));
    const live = uids.filter((u, i) => !(muted[i].status === "fulfilled" && muted[i].value.val() === true));
    const tokens = [];
    for (const uid of live) {
      const v = (await db.ref(`push_tokens/${uid}`).get()).val();
      for (const [tokenId, rec] of Object.entries(v && typeof v === "object" ? v : {})) if (rec && typeof rec.token === "string") tokens.push({ uid, tokenId, token: rec.token });
    }
    if (!tokens.length) return { sent: false, why: `no phone registered for ${hub}` };
    // Data-only, like the order push: the service worker (or the open page) shows it, exactly once. The relative link
    // rides in data.link only (FCM's webpush.fcmOptions.link must be an absolute HTTPS URL).
    const res = await messaging.sendEachForMulticast({ tokens: tokens.map((t) => t.token), data: { kind: "order", hub, title, body, link, tag, sentAt: String(Date.now()) } });
    const ok = (res?.responses || []).filter((r) => r.success).length;
    return { sent: ok > 0, delivered: ok, of: tokens.length, people: live.length, why: ok ? null : "every send failed" };
  };
}
