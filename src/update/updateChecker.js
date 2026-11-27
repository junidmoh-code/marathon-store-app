// Auto-update detection for long-lived till tabs. The build stamps a version
// into the bundle (__BUILD_VERSION__, vite define) AND emits /version.json with
// the same value; this module polls version.json (no-store) and, when the
// deployed version differs from the running one, surfaces the "Update ready"
// pill via subscribers.
//
// ── WHEN A NEW BUILD IS TAKEN (Junid, 27 Nov 2026) ──────────────────────────
// Never under somebody, and never because they looked away. Only:
//   - on the next cold start (index.html is served no-cache, so any fresh
//     load is the new build),
//   - on a tap of the pill (applyUpdate),
//   - or, so no device can sit on an old bundle for ever, in the 03:00–05:00
//     SAST quiet window with the store shut, after IDLE_MS untouched and with
//     nothing busy.
// The old rules reloaded a tab when it went hidden and a mirrored device 30 s
// after any deploy; with several deploys a day that was a cold start — and a
// fresh download of every non-mirrored read — each time staff came back to the
// app. See docs/resume-reload-investigation.md.
//
// No service worker on purpose: the store-app's SW caused the iOS zero-data
// incident and is actively unregistered in main.jsx — polling a tiny JSON is
// the whole mechanism.

const POLL_MS = 5 * 60 * 1000;
const IDLE_MS = 3 * 60 * 1000;
const RELOAD_LATCH_KEY = "marathon.update.reloadedFor";

// ── "FORCED" MODE, FOR A DEVICE SERVING FROM ITS LOCAL COPY ──────────────────
// A parked stale bundle once cost about $400/month, and a mirrored device has
// no whole-node subscriptions to make a wrong bundle obvious. Forced mode used
// to reload such a device 30 s after a deploy; it now only means the quiet-
// window reload keeps trying (up to FORCED_MAX_ATTEMPTS) instead of one
// attempt per version, so a device busy at 03:10 still takes it at 03:15.
// ── A FORCED RELOAD MUST NOT BE ABLE TO LOOP ────────────────────────────────
// The once-per-version latch that forced mode drops exists because a lagging
// CDN serves a new version.json beside an old bundle, and a device that
// reloads into the same old bundle reloads again, and again. Forced mode needs
// to keep retrying past a busy moment, so it cannot use that latch — but it
// must still have a floor. Five attempts, one per 5-minute poll, is long enough to
// outlast any busy spell and short enough that a CDN that is lying costs five
// reloads rather than a day of them, after which the banner remains as the
// manual path. (Fable-vs-spec review, PR #618.)
export const FORCED_MAX_ATTEMPTS = 5;
const FORCED_ATTEMPTS_KEY = "marathon.update.forcedAttempts";
let forcedMode = false;

// ── THE TV BOARD IS NOT RELOADED WHILE THE STORE IS OPEN ────────────────────
// The in-store queue board is idle for ever, so the idle rule above reloaded
// it within one poll of every deploy — and a reload re-locks the browser's
// audio, which is what silenced the pickup voice during the day. On a TV
// screen (the #tv kiosk hash, or the board mounted in-app for the DISPLAY
// role) the ONLY reload is one attempt per version inside the 03:00–05:00
// SAST quiet window, store shut, so a TV that was never put on the deploy/tv
// launcher still cannot sit on an old bundle for ever. A launcher TV gets the
// new bundle at its 04:30 Chrome restart anyway, with audio allowed by flag.
// The banner is never drawn on a TV.
export function isTvRoute(loc = typeof window === "undefined" ? null : window.location) {
  return !!loc && loc.hash === "#tv";
}

let tvBoardMounts = 0;
/** TvWithAutoCollect registers itself, so the in-app DISPLAY mount counts too. */
export function setTvBoardMounted(on) {
  tvBoardMounts = Math.max(0, tvBoardMounts + (on ? 1 : -1));
}
export function isTvScreen() {
  return isTvRoute() || tvBoardMounts > 0;
}

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000; // South Africa: UTC+2, no DST
export const TV_QUIET_FROM_HOUR = 3;
export const TV_QUIET_TO_HOUR = 5;
export function inTvQuietWindow(nowMs) {
  const h = new Date(nowMs + SAST_OFFSET_MS).getUTCHours();
  return h >= TV_QUIET_FROM_HOUR && h < TV_QUIET_TO_HOUR;
}

// The one place a reload happens, so a test can prove the TV never reaches it.
export const reloadIo = { reload: () => window.location.reload() };

/** Turned on by the mirror's bootstrap once this device is serving locally. */
export function setForcedUpdateMode(on) {
  forcedMode = !!on;
}
export function isForcedUpdateMode() {
  return forcedMode;
}

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

// ── A screen that shows its OWN "Update ready" banner ────────────────────────
// The Black Friday card (Junid, 21 Nov 2026) is never reloaded under him: it
// registers busy for as long as it is open (so no silent reload, not even when
// the tab goes hidden), and draws its own banner where it does not cover its
// selection bar. While such a screen is open the global pill stays hidden.
const bannerHosts = new Set();
const hostSubs = new Set();
export function setUpdateBannerHost(key, on) {
  const before = bannerHosts.size > 0;
  if (on) bannerHosts.add(key); else bannerHosts.delete(key);
  if (before !== bannerHosts.size > 0) for (const fn of hostSubs) { try { fn(bannerHosts.size > 0); } catch { /* never breaks the checker */ } }
}
export function isUpdateBannerHosted() {
  return bannerHosts.size > 0;
}
export function onUpdateBannerHosted(fn) {
  hostSubs.add(fn);
  return () => hostSubs.delete(fn);
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

export function shouldAutoReload({
  updateAvailable, busy, msSinceActivity, alreadyAttempted,
  forced = false, attempts = 0, tvRoute = false, tvQuiet = false,
}) {
  if (!updateAvailable) return false;
  // BUSY IS ABSOLUTE, in every mode. It is the cart, the count in progress,
  // and — on a mirrored device — unsent writes. Nothing reloads over those.
  if (busy) return false;
  // ── NOTHING RELOADS BY ITSELF WHILE THE SHOPS CAN BE TRADING ─────────────
  // (Junid, 27 Nov 2026: leave the app, come back, and Source was loading
  // again from nothing.) The old rules reloaded a tab the moment it went
  // HIDDEN, and a mirrored device 30 seconds after any deploy whether or not
  // somebody was using it — so a person who switched to WhatsApp came back to
  // a cold start, and paid for it again in database reads. A new build is now
  // taken on the next cold start, on a tap of the "Update ready" pill, or —
  // so no device can sit on an old bundle for ever — in the 03:00–05:00 SAST
  // quiet window, store shut, and only after IDLE_MS untouched.
  if (!tvQuiet) return false;
  // A TV: one attempt per version, the quiet window only — see isTvScreen.
  if (tvRoute) return !alreadyAttempted;
  if (!(msSinceActivity >= IDLE_MS)) return false;
  // A mirrored device keeps trying through the window (a busy spell must not
  // cost it the night), with the FORCED_MAX_ATTEMPTS floor against a lying CDN.
  if (forced) return attempts < FORCED_MAX_ATTEMPTS;
  return !alreadyAttempted;
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

function forcedAttempts() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(FORCED_ATTEMPTS_KEY) || "null");
    return raw && raw.version === fetchedVersion ? Number(raw.n) || 0 : 0;
  } catch { return 0; }
}

export function applyUpdate() {
  if (isTvScreen() && !inTvQuietWindow(Date.now())) {
    console.warn("update: a new build is deployed; the TV board takes it at 03:00–05:00, never while the store is open.");
    return;
  }
  try { sessionStorage.setItem(RELOAD_LATCH_KEY, fetchedVersion ?? "unknown"); } catch { /* reload anyway */ }
  if (forcedMode) {
    try {
      sessionStorage.setItem(FORCED_ATTEMPTS_KEY,
        JSON.stringify({ version: fetchedVersion, n: forcedAttempts() + 1 }));
    } catch { /* reload anyway */ }
  }
  reloadIo.reload();
}

function maybeAutoReload() {
  if (
    shouldAutoReload({
      updateAvailable,
      busy: isUpdateBusy(),
      msSinceActivity: Date.now() - lastActivity,
      alreadyAttempted: alreadyAttempted(),
      forced: forcedMode,
      attempts: forcedAttempts(),
      tvRoute: isTvScreen(),
      tvQuiet: inTvQuietWindow(Date.now()),
    })
  ) {
    applyUpdate();
  }
  // No retry timer: check() runs every POLL_MS and asks again, which inside
  // the two-hour quiet window is plenty of attempts.
}

// Single-flight: check() is wired to five triggers (interval, focus, online,
// visibility, initial) and e.g. wake-from-sleep fires several at once — one
// outstanding fetch at a time, with a hard timeout so a stalled request on a
// flaky till network can't pile up over a days-long session.
let checkInFlight = false;
const FETCH_TIMEOUT_MS = 10_000;

async function check() {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return; // 404 in dev / transient CDN error — say nothing
    const data = await res.json();
    if (isNewVersion(CURRENT_VERSION, data?.version)) {
      fetchedVersion = data.version;
      if (!updateAvailable) {
        updateAvailable = true;
        notify();
      }
      maybeAutoReload();
    }
  } catch {
    // Offline / timeout / fetch failure — the next tick retries silently.
  } finally {
    checkInFlight = false;
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
  // Coming back looks for a new build (and shows the pill) — it never
  // reloads. Going hidden does nothing at all: a hidden tab is a person who
  // will be back in a moment, and reloading it is what made them wait.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  check();
}
