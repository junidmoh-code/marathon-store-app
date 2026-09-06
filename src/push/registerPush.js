// ─── WEB PUSH: TOKEN LIFECYCLE ON THE CLIENT ─────────────────────────────────
// One entry point — ensurePushRegistration() — called on EVERY app load, not
// only the load where permission was first granted.
//
// ── WHY EVERY LOAD ──────────────────────────────────────────────────────────
// An FCM registration token is not permanent. It rotates when the browser
// decides to (storage pressure, a long gap between visits, a Safari data
// clear-out), and a rotated token is silently dead: the server keeps sending to
// an address nobody is at, and the staff member simply stops being told. There
// is no error anywhere that a person would see. Re-reading the token on every
// load and re-writing the row costs one tiny RTDB write per app open and closes
// that whole failure class.
//
// It is also what makes lastSeenAt worth anything. A token whose lastSeenAt is
// three weeks old is a device that has not opened the app in three weeks — which
// is the only signal anyone has for pruning by hand.
//
// ── NO TOKEN, NO LISTENER, NO COST WHEN IT IS OFF ───────────────────────────
// `wanted: false` does not merely skip registration — it actively REVOKES:
// deletes the FCM token, deletes the /push_tokens row, and clears the user out
// of every audience bucket. Nothing subscribes, nothing is stored, the fan-out
// cannot find them, and the messaging SDK is never even imported. Turning it off
// costs nothing and leaves nothing behind.
//
// Firebase Messaging is loaded with a DYNAMIC import for the same reason: a
// staff member with notifications off never downloads the SDK at all.

import { get, ref, remove, runTransaction, update } from "firebase/database";
import { database } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import { getDeviceId } from "../device/deviceId";
import { describeDevice, isStandalone } from "./deviceLabel";
import {
  AUDIENCE_BUCKETS,
  PUSH_SW_SCOPE,
  PUSH_SW_URL,
  VAPID_PUBLIC_KEY,
  pushAudienceEntryPath,
  pushTokenPath,
} from "./pushConfig";

// ── "NO COST WHEN IT IS OFF" HAS TO MEAN NO WRITES EITHER ───────────────────
// Most staff are not subscribed, and every one of them loads this app several
// times a day. A revoke that runs unconditionally would mean a delete plus an
// eight-leaf index clear per load, per person, forever — to remove things that
// were never there. This marker records that THIS browser actually registered
// something, so a revoke with nothing to revoke touches the database not at all.
// It is a local optimisation hint, never a source of truth: if it is missing
// when a registration does exist, the worst case is a stale index entry whose
// uid has no tokens, which the fan-out already ignores.
const REGISTERED_KEY = "marathon.push.registered";

function registeredMarker() {
  try { return localStorage.getItem(REGISTERED_KEY); } catch { return null; }
}
function setRegisteredMarker(uid) {
  try { if (uid) localStorage.setItem(REGISTERED_KEY, uid); else localStorage.removeItem(REGISTERED_KEY); }
  catch { /* private mode: revoke simply stops being able to skip its writes */ }
}

// Every non-registering outcome is a NAMED state rather than a bare false, so
// the toggle can say what is actually wrong instead of "notifications are off".
export const PUSH_STATE = Object.freeze({
  OFF: "off",                       // the user (or their role default) wants nothing
  UNSUPPORTED: "unsupported",       // no service worker / no Push API in this browser
  NEEDS_INSTALL: "needs-install",   // iOS Safari in a tab: push needs the Home Screen copy
  NEEDS_PERMISSION: "needs-permission", // never asked — the toggle prompts on tap
  BLOCKED: "blocked",               // the user said no; only OS settings can undo it
  MISCONFIGURED: "misconfigured",   // no VAPID key in the build
  ERROR: "error",
  ON: "on",
});

/** iOS grants web push ONLY to a Home-Screen install, and only from 16.4.
 *  Detecting it lets the settings row say "Add to Home Screen" instead of
 *  failing with a meaningless browser error. */
function iosNeedsInstall(nav = typeof navigator === "undefined" ? null : navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || "");
  const isIos = /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh|Mac OS X/i.test(ua) && Number(nav.maxTouchPoints || 0) > 1);
  if (!isIos) return false;
  return !isStandalone();
}

/** Is web push even possible here? Cheap, synchronous, no side effects. */
export function pushCapability(nav = typeof navigator === "undefined" ? null : navigator) {
  if (typeof window === "undefined" || !nav) return PUSH_STATE.UNSUPPORTED;
  if (!("serviceWorker" in nav)) return PUSH_STATE.UNSUPPORTED;
  if (typeof window.Notification === "undefined" || !("PushManager" in window)) {
    // On iOS the Push API is genuinely absent until the app is installed, so
    // "add it to the Home Screen" is the accurate advice, not "unsupported".
    return iosNeedsInstall(nav) ? PUSH_STATE.NEEDS_INSTALL : PUSH_STATE.UNSUPPORTED;
  }
  if (iosNeedsInstall(nav)) return PUSH_STATE.NEEDS_INSTALL;
  return PUSH_STATE.ON;
}

/** Register the dedicated messaging worker under its narrow scope.
 *  See public/firebase-messaging-sw.js for why the scope is /fcm/. */
export async function registerMessagingWorker() {
  return navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE });
}

// The audience index this device's user should appear in, written as ONE
// multi-path update: the wanted buckets set, every other known bucket cleared.
// A closed bucket list is what makes the clear possible — see pushConfig.js.
function audienceUpdates(uid, buckets, nowMs) {
  const want = new Set(Array.isArray(buckets) ? buckets : []);
  const upd = {};
  for (const bucket of AUDIENCE_BUCKETS) {
    upd[pushAudienceEntryPath(bucket, uid)] = want.has(bucket) ? { at: nowMs } : null;
  }
  return upd;
}

/**
 * Bring this device's push registration in line with what the user wants.
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {boolean} args.wanted   resolved subscription (see notificationPrefs.js)
 * @param {string[]} args.buckets audience buckets to appear in when wanted
 * @param {boolean} [args.promptIfNeeded] ask for OS permission — ONLY ever true
 *        on a real user gesture; browsers ignore (and Safari penalises) a
 *        permission prompt that is not tied to a tap.
 * @returns {Promise<{state:string, token?:string, reason?:string}>}
 */
export async function ensurePushRegistration({ uid, wanted, buckets = [], promptIfNeeded = false }) {
  if (!uid) return { state: PUSH_STATE.ERROR, reason: "no_uid" };

  // ── THE SHARED TABLET ───────────────────────────────────────────────────────
  // Staff sign in with a PIN on tablets they share. An FCM token belongs to the
  // BROWSER, not to the signed-in account, and getDeviceId() is stable across
  // sign-outs — so when B signs in after A, getToken() hands back A's token and
  // it gets written under B as well. A's row stays live, pointing at a device A
  // is not holding, and the fan-out sends A's alerts to whoever is using it.
  //
  // The clean fix is to revoke while the user is still authenticated, which
  // signOutWithPush() does at the sign-out tap. This is the path for when that
  // did not happen — a closed tab, an expired session, a device handed over.
  // B cannot delete A's rows (the rules scope every write to auth.uid, and that
  // is exactly right), so instead B DELETES THE SHARED TOKEN and registers a
  // fresh one. A's row is left holding an address that no longer exists, and
  // the fan-out's dead-token pruning removes it on the very next send. The
  // machinery to clean this up already exists; this just makes it fire.
  const marker = registeredMarker();
  if (marker && marker !== uid) {
    await orphanForeignToken();
    setRegisteredMarker(null);
  }

  if (!wanted) {
    // Nothing was ever registered from this browser for this user — so there is
    // nothing to delete, and the cheapest correct thing is silence.
    if (registeredMarker() !== uid) return { state: PUSH_STATE.OFF };
    await revokePushRegistration({ uid });
    return { state: PUSH_STATE.OFF };
  }

  const capability = pushCapability();
  if (capability !== PUSH_STATE.ON) return { state: capability };

  if (!VAPID_PUBLIC_KEY) {
    // FAIL LOUDLY. A blank key means getToken would throw an opaque error and
    // the feature would appear "on" while reaching nobody.
    console.error(
      "[push] no VAPID public key in this build — web push cannot register. "
      + "Firebase Console → Project settings → Cloud Messaging → Web Push certificates, "
      + "then set VAPID_PUBLIC_KEY in src/push/pushConfig.js.",
    );
    return { state: PUSH_STATE.MISCONFIGURED, reason: "no_vapid_key" };
  }

  let permission = Notification.permission;
  if (permission === "denied") return { state: PUSH_STATE.BLOCKED };
  if (permission === "default") {
    if (!promptIfNeeded) return { state: PUSH_STATE.NEEDS_PERMISSION };
    permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { state: permission === "denied" ? PUSH_STATE.BLOCKED : PUSH_STATE.NEEDS_PERMISSION };
    }
  }

  try {
    const [{ getMessaging, getToken, isSupported }, swReg] = await Promise.all([
      import("firebase/messaging"),
      registerMessagingWorker(),
    ]);
    if (!(await isSupported())) return { state: PUSH_STATE.UNSUPPORTED };

    const token = await getToken(getMessaging(), {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: swReg,
    });
    if (!token) return { state: PUSH_STATE.ERROR, reason: "no_token" };

    const deviceId = getDeviceId();
    // A browser with no storage returns null from getDeviceId, and a null key
    // is not a legal RTDB path. Fall back to a hash of the token itself: stable
    // for as long as the token is, which is exactly the row's lifetime anyway.
    const tokenId = deviceId || `t_${token.slice(-24).replace(/[^A-Za-z0-9_-]/g, "")}`;
    const nowMs = serverNowMs();
    const label = describeDevice({ deviceId: tokenId, standalone: isStandalone() });

    // A TRANSACTION, not a set: createdAt must survive every subsequent load
    // (it is how you tell a device registered this morning from one registered
    // in July), while lastSeenAt is overwritten every time. A read-then-write
    // would race two tabs opening together and lose one of the two.
    await runTransaction(ref(database, pushTokenPath(uid, tokenId)), (cur) => ({
      token,
      device: label,
      createdAt: (cur && cur.createdAt) || nowMs,
      lastSeenAt: nowMs,
    }));

    await update(ref(database), audienceUpdates(uid, buckets, nowMs));
    setRegisteredMarker(uid);
    return { state: PUSH_STATE.ON, token };
  } catch (err) {
    console.error("[push] registration failed:", err);
    return { state: PUSH_STATE.ERROR, reason: err?.message || "unknown" };
  }
}

/**
 * Revoke this browser's push registration BEFORE the user signs out, while they
 * are still authenticated — the only moment the database will accept the
 * delete, because the rules scope every write on these paths to auth.uid.
 *
 * Wired into the app's one sign-out (src/components/AuthGate.jsx). Doing it
 * afterwards cannot work, and doing it from the NEXT user's session cannot work
 * either; both would leave a live token row pointing at a tablet its owner has
 * handed over.
 *
 * Never blocks the sign-out. A staff member tapping Sign out must always sign
 * out, so a failed cleanup keeps the marker (so a later load can retry) and
 * lets the sign-out proceed; the fan-out's dead-token pruning is the backstop.
 */
export async function revokeBeforeSignOut(uid) {
  if (!uid || registeredMarker() !== uid) return;
  try {
    await revokePushRegistration({ uid });
  } catch (err) {
    console.warn("[push] sign-out cleanup failed (sign-out continues):", err);
  }
}

/** Drop the FCM token this browser shares with a PREVIOUS user, so the next
 *  getToken() mints a fresh one. Deliberately does not touch RTDB: the previous
 *  user's rows are theirs, and the rules (correctly) refuse this write. Their
 *  row is left pointing at a dead address, which the fan-out prunes on its next
 *  send — see the shared-tablet note in ensurePushRegistration. */
async function orphanForeignToken() {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const swReg = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE);
    if (!swReg) return;
    const { getMessaging, deleteToken, isSupported } = await import("firebase/messaging");
    if (await isSupported()) await deleteToken(getMessaging());
  } catch (err) {
    // Worst case the token is shared for a while longer and the previous user's
    // device label is wrong. Never worth failing a sign-in over.
    console.warn("[push] could not release the previous user's token:", err);
  }
}

/** Tear the registration down completely: no token, no row, no index entry. */
export async function revokePushRegistration({ uid }) {
  if (!uid) return;
  const deviceId = getDeviceId();
  try {
    // Only touch the messaging SDK if a worker for it actually exists —
    // importing it just to delete nothing would defeat the point of the dynamic
    // import above.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const swReg = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE);
      if (swReg) {
        const { getMessaging, deleteToken, isSupported } = await import("firebase/messaging");
        if (await isSupported()) await deleteToken(getMessaging()).catch(() => {});
      }
    }
  } catch { /* the RTDB cleanup below is what actually stops the sends */ }

  let cleanupFailed = false;
  try {
    if (deviceId) {
      await remove(ref(database, pushTokenPath(uid, deviceId)));
    } else {
      // No device id (private mode): the row was keyed by a token hash we can no
      // longer reconstruct. Clear whatever this uid has — it is their own node,
      // it is small, and leaving a live token behind would keep sending to a
      // device whose owner just said stop.
      const snap = await get(ref(database, `push_tokens/${uid}`));
      if (snap.exists()) await remove(ref(database, `push_tokens/${uid}`));
    }
  } catch (err) {
    cleanupFailed = true;
    console.warn("[push] could not remove token row:", err);
  }

  try {
    await update(ref(database), audienceUpdates(uid, [], serverNowMs()));
  } catch (err) {
    cleanupFailed = true;
    console.warn("[push] could not clear audience entries:", err);
  }

  // Cleared LAST, and only if the writes above actually succeeded. The marker
  // is what lets a later load retry; clearing it after a FAILED delete would
  // make the next load skip the whole path and leave a live token notifying
  // someone who switched notifications off — or, on a shared tablet, notifying
  // the wrong person entirely.
  if (!cleanupFailed) setRegisteredMarker(null);
}
