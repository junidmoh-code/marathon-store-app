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

// The explicit preference, when the user has expressed one. ABSENT means
// "no explicit preference" — which resolves to the role default, not to off.
// See src/push/notificationPrefs.js.
export const notificationPrefPath = (uid) => `notification_prefs/${uid}`;

// ── THE TARGETED INDEX ───────────────────────────────────────────────────────
// The fan-out MUST NOT scan /users (31 records with permissions arrays) or
// /push_tokens (one node per staff device) to answer "who wants this?". Live
// bandwidth is the single largest line on this project's bill.
//
// So the client — which already knows its own uid, stockRole, destShop and
// preference — maintains a denormalised index of subscribed users per bucket.
// The fan-out reads exactly two tiny nodes: the destination's bucket and the
// `all` bucket. Each entry is a uid → {at} stub, nothing more.
//
// Having the CLIENT own the index is sound rather than fragile, because a user
// with no registered device cannot be notified at all: the index can only ever
// go stale in the direction of a uid whose tokens are gone, and the fan-out
// already tolerates that (a uid with no tokens contributes nothing).
export const pushAudiencePath = (bucket) => `push_audience/${bucket}`;
export const pushAudienceEntryPath = (bucket, uid) => `push_audience/${bucket}/${uid}`;

// Where the fan-out keeps its burst window + replay guard, one node per
// destination STORE. Server-owned; the client never reads or writes it.
export const pushBurstPath = (hub) => `push_bursts/${hub}`;

// ── BUCKETS ──────────────────────────────────────────────────────────────────
// `all` is the wildcard bucket: Central-side staff (warehouse / admin) fulfil
// orders for EVERY destination, so scoping them to one shop would be wrong.
// The rest are destination keys, matching `destShop` on an order exactly (the
// three shops), plus the hub keys a destShop-pinned account could carry.
export const AUDIENCE_ALL = "all";

// The CLOSED list of buckets a client may write itself into, and — just as
// importantly — the closed list it clears itself out of when its resolution
// changes. Without a closed list, a user who moves from hub2 to hub1 would stay
// subscribed to hub2 forever, because nothing would know to look there.
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
