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

// ── FORCED RELOAD, FOR A DEVICE SERVING FROM ITS LOCAL COPY ──────────────────
//
// A parked stale bundle once cost about $400/month. A device reading from a
// local mirror makes that worse, not better: it has no whole-node
// subscriptions to make a wrong bundle obvious, so it can sit on an old build
// for days, quietly, reading a schema the new build has moved on from.
//
// So on a mirrored device the reload is FORCED rather than advisory — it does
// not wait for three minutes of stillness, and it does not give up after one
// attempt per version. What it never does is interrupt:
//
//   - nothing may be registered busy. That is the same registry the cart and
//     the count screens already use (setUpdateBusy), and the mirror adds
//     "there are unsent writes" to it.
//   - and it waits FORCED_GRACE_MS after the update is first seen, so a person
//     mid-sentence gets a moment rather than a reload under their hands.
//
// A device NOT serving from the mirror keeps exactly the old behaviour: idle
// auto-reload, one silent attempt per version, banner otherwise.
export const FORCED_GRACE_MS = 30 * 1000;
export const FORCED_RETRY_MS = 60 * 1000;
// ── A FORCED RELOAD MUST NOT BE ABLE TO LOOP ────────────────────────────────
// The once-per-version latch that forced mode drops exists because a lagging
// CDN serves a new version.json beside an old bundle, and a device that
// reloads into the same old bundle reloads again, and again. Forced mode needs
// to keep retrying past a busy moment, so it cannot use that latch — but it
// must still have a floor. Five attempts at a minute apart is long enough to
// outlast any busy spell and short enough that a CDN that is lying costs five
// reloads rather than a day of them, after which the banner remains as the
// manual path. (Fable-vs-spec review, PR #618.)
export const FORCED_MAX_ATTEMPTS = 5;
const FORCED_ATTEMPTS_KEY = "marathon.update.forcedAttempts";
let forcedMode = false;
let firstSeenAt = null;

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
  updateAvailable, busy, msSinceActivity, alreadyAttempted, hidden = false,
  forced = false, msSinceFirstSeen = 0, attempts = 0,
}) {
  if (!updateAvailable) return false;
  // BUSY IS ABSOLUTE, in both modes. It is the cart, the count in progress,
  // and — on a mirrored device — unsent writes. Nothing reloads over those.
  if (busy) return false;
  if (forced) {
    // No idle requirement and no once-per-version latch: a forced reload is
    // the point, and a device that stayed busy through its one attempt would
    // otherwise never take the new bundle at all. There is still a floor —
    // see FORCED_MAX_ATTEMPTS.
    if (attempts >= FORCED_MAX_ATTEMPTS) return false;
    return msSinceFirstSeen >= FORCED_GRACE_MS;
  }
  if (alreadyAttempted) return false;
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

function forcedAttempts() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(FORCED_ATTEMPTS_KEY) || "null");
    return raw && raw.version === fetchedVersion ? Number(raw.n) || 0 : 0;
  } catch { return 0; }
}

export function applyUpdate() {
  try { sessionStorage.setItem(RELOAD_LATCH_KEY, fetchedVersion ?? "unknown"); } catch { /* reload anyway */ }
  if (forcedMode) {
    try {
      sessionStorage.setItem(FORCED_ATTEMPTS_KEY,
        JSON.stringify({ version: fetchedVersion, n: forcedAttempts() + 1 }));
    } catch { /* reload anyway */ }
  }
  window.location.reload();
}

let forcedTimer = null;

function maybeAutoReload(hidden) {
  if (updateAvailable && firstSeenAt === null) firstSeenAt = Date.now();
  if (
    shouldAutoReload({
      updateAvailable,
      busy: isUpdateBusy(),
      msSinceActivity: Date.now() - lastActivity,
      alreadyAttempted: alreadyAttempted(),
      hidden,
      forced: forcedMode,
      msSinceFirstSeen: firstSeenAt === null ? 0 : Date.now() - firstSeenAt,
      attempts: forcedAttempts(),
    })
  ) {
    applyUpdate();
    return;
  }
  // A forced reload that was refused — busy, or inside its grace — comes back
  // for it. The ordinary mode deliberately does not: its one attempt per
  // version is what stops a lagging CDN reload-looping a device.
  if (forcedMode && updateAvailable && forcedTimer === null
    && forcedAttempts() < FORCED_MAX_ATTEMPTS) {
    forcedTimer = setTimeout(() => {
      forcedTimer = null;
      maybeAutoReload(document.visibilityState === "hidden");
    }, FORCED_RETRY_MS);
  }
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
      maybeAutoReload(document.visibilityState === "hidden");
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
    else maybeAutoReload(true); // tab just went hidden — invisible moment to swap builds
  });
  check();
}
