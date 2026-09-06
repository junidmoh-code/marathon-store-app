import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { startUpdateChecker } from "./update/updateChecker.js";
import { applyPushDeepLink } from "./push/deepLink.js";

// Last-resort crash surface: show ANY uncaught error / promise rejection as a
// fixed banner on screen, so a failure can never be a silent black screen with
// no clue (which is what the Returns view showed). Sits below React's error
// boundaries and catches the async / event-handler errors those can't.
if (typeof window !== "undefined") {
  const showFatal = (msg) => {
    try {
      let el = document.getElementById("__fatal_error");
      if (!el) {
        el = document.createElement("div");
        el.id = "__fatal_error";
        el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#7f1d1d;color:#fff;font:12px/1.5 -apple-system,system-ui,sans-serif;padding:10px 40px 10px 12px;white-space:pre-wrap;word-break:break-word;max-height:45vh;overflow:auto;box-shadow:0 2px 10px rgba(0,0,0,.5)";
        const x = document.createElement("button");
        x.textContent = "✕";
        x.style.cssText = "position:absolute;right:8px;top:6px;background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer";
        x.onclick = () => el.remove();
        el.appendChild(x);
        document.body.appendChild(el);
      }
      const line = document.createElement("div");
      line.textContent = "⚠ " + msg;
      el.appendChild(line);
    } catch { /* ignore */ }
  };
  window.addEventListener("error", (e) => showFatal(String(e?.message || e?.error || e) + (e?.filename ? `  (${e.filename}:${e.lineno})` : "")));
  window.addEventListener("unhandledrejection", (e) => showFatal("Promise: " + String(e?.reason?.message || e?.reason || e)));
}

// A tapped push notification lands here as /?push=order&hub=…&order=… .
// Consumed BEFORE React mounts, because the workspace, the warehouse hub and
// its tab are all seeded from localStorage at first render — writing those keys
// first is what makes the deep link work with no route, no parser and no second
// source of truth about where a screen lives. See src/push/deepLink.js.
applyPushDeepLink();

// Long-lived warehouse/TV tabs: poll /version.json and pick up new deploys on
// their own (banner + idle auto-reload; never mid-count — see updateChecker.js).
// Deliberately NOT a service worker — see the SW rollback note below.
startUpdateChecker();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// ─── PWA: the CACHING service worker stays DISABLED (rolled back 2026-05-09) ──
// Installed PWA on iOS was showing 0 data on Source/Warehouse/Assistant/Returns
// while regular Safari worked. The root cause was never identified, so the
// caching worker is still neither registered nor served as active, and any SW
// already installed on a staff phone is unregistered + its caches cleared on
// next visit. Manifest + icons + iOS meta are unaffected, so home-screen
// install + standalone display still work.
//
// ── THE ONE EXCEPTION: /firebase-messaging-sw.js ─────────────────────────────
// Web push cannot exist without a service worker, so the push worker is spared
// here BY NAME. It is not the worker that was rolled back and it cannot become
// it: it registers no fetch handler (so the browser bypasses it for every
// navigation and resource request), opens no cache, and lives under the /fcm/
// scope, which matches no page in this app. Sparing it therefore restores
// nothing of the 2026-05-09 failure — see public/firebase-messaging-sw.js.
//
// The filter is a SUFFIX match on the script URL, not an equality check on a
// full URL, so it keeps working across origins (localhost, the preview channel,
// the live site) without a per-environment list.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(
      regs
        .filter((r) => !(r.active || r.installing || r.waiting)?.scriptURL?.endsWith("/firebase-messaging-sw.js"))
        .map((r) => r.unregister()),
    ))
    .catch(() => {});
}
// Caches are still cleared wholesale — the push worker opens none, so there is
// nothing of its to preserve.
if (typeof caches !== "undefined" && caches.keys) {
  caches.keys()
    .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    .catch(() => {});
}

// Capture the Android install prompt so the App can fire it on user gesture.
// Kept active — install prompt works without a service worker on Chrome.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__pwaInstallPrompt = e;
  window.dispatchEvent(new CustomEvent("pwa-install-available"));
});
