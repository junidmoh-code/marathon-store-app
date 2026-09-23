// ─── DEVICE QUARANTINE — "BRING THIS PHONE TO JUNID" ─────────────────────────
//
// Accounts in this shop are SHARED: several people sign in as one login, so a
// message to an account reaches everybody on it and tells nobody which handset
// is meant. When the owner needs ONE physical device back — the phone whose
// browser keeps throwing its local copy away, say — the only identity that
// names exactly that handset is the device id the offline mirror already
// reports under (/mirror_devices/{deviceId}, minted once per browser in
// src/device/deviceId.js).
//
// So the flag is keyed by that id, and nothing else:
//
//   /mirror_switch/quarantine/{deviceId} = { on: true, at, by }
//
// ── WHY UNDER /mirror_switch ───────────────────────────────────────────────
//
// The flag must be readable by a device whose own storage has just been wiped,
// so it cannot live in the local mirror. And it must need NO rules change: the
// owner asked for none. /mirror_switch is already readable by every signed-in,
// non-anonymous user and writable only by the owner's address — exactly the
// shape this needs — so the flag is a child of it. Each device listens to its
// OWN child only, never to the parent: the fleet's existing listener is on
// /mirror_switch/enabled, so nobody else downloads anybody's flag.
//
// ── IT FAILS OPEN ──────────────────────────────────────────────────────────
//
// A bug here that showed the message to the wrong device, or to every device,
// would take the shop off the air. So the answer to every doubt is NO MESSAGE:
//
//   · only `true` or `{ on: true }` counts; everything else — absent, false,
//     a string, a number, an object without on:true — is "not quarantined";
//   · a device with no id (private mode) is never quarantined;
//   · a read the database REFUSES (the only error an RTDB listener reports —
//     being offline is not an error, it is silence) clears the message and
//     the cache: a device that may not read its flag is not quarantined;
//   · while offline, a cached "quarantined" is kept, but only for its trust
//     window;
//   · a cached "quarantined" older than CACHE_TRUST_MS is ignored, so a
//     device that has lost the database for days is never stuck behind a
//     message nobody can clear;
//   · the screen that draws the message sits in its own error boundary, and
//     a throw anywhere in it renders nothing.
//
// ── IT NEVER INTERRUPTS A JOB ──────────────────────────────────────────────
//
// The flag says the device SHOULD be quarantined. Whether the message is
// SHOWN yet is decided separately (`shouldShowNow`): not while anything is
// registered busy (a sale in the cart, a count, a save still being confirmed
// — the same registry the auto-updater respects), and not until the screen
// has been left alone for QUIET_MS. The app underneath is never unmounted or
// reloaded, so every write it has queued keeps flushing behind the message.

export const QUARANTINE_NODE = "mirror_switch/quarantine";

// Owner-facing: who clears it, and what the message says.
export const OWNER_NAME = "Junid";

// A cached "you are quarantined" is trusted for this long without the
// database confirming it. Long enough to survive a phone being taken out of
// signal for a weekend; short enough that a bug can never lock a device for
// good.
export const CACHE_TRUST_MS = 3 * 24 * 3600 * 1000;

// How long the screen must be left alone before the message may cover it.
export const QUIET_MS = 15 * 1000;

export const QUARANTINE_CACHE_KEY = "marathon.deviceQuarantine";

// A device id is a UUID (or deviceId.js's dev-… fallback). Anything else —
// empty, a path separator, a key that would address the PARENT — is refused,
// so a malformed id can never become a listener on the whole flag list.
const ID_OK = /^[A-Za-z0-9_-]{8,64}$/;
export function validDeviceId(id) {
  return typeof id === "string" && ID_OK.test(id);
}

/** The path for ONE device, or null when there is no safe one. */
export function quarantinePath(deviceId) {
  return validDeviceId(deviceId) ? `${QUARANTINE_NODE}/${deviceId}` : null;
}

/**
 * What a raw value at /mirror_switch/quarantine/{deviceId} means.
 * Only something written on purpose is ON.
 */
export function quarantineVerdict(raw) {
  if (raw === true) return true;
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && raw.on === true;
}

/** The value the owner writes. */
export function quarantineRecord({ by = null, now = Date.now } = {}) {
  return { on: true, at: now(), by };
}

// ── THE CACHE ──────────────────────────────────────────────────────────────
// Only a POSITIVE answer is cached, with the device id it was about. A device
// that is cleared simply loses the key.

export function readCachedQuarantine(deviceId, { now = Date.now } = {}) {
  try {
    if (!validDeviceId(deviceId) || typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(QUARANTINE_CACHE_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    if (!c || c.deviceId !== deviceId || c.on !== true) return false;
    if (!(typeof c.heardAt === "number") || now() - c.heardAt > CACHE_TRUST_MS || c.heardAt > now() + 60_000) return false;
    return true;
  } catch {
    return false;
  }
}

export function writeCachedQuarantine(deviceId, on, { now = Date.now } = {}) {
  try {
    if (typeof localStorage === "undefined") return;
    if (on && validDeviceId(deviceId)) {
      localStorage.setItem(QUARANTINE_CACHE_KEY, JSON.stringify({ deviceId, on: true, heardAt: now() }));
    } else {
      localStorage.removeItem(QUARANTINE_CACHE_KEY);
    }
  } catch { /* private mode: the live answer still holds for this tab */ }
}

/**
 * May the message cover the screen RIGHT NOW?
 *
 * `untouched` is true until the first tap or key of this page load: a device
 * that opens already quarantined shows the message at once, before anyone
 * starts something it would then interrupt.
 */
export function shouldShowNow({ quarantined, busy, msSinceActivity, untouched }) {
  if (!quarantined) return false;
  if (busy) return false;
  return untouched || msSinceActivity >= QUIET_MS;
}

/**
 * Listen to ONE device's flag. `subscribe(path, onValue, onError)` is
 * injected so this has no firebase import and can be tested with a plain
 * function. Returns a teardown. Never throws. A subscription that cannot be
 * opened calls nothing (the device stays as it was, which with no recent cache
 * is NOT quarantined); a read the database refuses reports NOT quarantined.
 */
export function watchQuarantine({ deviceId, subscribe, onChange, now = Date.now }) {
  const path = quarantinePath(deviceId);
  if (!path) return () => {};
  let stop = () => {};
  try {
    stop = subscribe(
      path,
      (raw) => {
        let on = false;
        try { on = quarantineVerdict(raw); } catch { on = false; }
        writeCachedQuarantine(deviceId, on, { now });
        try { onChange(on); } catch { /* a listener never breaks the watch */ }
      },
      (err) => {
        console.warn("device quarantine: could not read this device's flag —", err?.message ?? err);
        // FAIL OPEN: a refused read ends the message. (CodeRabbit, PR #640.)
        writeCachedQuarantine(deviceId, false, { now });
        try { onChange(false); } catch { /* a listener never breaks the watch */ }
      },
    ) ?? (() => {});
  } catch (err) {
    console.warn("device quarantine: could not watch this device's flag —", err?.message ?? err);
    return () => {};
  }
  return () => { try { stop(); } catch { /* ignore */ } };
}

/** The firebase-backed subscribe, loaded lazily like killSwitch.js's. */
export function firebaseSubscribe(path, onAnswer, onError) {
  let unsub = null;
  let cancelled = false;
  (async () => {
    try {
      const [{ ref, onValue }, { database }] = await Promise.all([
        import("firebase/database"),
        import("../firebase"),
      ]);
      if (cancelled) return;
      unsub = onValue(
        ref(database, path),
        (snap) => onAnswer(snap.exists() ? snap.val() : null),
        (err) => onError(err),
      );
    } catch (err) { onError(err); }
  })();
  return () => { cancelled = true; if (unsub) unsub(); };
}
