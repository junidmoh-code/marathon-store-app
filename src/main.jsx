import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

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
