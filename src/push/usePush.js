// ─── THE ONE HOOK THAT KEEPS A DEVICE'S REGISTRATION HONEST ──────────────────
// Called once, at the app root, on every load. Its whole job is to make sure
// this browser's FCM token is registered and current, so that the moment Junid
// assigns this person to a hub the very next order reaches them — with nothing
// for them to find, tap or agree to.
//
// ── THERE IS NO PERSONAL SWITCH ANY MORE ────────────────────────────────────
// Until 2026-09-07 this hook also read /notification_prefs/{uid}, resolved it
// against the person's stockRole, and drove a toggle on the home screen. That
// whole path is gone (owner directive: notifications are ADMIN-ASSIGNED and
// HUB-SCOPED, default off for everyone). Who receives is decided in one place —
// the Notifications card in Admin, which writes /push_assignments — and a staff
// member has no control of their own to find, get wrong, or be confused by.
//
// What that means here, precisely:
//
//   • `wanted` is ALWAYS true. Registering a token is not a subscription; it is
//     an ADDRESS. A token with no assignment is never sent to, because the
//     fan-out resolves recipients from /push_hub_audience and nothing else.
//     Registering unconditionally is what makes an assignment take effect
//     immediately instead of on this person's next app load after being told.
//   • `promptIfNeeded` is ALWAYS false. A permission prompt may only be fired
//     from a real user gesture, and there is no longer any gesture to fire it
//     from. A browser that has never been asked simply resolves to
//     NEEDS_PERMISSION and writes nothing — silently, with no nag, no broken
//     control and no error. The admin card is where that shows up: a person
//     with no live token is displayed as undeliverable, so an assignment that
//     cannot arrive is VISIBLE to the one person who can do something about it.
//   • `buckets` is ALWAYS empty, which makes every load CLEAR this uid out of
//     the legacy /push_audience index. That index was client-owned and
//     preference-driven; the fan-out no longer reads it, and self-healing it on
//     the way past means the live node empties itself instead of sitting there
//     as a stale copy of a model that no longer exists.
//
// ── WHAT IT COSTS ───────────────────────────────────────────────────────────
// Nothing is read at all — no /notification_prefs listener, no /users read
// (AuthGate already holds that record), no /push_tokens or /push_audience read.
// A browser that has never been granted permission writes nothing either. One
// small token row per app open, for the devices that can actually receive.

import { useEffect, useState } from "react";
import { PUSH_STATE, ensurePushRegistration, pushCapability } from "./registerPush";

/**
 * @param {object} args
 * @param {object|null} args.user  firebase auth user
 */
export function usePushRegistration({ user }) {
  const uid = user && !user.isAnonymous ? user.uid : null;
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!uid) { setState(null); return undefined; }
    let cancelled = false;
    // Cleared before every attempt AND on a uid change, so a previous user's
    // successful registration can never be read as this one's. On a shared
    // tablet that is the difference between "B is registered" and "A was".
    setState(null);
    ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: false })
      .then((r) => { if (!cancelled) setState(r.state); })
      .catch((e) => { if (!cancelled) { console.error("[push]", e); setState(PUSH_STATE.ERROR); } });
    return () => { cancelled = true; };
  }, [uid]);

  return {
    uid,
    // ── WHAT THE FOREGROUND LISTENER MUST GATE ON ────────────────────────────
    // Registration can be in flight, or have come back BLOCKED, UNSUPPORTED,
    // NEEDS_PERMISSION or ERROR — and several of those paths leave an earlier
    // token alive, so a payload can reach the tab and chime at somebody whose
    // registration is not actually working. `ready` says the current uid's
    // registration returned ON, and nothing else does.
    ready: state === PUSH_STATE.ON,
    state,
    capability: pushCapability(),
  };
}
