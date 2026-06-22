// Marathon Club service worker.
// Bump CACHE_VERSION on every deploy that should invalidate cached static
// assets. Existing clients will fetch the new SW (uncached per firebase.json
// header), activate it (skipWaiting + clients.claim), and the page will
// show the "Update available" banner via a message dispatched from here.
const CACHE_VERSION = "v2";
const STATIC_CACHE  = `mc-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `mc-runtime-${CACHE_VERSION}`;

// Pre-cache the app shell + icons so first-paint works offline after install.
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180-apple.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Notify open pages on activation so the update banner can appear without a hard refresh.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

// Strategy:
//   - Same-origin navigations + HTML → network-first, fall back to cached shell.
//   - Same-origin static assets (js/css/png/jpg/svg/woff*) → cache-first, refresh in background.
//   - Cross-origin requests (Firebase, WhatsApp, etc.) → bypass entirely.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("/index.html")))
    );
    return;
  }

  if (/\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|ttf)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
