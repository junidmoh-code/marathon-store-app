/* ─── FIREBASE MESSAGING SERVICE WORKER ──────────────────────────────────────
 * The ONLY service worker this app registers, and the narrowest one it could
 * possibly be.
 *
 * ── READ THIS BEFORE ADDING ANYTHING ────────────────────────────────────────
 * Service workers were disabled app-wide on 2026-05-09 (see src/main.jsx): the
 * caching worker blanked Source / Warehouse / Assistant / Returns inside the
 * installed iOS PWA while plain Safari was fine. That rollback stands. Web push
 * physically cannot work without a worker, so this one is allowed back under
 * three standing rules:
 *
 *   1. NO `fetch` LISTENER. Not a pass-through one, not a "just for icons" one.
 *      A worker with no fetch listener is bypassed by the browser for every
 *      navigation and resource request, so it cannot serve a stale anything.
 *      Adding a fetch handler here re-opens the exact defect that was rolled
 *      back.
 *   2. NO caches. Nothing is precached, nothing is stored.
 *   3. Registered under the /fcm/ scope (src/push/pushConfig.js), which matches
 *      no page in this app, so it controls no client even in principle.
 *
 * Its entire job is: receive a push, show a notification, and open the right
 * screen when someone taps it.
 *
 * ── WHY compat BUILDS ───────────────────────────────────────────────────────
 * A service worker is not a module context here, so it uses importScripts with
 * the compat bundles — the standard, documented way to run Firebase Messaging
 * in a worker. The version is PINNED to the same major.minor as the app's
 * firebase dependency; a drift between the two is a real (if rare) source of
 * "the token registers but nothing ever arrives".
 */
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

// Same project config as src/firebase.js. A worker cannot import from src/, and
// only the messaging fields are needed here; the API key is the public,
// project-identifying one every Firebase web app ships.
firebase.initializeApp({
  apiKey: "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain: "marathon-club.firebaseapp.com",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "marathon-club",
  storageBucket: "marathon-club.firebasestorage.app",
  messagingSenderId: "306270814317",
  appId: "1:306270814317:web:470395933121de7dbdbf64",
});

const messaging = firebase.messaging();

// Take over immediately so a freshly-deployed worker starts receiving pushes
// without waiting for every tab to close. Safe here in a way it is not for a
// caching worker: this one serves nothing, so "the new one is in charge" has no
// content consequences at all.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// ── DATA-ONLY MESSAGES, ON PURPOSE ──────────────────────────────────────────
// The server sends `data` and never `notification` (functions/lib/order-push.cjs).
// A `notification` payload is displayed by the browser ITSELF, including while
// the app is open — which is exactly the double-fire the foreground behaviour is
// meant to prevent. Data-only puts the decision here and in the page:
//   app backgrounded → this handler shows the OS notification
//   app foregrounded → onMessage in the page shows a banner + chime instead
// Exactly one of the two runs for any given message.
messaging.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  const title = d.title || "New order";
  return self.registration.showNotification(title, {
    body: d.body || "",
    // The circuit icon is the installed app's own icon, so the notification
    // looks like it came from Marathon and not from a generic web page.
    icon: "/icons/icon-192-circuit.png",
    badge: "/icons/icon-192-maskable-circuit.png",
    // Collapse in the TRAY as well as at the server: one store's burst replaces
    // its own previous notification rather than stacking a column of them.
    tag: d.tag || "order",
    renotify: true,
    data: { link: d.link || "/" },
  });
});

// Tapping the notification: focus an already-open Marathon tab and tell it where
// to go, or open a new one at the deep link. Focusing beats opening a second
// copy of a PWA that is already running.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if (client.url && client.url.indexOf(self.location.origin) === 0) {
        // postMessage first: a focused client routes itself without a reload,
        // which keeps an in-progress count or pick on screen.
        try { client.postMessage({ type: "marathon-push-navigate", link }); } catch (e) { /* ignore */ }
        if ("focus" in client) return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(link);
    return undefined;
  })());
});
