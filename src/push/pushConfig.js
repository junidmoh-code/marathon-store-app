// ─── WEB PUSH: THE SHARED CONSTANTS ──────────────────────────────────────────
// One module both halves of the feature read from, so the client, the service
// worker and the tests can never disagree about a path, a bucket name or a
// window length.
//
// ── THE VAPID KEY IS PUBLIC, AND THAT IS NOT AN OVERSIGHT ────────────────────
// This is the Web Push certificate's PUBLIC key from Firebase Console →
// Project settings → Cloud Messaging → Web Push certificates. It is the half a
// browser needs to create a subscription, and it is designed to be published:
// every site doing web push ships it in its JavaScript. It authorises nothing
// and spends nothing — the matching PRIVATE key never leaves Google, and the
// only thing that can send to a subscription is this project's server
// credentials.
//
// So it sits here as a plain string, exactly like the Firebase Web API key in
// src/firebase.js, and NOT as a vite `define` reading an environment variable.
// That is deliberate: src/noBakedKeys.test.js forbids the build from injecting
// anything KEY/SECRET/TOKEN-shaped, and adding an env read here to hold a value
// that is public anyway would weaken a real guard for no benefit. Pinned by
// src/push/pushConfig.test.js so it cannot silently become an env read later.
//
// If it is ever blank, registerPush() FAILS LOUDLY (console.error + a thrown
// reason surfaced to the caller) rather than quietly registering nothing — a
// silent no-op here means staff who believe they are covered are not.
export const VAPID_PUBLIC_KEY =
  "BJDsD4kzZfqM624Q0NqT9W7tmOW77vhcq1OsqL7uZwv5BYIHlGYpAGJR-dAP7kkd5oqxm1ShJbWX98Ol2A-H5n4";

// ── THE SERVICE WORKER ───────────────────────────────────────────────────────
// A DEDICATED, FETCH-HANDLER-FREE worker, registered under a NARROW scope that
// contains no page in this app.
//
// This matters more here than anywhere else in the codebase. src/main.jsx has
// unregistered every service worker on every load since 2026-05-09, because the
// caching worker blanked the Source/Warehouse/Assistant/Returns screens inside
// the installed iOS PWA. Web push cannot exist without a worker, so the rollback
// had to be threaded, not reversed:
//
//   • This worker has NO fetch listener. A worker with no fetch listener is
//     skipped entirely for navigation and resource requests — the browser does
//     not even consult it. It therefore cannot serve a stale shell, which is
//     the whole failure class that was rolled back.
//   • Its scope is /fcm/, a path this app never navigates to, so it does not
//     CONTROL any page even in principle.
//   • main.jsx still unregisters every OTHER worker, exactly as before.
//
// Three independent reasons the 2026-05-09 failure cannot come back. Deleting
// any one of them still leaves the other two.
export const PUSH_SW_URL = "/firebase-messaging-sw.js";
export const PUSH_SW_SCOPE = "/fcm/";

// ── RTDB PATHS ───────────────────────────────────────────────────────────────
// Per-user tokens, one child per device. The device id is the child key (rather
// than a push id) so a browser that re-registers overwrites its own row instead
// of accumulating one dead token per app load.
export const pushTokensPath = (uid) => `push_tokens/${uid}`;
export const pushTokenPath = (uid, tokenId) => `push_tokens/${uid}/${tokenId}`;

// ── THE LEGACY AUDIENCE INDEX — KEPT ONLY TO BE EMPTIED ─────────────────────
// /push_audience was the CLIENT-OWNED index of the old model: each browser
// wrote its own uid into the buckets its stockRole and destShop resolved to,
// and the fan-out read the destination's bucket plus the `all` wildcard.
//
// That model is gone (2026-09-07). Recipients are now ADMIN-ASSIGNED and
// HUB-SCOPED — /push_assignments is what Junid sets and /push_hub_audience is
// what the fan-out reads (src/push/pushAssignments.js). Nothing on the server
// reads /push_audience any more.
//
// The paths and the closed bucket list survive for exactly one reason: every
// app load now passes an EMPTY bucket list through audienceUpdates(), which
// writes a null at every one of these leaves. That is what makes the live node
// drain itself instead of sitting there as a stale copy of a model that no
// longer exists. Deleting the list would strand whatever is already in it.
export const pushAudiencePath = (bucket) => `push_audience/${bucket}`;
export const pushAudienceEntryPath = (bucket, uid) => `push_audience/${bucket}/${uid}`;

// Where the fan-out keeps its burst window + replay guard. One node per
// FULFILLING HUB since 2026-09-07 (it was per destination store before, when
// the audience was bucketed that way). Server-owned; the client never reads or
// writes it, and no rule names the key.
export const pushBurstPath = (hub) => `push_bursts/${hub}`;

// ── BUCKETS (LEGACY) ─────────────────────────────────────────────────────────
// `all` was the wildcard bucket. Retained only as part of the closed list the
// clear above walks.
export const AUDIENCE_ALL = "all";
export const AUDIENCE_BUCKETS = Object.freeze([
  AUDIENCE_ALL,
  "hub1",
  "hub2",
  "hub3",
  "central",
  "marathon-pe",
  "trophy",
  "marathon-pine",
]);

// Destination key → the words a human reads in the notification.
export const HUB_LABEL = Object.freeze({
  hub1: "Hub 1",
  hub2: "Hub 2",
  hub3: "Hub 3",
  central: "Central",
  "marathon-pe": "Marathon PE",
  trophy: "Trophy",
  "marathon-pine": "Marathon Pine",
});

/** Human label for a destination, falling back to the raw key rather than "" —
 *  an unknown hub must still produce a readable notification. */
export function hubLabel(hub) {
  return HUB_LABEL[hub] || String(hub || "a hub");
}

// Which WarehouseView tab an order's card lives on, for the deep link. A shop
// refill line at a CR hub is a card on that hub's "CR Orders" tab; everything
// else is on the order queue. Mirrored server-side in
// functions/lib/order-push.cjs (warehouseTabFor) — the two are pinned to the
// same two strings by src/push/pushConfig.test.js.
export const WAREHOUSE_TAB_CLOTHING = "clothing";
export const WAREHOUSE_TAB_QUEUE = "queue";
