import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

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

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// ─── PWA: service worker DISABLED (rolled back 2026-05-09) ────────────────────
// Installed PWA on iOS was showing 0 data on Source/Warehouse/Assistant/Returns
// while regular Safari worked. Until the root cause is identified the SW is
// neither registered nor served as active — and any SW already installed on a
// staff phone is unregistered + its caches cleared on next visit, so they fall
// back to live network behaviour. Manifest + icons + iOS meta are unaffected,
// so home-screen install + standalone display still work.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}
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
