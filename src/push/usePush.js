// ─── THE ONE HOOK THAT KEEPS A DEVICE'S REGISTRATION HONEST ──────────────────
// Subscribes to this user's explicit preference (one tiny node), resolves it
// against their role, and drives ensurePushRegistration on every app load and on
// every change to the answer.
//
// ── WHAT IT COSTS ───────────────────────────────────────────────────────────
// One onValue on /notification_prefs/{uid} — a two-field node, per user, not a
// list. Nothing here reads /users (AuthGate already holds that record and hands
// it over), and nothing reads /push_tokens or /push_audience. The whole client
// side of this feature is a per-user leaf and a per-device row.

import { useCallback, useEffect, useMemo, useState } from "react";
import { onValue, ref, remove, set } from "firebase/database";
import { database } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import { notificationPrefPath } from "./pushConfig";
import { prefPayload, resolvePushSubscription } from "./notificationPrefs";
import { PUSH_STATE, ensurePushRegistration, pushCapability } from "./registerPush";

/**
 * @param {object} args
 * @param {object|null} args.user       firebase auth user
 * @param {object|null} args.permRecord /users/{uid}
 * @param {boolean} args.isSuperAdmin
 */
export function usePushRegistration({ user, permRecord, isSuperAdmin }) {
  const uid = user && !user.isAnonymous ? user.uid : null;
  const [prefs, setPrefs] = useState(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!uid) { setPrefs(null); setPrefsLoaded(false); return undefined; }
    const off = onValue(
      ref(database, notificationPrefPath(uid)),
      (snap) => { setPrefs(snap.val() || null); setPrefsLoaded(true); },
      // A failed read must not be mistaken for "no explicit preference set",
      // which would flip a deliberate OFF back to the role default and start
      // notifying someone who asked not to be. Stay unloaded; nothing registers.
      (err) => { console.warn("[push] preference read failed:", err); setPrefsLoaded(false); },
    );
    return () => off();
  }, [uid]);

  const resolved = useMemo(
    () => resolvePushSubscription({ permRecord, prefs, isSuperAdmin }),
    [permRecord, prefs, isSuperAdmin],
  );

  // EVERY LOAD, not just the first grant — see registerPush.js. The dependency
  // list is the resolution itself, so a preference change re-runs this in place
  // (registering or revoking) without a reload.
  const bucketKey = resolved.buckets.join(",");
  useEffect(() => {
    if (!uid || !prefsLoaded) return;
    let cancelled = false;
    // Cleared before every attempt AND on a uid change, so a previous user's
    // successful registration can never be read as this one's. On a shared
    // tablet that is the difference between "B is registered" and "A was".
    setState(null);
    ensurePushRegistration({ uid, wanted: resolved.on, buckets: resolved.buckets })
      .then((r) => { if (!cancelled) setState(r.state); })
      .catch((e) => { if (!cancelled) { console.error("[push]", e); setState(PUSH_STATE.ERROR); } });
    return () => { cancelled = true; };
  }, [uid, prefsLoaded, resolved.on, bucketKey]);

  // The toggle. Turning it ON is the only path allowed to prompt for OS
  // permission, because it is the only one that runs on a real user gesture —
  // a prompt fired from an effect is ignored by Chrome and held against the
  // site by Safari.
  const setEnabled = useCallback(async (next) => {
    if (!uid) return;
    setBusy(true);
    try {
      if (next) {
        const r = await ensurePushRegistration({
          uid, wanted: true, buckets: resolved.buckets.length ? resolved.buckets : ["all"],
          promptIfNeeded: true,
        });
        setState(r.state);
        // Only record the intent once the browser actually agreed. Writing
        // "on" after a denied prompt would leave a switch that says on above a
        // device that can never receive anything.
        if (r.state === PUSH_STATE.ON) {
          await set(ref(database, notificationPrefPath(uid)), prefPayload(true, serverNowMs()));
        }
      } else {
        await set(ref(database, notificationPrefPath(uid)), prefPayload(false, serverNowMs()));
        const r = await ensurePushRegistration({ uid, wanted: false });
        setState(r.state);
      }
    } catch (e) {
      console.error("[push] toggle failed:", e);
      setState(PUSH_STATE.ERROR);
    } finally {
      setBusy(false);
    }
  }, [uid, resolved.buckets]);

  // "Use my role's default again" — deletes the explicit record rather than
  // writing the default value into it, so a later change to the role rule
  // reaches this user instead of being shadowed by a stale copy of it.
  const clearExplicit = useCallback(async () => {
    if (!uid) return;
    await remove(ref(database, notificationPrefPath(uid))).catch((e) =>
      console.warn("[push] could not clear preference:", e));
  }, [uid]);

  return {
    uid,
    enabled: resolved.on,
    // ── WHAT THE FOREGROUND LISTENER MUST GATE ON ────────────────────────────
    // `enabled` is only the resolved PREFERENCE. Registration can still be in
    // flight, or have come back BLOCKED, UNSUPPORTED or ERROR — and several of
    // those paths leave an earlier token and audience entry alive, so a payload
    // can reach the tab and chime at somebody whose registration is not
    // actually working. `ready` says the current uid's registration returned
    // ON, and nothing else does.
    ready: state === PUSH_STATE.ON,
    reason: resolved.reason,
    hasExplicit: typeof (prefs && prefs.refillRequests) === "boolean",
    state,
    capability: pushCapability(),
    busy,
    setEnabled,
    clearExplicit,
  };
}
