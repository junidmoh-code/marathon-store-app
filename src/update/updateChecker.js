// Auto-update detection for long-lived till tabs. The build stamps a version
// into the bundle (__BUILD_VERSION__, vite define) AND emits /version.json with
// the same value; this module polls version.json (no-store) and, when the
// deployed version differs from the running one, (a) surfaces a banner via
// subscribers and (b) auto-reloads ONLY when it cannot interrupt anyone:
// nothing has marked itself busy (a sale in the cart, a count in progress) and
// the user hasn't touched the app for IDLE_MS — or the tab just went hidden
// while idle. One silent attempt per version (sessionStorage latch) so a lagging
// CDN can never reload-loop a till; the banner remains as the manual path.
//
// No service worker on purpose: the store-app's SW caused the iOS zero-data
// incident and is actively unregistered in main.jsx — polling a tiny JSON is
// the whole mechanism.

const POLL_MS = 5 * 60 * 1000;
const IDLE_MS = 3 * 60 * 1000;
const RELOAD_LATCH_KEY = "marathon.update.reloadedFor";

/* global __BUILD_VERSION__ -- compile-time constant injected by vite define */
export const CURRENT_VERSION =
  typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "dev";

// ── Busy registry ─────────────────────────────────────────────────────────────
// Screens that must never be reloaded under someone register themselves here
// (e.g. the cart while it has lines). Keys are arbitrary strings.
const busyKeys = new Set();
export function setUpdateBusy(key, busy) {
  if (busy) busyKeys.add(key);
  else busyKeys.delete(key);
}
export function isUpdateBusy() {
  return busyKeys.size > 0;
}

// ── Pure decision helpers (unit-tested) ──────────────────────────────────────
export function isNewVersion(currentVersion, fetchedVersion) {
  return (
    typeof fetchedVersion === "string" &&
    fetchedVersion.length > 0 &&
    currentVersion !== "dev" &&
    fetchedVersion !== currentVersion
  );
}

export function shouldAutoReload({ updateAvailable, busy, msSinceActivity, alreadyAttempted, hidden = false }) {
  if (!updateAvailable || busy || alreadyAttempted) return false;
  // A hidden tab can't be interrupting anyone; a visible one must be idle.
  return hidden || msSinceActivity >= IDLE_MS;
}

// ── Runtime ───────────────────────────────────────────────────────────────────
let updateAvailable = false;
let fetchedVersion = null;
let lastActivity = Date.now();
const subscribers = new Set();

export function onUpdateAvailable(fn) {
  subscribers.add(fn);
  if (updateAvailable) fn(true);
  return () => subscribers.delete(fn);
}
export function isUpdateAvailable() {
  return updateAvailable;
}

function notify() {
  for (const fn of subscribers) {
    try { fn(updateAvailable); } catch { /* subscriber errors never break the checker */ }
  }
}

function alreadyAttempted() {
  try { return sessionStorage.getItem(RELOAD_LATCH_KEY) === fetchedVersion; } catch { return true; }
}

export function applyUpdate() {
  try { sessionStorage.setItem(RELOAD_LATCH_KEY, fetchedVersion ?? "unknown"); } catch { /* reload anyway */ }
  window.location.reload();
}

function maybeAutoReload(hidden) {
  if (
    shouldAutoReload({
      updateAvailable,
      busy: isUpdateBusy(),
      msSinceActivity: Date.now() - lastActivity,
      alreadyAttempted: alreadyAttempted(),
      hidden,
    })
  ) {
    applyUpdate();
  }
}

async function check() {
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return; // 404 in dev / transient CDN error — say nothing
    const data = await res.json();
    if (isNewVersion(CURRENT_VERSION, data?.version)) {
      fetchedVersion = data.version;
      if (!updateAvailable) {
        updateAvailable = true;
        notify();
      }
      maybeAutoReload(document.visibilityState === "hidden");
    }
  } catch {
    // Offline / fetch failure — the next tick retries; never surface an error.
  }
}

let started = false;
export function startUpdateChecker() {
  if (started || typeof window === "undefined") return;
  started = true;

  const bumpActivity = () => { lastActivity = Date.now(); };
  window.addEventListener("pointerdown", bumpActivity, { passive: true, capture: true });
  window.addEventListener("keydown", bumpActivity, { passive: true, capture: true });

  window.setInterval(check, POLL_MS);
  window.addEventListener("focus", check);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
    else maybeAutoReload(true); // tab just went hidden — invisible moment to swap builds
  });
  check();
}
