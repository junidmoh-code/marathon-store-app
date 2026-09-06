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

  if (!wanted) {
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
    return { state: PUSH_STATE.ON, token };
  } catch (err) {
    console.error("[push] registration failed:", err);
    return { state: PUSH_STATE.ERROR, reason: err?.message || "unknown" };
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
    console.warn("[push] could not remove token row:", err);
  }

  try {
    await update(ref(database), audienceUpdates(uid, [], serverNowMs()));
  } catch (err) {
    console.warn("[push] could not clear audience entries:", err);
  }
}
